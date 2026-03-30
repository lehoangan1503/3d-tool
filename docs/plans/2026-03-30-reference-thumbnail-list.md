# Reference Thumbnail List Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace color-card layout previews with real rendered PNG thumbnails in both the Download Multiple dialog and the Load Reference panel, with search and infinite scroll.

**Architecture:** Add pagination+search to the API; build a shared `useReferenceList` hook for fetch/pagination/search; build a shared `ReferenceThumbnailGrid` component that renders thumbnails in a capped concurrency pool (3 at a time) and frees GPU memory after each render; wire both dialogs to use it.

**Tech Stack:** Next.js API route (query params), React hooks (IntersectionObserver for scroll, useCallback, useRef), existing `onRenderReference: (ref) => Promise<Blob>` callback, existing `ExtractorReference` types.

---

## Task 1: API — add pagination + search to GET /api/extractor-references

**Files:**
- Modify: `src/app/api/extractor-references/route.ts`

The current GET returns ALL references with no filtering. Add `limit`, `offset`, `search` query params.

**Step 1: Update GET handler**

Replace the current `.order(...)` chain with:

```typescript
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "20", 10), 50);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0",  10), 0);
    const search = (searchParams.get("search") ?? "").trim();

    let query = supabase
      .from("extractor_references")
      .select(`id, name, created_at, updated_at,
        extractor_frames (
          id, frame_order, frame_type,
          pos_x, pos_y, width, height, rotation,
          cue_orbit_x, cue_orbit_y, cue_zoom,
          cue_offset_x, cue_offset_y,
          light_angle, hdri_layers, image_settings
        )`, { count: "exact" })
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data: references, error, count } = await query;

    if (error) {
      console.error("Fetch references error:", error);
      return NextResponse.json({ error: "Failed to fetch references" }, { status: 500 });
    }

    // ... existing transform logic unchanged ...

    return NextResponse.json({ items: result, total: count ?? 0 });
  } catch (error) {
    console.error("GET /api/extractor-references error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

> **Note:** The response shape changes from `ExtractorReference[]` to `{ items: ExtractorReference[], total: number }`. Every caller must be updated (Tasks 2, 3, 4).

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "extractor-references\|error TS"
```
Expected: errors pointing at old callers (we fix those next).

**Step 3: Commit**

```bash
git add src/app/api/extractor-references/route.ts
git commit -m "feat(api): add pagination and search to GET /api/extractor-references"
```

---

## Task 2: Shared hook — `useReferenceList`

**Files:**
- Create: `src/hooks/use-reference-list.ts`

This hook owns fetch, pagination, search debounce, and scroll sentinel logic. Both dialogs use it.

