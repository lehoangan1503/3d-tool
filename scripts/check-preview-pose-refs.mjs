/**
 * READ-ONLY audit: which extractor references can drive the storefront's
 * 2D → 3D preview swap?
 *
 * The swap is only invisible when the 2D image was rendered from a SINGLE
 * full-canvas, unrotated cue frame. Art-directed composites (several cues,
 * offset, rotated) can never line up with one 3D camera, so they are rejected.
 *
 * Mirrors the rules in src/lib/shopify/preview-pose.ts — run it after building a
 * Preview-3D reference to confirm it qualifies BEFORE deploying.
 *
 * This script never writes: it issues GET requests only.
 *
 *   node scripts/check-preview-pose-refs.mjs                # opt-in names + any eligible
 *   node scripts/check-preview-pose-refs.mjs --all          # verdict for every reference
 *   node scripts/check-preview-pose-refs.mjs --name=Mockup  # filter by name substring
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const nameFilter = (args.find((a) => a.startsWith("--name=")) || "").slice("--name=".length).toLowerCase();

// Kept in sync with PREVIEW_POSE_NAMES in src/lib/shopify/preview-pose.ts
const OPT_IN_NAMES = ["preview-3d", "mockup-web-3d"];
const MAX_OFFSET_PX = 8;
const MAX_ROTATION_DEG = 0.5;
const SIZE_TOLERANCE = 0.02;

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const readEnv = (key) => {
  const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
};

const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
const schema = readEnv("NEXT_PUBLIC_DB_SCHEMA") || "public";
if (!url || !serviceKey) throw new Error("Missing Supabase env vars in .env");

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Accept-Profile": schema,
};

const finite = (v, f) => {
  if (v === null || v === undefined || v === "") return f;
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};

/** Same decision tree as checkPoseEligibility(). */
function checkEligibility(ref, frames) {
  const cues = frames.filter((f) => f.frame_type === "cue");
  if (cues.length === 0) return { eligible: false, reason: "no-cue-frame" };
  if (cues.length > 1) {
    return { eligible: false, reason: "multiple-cue-frames", detail: `${cues.length} cue frames` };
  }

  const f = cues[0];
  if (f.shadow_config?.studioConfigSnapshot) {
    return {
      eligible: false,
      reason: "studio-snapshot",
      detail: "camera comes from the snapshot, so phi/zoom describe nothing",
    };
  }

  const canvasW = finite(ref.canvas_width, 2048);
  const canvasH = finite(ref.canvas_height, 2048);
  const rotation = finite(f.rotation, 0);
  if (Math.abs(rotation) > MAX_ROTATION_DEG) {
    return { eligible: false, reason: "frame-rotated", detail: `${rotation.toFixed(1)}°` };
  }

  const offsetOk =
    Math.abs(finite(f.pos_x, 0)) <= MAX_OFFSET_PX && Math.abs(finite(f.pos_y, 0)) <= MAX_OFFSET_PX;
  const sizeOk =
    Math.abs(finite(f.width, 0) - canvasW) <= canvasW * SIZE_TOLERANCE &&
    Math.abs(finite(f.height, 0) - canvasH) <= canvasH * SIZE_TOLERANCE;
  if (!offsetOk || !sizeOk) {
    return {
      eligible: false,
      reason: "frame-not-full-canvas",
      detail:
        `${Math.round(finite(f.width, 0))}×${Math.round(finite(f.height, 0))} ` +
        `at (${Math.round(finite(f.pos_x, 0))},${Math.round(finite(f.pos_y, 0))}) ` +
        `vs canvas ${Math.round(canvasW)}×${Math.round(canvasH)}`,
    };
  }

  return {
    eligible: true,
    pose: {
      spinY: finite(f.cue_orbit_x, 0),
      phi: finite(f.cue_orbit_y, Math.PI / 2),
      zoom: finite(f.cue_zoom, 1) > 0 ? finite(f.cue_zoom, 1) : 1,
      offsetX: finite(f.cue_offset_x, 0),
      offsetY: finite(f.cue_offset_y, 0),
      distance: 2,
    },
  };
}

async function getAll(table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*`, { headers });
  if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

const [references, frames] = await Promise.all([
  getAll("extractor_references"),
  getAll("extractor_frames"),
]);

const framesByRef = new Map();
for (const f of frames) {
  if (!framesByRef.has(f.reference_id)) framesByRef.set(f.reference_id, []);
  framesByRef.get(f.reference_id).push(f);
}

const rows = references
  .map((ref) => ({ ref, result: checkEligibility(ref, framesByRef.get(ref.id) || []) }))
  .sort((a, b) => a.ref.name.localeCompare(b.ref.name));

const optIn = rows.filter((r) => OPT_IN_NAMES.includes(r.ref.name.trim().toLowerCase()));
const eligible = rows.filter((r) => r.result.eligible);

console.log(`Scanned ${references.length} references in schema "${schema}" (read-only)\n`);

console.log("=== Opt-in names the deploy actually looks for ===");
if (!optIn.length) {
  console.log(`(none) — create a reference named "Preview-3D" to enable the swap.`);
} else {
  for (const { ref, result } of optIn) {
    if (result.eligible) {
      const p = result.pose;
      console.log(`✅ ${ref.name} — READY`);
      console.log(
        `   spinY=${p.spinY.toFixed(4)} phi=${p.phi.toFixed(4)} zoom=${p.zoom} ` +
          `offset=(${p.offsetX},${p.offsetY}) distance=${p.distance}`,
      );
      console.log(
        `   → camera (0, ${(p.distance * Math.cos(p.phi)).toFixed(3)}, ` +
          `${(p.distance * Math.sin(p.phi)).toFixed(3)}), fov ${(50 / p.zoom).toFixed(2)}°`,
      );
    } else {
      console.log(`⛔ ${ref.name} — ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
      console.log("   Fix: exactly ONE cue frame, full canvas, rotation 0, no studio snapshot.");
    }
  }
}

console.log(`\n=== Other eligible references (${eligible.length - optIn.filter((r) => r.result.eligible).length}) ===`);
const others = eligible.filter((r) => !OPT_IN_NAMES.includes(r.ref.name.trim().toLowerCase()));
console.log(others.length ? others.map((r) => `   ${r.ref.name}`).join("\n") : "   (none)");
console.log("   (These qualify technically but are ignored — only the opt-in names are used.)");

if (showAll || nameFilter) {
  const shown = rows.filter((r) => !nameFilter || r.ref.name.toLowerCase().includes(nameFilter));
  console.log(`\n=== Verdict for ${shown.length} reference(s) ===`);
  for (const { ref, result } of shown) {
    const mark = result.eligible ? "✅" : "⛔";
    const why = result.eligible ? "" : `${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
    console.log(`${mark} ${ref.name.padEnd(28)} ${why}`);
  }
}
