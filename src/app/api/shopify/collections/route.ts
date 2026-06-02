import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import type { ShopifyCollection } from "@/types/product";

// GET /api/shopify/collections — list saved collection values (for the picker).
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("shopify_collections")
      .select("id, value, created_by, created_at")
      .order("value", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ items: (data as ShopifyCollection[]) ?? [] });
  } catch (error) {
    console.error("GET /api/shopify/collections error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/shopify/collections — upsert new collection values (dedup case-insensitive).
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { values?: string[] };
    const values = (body.values ?? [])
      .map((v) => v.trim())
      .filter(Boolean);

    if (values.length === 0) {
      return NextResponse.json({ inserted: 0 });
    }

    // Dedup against existing values (case-insensitive) before inserting.
    const service = createAdminServiceClient();
    const { data: existing } = await service
      .from("shopify_collections")
      .select("value_lower");
    const seen = new Set((existing ?? []).map((r) => (r.value_lower as string)));

    const toInsert: { value: string; created_by: string }[] = [];
    const addedThisCall = new Set<string>();
    for (const value of values) {
      const lower = value.toLowerCase();
      if (seen.has(lower) || addedThisCall.has(lower)) continue;
      addedThisCall.add(lower);
      toInsert.push({ value, created_by: user.id });
    }

    if (toInsert.length === 0) {
      return NextResponse.json({ inserted: 0 });
    }

    const { error } = await service.from("shopify_collections").insert(toInsert);
    if (error) {
      // Unique-violation races are harmless — report others.
      if (!error.message.includes("duplicate")) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ inserted: toInsert.length });
  } catch (error) {
    console.error("POST /api/shopify/collections error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
