-- =====================================================
-- 028: Simplify the price-template layer
-- =====================================================
-- Migration 027 was applied in an earlier, over-built shape: a per-(template ×
-- store) price override table, plus per-template default mockup/video/collection
-- columns. That was rejected as too complicated.
--
-- The model is now just: a flat list of NAMED PRICE TABLES, picked at deploy
-- time; and each deploy records what IT used, per store (price table + mockup
-- image group + video template) on shopify_deployments — which is already keyed
-- (product_id, store_id) since 021.
--
-- This migration converts an already-applied 027 to that shape. Every step is
-- idempotent and guarded, so it is also safe to run on a database where 027 was
-- applied in its current (simplified) form, or never applied at all.
-- =====================================================

SET search_path TO shopify_customizer, public;

-- 1. The per-store override table is gone. Any rows in it are discarded: the
--    price a live Shopify product carries is already on the product itself, so
--    dropping these changes nothing that is published.
DROP TABLE IF EXISTS shopify_customizer.deploy_template_store_overrides;

-- 2. Per-template default mockup/video/collection columns are gone. What a
--    deploy used is now recorded per store on shopify_deployments (step 3),
--    which is more accurate than a per-template default.
ALTER TABLE shopify_customizer.deploy_templates
  DROP COLUMN IF EXISTS default_group_id,
  DROP COLUMN IF EXISTS default_video_template_id,
  DROP COLUMN IF EXISTS default_collections,
  DROP COLUMN IF EXISTS default_breadcrumb;

-- 3. Record the mockup image group + video template each store's deploy used,
--    so switching stores in the dialog restores that store's own setup.
--    Plain UUIDs, no FK: extractor_reference_groups has no migration in this
--    repo (live-DB only), so a FK would not resolve on a fresh database.
ALTER TABLE shopify_customizer.shopify_deployments
  ADD COLUMN IF NOT EXISTS image_group_id UUID,
  ADD COLUMN IF NOT EXISTS video_template_id UUID;

-- 4. The seeded default table is named "Global" (027 originally seeded it as
--    "Uni Cues"). Rename in place so the row keeps its id — products already
--    deployed against it stay linked. Only renames when there is no separate
--    "Global" row already, and leaves a user-renamed row alone.
UPDATE shopify_customizer.deploy_templates
  SET name = 'Global'
  WHERE lower(name) = 'uni cues'
    AND NOT EXISTS (
      SELECT 1 FROM shopify_customizer.deploy_templates WHERE lower(name) = 'global'
    );

-- 5. Guarantee a "Global" table exists holding today's prices, in case 027 was
--    never applied or its seed row was deleted.
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

NOTIFY pgrst, 'reload schema';
