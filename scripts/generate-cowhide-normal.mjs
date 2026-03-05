/**
 * Generate Cowhide Normal Map from Reference Texture
 * 
 * This script creates a normal map with pronounced pebble grain
 * that mimics real cowhide leather texture.
 * 
 * Usage: node scripts/generate-cowhide-normal.mjs
 */

import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_PATH = path.join(__dirname, '../public/textures/leathers/type2/leather-texture.webp');
const OUTPUT_PATH = path.join(__dirname, '../public/textures/leathers/type2/cowhide-normal.png');
const OUTPUT_SIZE = 1024; // Output resolution
const GRAIN_SCALE = 16; // Scale factor to make grain MUCH larger (like crocodile)

/**
 * Convert grayscale height map to normal map
 * Uses Sobel operator to calculate gradients
 */
function heightToNormal(heightData, width, height, strength = 2.0) {
  const normalData = new Uint8ClampedArray(width * height * 4);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      // Sample neighbors (with wrapping for tileable textures)
      const getHeight = (px, py) => {
        const wx = (px + width) % width;
        const wy = (py + height) % height;
        return heightData[wy * width + wx];
      };
      
      // Sobel operator for gradient calculation
      const tl = getHeight(x - 1, y - 1);
      const t  = getHeight(x,     y - 1);
      const tr = getHeight(x + 1, y - 1);
      const l  = getHeight(x - 1, y);
      const r  = getHeight(x + 1, y);
      const bl = getHeight(x - 1, y + 1);
      const b  = getHeight(x,     y + 1);
      const br = getHeight(x + 1, y + 1);
      
      // Calculate gradients (Sobel)
      const dX = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
      const dY = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
      
      // Create normal vector
      let nx = -dX * strength / 255.0;
      let ny = -dY * strength / 255.0;
      let nz = 1.0;
      
      // Normalize
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;
      
      // Convert to RGB (0-255 range)
      // Normal maps: R = X (-1 to 1 -> 0 to 255)
      //              G = Y (-1 to 1 -> 0 to 255)
      //              B = Z (0 to 1 -> 128 to 255, typically 255 for flat)
      const outIdx = idx * 4;
      normalData[outIdx]     = Math.round((nx + 1.0) * 0.5 * 255); // R
      normalData[outIdx + 1] = Math.round((ny + 1.0) * 0.5 * 255); // G  
      normalData[outIdx + 2] = Math.round((nz + 1.0) * 0.5 * 255); // B
      normalData[outIdx + 3] = 255; // A
    }
  }
  
  return normalData;
}

/**
 * Enhance the bump effect by processing the height map
 */
function enhanceHeightMap(data, width, height) {
  const enhanced = new Uint8ClampedArray(data.length);
  
  // Apply histogram equalization for better contrast
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) {
    histogram[data[i]]++;
  }
  
  // Calculate CDF
  const cdf = new Array(256);
  cdf[0] = histogram[0];
  for (let i = 1; i < 256; i++) {
    cdf[i] = cdf[i - 1] + histogram[i];
  }
  
  // Normalize CDF
  const cdfMin = cdf.find(v => v > 0);
  const total = width * height;
  
  for (let i = 0; i < data.length; i++) {
    enhanced[i] = Math.round(((cdf[data[i]] - cdfMin) / (total - cdfMin)) * 255);
  }
  
  return enhanced;
}

/**
 * Apply edge enhancement to make grain more pronounced
 */
function enhanceEdges(data, width, height, amount = 0.5) {
  const enhanced = new Uint8ClampedArray(data.length);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      // Get neighbors
      const getVal = (px, py) => {
        const wx = Math.max(0, Math.min(width - 1, px));
        const wy = Math.max(0, Math.min(height - 1, py));
        return data[wy * width + wx];
      };
      
      // Laplacian kernel for edge detection
      const center = data[idx];
      const neighbors = 
        getVal(x-1, y-1) + getVal(x, y-1) + getVal(x+1, y-1) +
        getVal(x-1, y)   +                  getVal(x+1, y) +
        getVal(x-1, y+1) + getVal(x, y+1) + getVal(x+1, y+1);
      
      const laplacian = center * 8 - neighbors;
      
      // Sharpen by adding edge information
      let sharpened = center + laplacian * amount;
      enhanced[idx] = Math.max(0, Math.min(255, Math.round(sharpened)));
    }
  }
  
  return enhanced;
}

