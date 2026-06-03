-- =====================================================
-- 019: Add 'lizard' (lizard leather) product type
-- =====================================================
-- Adds a third cue type alongside 'smooth' and 'leather'. Lizard is a
-- leather-like type: it reuses the leather material pipeline (color,
-- texture_type, leather config) and only loads a different GLB model.
-- This migration just widens the products.type CHECK constraint.
-- =====================================================

ALTER TABLE shopify_customizer.products
  DROP CONSTRAINT IF EXISTS products_type_check;

ALTER TABLE shopify_customizer.products
  ADD CONSTRAINT products_type_check
  CHECK (type IN ('smooth', 'leather', 'lizard'));
