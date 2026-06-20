import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStoresPublic } from "@/lib/shopify/stores";

// GET /api/shopify/stores — the configured Shopify stores (id + name only, no
// tokens) for the store-switcher UI.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ items: getStoresPublic() });
}
