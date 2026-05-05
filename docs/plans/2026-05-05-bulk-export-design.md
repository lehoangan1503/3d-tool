# Bulk Export ("Tải xuống nhiều") Design

## Problem

Users manage many products on the dashboard. Currently export (image/video) is only
available one product at a time inside the product editor. Users need to batch-export
multiple products with the same template, without opening each product individually.

## Approach

Add a **"Tải xuống nhiều"** button to the dashboard toolbar (visible when ≥1 product
is selected). Opens a modal dialog with two tabs: **Ảnh** and **Video**. Each tab
runs a sequential queue — one product at a time — to keep GPU/memory pressure low.
Results appear incrementally. A "Download all as ZIP" button activates when the
queue finishes.

---

## Architecture

### Entry point

`ProductsGrid` toolbar: when `selectedIds.size > 0`, show "Tải xuống nhiều" button
(alongside the existing "Clone N sản phẩm" button). Button opens `BulkExportDialog`
and passes `selectedProducts` array.

### Product model loading

For each product in the queue, bulk export needs a Three.js model group. The pattern:
1. Create a tiny off-screen `<canvas>` (1×1)
2. Create a `SceneManager` on it
3. `await sm.loadModel(MODEL_PATHS[product.type])`
4. `await sm.applySurface({ surfaceUrl, color, textureType })`
5. `const model = sm.getModelForClone()`
6. `esm.setModel(model)` on the shared `ExtractorSceneManager`
7. Dispose `sm` + remove canvas

This is encapsulated in a new utility:
`src/lib/three/load-product-for-esm.ts` → `loadProductIntoEsm(product, esm)`

### Image export

- Reuses `renderCueFrameViaStudio()` from `image-extractor.tsx` (export the function)
- For each product × each reference in the selected group → one PNG blob
- Result naming: `{productName}_{referenceName}.png`

### Video recording

- Reuses `esm.startStudioRecording(config, onProgress)` from `ExtractorSceneManager`
- Template config applied to each product in turn
- Result naming: `{productName}_{templateName}.webm`

### Queue state per item

```ts
type BulkItemStatus = 'pending' | 'in_progress' | 'done' | 'failed';

interface BulkItem {
  product: Product;
  status: BulkItemStatus;
  progress?: number;          // 0–1, only when in_progress
  blobs?: { name: string; blob: Blob }[]; // result files
  error?: string;
}
```

Queue is a simple async `for` loop inside a `useCallback`; a `cancelledRef` allows
the user to abort mid-queue.

---

## Image Tab UI

1. **Reference group selector** — Groups dropdown (fetches `/api/extractor-reference-groups`)
2. **Product list** — selected products as rows, each with status badge
3. **"Xuất ảnh"** button — disabled until a group is selected
4. Progress: overall `3/10 sản phẩm hoàn thành` bar + per-product spinner → thumbnail grid
5. Each finished product shows its per-reference download links
6. **"Tải tất cả (.zip)"** button activates when queue is done

---

## Video Tab UI

1. **Template selector** — reuses `StudioTemplateSelector` (only templates with
   `cameraStart` + `cameraEnd` set are ready for recording)
2. **Product queue** — selected products as ordered rows with status badges
3. **"Bắt đầu ghi"** — disabled until a template with camera positions is selected
4. Progress: per-product recording progress bar (same `onProgress` callback)
   + overall `2/5 video hoàn thành` counter
5. Each finished product shows a video thumbnail + download link
6. **"Tải tất cả (.zip)"** button activates when queue is done

---

## Files

| Action   | File |
|----------|------|
| NEW      | `src/lib/three/load-product-for-esm.ts` |
| MODIFY   | `src/components/editor/image-extractor.tsx` — export `renderCueFrameViaStudio` |
| NEW      | `src/components/products/bulk-export-dialog.tsx` |
| NEW      | `src/components/products/bulk-image-tab.tsx` |
| NEW      | `src/components/products/bulk-video-tab.tsx` |
| MODIFY   | `src/components/products/products-grid.tsx` — add toolbar button + dialog |

---

## Out of scope

- Multiple templates per product (YAGNI)
- Background server-side rendering
- Progress persistence across page reload