```typescript
// src/hooks/use-reference-list.ts
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ExtractorReference } from "@/types/extractor";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

export interface UseReferenceListOptions {
  enabled: boolean;       // only fetch when the panel/dialog is open
  pageSize?: number;
}

export interface UseReferenceListResult {
  references: ExtractorReference[];
  total: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  search: string;
  setSearch: (v: string) => void;
  loadMore: () => void;
  reload: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void; // attach to bottom sentinel div
}

export function useReferenceList({
  enabled,
  pageSize = PAGE_SIZE,
}: UseReferenceListOptions): UseReferenceListResult {
  const [references, setReferences] = useState<ExtractorReference[]>([]);
  const [total, setTotal]           = useState(0);
  const [isLoading, setIsLoading]   = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearchRaw]      = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const offsetRef = useRef(0);
  const observer  = useRef<IntersectionObserver | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, currentSearch: string, append: boolean) => {
      if (offset === 0) setIsLoading(true);
      else setIsFetchingMore(true);

      try {
        const params = new URLSearchParams({
          limit:  String(pageSize),
          offset: String(offset),
        });
        if (currentSearch) params.set("search", currentSearch);

        const res = await fetch(`/api/extractor-references?${params}`);
        if (!res.ok) throw new Error("Failed to fetch");

        const { items, total: t }: { items: ExtractorReference[]; total: number } =
          await res.json();

        setReferences((prev) => (append ? [...prev, ...items] : items));
        setTotal(t);
        offsetRef.current = offset + items.length;
      } catch (err) {
        console.error("useReferenceList fetch error:", err);
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    [pageSize]
  );

  // Initial load + search reset
  useEffect(() => {
    if (!enabled) return;
    offsetRef.current = 0;
    setReferences([]);
    fetchPage(0, debouncedSearch, false);
  }, [enabled, debouncedSearch, fetchPage]);

  const loadMore = useCallback(() => {
    if (isLoading || isFetchingMore) return;
    fetchPage(offsetRef.current, debouncedSearch, true);
  }, [isLoading, isFetchingMore, fetchPage, debouncedSearch]);

  const reload = useCallback(() => {
    offsetRef.current = 0;
    setReferences([]);
    fetchPage(0, debouncedSearch, false);
  }, [fetchPage, debouncedSearch]);

  // IntersectionObserver — auto-loadMore when sentinel enters viewport
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observer.current) observer.current.disconnect();
      if (!el) return;
      observer.current = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) loadMore(); },
        { threshold: 0.1 }
      );
      observer.current.observe(el);
    },
    [loadMore]
  );

  const hasMore = references.length < total;

  const setSearch = useCallback((v: string) => {
    setSearchRaw(v);
  }, []);

  return {
    references, total, isLoading, isFetchingMore, hasMore,
    search, setSearch,
    loadMore, reload, sentinelRef,
  };
}
```

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "use-reference-list\|error TS"
```

**Step 3: Commit**

```bash
git add src/hooks/use-reference-list.ts
git commit -m "feat: add useReferenceList hook with pagination, search, and IntersectionObserver scroll"
```

---

## Task 3: Shared rendering pool utility

**Files:**
- Create: `src/lib/render-pool.ts`

Limits concurrent GPU renders to avoid WebGL context loss.

```typescript
// src/lib/render-pool.ts

/**
 * Renders items in parallel up to `concurrency` at a time.
 * Calls `onDone(index, url)` after each item finishes so callers
 * can update UI progressively rather than waiting for all.
 * Disposes memory between renders — the render fn must not hold
 * references to WebGL resources after the Promise resolves.
 */
