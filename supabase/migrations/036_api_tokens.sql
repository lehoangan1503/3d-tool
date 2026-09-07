-- =====================================================
-- 036: API tokens — create products from outside the app
-- =====================================================
-- Templates are made outside this app (increasingly by an AI), and getting one
-- in meant a person opening the dashboard, creating a product, picking its
-- type, then uploading the surface image. Two requests and a human for work
-- that is entirely mechanical.
--
-- A token replaces the human. It carries BOTH the identity (whose product this
-- becomes) and the configuration (what kind of cue to build), so an external
-- caller sends nothing but the image file:
--
--   curl -H "Authorization: Bearer cue_live_..." \
--        -F file=@dragon-gold.jpg  https://app/api/v1/products
--
-- Config in the token rather than the request is the point, not a shortcut.
-- One token per cue type means the caller never states the type, so it can
-- never state it wrong: token A always builds a leather cue, token B always a
-- smooth one. A prompt-driven caller has no format to get right.
--
-- Only `type` is stored. texture_type/color are nullable on products and the
-- 3D settings come from DEFAULT_CONFIG_BY_TYPE, so the API creates exactly
-- what the dashboard's "new product" form creates. Adding fields here later is
-- additive; each one is a new decision the caller no longer gets to make.
-- =====================================================

SET search_path TO shopify_customizer, public;

CREATE TABLE IF NOT EXISTS shopify_customizer.api_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Shown in the settings list so a user can tell their tokens apart
  -- ("gậy da", "gậy trơn"). Free text; never used for lookup.
  label       TEXT NOT NULL,

  -- SHA-256 of the token, hex. The plaintext is returned exactly once, at
  -- creation, and is not recoverable afterwards — a leaked database gives an
  -- attacker no usable tokens. Unique so a lookup by hash needs no scan and a
  -- (vanishingly unlikely) generator collision is a constraint error rather
  -- than two users sharing a credential.
  token_hash  TEXT NOT NULL UNIQUE,

  -- First characters of the plaintext, e.g. "cue_live_7f3a". Enough for a user
  -- to match a token in this list against one pasted in their AI tool, and
  -- far too little to authenticate with.
  token_prefix TEXT NOT NULL,

  -- What this token builds. Mirrors products.type; 'lizard' was added by 019,
  -- which is also why products' own CHECK still lists only two values.
  product_type TEXT NOT NULL CHECK (product_type IN ('smooth', 'leather', 'lizard')),

  -- Prepended to every product name this token creates ("n02" -> "n02-dragon").
  -- Per-token rather than per-user: the same person may bring in templates on
  -- behalf of different stores. NULL means no prefix.
  name_prefix TEXT,

  -- Lets a user park a token without losing its history. Checked on every
  -- request, so revoking takes effect immediately.
  revoked_at  TIMESTAMPTZ,

  -- Answers "is this token still in use?" before revoking it. Updated on each
  -- successful authentication, best-effort — a failed write here must never
  -- fail the request it was only observing.
  last_used_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The settings list: a user's tokens, newest first.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user
  ON shopify_customizer.api_tokens(user_id, created_at DESC);

-- =====================================================
-- RLS
-- =====================================================
-- A user manages only their own tokens, and NO policy grants SELECT on
-- token_hash to anyone else — including admins, who can already act on other
-- users' products through their role and would gain nothing but the ability to
-- impersonate a token.
--
-- Authentication itself does not go through these policies: the request
-- carries no Supabase session, only the bearer token, so the API route looks
-- the hash up with the service key (RLS-exempt) and then acts as the token's
-- owner.
ALTER TABLE shopify_customizer.api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "api_tokens_select_own" ON shopify_customizer.api_tokens;
CREATE POLICY "api_tokens_select_own"
  ON shopify_customizer.api_tokens FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "api_tokens_insert_own" ON shopify_customizer.api_tokens;
CREATE POLICY "api_tokens_insert_own"
  ON shopify_customizer.api_tokens FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Covers revoking and relabelling. Rotating a secret is not an update: a new
-- token is a new row, so the old one keeps its own last_used_at history.
DROP POLICY IF EXISTS "api_tokens_update_own" ON shopify_customizer.api_tokens;
CREATE POLICY "api_tokens_update_own"
  ON shopify_customizer.api_tokens FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "api_tokens_delete_own" ON shopify_customizer.api_tokens;
CREATE POLICY "api_tokens_delete_own"
  ON shopify_customizer.api_tokens FOR DELETE
  USING (user_id = auth.uid());

-- =====================================================
-- GRANTS
-- =====================================================
-- Required, not optional: this is a non-public schema, so PostgREST's roles
-- have no implicit rights on a new table. Without these every query fails with
-- "permission denied for table api_tokens" (SQLSTATE 42501) — which the API
-- surfaces as a 503, so it reads like a database outage rather than a missing
-- grant.
--
-- `anon` is deliberately NOT granted, unlike most tables in this schema. Only
-- two callers touch this table: a signed-in user managing their own tokens
-- (authenticated), and the bearer-token lookup, which runs on the service key.
-- Nothing legitimate reads it without a session, and the table stores
-- credentials — so the role that represents "no session at all" gets nothing.
-- RLS would already block it; withholding the grant means an RLS mistake alone
-- cannot expose token hashes.
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.api_tokens
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
