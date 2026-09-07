/**
 * Bearer-token authentication for the public API.
 *
 * These requests come from outside the app — an AI tool, a script, curl — and
 * carry no Supabase session, so nothing here can rely on cookies or RLS. The
 * token IS the credential: it names the user, and nothing else that matters.
 * The cue type is a request field (migration 037); the token carries only an
 * optional default name prefix.
 *
 * A token also inherits its owner's ADMIN standing (see resolveTokenRole): an
 * admin's token may act on products it does not own, exactly as that person
 * can in the dashboard. Resolved here rather than per-route so there is one
 * answer to "what may this credential touch".
 *
 * Two rules make that safe:
 *   1. Only a hash is stored. The plaintext exists once, in the creation
 *      response, and is unrecoverable afterwards.
 *   2. Lookup runs with the service key, because the caller has no session to
 *      authorise it — so every route that uses this MUST scope its own writes
 *      to `ctx.userId` by hand. RLS is not there to catch a mistake.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import type { ApiTokenContext } from "@/types/api-token";

/**
 * Prefix on every token. Makes a leaked string recognisable in a log or a
 * paste — both to a scanning tool and to a person wondering what they found.
 */
const TOKEN_PREFIX = "cue_live_";

/** Bytes of entropy. 32 is 256 bits; base64url makes it 43 characters. */
const TOKEN_BYTES = 32;

/** How much of the plaintext is stored for display. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;

export interface GeneratedToken {
  /** Plaintext — return to the creator once, never store. */
  token: string;
  hash: string;
  /** e.g. "cue_live_7f3a", safe to store and display. */
  displayPrefix: string;
}

/**
 * Mints a new token.
 *
 * base64url rather than hex: the same entropy in fewer characters, and no `+`
 * or `/` to be mangled when someone pastes it into a YAML or shell context.
 */
export function generateToken(): GeneratedToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  return {
    token,
    hash: hashToken(token),
    displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * SHA-256, hex.
 *
 * Not bcrypt/argon2, and that is a considered choice rather than an oversight:
 * those exist to slow down brute force against LOW-entropy human passwords.
 * This token is 256 random bits, which no amount of hardware enumerates, and a
 * deliberately slow hash would instead add its cost to every API request.
 * A fast hash over high entropy is the right trade here.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time hex compare, so a near-miss leaks nothing through timing. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal; equal-length SHA-256 digests make this a formality.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The bearer credential, or null when the header is absent or malformed. */
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice(7).trim();
  return value.length > 0 ? value : null;
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export type ApiTokenAuthResult =
  | { ok: true; ctx: ApiTokenContext }
  | { ok: false; response: NextResponse };

interface ApiTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  name_prefix: string | null;
  revoked_at: string | null;
}

/**
 * Verifies the request's bearer token and resolves what it authorises.
 *
 * Every failure returns the same message. Distinguishing "no such token" from
 * "revoked" would tell someone probing tokens which guesses were once real.
 */
/**
 * Whether the token's owner may act on OTHER users' products.
 *
 * Mirrors `canEditAnyProduct` in lib/auth/roles.ts, and must keep mirroring it:
 * a token is meant to carry the same reach its owner has in the dashboard, so
 * the two definitions of "admin" being allowed to drift apart is the bug to
 * avoid. Two independent sources, same as there:
 *   - auth.users.app_metadata.role === 'admin'  (superadmin, set via SQL)
 *   - user_profiles.role === 'admin'            (tool admin, assigned in the UI)
 *
 * Runs on the service key because a bearer request has no session. A failure
 * to read either source resolves to `false`: an admin losing their extra reach
 * shows up as a clear 404 they can act on, while wrongly granting it would let
 * a token write to another user's products.
 */
async function resolveTokenRole(
  admin: ReturnType<typeof createAdminServiceClient>,
  userId: string
): Promise<boolean> {
  const [authUser, profile] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin
      .from("user_profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle<{ role: string | null }>(),
  ]);

  if (authUser.error) {
    console.warn("api token role lookup failed:", authUser.error.message);
  }
  if (profile.error) {
    console.warn("api token profile lookup failed:", profile.error.message);
  }

  const isSuperAdmin = authUser.data?.user?.app_metadata?.role === "admin";
  const isToolAdmin = profile.data?.role === "admin";
  return isSuperAdmin || isToolAdmin;
}

export async function requireApiToken(request: Request): Promise<ApiTokenAuthResult> {
  const presented = readBearer(request);
  if (!presented) {
    return {
      ok: false,
      response: unauthorized(
        "Missing API token. Send: Authorization: Bearer <token>"
      ),
    };
  }

  const admin = createAdminServiceClient();

  // Looked up BY HASH, never by prefix: the hash is what the unique index
  // covers, and a prefix lookup would return candidate rows to compare in
  // application code.
  const { data, error } = await admin
    .from("api_tokens")
    .select("id, user_id, token_hash, name_prefix, revoked_at")
    .eq("token_hash", hashToken(presented))
    .maybeSingle<ApiTokenRow>();

  if (error) {
    console.error("api token lookup failed:", error.message);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Could not verify API token" },
        { status: 503 }
      ),
    };
  }

  if (!data) return { ok: false, response: unauthorized("Invalid API token") };

  // The lookup already matched on the hash, so this can only fail if the row
  // arrived some other way. Comparing again in constant time costs nothing and
  // keeps the equality check in one place.
  if (!hashesMatch(data.token_hash, hashToken(presented))) {
    return { ok: false, response: unauthorized("Invalid API token") };
  }

  if (data.revoked_at) {
    return { ok: false, response: unauthorized("Invalid API token") };
  }

  // Best-effort: this only answers "still in use?" in the settings list, and
  // must never turn a successful request into a failed one.
  void admin
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: touchError }) => {
      if (touchError) {
        console.warn("could not record api token use:", touchError.message);
      }
    });

  const canActOnAnyProduct = await resolveTokenRole(admin, data.user_id);

  return {
    ok: true,
    ctx: {
      tokenId: data.id,
      userId: data.user_id,
      namePrefix: data.name_prefix,
      canActOnAnyProduct,
    },
  };
}