export async function renderPool<T>(
  items: T[],
  render: (item: T) => Promise<Blob>,
  onDone: (index: number, url: string) => void,
  concurrency = 3
): Promise<void> {
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      try {
        const blob = await render(item);
        const url  = URL.createObjectURL(blob);
        onDone(idx, url);
      } catch {
        // Silently ignore failed renders — item keeps SVG fallback
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
}
```

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "render-pool\|error TS"
```

**Step 3: Commit**

```bash
git add src/lib/render-pool.ts
git commit -m "feat: add renderPool concurrency utility for GPU-safe parallel thumbnail rendering"
```

---

## Task 4: Rewrite `download-multiple-dialog.tsx`

**Files:**
- Modify: `src/components/editor/download-multiple-dialog.tsx`

**What changes:**
- Remove ALL hover preview state and `schedulePreviewRender` / debounce logic
- Remove right-panel hover preview
- Use `useReferenceList` hook for fetching (search + infinite scroll)
- After load, render thumbnails via `renderPool` (concurrency 3)
- Store `thumbnails: Map<id, url>` in a ref (revoke on close)
- Make the list cards bigger (show 80px thumbnail image instead of 44px SVG)
- Add search input at top
- Remove `LayoutPreviewSvg` from the list items (keep as fallback only if render failed)

**New component structure:**

```tsx
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import JSZip from "jszip";
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button }   from "@/components/ui/button";
import { Input }    from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Loader2, Download, Image as ImageIcon, Search } from "lucide-react";
import type { ExtractorReference, ExtractorFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";
import { useReferenceList } from "@/hooks/use-reference-list";
import { renderPool }       from "@/lib/render-pool";

// Keep LayoutPreviewSvg as fallback (unchanged from original)
const PREVIEW_CANVAS = 2048;
function LayoutPreviewSvg(...) { ... }  // unchanged

interface DownloadMultipleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  onRenderReference: (reference: ExtractorReference) => Promise<Blob>;
}

export function DownloadMultipleDialog({
  open, onOpenChange, productId, onRenderReference,
}: DownloadMultipleDialogProps) {

  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting]   = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, status: "" });
  const [error, setError]               = useState<string | null>(null);

  // thumbnail url cache: id → objectURL
  const thumbnailUrls = useRef<Map<string, string>>(new Map());
  const [thumbnailVersion, setThumbnailVersion] = useState(0); // bump to re-render

  const { references, total, isLoading, isFetchingMore, hasMore,
          search, setSearch, reload, sentinelRef } =
    useReferenceList({ enabled: open });

  // Select-all when first page loads
  useEffect(() => {
    if (references.length > 0 && selectedIds.size === 0) {
      setSelectedIds(new Set(references.map((r) => r.id)));
    }
  }, [references]);

  // Render thumbnails for newly-arrived references
  useEffect(() => {
    if (references.length === 0) return;
    const unrendered = references.filter(
      (r) => !thumbnailUrls.current.has(r.id)
    );
    if (unrendered.length === 0) return;

    renderPool(
      unrendered,
      onRenderReference,
      (_idx, url) => {
        thumbnailUrls.current.set(unrendered[_idx].id, url);
        setThumbnailVersion((v) => v + 1); // trigger re-render
      },
      3 // max concurrent GPU renders
    );
  }, [references, onRenderReference]);

  // Revoke all blob URLs + reset state on close
  useEffect(() => {
    if (!open) {
      thumbnailUrls.current.forEach((url) => URL.revokeObjectURL(url));
      thumbnailUrls.current.clear();
      setThumbnailVersion(0);
      setSelectedIds(new Set());
      setExportProgress({ current: 0, total: 0, status: "" });
      setError(null);
    }
  }, [open]);

  // ... handleExport (unchanged logic, uses selectedIds + references) ...
  // ... handleToggle, handleSelectAll, handleDeselectAll (unchanged) ...

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>...</DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {/* List */}
        {isLoading && references.length === 0 ? (
          <Loader2 className="animate-spin mx-auto" />
        ) : references.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1 py-2">
            {references.map((ref) => {
              const thumbUrl = thumbnailUrls.current.get(ref.id);
              return (
                <label key={ref.id} className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-muted/50">
                  <Checkbox checked={selectedIds.has(ref.id)} onCheckedChange={() => handleToggle(ref.id)} />
                  {/* 80×80 thumbnail */}
                  <div className="flex-shrink-0 w-20 h-20 rounded overflow-hidden bg-[#111827]">
                    {thumbUrl ? (
                      <img src={thumbUrl} alt={ref.name} className="w-full h-full object-contain" />
                    ) : (
                      <LayoutPreviewSvg frames={ref.frames} size={80} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{ref.name}</div>
                    <div className="text-xs text-muted-foreground">{getFramesSummary(ref.frames)}</div>
                  </div>
                </label>
              );
            })}

            {/* Infinite scroll sentinel */}
            {hasMore && (
              <div ref={sentinelRef} className="py-2 flex justify-center">
                {isFetchingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="border-t pt-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground flex-1">
            {selectedIds.size} of {total} selected
          </span>
          <Button onClick={handleExport} disabled={isExporting || selectedIds.size === 0}>
            Export Selected ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "download-multiple\|error TS"
```

**Step 3: Commit**

```bash
git add src/components/editor/download-multiple-dialog.tsx
git commit -m "feat(download-dialog): thumbnail grid with parallel rendering, search, and infinite scroll"
```

---

## Task 5: Rewrite Load Reference panel in `frame-controls-panel.tsx`

**Files:**
- Modify: `src/components/editor/frame-controls-panel.tsx`
- Modify: `src/components/editor/image-extractor.tsx`

**What changes:**

### 5a — Add `onRenderReference` prop to `FrameControlsPanel`

Add to `FrameControlsPanelProps`:
```typescript
onRenderReference?: (reference: ExtractorReference) => Promise<Blob>;
```

In `image-extractor.tsx` where `<FrameControlsPanel>` is rendered (around line 658-660), add:
```tsx
onRenderReference={handleRenderReference}
```

### 5b — Replace `<Select>` with a thumbnail popover/sheet

Replace the simple `<Select>` reference dropdown (lines 197-219 of frame-controls-panel.tsx) with a button that opens a `<Popover>` (or inline expandable section) containing:

1. Search input
2. Scrollable thumbnail grid (same card style as download dialog: 80px thumbnail)
3. Infinite scroll sentinel
4. "New Layout" option at top

The popover uses `useReferenceList({ enabled: popoverOpen })` internally.
Thumbnails rendered via `renderPool` with concurrency 3, same pattern as Task 4.

**New reference selector UI:**

```tsx
// State inside FrameControlsPanel:
const [refPopoverOpen, setRefPopoverOpen] = useState(false);

// Thumbnail cache (lives as long as panel is mounted):
const refThumbnailUrls = useRef<Map<string, string>>(new Map());
const [refThumbVersion, setRefThumbVersion] = useState(0);

const {
  references, isLoading, isFetchingMore, hasMore,
  search, setSearch, sentinelRef,
} = useReferenceList({ enabled: refPopoverOpen });

// Render thumbnails for new references
useEffect(() => {
  if (!onRenderReference || references.length === 0) return;
  const unrendered = references.filter((r) => !refThumbnailUrls.current.has(r.id));
  if (!unrendered.length) return;
  renderPool(unrendered, onRenderReference, (_i, url) => {
    refThumbnailUrls.current.set(unrendered[_i].id, url);
    setRefThumbVersion((v) => v + 1);
  }, 3);
}, [references, onRenderReference]);

// Clear thumbnail cache when popover closes
useEffect(() => {
  if (!refPopoverOpen) {
    refThumbnailUrls.current.forEach((u) => URL.revokeObjectURL(u));
    refThumbnailUrls.current.clear();
    setRefThumbVersion(0);
  }
}, [refPopoverOpen]);
```

**JSX for the trigger + popover content:**

```tsx
<Popover open={refPopoverOpen} onOpenChange={setRefPopoverOpen}>
  <PopoverTrigger asChild>
    <Button variant="outline" className="w-full justify-between text-sm font-normal">
      <span className="truncate">{selectedRefName ?? "New Layout"}</span>
      <ChevronDown className="h-4 w-4 ml-2 flex-shrink-0" />
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-72 p-2 space-y-2" align="start">
    {/* Search */}
    <div className="relative">
      <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
      <Input value={search} onChange={(e) => setSearch(e.target.value)}
             placeholder="Search..." className="pl-7 h-8 text-sm" />
    </div>

    {/* New Layout option */}
    <button
      className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent"
      onClick={() => { onSelectReference(null); setRefPopoverOpen(false); }}
    >
      + New Layout
    </button>

    {/* Scrollable thumbnail list */}
    <div className="max-h-64 overflow-y-auto space-y-1">
      {isLoading && references.length === 0 ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto my-4" />
      ) : references.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">No references found</p>
      ) : (
        references.map((ref) => {
          const thumbUrl = refThumbnailUrls.current.get(ref.id);
          return (
            <button
              key={ref.id}
              className={`w-full flex items-center gap-2 p-1.5 rounded text-left hover:bg-accent ${
                selectedReferenceId === ref.id ? "bg-accent" : ""
              }`}
              onClick={() => { onSelectReference(ref.id); setRefPopoverOpen(false); }}
            >
              <div className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-[#111827]">
                {thumbUrl ? (
                  <img src={thumbUrl} alt={ref.name} className="w-full h-full object-contain" />
                ) : (
                  <LayoutPreviewSvg frames={ref.frames} size={48} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{ref.name}</div>
                <div className="text-xs text-muted-foreground">{ref.frames.length} frames</div>
              </div>
            </button>
          );
        })
      )}

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={sentinelRef} className="py-1 flex justify-center">
          {isFetchingMore && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
      )}
    </div>
  </PopoverContent>
</Popover>
```

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "frame-controls\|image-extractor\|error TS"
```

**Step 3: Commit**

```bash
git add src/components/editor/frame-controls-panel.tsx src/components/editor/image-extractor.tsx
git commit -m "feat(load-reference): thumbnail popover with search and infinite scroll"
```

---

## Task 6: Fix old `loadReferences` caller in `image-extractor.tsx`

**Files:**
- Modify: `src/components/editor/image-extractor.tsx`

The `loadReferences` function (line 132) still calls `/api/extractor-references` and expects `ExtractorReference[]`. Since the API now returns `{ items, total }`, this must be updated.

```typescript
const loadReferences = async () => {
  try {
    const res = await fetch("/api/extractor-references?limit=50");
    if (res.ok) {
      const { items } = await res.json();
      setReferences(items);
    }
  } catch (err) {
    console.error("Failed to load references:", err);
  }
};
```

> **Note:** This call is only used for the old rename/delete flow that passes the flat list to frame-controls-panel. With Task 5 done, `frame-controls-panel` manages its own list via the hook. Keep `loadReferences` for now only to refresh after save/rename/delete operations. Limit 50 is safe (only used to populate the rename/delete dropdown).

**Step 2: Also fix the `download-multiple-dialog`'s internal fetch** (it no longer calls the API directly — it uses `useReferenceList` — but verify no stale direct fetch remains).

**Step 3: Verify full type-check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: zero errors.

**Step 4: Commit**

```bash
git add src/components/editor/image-extractor.tsx
git commit -m "fix: update loadReferences to use paginated API response shape"
```

---

---

## Task 7: Dashboard — pagination, infinite scroll, sticky toolbar

**Files:**
- Modify: `src/app/api/products/route.ts`
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/components/products/products-grid.tsx`

### 7a — Add pagination + search + type-filter to GET /api/products

Current GET returns all products. Add `limit`, `offset`, `search`, `type` query params and `{ count: "exact" }`.

```typescript
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "20", 10), 50);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0",  10), 0);
    const search = (searchParams.get("search") ?? "").trim();
    const type   = searchParams.get("type") ?? "";   // "smooth" | "leather" | ""

    let query = supabase
      .from("products")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) query = query.ilike("name", `%${search}%`);
    if (type && ["smooth", "leather"].includes(type)) query = query.eq("type", type);

    const { data, error, count } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ items: data, total: count ?? 0 });
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

### 7b — Simplify `dashboard/page.tsx` (server component)

Remove the direct Supabase products fetch — `ProductsGrid` now fetches client-side. Keep only auth check and user metadata (if needed for `CreateProductDialog`).

```tsx
// src/app/dashboard/page.tsx
export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-background">
      <header>...</header>
      <main className="container mx-auto px-4 py-8">
        <ProductsGrid />
      </main>
    </div>
  );
}
```

### 7c — Rewrite `ProductsGrid` as client component with sticky toolbar + infinite scroll

**ProductsGrid becomes fully client-side:**

```tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Product } from "@/types/product";
import { Input }  from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, Plus } from "lucide-react";
import { ProductCard }          from "./product-card";
import { CreateProductDialog }  from "./create-product-dialog";

