"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

async function upsertUserProfile(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, email: string) {
  await supabase
    .from("user_profiles")
    .upsert({ user_id: userId, email }, { onConflict: "user_id", ignoreDuplicates: false })
    .select();
}

export async function login(formData: FormData) {
  const supabase = await createClient();

  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const { data: authData, error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    return { error: error.message };
  }

  if (authData.user) {
    await upsertUserProfile(supabase, authData.user.id, authData.user.email!);
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function signup(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  // Use admin client to create user with email pre-confirmed (no email sending needed)
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: process.env.NEXT_PUBLIC_DB_SCHEMA || "shopify_customizer" } }
  );

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    return { error: createError.message };
  }

  // Sign in to establish session cookie
  const supabase = await createClient();
  const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

  if (signInError) {
    return { error: signInError.message };
  }

  if (authData.user) {
    await upsertUserProfile(supabase, authData.user.id, authData.user.email!);
  }

  // Ensure profile is created (fallback using created user id)
  if (!authData.user && created.user) {
    await adminClient
      .from("user_profiles")
      .upsert({ user_id: created.user.id, email }, { onConflict: "user_id", ignoreDuplicates: true });
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
