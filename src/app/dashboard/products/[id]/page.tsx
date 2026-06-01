import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { EditorClient } from "@/components/editor/editor-client";
import type {
  Product,
  ProductConfig,
  ThreeJSSettingsJson,
  UserProfile,
  ShopifyDeploymentSummary,
} from "@/types/product";
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

  // Role-based Shopify access:
  // admin → deploy any product; mode → deploy own products only.
  const { isAdmin, isMode } = await getSessionRole();
  const canDeploy = isAdmin || (isMode && isOwner);

  // Surface the deployment badge only to viewers allowed to see it
  // (admin: always; mode: own product).
  let deployment: ShopifyDeploymentSummary | null = null;
  if (isAdmin || (isMode && isOwner)) {
    const { data: dep } = await supabase
      .from("shopify_deployments")
      .select("shopify_product_id, admin_url, storefront_url, title, created_by, created_at")
      .eq("product_id", id)
      .maybeSingle();

    if (dep) {
      let creatorNickname: string | null = null;
      if (dep.created_by) {
        const { data: creator } = await supabase
          .from("user_profiles")
          .select("nickname")
          .eq("user_id", dep.created_by)
          .single();
        creatorNickname = creator?.nickname ?? null;
      }
      deployment = {
        shopify_product_id: dep.shopify_product_id,
        admin_url: dep.admin_url,
        storefront_url: dep.storefront_url,
        title: dep.title,
        created_by: dep.created_by,
        creator_nickname: creatorNickname,
        created_at: dep.created_at,
      };
    }
  }

  return (
    <EditorClient
      key={product.id}
      product={product as Product}
      initialConfig={initialConfig}
      isOwner={isOwner}
      ownerProfile={ownerProfile}
      canDeploy={canDeploy}
      deployment={deployment}
    />
  );
}
