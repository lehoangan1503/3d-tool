-- =====================================================
-- 026: tool-level 'admin' role on user_profiles
-- =====================================================
-- Adds 'admin' as a THIRD assignable value on user_profiles.role, granted and
-- revoked by the superadmin from /admin/dashboard/accounts (no manual SQL).
--
-- Role tiers after this migration:
--
--   superadmin  auth.users.app_metadata.role = 'admin'   (see 013; SQL only)
--               Full control, incl. /admin/* account management. Shown in the
--               accounts table as the "Supabase Admin" badge and NOT editable
--               from the UI.
--
--   admin       user_profiles.role = 'admin'             (NEW here)
--               Tool admin. May edit, update and deploy/un-deploy ANY user's
--               product. May NOT delete other users' products, and has NO
--               access to /admin/*.
--
--   mode        user_profiles.role = 'mode'              (see 016)
--               May deploy/update Shopify for their OWN products only.
--
--   NULL        normal user — own products only.
--
-- Enforcement note: product writes are authorized in the API layer
-- (src/app/api/products/[id]/route.ts and .../asset/route.ts), which reads the
-- caller's user_profiles.role and then uses the service client for cross-owner
-- writes. The products UPDATE policy from 001 is intentionally left as
-- USING (auth.uid() = user_id), so a tool admin's own JWT still cannot write
-- another user's row directly — only the verified server path can.
-- =====================================================

-- The 016 constraint was created inline, so its name is generated
-- (user_profiles_role_check). Drop whatever CHECK currently guards role.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'shopify_customizer'
      AND rel.relname = 'user_profiles'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%role%'
  LOOP
    EXECUTE format(
      'ALTER TABLE shopify_customizer.user_profiles DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE shopify_customizer.user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IS NULL OR role IN ('mode', 'admin'));

-- Speeds up the per-request role lookup in getSessionRole().
CREATE INDEX IF NOT EXISTS idx_user_profiles_role
  ON shopify_customizer.user_profiles (role)
  WHERE role IS NOT NULL;

-- =====================================================
-- To grant / revoke the tool admin role manually (the UI does this for you):
--
--   UPDATE shopify_customizer.user_profiles
--   SET role = 'admin'          -- or 'mode', or NULL
--   WHERE email = 'user@example.com';
-- =====================================================
