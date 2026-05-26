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
 * Converts an image to sRGB PNG by drawing it through the Canvas 2D API.
 *
 * The browser decodes CMYK JPEGs using their embedded ICC profiles during
 * drawImage(), and canvas always exports sRGB. PNG output is lossless so
 * no color information is discarded after the ICC-profile conversion.
 *
 * @param originalName  - Source file name; used to derive output name (_rgb.png)
 * @param srcBlobUrl    - Object URL pointing to the source file
 * @returns New sRGB PNG File and its Object URL
 * @important The caller is responsible for revoking the returned `url` via
 *   `URL.revokeObjectURL(url)` when it is no longer needed, to avoid memory leaks.
 */
export async function convertCmykToRgb(
  originalName: string,
  srcBlobUrl: string,
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

      // PNG = lossless; preserves all color detail from the ICC-profile decode
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("canvas.toBlob failed"));
            return;
          }
          const baseName = originalName.replace(/\.[^.]+$/, "");
          const rgbFile = new File([blob], `${baseName}_rgb.png`, {
            type: "image/png",
          });
          resolve({ file: rgbFile, url: URL.createObjectURL(blob) });
        },
        "image/png",
      );
    };

    img.onerror = () =>
      reject(new Error("Failed to load image for RGB conversion"));
    img.src = srcBlobUrl;
  });
}
