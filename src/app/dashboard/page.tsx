import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardClient } from "./dashboard-client";
import type { UserProfile } from "@/types/product";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch or create user profile
  let profile: UserProfile;
  const { data: existingProfile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (existingProfile) {
    profile = existingProfile as UserProfile;
  } else {
    // Upsert in case profile doesn't exist yet
    const { data: newProfile } = await supabase
      .from("user_profiles")
      .upsert({ user_id: user.id, email: user.email! }, { onConflict: "user_id" })
      .select()
      .single();
    profile = (newProfile as UserProfile) ?? {
      id: "",
      user_id: user.id,
      nickname: null,
      email: user.email!,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const showFirstLoginDialog = !profile.nickname;

  return (
    <DashboardClient
      profile={profile}
      showFirstLoginDialog={showFirstLoginDialog}
    />
  );
}

