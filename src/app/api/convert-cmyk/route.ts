import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/convert-cmyk
 *
 * Accepts a CMYK JPEG via multipart/form-data and returns a sRGB PNG.
 * Sharp uses LittleCMS with the embedded ICC profile for accurate color
 * mapping — avoids the sRGB-gamut clipping that happens in Canvas 2D.
 *
 * Body: FormData { file: File (image/jpeg) }
 * Response: image/png binary
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
    // converts to sRGB using relative-colorimetric + BPC — no gamut clipping.
    const pngBuffer = await sharp(buffer).toColorspace("srgb").png().toBuffer();

    return new Response(pngBuffer.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(pngBuffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[convert-cmyk] error:", err);
    return NextResponse.json({ error: "Conversion failed" }, { status: 500 });
  }
}