async function main() {
  console.log('🎨 Generating Cowhide Normal Map...\n');
  
  // Check if input exists
  try {
    await fs.access(INPUT_PATH);
  } catch {
    console.error(`❌ Input file not found: ${INPUT_PATH}`);
    process.exit(1);
  }
  
  console.log(`📖 Reading: ${path.basename(INPUT_PATH)}`);
  
  // Load and process the reference image
  const image = sharp(INPUT_PATH);
  const metadata = await image.metadata();
  console.log(`   Original size: ${metadata.width}x${metadata.height}`);
  
  // Calculate intermediate size (smaller = larger grain in final output)
  const intermediateSize = Math.floor(OUTPUT_SIZE / GRAIN_SCALE);
  console.log(`   Grain scale: ${GRAIN_SCALE}x (processing at ${intermediateSize}x${intermediateSize})`);
  
  // First, resize to smaller size to capture larger grain features
  const smallGrayscale = await image
    .resize(intermediateSize, intermediateSize, { fit: 'cover' })
    .grayscale()
    .raw()
    .toBuffer();
  
  console.log(`   Downscaled to: ${intermediateSize}x${intermediateSize} for larger grain`);
  
  // Convert buffer to array for processing at intermediate size
  let smallHeightData = new Uint8ClampedArray(smallGrayscale);
  
  // Step 1: Enhance contrast at smaller size
  console.log('   Enhancing contrast...');
  smallHeightData = enhanceHeightMap(smallHeightData, intermediateSize, intermediateSize);
  
  // Step 2: Enhance edges at smaller size
  console.log('   Enhancing edges...');
  smallHeightData = enhanceEdges(smallHeightData, intermediateSize, intermediateSize, 0.6);
  
  // Step 3: Invert for proper bump direction
  console.log('   Inverting for correct bump direction...');
  for (let i = 0; i < smallHeightData.length; i++) {
    smallHeightData[i] = 255 - smallHeightData[i];
  }
  
  // Step 4: Scale up the height map to output size (this makes grain bigger)
  console.log(`   Upscaling height map to ${OUTPUT_SIZE}x${OUTPUT_SIZE}...`);
  const upscaledBuffer = await sharp(Buffer.from(smallHeightData), {
    raw: {
      width: intermediateSize,
      height: intermediateSize,
      channels: 1
    }
  })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { 
      kernel: 'cubic'  // Smooth interpolation for organic look
    })
    .raw()
    .toBuffer();
  
  const heightData = new Uint8ClampedArray(upscaledBuffer);
  
  // Step 5: Convert to normal map with stronger effect for larger grain
  console.log('   Generating normal map (strength: 6.0)...');
  const normalData = heightToNormal(heightData, OUTPUT_SIZE, OUTPUT_SIZE, 6.0);
  
  // Step 6: Save as PNG
  console.log(`💾 Saving: ${path.basename(OUTPUT_PATH)}`);
  
  await sharp(Buffer.from(normalData), {
    raw: {
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      channels: 4
    }
  })
    .png({ compressionLevel: 9 })
    .toFile(OUTPUT_PATH);
  
  const stats = await fs.stat(OUTPUT_PATH);
  console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB\n`);
  
  console.log('✅ Done! Normal map generated at:');
  console.log(`   ${OUTPUT_PATH}\n`);
  console.log('📝 Update LEATHER_TEXTURE_TYPES in leather-config.ts to use:');
  console.log('   "/textures/leathers/type2/cowhide-normal.png"');
}

main().catch(console.error);
