# CMYK Detection and RGB Conversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect CMYK surface images on upload, auto-convert them to RGB, always upload the RGB version, and show a badge ("RGB") or two-tab toggle ("Gốc (CMYK)" / "RGB ✓") in the surface uploader UI.

**Architecture:** CMYK detection reads the raw JPEG SOF (Start of Frame) marker to count color components — 4 means CMYK/YCCK, 3 means RGB/YCbCr. PNG/WebP never use CMYK so they short-circuit to false. Conversion uses the browser's Canvas 2D API: `drawImage` decodes CMYK JPEGs using embedded ICC profiles automatically, then `toBlob("image/jpeg")` outputs sRGB JPEG. All of this is isolated in a small utility file. `SurfaceUploader` calls it after file selection, always passing the RGB file upward via `onFileSelect`. The parent (`editor-client.tsx`) needs zero changes — it always receives an RGB file.

**Tech Stack:** TypeScript, React, Canvas 2D API, `DataView` (raw byte parsing), Tailwind CSS, `cn` (existing util at `src/lib/utils.ts`)

---

## Key Files

| File | Action |
|---|---|
| `src/lib/image/cmyk-detection.ts` | **Create** — `detectCmykJpeg` + `convertCmykToRgb` utilities |
| `src/components/editor/surface-uploader.tsx` | **Modify** — detection flow, state, UI |
| `src/components/editor/editor-client.tsx` | **No change** — already receives a `File` + URL, stays the same |
| `src/lib/supabase/upload.ts` | **No change** — upload accepts any `File`, JPEG is already allowed |

---

## Task 1: Create CMYK Detection + Conversion Utility

**Files:**
- Create: `src/lib/image/cmyk-detection.ts`

### Step 1: Create the file

```typescript
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
```

### Step 2: TypeScript check

```bash
cd /Users/an/Documents/cue-customizer-nextjs && npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: exit 0, no errors.

### Step 3: Commit

```bash
git add src/lib/image/cmyk-detection.ts
git commit -m "feat: add CMYK JPEG detection and Canvas RGB conversion utility"
```

---

## Task 2: Update SurfaceUploader — Detection State & Logic

**Files:**
- Modify: `src/components/editor/surface-uploader.tsx`

### Overview of new state

```
colorSpace: "rgb" | "cmyk" | "detecting" | null
  null        → no pending file / initial state
  "detecting" → async detection in progress
  "rgb"       → file is RGB (or PNG/WebP)
  "cmyk"      → file was CMYK, RGB version has been prepared

originalCmykUrl: string | null
  During "detecting": holds the temporary blob URL so preview shows immediately
  During "cmyk":      holds the original CMYK blob URL for the "Gốc" tab

