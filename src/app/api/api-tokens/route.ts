import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateToken } from "@/lib/api-tokens/auth";
import type {
  ApiTokenCreated,
  ApiTokenSummary,
  CreateApiTokenInput,
} from "@/types/api-token";
import type { ProductType } from "@/types/product";

/**
 * Manages the caller's own API tokens.
 *
 * Session-authenticated (a person in the dashboard), unlike /api/v1/* which is
 * token-authenticated. Uses the cookie client so RLS scopes every row to the
 * signed-in user — the service key is not needed here and would only widen
 * what a bug could reach.
 */

const VALID_PRODUCT_TYPES: ProductType[] = ["smooth", "leather", "lizard"];

/** Never selects token_hash: nothing here needs it, so nothing can leak it. */
const TOKEN_COLUMNS =
  "id, label, token_prefix, product_type, name_prefix, revoked_at, last_used_at, created_at";

/**
 * Cap per user. High enough for one token per cue type per store, low enough
 * that a runaway script cannot fill the table.
 */
const MAX_TOKENS_PER_USER = 25;

/** Keeps a prefix usable in a product name and a storage path. */
const NAME_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

// GET /api/api-tokens — the signed-in user's tokens, newest first.
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("api_tokens")
      .select(TOKEN_COLUMNS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("GET /api/api-tokens failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const tokens: ApiTokenSummary[] = data ?? [];
    return NextResponse.json({ tokens });
  } catch (error) {
    console.error("GET /api/api-tokens error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/api-tokens — mint a token.
 *
 * The response is the ONLY time the plaintext exists outside the caller's
 * hands; the database keeps a hash. The UI must present it as copy-now.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: CreateApiTokenInput;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const label = body.label?.trim();
    if (!label) {
      return NextResponse.json(
        { error: "A label is required, e.g. \"gậy da\"" },
        { status: 400 }
      );
    }
    if (label.length > 80) {
      return NextResponse.json({ error: "Label is too long (max 80)" }, { status: 400 });
    }

    if (!VALID_PRODUCT_TYPES.includes(body.product_type)) {
      return NextResponse.json(
        { error: "product_type must be 'smooth', 'leather' or 'lizard'" },
        { status: 400 }
      );
    }

    // Normalised here rather than at use time so the stored value is exactly
    // what will appear in product names — a user who typed "N02" sees "n02"
    // in the list and knows what to expect.
    const rawPrefix = body.name_prefix?.trim().toLowerCase() ?? "";
    if (rawPrefix.length > 0 && !NAME_PREFIX_PATTERN.test(rawPrefix)) {
      return NextResponse.json(
        {
          error:
            "name_prefix may contain only lowercase letters, digits and hyphens, " +
            "must start with a letter or digit, and be at most 32 characters.",
        },
        { status: 400 }
      );
    }
    const namePrefix = rawPrefix.length > 0 ? rawPrefix : null;

    const { count, error: countError } = await supabase
      .from("api_tokens")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      console.error("POST /api/api-tokens count failed:", countError.message);
      return NextResponse.json({ error: countError.message }, { status: 500 });
    }

    if ((count ?? 0) >= MAX_TOKENS_PER_USER) {
      return NextResponse.json(
        {
          error: `You already have ${MAX_TOKENS_PER_USER} tokens. Delete one first.`,
        },
        { status: 409 }
      );
    }

    const generated = generateToken();

    const { data, error } = await supabase
      .from("api_tokens")
      .insert({
        user_id: user.id,
        label,
        token_hash: generated.hash,
        token_prefix: generated.displayPrefix,
        product_type: body.product_type,
        name_prefix: namePrefix,
      })
      .select(TOKEN_COLUMNS)
      .single();

    if (error || !data) {
      console.error("POST /api/api-tokens insert failed:", error?.message);
      return NextResponse.json(
        { error: error?.message ?? "Could not create the token" },
        { status: 500 }
      );
    }

    const created: ApiTokenCreated = { ...(data as ApiTokenSummary), token: generated.token };
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("POST /api/api-tokens error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
