/**
 * Price templates CRUD — named price tables ("Global", "Uni", "Novera", ...)
 * picked when deploying.
 *
 * Writes go through the service-role client after a deploy-role gate, matching
 * how /api/shopify/skills manages its shared presets.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { listDeployTemplates, getDeployTemplate } from "@/lib/shopify/deploy-templates";
import type { DeployPricing, DeployTemplateInput } from "@/types/deploy-template";
import type { ShopifyVersionName } from "@/types/product";

async function requireDeployRole() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, user: null, isToolAdmin: false };
  const { isToolAdmin, isMode } = await getSessionRole();
  if (!isToolAdmin && !isMode) {
    return { error: "Forbidden", status: 403 as const, user: null, isToolAdmin: false };
  }
  return { error: null, status: 200 as const, user, isToolAdmin };
}

/**
 * Only admins may create/edit/delete price tables — "mode" users deploy with
 * them but must not change what anything is priced at. Enforced on every write
 * below, and surfaced on GET so the UI can hide the controls.
 */
function requireAdmin(gate: { isToolAdmin: boolean }) {
  return gate.isToolAdmin
    ? null
    : NextResponse.json({ error: "Chỉ admin mới sửa được bảng giá." }, { status: 403 });
}

const VERSIONS: readonly ShopifyVersionName[] = ["Standard", "Premium", "Pro", "Lux"] as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Keep only well-formed numbers so a malformed body can never persist a price
 * that would later be posted to Shopify. Dropped values fall back to the
 * built-in default for that field.
 */
function sanitizePricing(raw: unknown): DeployPricing {
  const out: DeployPricing = {};
  if (!raw || typeof raw !== "object") return out;
  const input = raw as DeployPricing;

  if (input.versions && typeof input.versions === "object") {
    const versions: DeployPricing["versions"] = {};
    for (const version of VERSIONS) {
      const entry = input.versions[version];
      if (!entry || typeof entry !== "object") continue;
      const cleaned: { price?: number; discountPercent?: number } = {};
      if (isFiniteNumber(entry.price) && entry.price >= 0) cleaned.price = entry.price;
      if (
        isFiniteNumber(entry.discountPercent) &&
        entry.discountPercent >= 0 &&
        entry.discountPercent < 100
      ) {
        cleaned.discountPercent = entry.discountPercent;
      }
      if (Object.keys(cleaned).length) versions[version] = cleaned;
    }
    if (Object.keys(versions).length) out.versions = versions;
  }

  if (input.modifiers && typeof input.modifiers === "object") {
    const modifiers: DeployPricing["modifiers"] = {};
    for (const key of ["laserShaft", "customImage", "customTextPaid"] as const) {
      const value = input.modifiers[key];
      if (isFiniteNumber(value) && value >= 0) modifiers[key] = value;
    }
    if (Object.keys(modifiers).length) out.modifiers = modifiers;
  }

  return out;
}

/** A blank string means "unset" for the nullable vendor column. */
function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// GET — list all templates. ?id= returns one.
export async function GET(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const item = await getDeployTemplate(id);
      if (!item) return NextResponse.json({ error: "Không tìm thấy bảng giá." }, { status: 404 });
      return NextResponse.json({ item });
    }

    return NextResponse.json({ items: await listDeployTemplates(), canEdit: gate.isToolAdmin });
  } catch (error) {
    console.error("GET /api/shopify/deploy-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — create a template.
export async function POST(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error || !gate.user) {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }

    const denied = requireAdmin(gate);
    if (denied) return denied;

    const body = (await request.json()) as DeployTemplateInput;
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "Tên bảng giá là bắt buộc." }, { status: 400 });

    const service = createAdminServiceClient();
    const { data, error } = await service
      .from("deploy_templates")
      .insert({
        name,
        vendor: nullableText(body.vendor),
        pricing: sanitizePricing(body.pricing),
        created_by: gate.user.id,
      })
      .select("id")
      .single();

    if (error) {
      // The case-insensitive unique index on name surfaces as 23505.
      const conflict = error.code === "23505";
      const message = conflict ? "Tên bảng giá đã tồn tại." : error.message;
      return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
    }

    const item = await getDeployTemplate((data as { id: string }).id);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    console.error("POST /api/shopify/deploy-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT — edit a template's name / vendor / prices.
export async function PUT(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const denied = requireAdmin(gate);
    if (denied) return denied;

    const body = (await request.json()) as DeployTemplateInput & { id?: string };
    const id = body.id?.trim();
    if (!id) return NextResponse.json({ error: "id là bắt buộc." }, { status: 400 });

    const name = body.name?.trim();
    if (body.name !== undefined && !name) {
      return NextResponse.json({ error: "Tên bảng giá không được để trống." }, { status: 400 });
    }

    // Only patch the fields that were actually sent.
    const patch: Record<string, string | null | DeployPricing> = {};
    if (name) patch.name = name;
    if (body.vendor !== undefined) patch.vendor = nullableText(body.vendor);
    if (body.pricing !== undefined) patch.pricing = sanitizePricing(body.pricing);

    if (Object.keys(patch).length) {
      const service = createAdminServiceClient();
      const { error } = await service.from("deploy_templates").update(patch).eq("id", id);
      if (error) {
        const conflict = error.code === "23505";
        const message = conflict ? "Tên bảng giá đã tồn tại." : error.message;
        return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
      }
    }

    const item = await getDeployTemplate(id);
    if (!item) return NextResponse.json({ error: "Không tìm thấy bảng giá." }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) {
    console.error("PUT /api/shopify/deploy-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — remove a template.
export async function DELETE(request: Request) {
  try {
    const gate = await requireDeployRole();
    if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const denied = requireAdmin(gate);
    if (denied) return denied;

    const body = (await request.json()) as { id?: string };
    const id = body.id?.trim();
    if (!id) return NextResponse.json({ error: "id là bắt buộc." }, { status: 400 });

    // Deployment rows keep their history: deploy_template_id is ON DELETE SET
    // NULL, so deleting a price table does not delete any deployment record.
    const service = createAdminServiceClient();
    const { error } = await service.from("deploy_templates").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/shopify/deploy-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
