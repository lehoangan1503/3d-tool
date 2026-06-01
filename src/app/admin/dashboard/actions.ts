"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";

async function assertAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return { ok: false, error: "Không có quyền truy cập." };
  }
  return { ok: true };
}

export async function createUser(formData: FormData) {
  const guard = await assertAdmin();
  if (!guard.ok) return { error: guard.error };

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email và mật khẩu là bắt buộc." };
  }

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    return { error: createError.message };
  }

  // user_profiles is automatically populated by the on_auth_user_created trigger
  revalidatePath("/admin/dashboard");
  return { success: true };
}

/**
 * Grant or revoke the 'mode' role on a user_profiles row. Admin-only.
 * 'mode' users may deploy/upload to Shopify on their own products.
 */
export async function setUserMode(userId: string, enable: boolean) {
  const guard = await assertAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!userId) {
    return { error: "userId là bắt buộc." };
  }

  const supabase = createAdminServiceClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .update({ role: enable ? "mode" : null })
    .eq("user_id", userId)
    .select("user_id, role");

  if (error) {
    console.error("[setUserMode] update failed:", error.message, error);
    return { error: error.message };
  }

  if (!data || data.length === 0) {
    console.error("[setUserMode] no row matched user_id:", userId);
    return { error: "Không tìm thấy tài khoản để cập nhật." };
  }

  console.log("[setUserMode] updated:", data);
  revalidatePath("/admin/dashboard/accounts");
  return { success: true };
}
