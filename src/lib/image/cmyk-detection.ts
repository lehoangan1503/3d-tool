// src/lib/image/cmyk-detection.ts

/**
 * Detects if a JPEG file uses CMYK (or YCCK) color space by reading the
 * SOF (Start of Frame) marker in the raw JPEG byte stream.
 *
 * A JPEG SOF with 4 components is CMYK/YCCK; 3 components is YCbCr/RGB.
 * PNG and WebP never use CMYK, so those always return false.
 *
 * Only reads the first 64 KB — the SOF marker is always near the file start.
 */
export async function detectCmykJpeg(file: File): Promise<boolean> {
  if (!file.type.includes("jpeg") && !file.type.includes("jpg")) return false;

  const buffer = await file.slice(0, 65536).arrayBuffer();
  const view = new DataView(buffer);

  // Must start with JPEG SOI marker 0xFF 0xD8
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return false;

  let offset = 2;
  while (offset + 3 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);

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
      if (offset + 9 >= view.byteLength) break;
      return view.getUint8(offset + 9) === 4; // 4 = CMYK or YCCK
    }

    // Advance past this segment: marker(2) + segment body (segLen includes the 2-byte length field)
    const segLen = view.getUint16(offset + 2);
    if (segLen < 2) break; // malformed
    offset += 2 + segLen;
  }

  return false;
}

/**
 * Converts an image to sRGB JPEG by drawing it through the Canvas 2D API.
 *
 * The browser decodes CMYK JPEGs using their embedded ICC profiles during
 * drawImage(), and canvas always exports sRGB. This is the standard
 * browser-side CMYK → RGB conversion path.
 *
 * @param originalName  - Source file name; used to derive output name (_rgb.jpg)
 * @param srcBlobUrl    - Object URL pointing to the source file
 * @param quality       - JPEG quality 0–1 (default 0.95)
 * @returns New sRGB JPEG File and its Object URL
 * @important The caller is responsible for revoking the returned `url` via
 *   `URL.revokeObjectURL(url)` when it is no longer needed, to avoid memory leaks.
 */
export async function convertCmykToRgb(
  originalName: string,
  srcBlobUrl: string,
  quality = 0.95,
): Promise<{ file: File; url: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }

      ctx.drawImage(img, 0, 0);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("canvas.toBlob failed"));
            return;
          }
          const baseName = originalName.replace(/\.[^.]+$/, "");
          const rgbFile = new File([blob], `${baseName}_rgb.jpg`, {
            type: "image/jpeg",
          });
          resolve({ file: rgbFile, url: URL.createObjectURL(blob) });
        },
        "image/jpeg",
        quality,
      );
    };

    img.onerror = () =>
      reject(new Error("Failed to load image for RGB conversion"));
    img.src = srcBlobUrl;
  });
}
