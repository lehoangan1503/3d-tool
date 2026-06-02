-- =====================================================
-- 017: Full deploy form persistence + saved collections
-- =====================================================
-- 1) Store the entire deploy form payload so a deployed product can be
--    re-opened, edited and re-deployed (or deleted + re-created).
-- 2) Persist collections users pick so they can be re-selected from a
--    dropdown (avoids typos). Tags are auto-generated, so not stored.
-- =====================================================

ALTER TABLE shopify_customizer.shopify_deployments
  ADD COLUMN IF NOT EXISTS form_data JSONB;

-- =====================================================
-- SAVED COLLECTIONS (taxonomy for the deploy form's Collections picker)
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.shopify_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value TEXT NOT NULL,
  value_lower TEXT GENERATED ALWAYS AS (lower(value)) STORED,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive uniqueness so "Patriotic" and "patriotic" don't duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_collections_value_lower
  ON shopify_customizer.shopify_collections(value_lower);

-- =====================================================
-- RLS
-- =====================================================
ALTER TABLE shopify_customizer.shopify_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read collections"
  ON shopify_customizer.shopify_collections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert collections"
  ON shopify_customizer.shopify_collections
  FOR INSERT TO authenticated WITH CHECK (true);

-- =====================================================
-- GRANTS (custom schema needs explicit table grants; service_role too)
-- =====================================================
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.shopify_collections
  TO anon, authenticated, service_role;
