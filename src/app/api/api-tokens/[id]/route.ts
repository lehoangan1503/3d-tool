import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ApiTokenSummary, UpdateApiTokenInput } from "@/types/api-token";

/**
 * Revoke, relabel or delete one of the caller's API tokens.
 *
 * RLS scopes both routes to the signed-in user, and the `.eq("user_id", ...)`
 * below repeats that constraint rather than relying on it alone — a policy
 * change should not silently widen what this can touch.
 */

const TOKEN_COLUMNS =
  "id, label, token_prefix, product_type, name_prefix, revoked_at, last_used_at, created_at";

const NAME_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * PATCH /api/api-tokens/:id — relabel, change the prefix, revoke or restore.
 *
 * Rotating the secret is deliberately NOT here: a new secret is a new token, so
 * the old row keeps its own last_used_at and a user can see whether the
 * retired credential was still in use.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: UpdateApiTokenInput;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};

    if (body.label !== undefined) {
      const label = body.label.trim();
      if (!label) {
        return NextResponse.json({ error: "Label cannot be empty" }, { status: 400 });
      }
      if (label.length > 80) {
        return NextResponse.json({ error: "Label is too long (max 80)" }, { status: 400 });
      }
      updates.label = label;
    }

    if (body.name_prefix !== undefined) {
      const raw = body.name_prefix?.trim().toLowerCase() ?? "";
      if (raw.length > 0 && !NAME_PREFIX_PATTERN.test(raw)) {
        return NextResponse.json(
          {
            error:
              "name_prefix may contain only lowercase letters, digits and hyphens, " +
              "must start with a letter or digit, and be at most 32 characters.",
          },
          { status: 400 }
        );
      }
      updates.name_prefix = raw.length > 0 ? raw : null;
    }

    if (body.revoked !== undefined) {
      // A timestamp rather than a boolean, so the list can say when.
      updates.revoked_at = body.revoked ? new Date().toISOString() : null;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("api_tokens")
      .update(updates)
      .eq("id", id)
      .eq("user_id", user.id)
      .select(TOKEN_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error("PATCH /api/api-tokens failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // No row matched: either it does not exist or it is someone else's. Both
    // answer "not yours", and saying which would confirm the id exists.
    if (!data) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json(data as ApiTokenSummary);
  } catch (error) {
    console.error("PATCH /api/api-tokens/:id error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/api-tokens/:id — remove a token for good.
 *
 * Products the token created are untouched: they belong to the user, not to
 * the credential that happened to create them.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("DELETE /api/api-tokens failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("DELETE /api/api-tokens/:id error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
