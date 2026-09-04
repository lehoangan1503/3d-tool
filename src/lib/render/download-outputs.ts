/**
 * Bundling render output into a zip the operator can actually keep.
 *
 * Unlike the bulk tabs, which already hold their blobs in memory, these files
 * live in Supabase Storage — so every download starts with a fetch. That is the
 * whole reason this exists as a shared helper: doing it per card and again for
 * "download everything" would otherwise mean two copies of the same
 * fetch-then-zip dance drifting apart.
 *
 * Files are fetched with limited concurrency. A 6-image job is ~12MB and a
 * video batch is far more; firing every request at once makes the browser
 * queue them anyway while spiking memory, and a failed middle file would be
 * harder to attribute.
 */

import JSZip from "jszip";
import {
  downloadableSections,
  type ProductRenderGroup,
} from "@/lib/render/group-jobs";
import type { RenderJob, RenderJobOutput } from "@/types/render-job";

/** Parallel fetches. Enough to hide latency, low enough to stay predictable. */
const FETCH_CONCURRENCY = 4;

/** Storage keys and file names must survive Windows, macOS and zip tooling. */
function safeName(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "render"
  );
}

/** Extension implied by the stored path, falling back to the content type. */
function extensionFor(output: RenderJobOutput): string {
  const fromPath = output.storagePath?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  const fromType = output.contentType?.split("/")[1];
  return (fromType ?? "bin").replace("jpeg", "jpg");
}

export interface DownloadProgress {
  done: number;
  total: number;
}

/** Runs `task` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking immediately can cancel the download in some browsers; one tick is
  // enough for the click to have been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads one output under its reference name rather than the storage key. */
export async function downloadOutput(output: RenderJobOutput): Promise<void> {
  const res = await fetch(output.url);
  if (!res.ok) throw new Error(`Tải ${output.name} thất bại (${res.status})`);
  triggerDownload(await res.blob(), `${safeName(output.name)}.${extensionFor(output)}`);
}

/**
 * Zips one job's outputs.
 *
 * Named after the product, because that is what the operator is looking for
 * later — the job id means nothing to them.
 */
export async function downloadJobAsZip(
  job: RenderJob,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const outputs = job.outputs.filter((o) => o.url);
  if (outputs.length === 0) return;

  const zip = new JSZip();
  let done = 0;

  await mapLimit(outputs, FETCH_CONCURRENCY, async (output) => {
    const res = await fetch(output.url);
    if (!res.ok) throw new Error(`Tải ${output.name} thất bại (${res.status})`);
    zip.file(`${safeName(output.name)}.${extensionFor(output)}`, await res.blob());
    onProgress?.({ done: ++done, total: outputs.length });
  });

  const label = safeName(job.productName ?? job.productId ?? "render");
  triggerDownload(
    await zip.generateAsync({ type: "blob" }),
    `${label}_${job.kind === "video" ? "videos" : "mockups"}.zip`
  );
}

/**
 * Zips one product's whole render output, one folder per section.
 *
 * The folder rule is the point of this function. A product card merges several
 * jobs (two image groups and a video template, say), and dropping 20 files into
 * one flat zip would leave the operator sorting "which of these came from
 * Mockup-Web and which from Gallery" by hand — the exact busywork the merged
 * card would otherwise create. So each section keeps its own directory, named
 * after the image group or video template that produced it.
 *
 * Two sections can share a name (the same group rendered twice, or a group and
 * a template named alike), so folders are de-duplicated with a numeric suffix.
 * Without it JSZip silently merges them and the second render overwrites the
 * first — a data loss that looks like a successful download.
 */
export async function downloadProductGroupAsZip(
  group: ProductRenderGroup,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const sections = downloadableSections(group);
  const entries = sections.flatMap((section) =>
    section.job.outputs.filter((o) => o.url).map((output) => ({ section, output }))
  );
  if (entries.length === 0) return;

  const zip = new JSZip();
  const folderNames = new Map<string, string>();
  const used = new Set<string>();

  for (const section of sections) {
    const base = safeName(section.targetName) || (section.kind === "video" ? "video" : "images");
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    // Keyed by job id, not by target: the same group rendered twice is two
    // sections that must land in two folders.
    folderNames.set(section.job.id, name);
  }

  let done = 0;

  await mapLimit(entries, FETCH_CONCURRENCY, async ({ section, output }) => {
    const res = await fetch(output.url);
    if (!res.ok) throw new Error(`Tải ${output.name} thất bại (${res.status})`);
    const folder = folderNames.get(section.job.id) ?? "render";
    zip.file(
      `${folder}/${safeName(output.name)}.${extensionFor(output)}`,
      await res.blob()
    );
    onProgress?.({ done: ++done, total: entries.length });
  });

  const label = safeName(group.productName ?? group.productId ?? "render");
  triggerDownload(await zip.generateAsync({ type: "blob" }), `${label}.zip`);
}

/**
 * Zips every product on screen: one folder per product, one sub-folder per
 * section inside it.
 *
 * Same folder rule as the single-product zip, one level deeper — "tải tất cả"
 * across a batch must not flatten two products' Mockup-Web-1.png onto each
 * other, nor merge two groups of the same product.
 */
export async function downloadProductGroupsAsZip(
  groups: ProductRenderGroup[],
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  interface ZipEntry {
    path: string;
    output: RenderJobOutput;
  }

  const entries: ZipEntry[] = [];
  const usedProducts = new Set<string>();

  for (const group of groups) {
    const sections = downloadableSections(group);
    if (sections.length === 0) continue;

    const productBase = safeName(group.productName ?? group.productId ?? "render");
    let productFolder = productBase;
    let pn = 2;
    while (usedProducts.has(productFolder)) productFolder = `${productBase}_${pn++}`;
    usedProducts.add(productFolder);

    const usedSections = new Set<string>();
    for (const section of sections) {
      const base =
        safeName(section.targetName) || (section.kind === "video" ? "video" : "images");
      let sectionFolder = base;
      let sn = 2;
      while (usedSections.has(sectionFolder)) sectionFolder = `${base}_${sn++}`;
      usedSections.add(sectionFolder);

      for (const output of section.job.outputs) {
        if (!output.url) continue;
        entries.push({
          path: `${productFolder}/${sectionFolder}/${safeName(output.name)}.${extensionFor(output)}`,
          output,
        });
      }
    }
  }

  if (entries.length === 0) return;

  const zip = new JSZip();
  let done = 0;

  await mapLimit(entries, FETCH_CONCURRENCY, async ({ path, output }) => {
    const res = await fetch(output.url);
    if (!res.ok) throw new Error(`Tải ${output.name} thất bại (${res.status})`);
    zip.file(path, await res.blob());
    onProgress?.({ done: ++done, total: entries.length });
  });

  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(await zip.generateAsync({ type: "blob" }), `renders_${stamp}.zip`);
}
