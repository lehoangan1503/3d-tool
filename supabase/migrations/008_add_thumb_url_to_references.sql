-- =====================================================
-- ADD thumb_url TO EXTRACTOR REFERENCES
-- =====================================================

SET search_path TO shopify_customizer, public;

ALTER TABLE shopify_customizer.extractor_references
  ADD COLUMN IF NOT EXISTS thumb_url TEXT;