type TypeFilter = "all" | "smooth" | "leather";

const PAGE_SIZE = 20;

export function ProductsGrid() {
  const [products, setProducts]         = useState<Product[]>([]);
  const [total, setTotal]               = useState(0);
  const [isLoading, setIsLoading]       = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearchRaw]          = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter]     = useState<TypeFilter>("all");
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(async (
    offset: number, currentSearch: string, currentType: TypeFilter, append: boolean
  ) => {
    if (offset === 0) setIsLoading(true); else setIsFetchingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (currentSearch) params.set("search", currentSearch);
      if (currentType !== "all") params.set("type", currentType);

      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Failed");
      const { items, total: t }: { items: Product[]; total: number } = await res.json();

      setProducts(prev => append ? [...prev, ...items] : items);
      setTotal(t);
      offsetRef.current = offset + items.length;
    } finally {
      setIsLoading(false);
      setIsFetchingMore(false);
    }
  }, []);

  // Reset + refetch when search/filter changes
  useEffect(() => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, false);
  }, [debouncedSearch, typeFilter, fetchPage]);

  const hasMore = products.length < total;

  // IntersectionObserver sentinel
  const sentinelRef = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) observerRef.current.disconnect();
    if (!el) return;
    observerRef.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !isFetchingMore && hasMore) {
        fetchPage(offsetRef.current, debouncedSearch, typeFilter, true);
      }
    }, { threshold: 0.1 });
    observerRef.current.observe(el);
  }, [isFetchingMore, hasMore, fetchPage, debouncedSearch, typeFilter]);

  const handleProductCreated = () => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, false);
  };

  const handleProductDeleted = (id: string) => {
    setProducts(prev => prev.filter(p => p.id !== id));
    setTotal(prev => prev - 1);
  };

  return (
    <div>
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b pb-3 mb-6">
        <div className="flex items-center justify-between gap-3 pt-4">
          <h1 className="text-2xl font-bold shrink-0">My Products</h1>
          <CreateProductDialog onCreated={handleProductCreated} />
        </div>
        <div className="flex items-center gap-2 mt-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={search}
              onChange={e => setSearchRaw(e.target.value)}
              className="pl-8"
            />
          </div>
          {/* Type filter */}
          {(["all", "smooth", "leather"] as TypeFilter[]).map(f => (
            <Button
              key={f}
              variant={typeFilter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setTypeFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : products.length === 0 ? (
        <EmptyState search={debouncedSearch} typeFilter={typeFilter} onCreated={handleProductCreated} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map(product => (
              <ProductCard key={product.id} product={product} onDeleted={() => handleProductDeleted(product.id)} />
            ))}
          </div>

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={sentinelRef} className="py-8 flex justify-center">
              {isFetchingMore && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

**Notes for this task:**
- `CreateProductDialog` needs an `onCreated` callback prop — check if it already exists or add it.
- `ProductCard` may need an `onDeleted` prop — check current delete implementation. Currently delete is handled internally; may need to lift up or add a callback.
- The server component `dashboard/page.tsx` no longer passes `products` — remove that prop from `ProductsGrid`.
- Search and type filter are now server-side (API), not client-side filtering. Remove old `filteredProducts` useMemo.
- Keep existing empty state UI but adapt to handle both search-empty and fully-empty cases.

**Step 2: Verify type-check**

```bash
npx tsc --noEmit 2>&1 | grep "products\|dashboard\|error TS"
```

**Step 3: Commit**

```bash
git add src/app/api/products/route.ts src/app/dashboard/page.tsx src/components/products/products-grid.tsx
git commit -m "feat(dashboard): paginated products, sticky toolbar, infinite scroll"
```

---

## Notes & Constraints

- **Concurrency = 3** is safe for most GPUs. Do not increase beyond 5 without testing.
- `renderPool` processes items in FIFO order; the most-recently-loaded page renders last — which is fine since users scroll down to see more.
- Blob URLs are revoked on dialog/popover close to prevent memory leaks.
- The `LayoutPreviewSvg` stays as a fallback for any frame whose render failed.
- The `sentinelRef` from `useReferenceList` must be attached to a `<div>` **inside** the scrollable container, not outside it, for IntersectionObserver to fire correctly.
- `Popover` from `@/components/ui/popover` is already available in the project (shadcn/ui).
- `ChevronDown`, `Search` are available from `lucide-react`.
