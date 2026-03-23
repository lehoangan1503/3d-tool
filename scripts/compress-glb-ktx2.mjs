#!/usr/bin/env node
/**
 * compress-glb-ktx2.mjs
 *
 * Converts GLB textures to KTX2 / Basis Universal format using @gltf-transform/cli.
 * This dramatically reduces GPU VRAM usage (4–8×) and prevents mobile OOM crashes.
 *
 * KTX2 textures remain compressed in VRAM — unlike PNG/JPEG which decompress to
 * raw RGBA on the GPU. A 30 MB GLB with 4096×4096 textures can consume ~384 MB of
 * VRAM; with KTX2 ETC1S that drops to ~48 MB.
 *
 * Usage:
 *   node scripts/compress-glb-ktx2.mjs [--quality uastc|etc1s] [input.glb] [output.glb]
 *
 * Presets:
 *   --quality uastc   High quality, ~4× VRAM reduction (default for color-critical assets)
 *   --quality etc1s   Smaller file + VRAM, ~8× reduction (good for large atlases, some quality loss)
 *
 * Examples:
 *   node scripts/compress-glb-ktx2.mjs public/models/cue-butt-leather.glb
 *   node scripts/compress-glb-ktx2.mjs --quality etc1s public/models/cue-butt-leather.glb public/models/cue-butt-leather-ktx2.glb
 *
 * Requirements:
 *   npm install --save-dev @gltf-transform/cli @gltf-transform/extensions sharp
 *
 * The output GLB is a drop-in replacement — just point your loader at the new file.
 * Three.js KTX2Loader handles format detection (ETC2/ASTC/BC7) per-device automatically.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { basename, dirname, join } from "path";

const args = process.argv.slice(2);

// Parse --quality flag
let quality = "uastc";
const qualityIdx = args.indexOf("--quality");
if (qualityIdx !== -1) {
  quality = args[qualityIdx + 1];
  args.splice(qualityIdx, 2);
}

if (!["uastc", "etc1s"].includes(quality)) {
  console.error(`[compress-glb-ktx2] Unknown quality: "${quality}". Use "uastc" or "etc1s".`);
  process.exit(1);
}

const inputPath = args[0];
if (!inputPath) {
  console.error("Usage: node scripts/compress-glb-ktx2.mjs [--quality uastc|etc1s] <input.glb> [output.glb]");
  process.exit(1);
}

if (!existsSync(inputPath)) {
  console.error(`[compress-glb-ktx2] Input file not found: ${inputPath}`);
  process.exit(1);
}

const inputBase = basename(inputPath, ".glb");
const inputDir = dirname(inputPath);
const outputPath = args[1] || join(inputDir, `${inputBase}-ktx2.glb`);

// Ensure output directory exists
mkdirSync(dirname(outputPath), { recursive: true });

console.log(`[compress-glb-ktx2] Input:   ${inputPath}`);
console.log(`[compress-glb-ktx2] Output:  ${outputPath}`);
console.log(`[compress-glb-ktx2] Quality: ${quality.toUpperCase()}`);
console.log();

// gltf-transform texture compression command
// --slots baseColor,normal,occlusionRoughnessMetallic,emissive covers all standard PBR maps
const slots = "**";

let cmd;
if (quality === "uastc") {
  // UASTC: higher quality, supports HDR-like detail, ~4× VRAM reduction
  cmd = `npx @gltf-transform/cli uastc \
    --level 2 \
    --rdo \
    --rdo-lambda 1.5 \
    --zstd 18 \
    --slots "${slots}" \
    "${inputPath}" "${outputPath}"`;
} else {
  // ETC1S: maximum compression, ~8× VRAM reduction, slightly lower quality
  cmd = `npx @gltf-transform/cli etc1s \
    --quality 128 \
    --slots "${slots}" \
    "${inputPath}" "${outputPath}"`;
}

console.log("[compress-glb-ktx2] Running:", cmd);
console.log();

try {
  execSync(cmd, { stdio: "inherit" });

  console.log();
  console.log("✅ Conversion complete!");
  console.log(`   Output: ${outputPath}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Update your model path to point to the new -ktx2.glb file.");
  console.log("  2. The Three.js KTX2Loader (already configured in SceneManager) will");
  console.log("     automatically transcode textures to the best GPU format per device.");
  console.log("  3. Verify visually — UASTC is near-lossless, ETC1S may show subtle banding.");
  console.log();
  console.log("Memory impact (approximate for 4096×4096, 6 textures):");
  console.log("  PNG/JPEG in VRAM : ~384 MB");
  console.log("  KTX2 UASTC       : ~96 MB  (4× reduction)");
  console.log("  KTX2 ETC1S       : ~48 MB  (8× reduction)");
} catch (err) {
  console.error();
  console.error("[compress-glb-ktx2] Conversion failed.");
  if (err.message?.includes("cannot find module") || err.message?.includes("not found")) {
    console.error("  Missing dependencies. Run:");
    console.error("    npm install --save-dev @gltf-transform/cli @gltf-transform/extensions sharp");
  }
  process.exit(1);
}
