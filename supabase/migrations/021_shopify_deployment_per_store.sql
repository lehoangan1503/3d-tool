-- Multi-store deployments: a product can be deployed independently to several
-- Shopify stores. Previously shopify_deployments had one row per product
-- (product_id UNIQUE). We now key deployments by (product_id, store_id) so each
-- store's deployment state is tracked separately. The UI shows only the
-- currently-selected store's state.

-- 1. Add the store_id column (which Shopify store this row belongs to).
ALTER TABLE shopify_customizer.shopify_deployments
  ADD COLUMN IF NOT EXISTS store_id TEXT;

-- 2. Backfill existing rows to the default store ("main" = Prime-cues), since
--    everything deployed so far went there.
UPDATE shopify_customizer.shopify_deployments
  SET store_id = 'main'
  WHERE store_id IS NULL;

-- 3. Make store_id required going forward.
ALTER TABLE shopify_customizer.shopify_deployments
  ALTER COLUMN store_id SET NOT NULL,
  ALTER COLUMN store_id SET DEFAULT 'main';

-- 4. Drop the old single-store UNIQUE(product_id) constraint (auto-named by
--    Postgres when declared inline) and add a composite (product_id, store_id).
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'shopify_customizer.shopify_deployments'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (product_id)';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE shopify_customizer.shopify_deployments DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE shopify_customizer.shopify_deployments
  DROP CONSTRAINT IF EXISTS shopify_deployments_product_store_unique;
ALTER TABLE shopify_customizer.shopify_deployments
  ADD CONSTRAINT shopify_deployments_product_store_unique UNIQUE (product_id, store_id);

-- 5. Index to look up a product's deployments per store quickly.
CREATE INDEX IF NOT EXISTS idx_shopify_deployments_product_store
  ON shopify_customizer.shopify_deployments(product_id, store_id);
