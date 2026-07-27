import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/product";

export interface SessionRole {
  userId: string | null;
  user: User | null;
  /**
   * Superadmin — auth.users.app_metadata.role === 'admin'. Granted only via
   * SQL/service key. The only role with access to /admin/*.
   */
  isSuperAdmin: boolean;
  /**
   * Tool admin — user_profiles.role === 'admin'. May edit/update/deploy ANY
   * user's product, but cannot delete other users' products and has no
   * /admin/* access. Superadmins implicitly have these powers too.
   */
  isToolAdmin: boolean;
  isMode: boolean;
  /** Anyone allowed to edit/update products they do not own. */
  canEditAnyProduct: boolean;
  /** Anyone allowed to use the Shopify deploy tool at all. */
  canDeploy: boolean;
  /** Anyone allowed to deploy/un-deploy products they do not own. */
  canDeployAnyProduct: boolean;
  /** The assignable role on user_profiles, or null for a normal user. */
  profileRole: UserRole;
}

const ANONYMOUS: SessionRole = {
  userId: null,
  user: null,
  isSuperAdmin: false,
  isToolAdmin: false,
  isMode: false,
  canEditAnyProduct: false,
  canDeploy: false,
  canDeployAnyProduct: false,
  profileRole: null,
};

/**
 * Resolve the current request's auth context and role.
 *
 * Two independent tiers:
 * - superadmin: auth.users.app_metadata.role (authoritative for /admin routing).
 * - tool admin / mode: user_profiles.role (assigned by the superadmin in the UI).
 */
export async function getSessionRole(): Promise<SessionRole> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return ANONYMOUS;

  const isSuperAdmin = user.app_metadata?.role === "admin";

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const profileRole = (profile?.role ?? null) as UserRole;
  const isToolAdmin = isSuperAdmin || profileRole === "admin";
  const isMode = profileRole === "mode";

  return {
    userId: user.id,
    user,
    isSuperAdmin,
    isToolAdmin,
    isMode,
    canEditAnyProduct: isToolAdmin,
    canDeploy: isToolAdmin || isMode,
    canDeployAnyProduct: isToolAdmin,
    profileRole,
  };
}
