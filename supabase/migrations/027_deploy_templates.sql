-- =====================================================
-- 027: Price templates + per-store deploy config
-- =====================================================
-- Prices used to be hardcoded in src/lib/shopify/product-builder.ts, identical
-- for every store, so one store could not carry two brands at two prices.
--
-- A price template is just a NAMED PRICE TABLE. "Global" holds the current
-- prices; the user adds more (Uni, Novera, ...) and edits their numbers.
-- Picking a template at deploy time prices that product.
--
-- Separately, each deploy REMEMBERS what it used, per store: which price
-- template, which mockup image group, which video template. Switching stores in
-- the dialog reloads that store's last-used set, so what you see is what that
-- store was actually published with.
-- =====================================================

SET search_path TO shopify_customizer, public;

-- =====================================================
-- PRICE TEMPLATES (global list, like shadow_config_templates)
-- =====================================================
-- pricing shape:
--   {
--     "versions": {
--       "Standard": { "price": 154.5, "discountPercent": 15 },
--       "Premium":  { "price": 229.5, "discountPercent": 20 },
--       "Pro":      { "price": 299.5, "discountPercent": 20 },
--       "Lux":      { "price": 399.5, "discountPercent": 20 }
--     },
--     "modifiers": { "laserShaft": 20, "customImage": 20, "customTextPaid": 20 }
--   }
-- A missing key falls back to the built-in default for that field, so a partial
-- table is valid.
CREATE TABLE IF NOT EXISTS shopify_customizer.deploy_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  -- Shopify product vendor. NULL = keep the builder's default ("Uni Cues"), so
  -- leaving it blank changes nothing.
  vendor     TEXT,
  pricing    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive unique name so "Novera" and "novera" don't duplicate
-- (same guard as shopify_collections.value_lower in 017).
CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_templates_name_lower
  ON shopify_customizer.deploy_templates(lower(name));

DROP TRIGGER IF EXISTS trigger_deploy_templates_updated_at
  ON shopify_customizer.deploy_templates;
CREATE TRIGGER trigger_deploy_templates_updated_at
  BEFORE UPDATE ON shopify_customizer.deploy_templates
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

-- =====================================================
-- PER-STORE DEPLOY CONFIG
-- shopify_deployments is already keyed (product_id, store_id) — see 021 — so
-- these columns record what THIS store's last deploy used. Plain UUIDs, no FK:
-- extractor_reference_groups has no migration in this repo (live-DB only), so a
-- FK would not resolve on a freshly provisioned database.
-- =====================================================
ALTER TABLE shopify_customizer.shopify_deployments
  ADD COLUMN IF NOT EXISTS deploy_template_id UUID
    REFERENCES shopify_customizer.deploy_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_group_id UUID,
  ADD COLUMN IF NOT EXISTS video_template_id UUID;

-- =====================================================
-- SEED: the current hardcoded price table, as "Global".
-- Deploying with this picked produces exactly today's prices, so introducing
-- the layer changes no live price by itself.
-- =====================================================
INSERT INTO shopify_customizer.deploy_templates (name, pricing)
SELECT
  'Global',
  '{
     "versions": {
       "Standard": { "price": 154.5, "discountPercent": 15 },
       "Premium":  { "price": 229.5, "discountPercent": 20 },
       "Pro":      { "price": 299.5, "discountPercent": 20 },
       "Lux":      { "price": 399.5, "discountPercent": 20 }
     },
     "modifiers": { "laserShaft": 20, "customImage": 20, "customTextPaid": 20 }
   }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM shopify_customizer.deploy_templates WHERE lower(name) = 'global'
);

-- =====================================================
-- RLS + GRANTS
-- Reads open to authenticated; writes go through routes that gate on the deploy
-- role using the service-role client (which bypasses RLS), as in 018.
-- =====================================================
ALTER TABLE shopify_customizer.deploy_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read deploy templates"
  ON shopify_customizer.deploy_templates;
CREATE POLICY "Authenticated users can read deploy templates"
  ON shopify_customizer.deploy_templates FOR SELECT TO authenticated USING (true);

GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.deploy_templates
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
