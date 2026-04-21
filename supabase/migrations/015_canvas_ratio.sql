-- =====================================================
-- CANVAS RATIO SUPPORT
-- Schema: shopify_customizer
-- =====================================================

SET search_path TO shopify_customizer, public;

-- =====================================================
-- IMAGE RATIOS TABLE
-- Stores available canvas ratio presets.
-- Users can add custom ratios via the UI.
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.image_ratios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(80) NOT NULL,
  width INT NOT NULL CHECK (width > 0),
  height INT NOT NULL CHECK (height > 0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one ratio can be the default
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_ratios_default
  ON shopify_customizer.image_ratios(is_default)
  WHERE is_default = true;

-- Seed built-in presets
INSERT INTO shopify_customizer.image_ratios (label, width, height, is_default) VALUES
  ('Square (2048 × 2048)',  2048, 2048, true),
  ('Portrait (1638 × 2048)', 1638, 2048, false),
  ('Landscape (2048 × 1638)', 2048, 1638, false),
  ('Banner (2048 × 1024)',  2048, 1024, false)
ON CONFLICT DO NOTHING;

-- =====================================================
-- ADD CANVAS SIZE COLUMNS TO EXTRACTOR REFERENCES
-- =====================================================
ALTER TABLE shopify_customizer.extractor_references
  ADD COLUMN IF NOT EXISTS canvas_width  INT NOT NULL DEFAULT 2048,
  ADD COLUMN IF NOT EXISTS canvas_height INT NOT NULL DEFAULT 2048;

-- Backfill any rows that slipped through (safety net)
UPDATE shopify_customizer.extractor_references
  SET canvas_width = 2048, canvas_height = 2048
  WHERE canvas_width IS NULL OR canvas_height IS NULL;

-- =====================================================
-- RLS FOR IMAGE RATIOS
-- All authenticated users can read; anyone can insert
-- (no per-user ownership needed for global presets).
-- =====================================================
ALTER TABLE shopify_customizer.image_ratios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view ratios"
  ON shopify_customizer.image_ratios
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can create ratios"
  ON shopify_customizer.image_ratios
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
