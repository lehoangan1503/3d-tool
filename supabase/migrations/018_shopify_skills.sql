-- =====================================================
-- 018: Reusable AI prompt "skills" for the deploy form
-- =====================================================
-- A skill is a named, reusable prompt template. In the deploy dialog the user
-- can pick one or many skills; their text is prepended to the AI hint as the
-- final input to the AI endpoint. Shared across all deploy users (admin/mode);
-- anyone who can deploy may create / edit / delete.
-- =====================================================

CREATE TABLE IF NOT EXISTS shopify_customizer.shopify_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  prompt_text TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_skills_created_at
  ON shopify_customizer.shopify_skills(created_at DESC);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trigger_shopify_skills_updated_at ON shopify_customizer.shopify_skills;
CREATE TRIGGER trigger_shopify_skills_updated_at
  BEFORE UPDATE ON shopify_customizer.shopify_skills
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

-- =====================================================
-- RLS — shared; the API enforces the deploy-role check.
-- =====================================================
ALTER TABLE shopify_customizer.shopify_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read skills"
  ON shopify_customizer.shopify_skills
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert skills"
  ON shopify_customizer.shopify_skills
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update skills"
  ON shopify_customizer.shopify_skills
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete skills"
  ON shopify_customizer.shopify_skills
  FOR DELETE TO authenticated USING (true);

-- =====================================================
-- GRANTS (custom schema needs explicit table grants; service_role too)
-- =====================================================
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.shopify_skills
  TO anon, authenticated, service_role;
