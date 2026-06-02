import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import type { CreateProductInput, ShopifyDeploymentSummary } from "@/types/product";
import { DEFAULT_SMOOTH_CONFIG, DEFAULT_LEATHER_CONFIG, configToSettingsJson } from "@/types/product";

// GET /api/products - List ALL products (global) with pagination + search + type filter
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "20", 10), 50);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0",  10), 0);
    const search = (searchParams.get("search") ?? "").trim();
    const type   = searchParams.get("type") ?? "";
    const sort   = searchParams.get("sort") ?? "";
    const owner  = searchParams.get("owner") ?? "";

    // Fetch all products globally; optionally filter to current user only
    let query = supabase
      .from("products")
      .select("*", { count: "exact" });

    if (owner === "me") query = query.eq("user_id", user.id);
    if (search) query = query.ilike("name", `%${search}%`);
    if (type && ["smooth", "leather"].includes(type)) query = query.eq("type", type);
    if (sort === "asc") query = query.order("name", { ascending: true });
    else if (sort === "desc") query = query.order("name", { ascending: false });
    else query = query.order("created_at", { ascending: false });

    query = query.range(offset, offset + limit - 1);

    const { data: products, error, count } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!products || products.length === 0) {
      return NextResponse.json({ items: [], total: count ?? 0 });
    }

    // Fetch owner profiles for these products
    const ownerIds = [...new Set(products.map((p) => p.user_id))];
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("user_id, nickname, email")
      .in("user_id", ownerIds);

    const profileMap = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);

    // Shopify deployment badges — surfaced per the viewer's role:
    // admin sees all; mode sees only their own; normal users see none.
    const { isAdmin, isMode } = await getSessionRole();
    const deploymentMap = new Map<string, ShopifyDeploymentSummary>();
    if (isAdmin || isMode) {
      const productIds = products.map((p) => p.id);
      const { data: deployments } = await supabase
        .from("shopify_deployments")
        .select("product_id, shopify_product_id, admin_url, storefront_url, title, created_by, created_at")
        .in("product_id", productIds);

      const creatorIds = [
        ...new Set((deployments ?? []).map((d) => d.created_by).filter(Boolean)),
      ] as string[];
      const creatorMap = new Map(
        profiles
          ?.filter((p) => creatorIds.includes(p.user_id))
          .map((p) => [p.user_id, p]) ?? []
      );
      // Creators may not be among the product owners already fetched.
      const missingCreatorIds = creatorIds.filter((id) => !creatorMap.has(id));
      if (missingCreatorIds.length) {
        const { data: extraProfiles } = await supabase
          .from("user_profiles")
          .select("user_id, nickname, email")
          .in("user_id", missingCreatorIds);
        for (const p of extraProfiles ?? []) creatorMap.set(p.user_id, p);
      }

      for (const d of deployments ?? []) {
        // Only surface rows that are actually live on Shopify. A row with a
        // null id was deleted and only retains form_data for re-deploy.
        if (!d.shopify_product_id) continue;
        deploymentMap.set(d.product_id, {
          shopify_product_id: d.shopify_product_id,
          admin_url: d.admin_url,
          storefront_url: d.storefront_url,
          title: d.title,
          created_by: d.created_by,
          creator_nickname: d.created_by
            ? creatorMap.get(d.created_by)?.nickname ?? null
            : null,
          created_at: d.created_at,
          form_data: null,
        });
      }
    }

    const items = products.map((p) => {
      const profile = profileMap.get(p.user_id);
      // mode users only see badges on their own products
      const deployment =
        isAdmin || (isMode && p.user_id === user.id)
          ? deploymentMap.get(p.id) ?? null
          : null;
      return {
        ...p,
        owner_nickname: profile?.nickname ?? null,
        owner_email: profile?.email ?? null,
        shopify_deployment: deployment,
      };
    });

    return NextResponse.json({ items, total: count ?? 0 });
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/products - Create a new product
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: CreateProductInput = await request.json();

    // Validate required fields
    if (!body.name || !body.type) {
      return NextResponse.json(
        { error: "Name and type are required" },
        { status: 400 }
      );
    }

    if (!["smooth", "leather"].includes(body.type)) {
      return NextResponse.json(
        { error: "Type must be 'smooth' or 'leather'" },
        { status: 400 }
      );
    }

    // Create threejs_settings record with type-specific default config
    const defaultConfig = body.type === "leather" ? DEFAULT_LEATHER_CONFIG : DEFAULT_SMOOTH_CONFIG;
    const settingsJson = configToSettingsJson(defaultConfig);
    const { data: settingsData, error: settingsError } = await supabase
      .from("threejs_settings")
      .insert({
        name: `product_${Date.now()}`,
        settings: settingsJson,
      })
      .select()
      .single();

    if (settingsError) {
      console.error("Failed to create threejs_settings:", settingsError);
      return NextResponse.json({ error: settingsError.message }, { status: 500 });
    }

    // Create product with reference to settings
    const { data, error } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: body.name,
        type: body.type,
        surface_url: body.surface_url || null,
        texture_type: body.type === "leather" ? (body.texture_type || "crocodile") : null,
        color: body.type === "leather" ? (body.color || "black") : null,
        threejs_settings_id: settingsData.id,
      })
      .select()
      .single();

    if (error) {
      // Clean up settings if product creation fails
      await supabase.from("threejs_settings").delete().eq("id", settingsData.id);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("POST /api/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
