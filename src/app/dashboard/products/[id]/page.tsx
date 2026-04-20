import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EditorClient } from "@/components/editor/editor-client";
import type { Product, ProductConfig, ThreeJSSettingsJson, UserProfile } from "@/types/product";
import { settingsJsonToConfig } from "@/types/product";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProductEditorPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch product — any authenticated user can view any product
  const { data: product, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !product) {
    notFound();
  }

  const isOwner = product.user_id === user.id;

  // Config MUST come from database - no fallback to defaults
  if (!product.threejs_settings_id) {
    console.error(`[ProductEditorPage] Product ${id} has no threejs_settings_id`);
    notFound();
  }

  const { data: settings, error: settingsError } = await supabase
    .from("threejs_settings")
    .select("settings")
    .eq("id", product.threejs_settings_id)
    .single();

  if (settingsError || !settings?.settings) {
    console.error(`[ProductEditorPage] Failed to load settings for product ${id}:`, settingsError);
    notFound();
  }

  const initialConfig: ProductConfig = settingsJsonToConfig(settings.settings as ThreeJSSettingsJson);

  // Fetch owner profile for display
  let ownerProfile: UserProfile | null = null;
  if (!isOwner) {
    const { data: ownerData } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", product.user_id)
      .single();
    ownerProfile = ownerData as UserProfile | null;
  }

  return (
    <EditorClient
      key={product.id}
      product={product as Product}
      initialConfig={initialConfig}
      isOwner={isOwner}
      ownerProfile={ownerProfile}
    />
  );
}
