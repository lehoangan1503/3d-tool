-- Shadow Config Templates: Global shadow presets (name + JSON config)
SET search_path TO shopify_customizer, public;

CREATE TABLE IF NOT EXISTS shopify_customizer.shadow_config_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  config     JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE shopify_customizer.shadow_config_templates ENABLE ROW LEVEL SECURITY;

-- Ensure PostgREST can discover the table in schema cache.
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.shadow_config_templates
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated users can read shadow templates"
  ON shopify_customizer.shadow_config_templates;
CREATE POLICY "Authenticated users can read shadow templates"
  ON shopify_customizer.shadow_config_templates FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can insert shadow templates"
  ON shopify_customizer.shadow_config_templates;
CREATE POLICY "Authenticated users can insert shadow templates"
  ON shopify_customizer.shadow_config_templates FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update shadow templates"
  ON shopify_customizer.shadow_config_templates;
CREATE POLICY "Authenticated users can update shadow templates"
  ON shopify_customizer.shadow_config_templates FOR UPDATE
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can delete shadow templates"
  ON shopify_customizer.shadow_config_templates;
CREATE POLICY "Authenticated users can delete shadow templates"
  ON shopify_customizer.shadow_config_templates FOR DELETE
  USING (auth.role() = 'authenticated');

NOTIFY pgrst, 'reload schema';
