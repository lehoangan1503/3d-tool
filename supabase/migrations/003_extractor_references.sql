-- =====================================================
-- EXTRACTOR REFERENCES - SUPABASE SCHEMA MIGRATION
-- Schema: shopify_customizer
-- =====================================================

SET search_path TO shopify_customizer, public;

-- =====================================================
-- EXTRACTOR REFERENCES TABLE (parent - named layouts)
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.extractor_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_extractor_references_user_id 
  ON shopify_customizer.extractor_references(user_id);

-- =====================================================
-- EXTRACTOR FRAMES TABLE (child - frames in a layout)
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.extractor_frames (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id UUID NOT NULL REFERENCES shopify_customizer.extractor_references(id) ON DELETE CASCADE,
  frame_order INT NOT NULL DEFAULT 0,
  
  -- Frame transform (relative to 2048×2048 canvas)
  pos_x FLOAT NOT NULL DEFAULT 512,
  pos_y FLOAT NOT NULL DEFAULT 512,
  width FLOAT NOT NULL DEFAULT 600,
  height FLOAT NOT NULL DEFAULT 600,
  rotation FLOAT NOT NULL DEFAULT 0, -- degrees
  
  -- Cue settings
  cue_orbit_x FLOAT NOT NULL DEFAULT 0, -- radians
  cue_orbit_y FLOAT NOT NULL DEFAULT 0.785398, -- 45° in radians (PI/4)
  cue_zoom FLOAT NOT NULL DEFAULT 1,
  cue_offset_x FLOAT NOT NULL DEFAULT 0,
  cue_offset_y FLOAT NOT NULL DEFAULT 0,
  
  -- Light
  light_angle FLOAT NOT NULL DEFAULT 45, -- degrees
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for reference lookups
CREATE INDEX IF NOT EXISTS idx_extractor_frames_reference_id 
  ON shopify_customizer.extractor_frames(reference_id);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS
ALTER TABLE shopify_customizer.extractor_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_customizer.extractor_frames ENABLE ROW LEVEL SECURITY;

-- References policies: Users can only access their own references
CREATE POLICY "Users can view own references" 
  ON shopify_customizer.extractor_references
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own references" 
  ON shopify_customizer.extractor_references
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own references" 
  ON shopify_customizer.extractor_references
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own references" 
  ON shopify_customizer.extractor_references
  FOR DELETE USING (auth.uid() = user_id);

-- Frames policies: Users can access frames through their references
CREATE POLICY "Users can view frames via reference" 
  ON shopify_customizer.extractor_frames
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.extractor_references r
      WHERE r.id = reference_id AND r.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create frames via reference" 
  ON shopify_customizer.extractor_frames
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM shopify_customizer.extractor_references r
      WHERE r.id = reference_id AND r.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update frames via reference" 
  ON shopify_customizer.extractor_frames
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.extractor_references r
      WHERE r.id = reference_id AND r.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete frames via reference" 
  ON shopify_customizer.extractor_frames
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.extractor_references r
      WHERE r.id = reference_id AND r.user_id = auth.uid()
    )
  );
