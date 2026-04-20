-- =====================================================
-- USER PROFILES + GLOBAL PRODUCT ACCESS
-- =====================================================

-- =====================================================
-- USER PROFILES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname VARCHAR(50),
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON shopify_customizer.user_profiles(user_id);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trigger_user_profiles_updated_at ON shopify_customizer.user_profiles;
CREATE TRIGGER trigger_user_profiles_updated_at
  BEFORE UPDATE ON shopify_customizer.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

-- =====================================================
-- RLS FOR USER PROFILES
-- =====================================================
ALTER TABLE shopify_customizer.user_profiles ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read all profiles (needed for showing owner info)
CREATE POLICY "Authenticated users can read all profiles"
  ON shopify_customizer.user_profiles
  FOR SELECT TO authenticated USING (true);

-- Users can insert their own profile
CREATE POLICY "Users can insert own profile"
  ON shopify_customizer.user_profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update only their own profile
CREATE POLICY "Users can update own profile"
  ON shopify_customizer.user_profiles
  FOR UPDATE USING (auth.uid() = user_id);

-- =====================================================
-- UPDATE PRODUCTS RLS: allow all authenticated users
-- to read all products (global dashboard)
-- =====================================================
DROP POLICY IF EXISTS "Users can view own products" ON shopify_customizer.products;

CREATE POLICY "Authenticated users can view all products"
  ON shopify_customizer.products
  FOR SELECT TO authenticated USING (true);
