// src/lib/image/cmyk-detection.ts

/**
 * Detects if a JPEG file uses CMYK (or YCCK) color space by reading the
 * SOF (Start of Frame) marker in the raw JPEG byte stream.
 *
 * A JPEG SOF with 4 components is CMYK/YCCK; 3 components is YCbCr/RGB.
 * PNG and WebP never use CMYK, so those always return false.
 *
 * Reads segment headers lazily (4 bytes at a time) so that large embedded
 * ICC profiles — which can push the SOF marker past 2+ MB — are skipped
 * without loading the entire file into memory.
 */
export async function detectCmykJpeg(file: File): Promise<boolean> {
  if (!file.type.includes("jpeg") && !file.type.includes("jpg")) return false;

  // Verify SOI marker
  const soi = await file.slice(0, 4).arrayBuffer();
  const soiView = new DataView(soi);
  if (soiView.byteLength < 4 || soiView.getUint16(0) !== 0xffd8) return false;

  let offset = 2;
  // Cap at 1000 iterations to guard against malformed files
  for (let i = 0; i < 1000 && offset + 4 <= file.size; i++) {
    // Read just the segment header: marker(2) + length(2)
    const hdr = await file.slice(offset, offset + 4).arrayBuffer();
    const hdrView = new DataView(hdr);

    if (hdrView.getUint8(0) !== 0xff) break;
    const marker = hdrView.getUint8(1);

    // EOI (end of image) or SOS (start of scan) — stop
    if (marker === 0xd9 || marker === 0xda) break;

    // SOF markers: C0–C3, C5–C7, C9–CB, CD–CF
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSOF) {
      // SOF layout: marker(2) + length(2) + precision(1) + height(2) + width(2) + nComponents(1)
      // nComponents is at byte offset +9 from the marker start
      const sof = await file.slice(offset, offset + 10).arrayBuffer();
      return new DataView(sof).getUint8(9) === 4; // 4 = CMYK or YCCK
    }

    // Advance past this segment: marker(2) + segment body (segLen includes the 2-byte length field)
    const segLen = hdrView.getUint16(2);
    if (segLen < 2) break; // malformed
    offset += 2 + segLen;
  }

  return false;
}

/**
 * Converts a CMYK JPEG to sRGB JPEG using the server-side sharp/LittleCMS
 * pipeline (/api/convert-cmyk).
 *
 * Canvas 2D clips CMYK wide-gamut colors to sRGB. Sharp uses the embedded
 * ICC profile to produce perceptually accurate sRGB output with no clipping.
 * JPEG output (quality 95, 4:4:4 chroma) keeps file sizes similar to or
 * smaller than the original CMYK JPEG (3 channels vs 4).
 *
 * @param originalName  - Source file name; used to derive output name (_rgb.jpg)
 * @param srcBlobUrl    - Object URL pointing to the source CMYK JPEG
 * @returns New sRGB JPEG File and its Object URL
 * @important The caller is responsible for revoking the returned `url` via
 *   `URL.revokeObjectURL(url)` when it is no longer needed, to avoid memory leaks.
 */
export async function convertCmykToRgb(
  originalName: string,
  srcBlobUrl: string,
): Promise<{ file: File; url: string }> {
  const sourceBlob = await fetch(srcBlobUrl).then((r) => r.blob());

  const formData = new FormData();
  formData.append("file", sourceBlob, originalName);

  const response = await fetch("/api/convert-cmyk", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`CMYK conversion failed (HTTP ${response.status})`);
  }

  const jpegBlob = await response.blob();
  const baseName = originalName.replace(/\.[^.]+$/, "");
  const rgbFile = new File([jpegBlob], `${baseName}_rgb.jpg`, {
    type: "image/jpeg",
  });

  return { file: rgbFile, url: URL.createObjectURL(jpegBlob) };
}
