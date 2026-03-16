import { NextResponse } from "next/server";
import path from "path";
import { readdir } from "fs/promises";

function toLabel(fileName: string) {
  const base = fileName.replace(/\.(hdr|exr)$/i, "");
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET() {
  try {
    const dir = path.join(process.cwd(), "public", "hdri");
    const entries = await readdir(dir);

    const files = entries.filter((f) => /\.(hdr|exr)$/i.test(f)).sort((a, b) => a.localeCompare(b));

    const options = files.map((file) => ({
      id: file,
      file,
      path: `/hdri/${encodeURIComponent(file)}`,
      label: toLabel(file),
    }));

    return NextResponse.json({ options });
  } catch (error) {
    console.error("[api/hdri] Failed to list HDRIs:", error);
    return NextResponse.json({ options: [] }, { status: 200 });
  }
}
