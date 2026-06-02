import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import type { ShopifySkill } from "@/types/product";

// Only users who can deploy (admin or mode) may manage skills.
async function requireDeployRole() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, user: null };
  const { isAdmin, isMode } = await getSessionRole();
  if (!isAdmin && !isMode) return { error: "Forbidden", status: 403 as const, user: null };
  return { error: null, status: 200 as const, user };
}

// GET — list all skills (shared).
export async function GET() {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("shopify_skills")
      .select("id, name, prompt_text, created_by, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: (data as ShopifySkill[]) ?? [] });
  } catch (error) {
    console.error("GET /api/shopify/skills error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — create a skill.
export async function POST(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error || !gate.user) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = await request.json() as { name?: string; promptText?: string };
    const name = body.name?.trim();
    const promptText = body.promptText?.trim();
    if (!name || !promptText) {
      return NextResponse.json({ error: "Tên và nội dung skill là bắt buộc." }, { status: 400 });
    }

    const service = createAdminServiceClient();
    const { data, error } = await service
      .from("shopify_skills")
      .insert({ name, prompt_text: promptText, created_by: gate.user.id })
      .select("id, name, prompt_text, created_by, created_at, updated_at")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ item: data as ShopifySkill }, { status: 201 });
  } catch (error) {
    console.error("POST /api/shopify/skills error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT — edit a skill (shared edit).
export async function PUT(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = await request.json() as { id?: string; name?: string; promptText?: string };
    const { id } = body;
    const name = body.name?.trim();
    const promptText = body.promptText?.trim();
    if (!id || !name || !promptText) {
      return NextResponse.json({ error: "id, tên và nội dung skill là bắt buộc." }, { status: 400 });
    }

    const service = createAdminServiceClient();
    const { data, error } = await service
      .from("shopify_skills")
      .update({ name, prompt_text: promptText })
      .eq("id", id)
      .select("id, name, prompt_text, created_by, created_at, updated_at")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ item: data as ShopifySkill });
  } catch (error) {
    console.error("PUT /api/shopify/skills error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — remove a skill.
export async function DELETE(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { id } = await request.json() as { id?: string };
    if (!id) return NextResponse.json({ error: "id là bắt buộc." }, { status: 400 });

    const service = createAdminServiceClient();
    const { error } = await service.from("shopify_skills").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/shopify/skills error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
