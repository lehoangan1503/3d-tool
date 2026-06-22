-- Fix: shopify_drafts (migration 022) was created WITHOUT table-level grants, so
-- every write from the API failed with "42501 permission denied for table
-- shopify_drafts" — the same class of bug called out in migration 016 for
-- user_profiles. Because PostgREST surfaced only a logged error (the deploy flow
-- swallows it and continues), the table stayed empty: form_data never reached the
-- shared draft, so the Shopify deploy dialog rendered with no prefilled content.
--
-- service_role bypasses RLS but still needs raw table privileges; authenticated
-- needs them for the RLS-gated read policy already defined in 022.

GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.shopify_drafts
  TO anon, authenticated, service_role;
