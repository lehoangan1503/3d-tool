-- =====================================================
-- 037: cue type moves from the token to the request
-- =====================================================
-- 036 put `product_type` on the token so an external caller sent nothing but
-- the image: one token per cue type meant the type could never be stated
-- wrong. That worked, and was wrong for who actually uses it.
--
-- In practice the caller is one AI/n8n flow handling every cue type, and the
-- people wiring it up are not developers. Per-type tokens turned "one
-- credential, pick a type" into "remember which of three secrets matches this
-- template" — a bookkeeping problem outside the app, where nothing can check
-- it, replacing a validation problem inside the app, where a 400 can say
-- exactly what went wrong.
--
-- So: one token per person, and `type` is a request field with the allowed
-- values printed in the API docs on the settings page. Omitting it is a 400,
-- never a silent default — an unstated type must not quietly become a leather
-- cue.
--
-- `name_prefix` stays on the token. It is per-store bookkeeping rather than
-- per-template, so a default that a request may override is genuinely the
-- shape of it, unlike the type.
-- =====================================================

SET search_path TO shopify_customizer, public;

-- Dropped, not kept-and-ignored: a column the API no longer reads would
-- eventually be read again by mistake, and every existing token now works for
-- all three types.
ALTER TABLE shopify_customizer.api_tokens
  DROP COLUMN IF EXISTS product_type;

COMMENT ON TABLE shopify_customizer.api_tokens IS
  'Bearer credentials for /api/v1/*. Carries identity plus an optional default '
  'name_prefix; the cue type is a per-request field (see migration 037).';

NOTIFY pgrst, 'reload schema';
