import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/convert-cmyk
 *
 * Accepts a CMYK JPEG via multipart/form-data and returns an sRGB JPEG.
 * Sharp uses LittleCMS with the embedded ICC profile for accurate color
 * mapping — avoids the sRGB-gamut clipping that happens in Canvas 2D.
 * JPEG output at quality 95 produces files equal to or smaller than the
 * original CMYK JPEG (3 channels vs 4).
 *
 * Body: FormData { file: File (image/jpeg) }
 * Response: image/jpeg binary
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // sharp/libvips reads the embedded CMYK ICC profile via LittleCMS and
    // converts to sRGB — no gamut hard-clipping like Canvas 2D.
    // chromaSubsampling 4:4:4 preserves fine colour detail at full chroma.
    const jpegBuffer = await sharp(buffer)
      .toColorspace("srgb")
      .withMetadata() // preserve EXIF (rotation, copyright); ICC updated to sRGB
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
      .toBuffer();

    return new Response(jpegBuffer.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpegBuffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[convert-cmyk] error:", err);
    return NextResponse.json({ error: "Conversion failed" }, { status: 500 });
  }
}
