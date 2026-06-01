-- =====================================================
-- 016: 'mode' role + Shopify deployment tracking
-- =====================================================
-- The 'admin' role lives in auth.users.app_metadata.role (see 013).
-- The assignable 'mode' role lives here on user_profiles so it can be
-- joined into product queries. It is granted/revoked from the admin UI
-- (Account manage) — no manual SQL needed.
-- NULL role = normal user.
-- =====================================================

ALTER TABLE shopify_customizer.user_profiles
  ADD COLUMN IF NOT EXISTS role VARCHAR(20)
  CHECK (role IN ('mode'));

-- =====================================================
-- TABLE-LEVEL GRANTS
-- service_role bypasses RLS but still needs raw table privileges. Migration
-- 012 created user_profiles WITHOUT grants, so PostgREST returned
-- "42501 permission denied" for every read/write on it (incl. setUserMode's
-- UPDATE, which is why granting 'mode' silently left role = NULL). Grant here.
-- =====================================================
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.user_profiles
  TO anon, authenticated, service_role;

-- =====================================================
-- SHOPIFY DEPLOYMENTS TABLE
-- One record per product (re-deploy updates the same row).
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.shopify_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL UNIQUE REFERENCES shopify_customizer.products(id) ON DELETE CASCADE,
  shopify_product_id BIGINT NOT NULL,
  shopify_handle TEXT,
  admin_url TEXT,
  storefront_url TEXT,
  title TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_deployments_product_id
  ON shopify_customizer.shopify_deployments(product_id);
CREATE INDEX IF NOT EXISTS idx_shopify_deployments_created_by
  ON shopify_customizer.shopify_deployments(created_by);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trigger_shopify_deployments_updated_at ON shopify_customizer.shopify_deployments;
CREATE TRIGGER trigger_shopify_deployments_updated_at
  BEFORE UPDATE ON shopify_customizer.shopify_deployments
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

-- =====================================================
-- RLS FOR SHOPIFY DEPLOYMENTS
-- =====================================================
ALTER TABLE shopify_customizer.shopify_deployments ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read deployment rows (the API decides, per role,
-- which rows are surfaced to the UI; reads themselves are harmless metadata).
CREATE POLICY "Authenticated users can read deployments"
  ON shopify_customizer.shopify_deployments
  FOR SELECT TO authenticated USING (true);

-- Writes are performed server-side. Allow the deploying user to insert/update
-- a deployment for a product they own; admins use the service-role client which
-- bypasses RLS.
CREATE POLICY "Owners can insert own deployments"
  ON shopify_customizer.shopify_deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = created_by
    AND EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Owners can update own deployments"
  ON shopify_customizer.shopify_deployments
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

-- Table-level grants (see note above re: 42501).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.shopify_deployments
  TO anon, authenticated, service_role;
