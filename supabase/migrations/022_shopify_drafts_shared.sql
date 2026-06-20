-- Split the shared editor DRAFT (form_data) away from per-store deployment rows.
-- The draft belongs to the PRODUCT (one per product, shared across all stores) so
-- an editor fills it once and can deploy to any store. shopify_deployments rows
-- keep only the per-store live links (shopify_product_id, admin_url, ...).

-- 1. One draft per product, shared across stores.
CREATE TABLE IF NOT EXISTS shopify_customizer.shopify_drafts (
  product_id UUID PRIMARY KEY REFERENCES shopify_customizer.products(id) ON DELETE CASCADE,
  form_data JSONB,
  title TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trigger_shopify_drafts_updated_at ON shopify_customizer.shopify_drafts;
CREATE TRIGGER trigger_shopify_drafts_updated_at
  BEFORE UPDATE ON shopify_customizer.shopify_drafts
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

ALTER TABLE shopify_customizer.shopify_drafts ENABLE ROW LEVEL SECURITY;

-- Reads are harmless metadata; the API gates which products' drafts are surfaced.
DROP POLICY IF EXISTS "Authenticated users can read drafts" ON shopify_customizer.shopify_drafts;
CREATE POLICY "Authenticated users can read drafts"
  ON shopify_customizer.shopify_drafts
  FOR SELECT TO authenticated USING (true);

-- 2. Backfill: collapse any existing per-(product,store) form_data into ONE shared
--    draft per product. Prefer the most recently updated row's snapshot.
INSERT INTO shopify_customizer.shopify_drafts (product_id, form_data, title, updated_by, updated_at)
SELECT DISTINCT ON (d.product_id)
  d.product_id, d.form_data, d.title, d.created_by, d.updated_at
FROM shopify_customizer.shopify_deployments d
WHERE d.form_data IS NOT NULL
ORDER BY d.product_id, d.updated_at DESC
ON CONFLICT (product_id) DO NOTHING;

-- 3. form_data on shopify_deployments is now redundant (drafts own it). Keep the
--    column for now to avoid breaking older reads; new code stops writing it.
--    (No DROP COLUMN — non-destructive.)
