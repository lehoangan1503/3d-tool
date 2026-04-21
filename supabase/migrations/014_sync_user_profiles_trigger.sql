-- =====================================================
-- 014: Auto-sync user_profiles on auth.users INSERT
-- =====================================================
-- Trigger fires after every new user is created in
-- auth.users and inserts a matching row in
-- shopify_customizer.user_profiles.
-- SECURITY DEFINER lets it bypass RLS.
-- =====================================================

CREATE OR REPLACE FUNCTION shopify_customizer.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
BEGIN
  INSERT INTO shopify_customizer.user_profiles (user_id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists to allow re-running this migration safely
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.handle_new_user();
