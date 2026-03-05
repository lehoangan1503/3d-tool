import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EditorClient } from "@/components/editor/editor-client";
import type { Product, ProductConfig, ThreeJSSettingsJson } from "@/types/product";
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

  const { data: product, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !product) {
    notFound();
  }

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

  // Use key to force remount when product ID changes (important for client-side navigation)
  return <EditorClient key={product.id} product={product as Product} initialConfig={initialConfig} />;
}
