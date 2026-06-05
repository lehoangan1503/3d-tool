import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllCustomCollections, getAllSmartCollections } from "@/lib/shopify/client";

/** A live collection fetched from the Shopify store (for the picker). */
export interface ShopifyLiveCollection {
  id: number;
  title: string;
}

// GET /api/shopify/collections/shopify — list collections live from the Shopify
// store (custom + smart, deduped by title) so the editor can pick existing ones
// without having to save them to the DB first.
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [custom, smart] = await Promise.all([
      getAllCustomCollections(),
      getAllSmartCollections(),
    ]);

    // Dedup by lowercased title, keeping the first occurrence; sort by title.
    const seen = new Set<string>();
    const items: ShopifyLiveCollection[] = [];
    for (const c of [...custom, ...smart]) {
      const title = c.title?.trim();
      if (!title) continue;
      const lower = title.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      items.push({ id: c.id, title });
    }
    items.sort((a, b) => a.title.localeCompare(b.title));

    return NextResponse.json({ items });
  } catch (error) {
    console.error("GET /api/shopify/collections/shopify error:", error);
    return NextResponse.json({ error: "Failed to fetch Shopify collections" }, { status: 500 });
  }
}