activeTab: "original" | "converted"   (only relevant when colorSpace === "cmyk")
```

### Step 1: Replace `handleFile` with async version that detects + converts

Replace the existing `handleFile` in `surface-uploader.tsx`:

```typescript
// Add these imports at the top of surface-uploader.tsx:
import { cn } from "@/lib/utils";
import { detectCmykJpeg, convertCmykToRgb } from "@/lib/image/cmyk-detection";
```

Add new state declarations after the existing state (after `panRef.current = pan`):

```typescript
// CMYK detection state
const [colorSpace, setColorSpace] = useState<"rgb" | "cmyk" | "detecting" | null>(null);
const [originalCmykUrl, setOriginalCmykUrl] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<"original" | "converted">("converted");
const isDetectingRef = useRef(false);
const prevPendingFileRef = useRef<File | null | undefined>(undefined);
```

Add a `useEffect` right after the existing zoom/pan reset effect, to reset color state after save:

```typescript
// Reset color state when the pending file transitions from a File → null (save completed)
useEffect(() => {
  if (prevPendingFileRef.current instanceof File && pendingFile == null) {
    setColorSpace(null);
    setOriginalCmykUrl(null);
    setActiveTab("converted");
  }
  prevPendingFileRef.current = pendingFile ?? null;
}, [pendingFile]);
```

Replace the existing `handleFile`:

```typescript
const handleFile = useCallback(
  async (file: File) => {
    const localUrl = URL.createObjectURL(file);

    // Show preview immediately using the local blob URL, enter detecting state
    isDetectingRef.current = true;
    setColorSpace("detecting");
    setOriginalCmykUrl(localUrl); // temp preview while async detection runs
    setActiveTab("converted");

    try {
      const isCmyk = await detectCmykJpeg(file);

      if (isCmyk) {
        const { file: rgbFile, url: rgbUrl } = await convertCmykToRgb(file.name, localUrl);
        setColorSpace("cmyk");
        setOriginalCmykUrl(localUrl); // keep for "Gốc" tab
        onFileSelect(rgbFile, rgbUrl); // always pass RGB to parent
      } else {
        setColorSpace("rgb");
        setOriginalCmykUrl(null);
        onFileSelect(file, localUrl); // already RGB
      }
    } catch (err) {
      console.error("[SurfaceUploader] CMYK detection/conversion error:", err);
      // Fallback: treat as RGB, pass original file
      setColorSpace("rgb");
      setOriginalCmykUrl(null);
      onFileSelect(file, localUrl);
    } finally {
      isDetectingRef.current = false;
    }
  },
  [onFileSelect],
);
```

Update `handleRemove` to clean up CMYK state:

```typescript
function handleRemove() {
  if (originalCmykUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(originalCmykUrl);
  }
  setColorSpace(null);
  setOriginalCmykUrl(null);
  setActiveTab("converted");
  onFileSelect(null, "");
  if (inputRef.current) {
    inputRef.current.value = "";
  }
}
```

### Step 2: Compute `effectivePreview` (replaces `preview`)

Replace the `const preview = pendingPreview || currentUrl || null;` line with:

```typescript
// During detection or when viewing the CMYK original tab, show the local CMYK blob URL.
// Otherwise fall through to the parent-managed preview (pendingPreview) or saved URL (currentUrl).
const effectivePreview =
  (colorSpace === "detecting" || (colorSpace === "cmyk" && activeTab === "original")) &&
  originalCmykUrl
    ? originalCmykUrl
    : pendingPreview || currentUrl || null;
```

Replace every use of `preview` in the JSX (there are 3 places: the `if (preview)` guard, `img src={preview}`, and the fullscreen `img src={preview}`) with `effectivePreview`.

### Step 3: TypeScript check

```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: exit 0.

### Step 4: Commit

```bash
git add src/components/editor/surface-uploader.tsx
git commit -m "feat: wire CMYK detection into SurfaceUploader handleFile"
```

---

## Task 3: Add Color Space UI — Detecting Overlay, RGB Badge, CMYK Tabs

**Files:**
- Modify: `src/components/editor/surface-uploader.tsx`

### Step 1: Add "detecting" overlay inside the image preview container

Inside the `{effectivePreview ? ( <div className="relative ..."> ... </div> ) : ...}` block, add this **after** the uploading overlay block:

```tsx
{/* CMYK detection in progress */}
{colorSpace === "detecting" && (
  <div className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-sm">
    <div className="flex flex-col items-center gap-2">
      <Loader2 className="h-5 w-5 text-primary animate-spin" />
      <span className="text-xs text-muted-foreground">Đang phát hiện màu...</span>
    </div>
  </div>
)}
```

### Step 2: Add color space indicator below the preview container

Right after the closing `)}` of the `{effectivePreview ? ... : ...}` block (before the hidden `<input>`), add:

```tsx
{/* RGB badge — shown when the pending file is confirmed RGB */}
{colorSpace === "rgb" && !uploading && (
  <div className="flex items-center gap-1.5">
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-md bg-green-500/15 text-green-400 border border-green-500/25">
      <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
      RGB
    </span>
  </div>
)}

{/* CMYK tabs — shown when the pending file was CMYK-converted */}
{colorSpace === "cmyk" && !uploading && (
  <div className="flex gap-1">
    <button
      type="button"
      className={cn(
        "flex-1 py-1.5 text-[11px] rounded font-medium transition-colors border",
        activeTab === "original"
          ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
          : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
      onClick={() => setActiveTab("original")}
    >
      Gốc (CMYK)
    </button>
    <button
      type="button"
      className={cn(
        "flex-1 py-1.5 text-[11px] rounded font-medium transition-colors border",
        activeTab === "converted"
          ? "bg-green-500/20 text-green-400 border-green-500/30"
          : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
      onClick={() => setActiveTab("converted")}
    >
      RGB ✓
    </button>
  </div>
)}
```

