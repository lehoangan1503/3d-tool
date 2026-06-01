import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export interface SessionRole {
  userId: string | null;
  user: User | null;
  isAdmin: boolean;
  isMode: boolean;
  // Convenience: anyone allowed to use the Shopify deploy tool.
  canDeploy: boolean;
}

/**
 * Resolve the current request's auth context and role.
 * - admin: stored in auth.users.app_metadata.role (authoritative for routing).
 * - mode:  stored in user_profiles.role (assigned by an admin).
 */
export async function getSessionRole(): Promise<SessionRole> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { userId: null, user: null, isAdmin: false, isMode: false, canDeploy: false };
  }

  const isAdmin = user.app_metadata?.role === "admin";

  let isMode = false;
  if (!isAdmin) {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("user_id", user.id)
      .single();
    isMode = profile?.role === "mode";
  }

  return {
    userId: user.id,
    user,
    isAdmin,
    isMode,
    canDeploy: isAdmin || isMode,
  };
}
