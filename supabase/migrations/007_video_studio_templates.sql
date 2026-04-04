-- Video Studio Templates: Saved camera + background + cue configs per product
CREATE TABLE IF NOT EXISTS shopify_customizer.video_studio_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES shopify_customizer.products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_video_studio_templates_product
  ON shopify_customizer.video_studio_templates(product_id);

-- RLS
ALTER TABLE shopify_customizer.video_studio_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own studio templates"
  ON shopify_customizer.video_studio_templates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create studio templates for own products"
  ON shopify_customizer.video_studio_templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own studio templates"
  ON shopify_customizer.video_studio_templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own studio templates"
  ON shopify_customizer.video_studio_templates FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM shopify_customizer.products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    )
  );

-- Camera Easing Presets: User-defined custom easing curves
CREATE TABLE IF NOT EXISTS shopify_customizer.camera_easing_presets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  easing_value TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_camera_easing_presets_user
  ON shopify_customizer.camera_easing_presets(user_id);

ALTER TABLE shopify_customizer.camera_easing_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own easing presets"
  ON shopify_customizer.camera_easing_presets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own easing presets"
  ON shopify_customizer.camera_easing_presets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own easing presets"
  ON shopify_customizer.camera_easing_presets FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own easing presets"
  ON shopify_customizer.camera_easing_presets FOR DELETE
  USING (auth.uid() = user_id);
