-- Add shadow_config JSONB column to extractor_frames for per-frame shadow persistence
ALTER TABLE shopify_customizer.extractor_frames
  ADD COLUMN IF NOT EXISTS shadow_config JSONB;