### Step 3: Suppress "Chưa lưu" badge during detecting phase

The existing `"Chưa lưu"` badge condition is:
```tsx
{pendingFile && !uploading && (
  <div className="absolute bottom-2 left-2 px-2 py-1 bg-amber-500/90 ...">Chưa lưu</div>
)}
```

During detection, `pendingFile` is null (parent hasn't received the file yet), so the badge correctly won't show. No change needed here.

### Step 4: TypeScript check

```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: exit 0.

### Step 5: Commit

```bash
git add src/components/editor/surface-uploader.tsx
git commit -m "feat: add CMYK detecting overlay, RGB badge, and CMYK/RGB tab UI"
```

---

## Task 4: Allow JPEG in the `uploadToStorage` Allow-List

**Files:**
- Verify: `src/lib/supabase/upload.ts`

### Step 1: Check the current allowed types

```typescript
// Current in upload.ts:
const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
```

`image/jpeg` is already allowed. The RGB-converted file will have `type: "image/jpeg"` and name ending in `_rgb.jpg`. No change needed.

Also verify `surface-uploader.tsx` `<input accept="...">` — it currently has `image/jpeg,image/png,image/webp`. The converted file is created programmatically (not via the input), so no change needed there either.

### Step 2: Commit note

No code change required. Document the finding with a commit:

```bash
git commit --allow-empty -m "chore: confirm uploadToStorage accepts image/jpeg for CMYK-converted files"
```

---

## Task 5: Manual Verification Checklist

Since this feature is browser-side Canvas + file IO, manual testing is the most practical verification approach.

### Test A — RGB JPEG

1. Open the editor for any product
2. Upload a standard RGB JPEG (any photo from camera / stock)
3. **Expected:** 
   - Preview shows immediately with a "detecting" overlay for ~100ms
   - Green "RGB" badge appears below the preview
   - No tabs shown
   - Clicking Save → file uploads without error

### Test B — CMYK JPEG

1. Create a CMYK test file (Photoshop: Image → Mode → CMYK, Save As JPEG)  
   OR use any print-ready JPEG which is almost always CMYK
2. Upload it in the surface uploader
3. **Expected:**
   - Preview shows immediately with "Đang phát hiện màu..." overlay
   - After detection (~200ms), two tabs appear: "Gốc (CMYK)" and "RGB ✓"
   - "RGB ✓" tab is active by default; preview shows the sRGB-converted image
   - Clicking "Gốc (CMYK)" tab shows the original (may look different/more saturated)
   - Clicking Save → the **RGB converted** file (`_rgb.jpg`) is uploaded and applied to 3D cue

### Test C — PNG / WebP

1. Upload a PNG surface image
2. **Expected:** Green "RGB" badge shown (PNG is always RGB)

### Test D — Remove + Re-upload

1. Upload a CMYK file → tabs appear
2. Click the ✕ remove button
3. **Expected:** Tabs disappear, state resets
4. Upload a normal RGB file
5. **Expected:** RGB badge shown (no CMYK state leaking)

### Test E — Save clears color state

1. Upload CMYK file → tabs appear
2. Click Save
3. **Expected:** After save completes, tabs disappear (color state is reset)
4. The saved `surface_url` in the product points to the `_rgb.jpg` file (check Supabase dashboard)

---

## Final Commit

```bash
git add -A
git commit -m "feat: CMYK surface image detection and auto-conversion to RGB

- Add src/lib/image/cmyk-detection.ts with detectCmykJpeg (SOF marker parse) and convertCmykToRgb (Canvas 2D)
- SurfaceUploader detects CMYK on file select, auto-converts to sRGB JPEG
- RGB files show green 'RGB' badge
- CMYK files show 'Gốc (CMYK)' / 'RGB ✓' tab toggle for preview comparison
- Parent always receives the RGB file — no changes to editor-client.tsx or upload.ts

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
