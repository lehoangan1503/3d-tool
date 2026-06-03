#!/usr/bin/env node
/**
 * decode-ktx2-to-png.mjs
 *
 * Reverse of compress-glb-ktx2.mjs: takes a GLB whose textures are KTX2 /
 * Basis Universal and writes a NEW GLB whose textures are plain PNG, so it can
 * be opened in a Blender build that lacks the KHR_texture_basisu extension.
 *
 * The input file is only READ — it is never modified. Output goes to a separate
 * path (default: <input without -ktx2>-decoded.glb).
 *
 * How it works:
 *   1. Read the GLB with @gltf-transform/core + KHRTextureBasisu extension.
 *   2. For every KTX2 texture, dump the raw .ktx2 bytes to a temp file.
 *   3. Use the system `ktx extract --transcode rgba8` tool to decode it to PNG.
 *   4. Replace the texture's image with the PNG bytes and set mimeType image/png.
 *   5. Remove the basisu extension and write a plain GLB.
 *
 * Usage:
 *   node scripts/decode-ktx2-to-png.mjs <input-ktx2.glb> [output.glb]
 *
 * Requires the KTX-Software `ktx` CLI on PATH (v4.x).
 */

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/decode-ktx2-to-png.mjs <input-ktx2.glb> [output.glb]");
  process.exit(1);
}
if (!existsSync(inputPath)) {
  console.error(`[decode-ktx2] Input not found: ${inputPath}`);
  process.exit(1);
}

const inBase = basename(inputPath, ".glb").replace(/-ktx2$/, "");
const outputPath = process.argv[3] || join(dirname(inputPath), `${inBase}-decoded.glb`);

console.log(`[decode-ktx2] Input (read-only): ${inputPath}`);
console.log(`[decode-ktx2] Output:            ${outputPath}`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inputPath);

const tmp = mkdtempSync(join(tmpdir(), "ktx2decode-"));
let decoded = 0;
let skipped = 0;

try {
  const textures = doc.getRoot().listTextures();
  console.log(`[decode-ktx2] Found ${textures.length} textures.`);

  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const mime = tex.getMimeType();
    const image = tex.getImage();
    if (!image) { skipped++; continue; }

    if (mime !== "image/ktx2") {
      // Already a plain image — leave it.
      skipped++;
      continue;
    }

    const ktxFile = join(tmp, `tex_${i}.ktx2`);
    const pngFile = join(tmp, `tex_${i}.png`);
    writeFileSync(ktxFile, Buffer.from(image));

    // Decode KTX2 → PNG. Transcode to rgba8 so any Basis (ETC1S/UASTC) input
    // becomes uncompressed RGBA that `ktx extract` can write as PNG.
    execFileSync("ktx", ["extract", "--transcode", "rgba8", "--level", "0", ktxFile, pngFile], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    const png = readFileSync(pngFile);
    tex.setImage(new Uint8Array(png));
    tex.setMimeType("image/png");
    // Drop any KTX2-specific URI extension on the texture.
    decoded++;
    const label = tex.getName() || `texture_${i}`;
    console.log(`  ✓ ${label}: ktx2 → png (${png.length} bytes)`);
  }

  // Remove the basisu extension so the output is a plain GLB.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === KHRTextureBasisu.EXTENSION_NAME) ext.dispose();
  }

  await io.write(outputPath, doc);
  console.log();
  console.log(`✅ Done. Decoded ${decoded} texture(s), skipped ${skipped}.`);
  console.log(`   Open in Blender: ${outputPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
