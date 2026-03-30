-- =====================================================
-- ADD frame_type AND image_settings TO extractor_frames
-- Schema: shopify_customizer
-- Enables frames to be either 'cue' (3D model) or 'image' (overlay layer)
-- =====================================================

SET search_path TO shopify_customizer, public;

-- Add frame_type to distinguish cue vs image frames
ALTER TABLE shopify_customizer.extractor_frames
  ADD COLUMN IF NOT EXISTS frame_type VARCHAR(20) NOT NULL DEFAULT 'cue'
  CHECK (frame_type IN ('cue', 'image'));

-- Add image_settings as JSONB for image frame configuration
-- Stores: { imageUrl, backgroundColor, objectFit, rotation3d, opacity, blendMode }
ALTER TABLE shopify_customizer.extractor_frames
  ADD COLUMN IF NOT EXISTS image_settings JSONB DEFAULT NULL;

-- Backfill existing rows so frame_type is never null
UPDATE shopify_customizer.extractor_frames
  SET frame_type = 'cue'
  WHERE frame_type IS NULL OR frame_type = '';

COMMENT ON COLUMN shopify_customizer.extractor_frames.frame_type IS
  'Discriminator: cue = 3D model view, image = overlay image/color layer';

COMMENT ON COLUMN shopify_customizer.extractor_frames.image_settings IS
  'JSON settings for image frames: {imageUrl, backgroundColor, objectFit, rotation3d, opacity, blendMode}';
