-- =====================================================
-- ADD hdri_layers COLUMN TO extractor_frames
-- Schema: shopify_customizer
-- =====================================================

SET search_path TO shopify_customizer, public;

-- Add hdri_layers column as JSONB to store array of HdriLayer objects
-- Each HdriLayer has: id, hdriType, rotationX, rotationY
ALTER TABLE shopify_customizer.extractor_frames
ADD COLUMN IF NOT EXISTS hdri_layers JSONB DEFAULT '[{"id": "default", "hdriType": "bloem_train_track_clear_2k.hdr", "rotationX": 0, "rotationY": 300}]'::jsonb;

-- Add comment for documentation
COMMENT ON COLUMN shopify_customizer.extractor_frames.hdri_layers IS 
  'Array of HDRI layers for multi-lighting. Each layer: {id, hdriType, rotationX, rotationY}';
