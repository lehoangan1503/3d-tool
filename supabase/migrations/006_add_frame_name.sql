-- =====================================================
-- ADD frame_name TO extractor_frames
-- Schema: shopify_customizer
-- Allows frames to have optional user-defined names (e.g. "Front View", "Close-up")
-- =====================================================

SET search_path TO shopify_customizer, public;

ALTER TABLE shopify_customizer.extractor_frames
  ADD COLUMN IF NOT EXISTS frame_name TEXT DEFAULT NULL;

COMMENT ON COLUMN shopify_customizer.extractor_frames.frame_name IS
  'Optional user-defined name for the frame (e.g. "Front View", "Close-up"). Null means auto-label.';
