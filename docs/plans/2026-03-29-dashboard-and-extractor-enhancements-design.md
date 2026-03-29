# Dashboard & Image Extractor Enhancements Design

## Overview

This design covers six interconnected features:
1. Dashboard search, filter, and preview dialog
2. Slower zoom momentum in product detail
3. HDRI direction controls (X/Y) in dashboard editor
4. Multi-image download in Image Extractor
5. New Image frame type in Image Extractor
6. Enhanced frames list with selection, reorder, and visibility

---

## 1. Dashboard Search, Filter & Preview Dialog

### Search & Filter Bar
Location: Top of `/dashboard` page, above product grid

**Components:**
- Search input with magnifying glass icon, placeholder "Search by name..."
- Filter chips: "All" | "Smooth" | "Leather"

**Behavior:**
- Search is debounced (300ms) and filters client-side
- Filters combine: searching "Pro" with "Smooth" shows only smooth cues containing "Pro"
- Empty state shows "No products match your search"

### Product Card Changes
File: `src/components/products/product-card.tsx`

**Current:** Sparkles/Layers icon beside product name  
**New:** Replace icon with Eye button ("Preview")

- Preview button opens fullscreen dialog
- Rest of card still links to detail route on click

### Preview Dialog
Pattern: Reuse dialog structure from `surface-uploader.tsx` lines 158-173

**Layout:**
```
┌─────────────────────────────────────────────┐
│  [Product Name]     [Edit]            [X]   │  ← Header
├─────────────────────────────────────────────┤
│                                             │
│         ┌─────────────────────┐             │
│         │                     │             │
│         │   3D Surface        │             │
│         │   Preview           │             │
│         │                     │             │
│         └─────────────────────┘             │
│                                             │
└─────────────────────────────────────────────┘
```

**Features:**
- Title: Product name
- Edit button: Navigates to `/dashboard/products/[id]`
- Close button (X): Top right
- Body: Full 3D surface preview
- **Lazy loading**: Surface/texture only loads when dialog opens (not on dashboard load)

**Technical:**
- Create `ProductPreviewDialog` component
- Use existing `CuePreview` or `SceneManager` for 3D rendering
- Pass product data (surface_url, texture_url, type) on dialog open

---

## 2. Zoom Momentum Reduction

File: `src/lib/three/scene-manager.ts`

### Current Values (too fast)
```typescript
inertiaDamping = 0.92      // Line ~175
wheelZoomSpeed = 0.0015    // Line ~177
```

### New Values (slower, smoother)
```typescript
inertiaDamping = 0.85      // Faster decay = shorter glide
wheelZoomSpeed = 0.001     // Finer control per scroll tick
```

**Effect:** Zoom momentum will decelerate ~40% faster, giving more controlled feel.

---

## 3. HDRI Direction Controls (Dashboard Editor)

File: `src/components/editor/editor-controls-panel.tsx`

### New Controls
Add to HDRI/Lighting section:
- **X Direction slider**: 0-360° (vertical light position)
- **Y Direction slider**: 0-360° (horizontal light position)

### UI Pattern
Copy from `frame-controls-panel.tsx` lines 454-500:
- Sun icon for X rotation
- RotateCw icon for Y rotation
- Real-time value display
- Commit on slider release

### Data Flow
```
Slider change → update threejs_settings.lighting.hdri.rotationX/Y 
             → SceneManager applies rotation to HDRI environment
```

### Type Updates
File: `src/types/editor.ts` (or equivalent)
```typescript
interface HdriSettings {
  type: string;
  exposure: number;
  rotationX: number;  // NEW
  rotationY: number;  // NEW
}
```

---

## 4. Download Multiple Images

File: `src/components/editor/image-extractor.tsx`

### New Button
Add "Download Multiple" button next to existing download button

### Modal/Dialog UI
```
┌─────────────────────────────────────────────┐
│  Download Multiple References         [X]   │
├─────────────────────────────────────────────┤
│  [Select All] [Deselect All]                │
│                                             │
│  ☑ Template 1        [thumbnail]            │
│  ☐ Template 2        [thumbnail]            │
│  ☑ Template 3        [thumbnail]            │
│  ☐ Template 4        [thumbnail]            │
│                                             │
├─────────────────────────────────────────────┤
│           [Export Selected (2)]             │
└─────────────────────────────────────────────┘
```

### Export Flow
1. User opens modal, sees all saved references
2. Selects desired references via checkboxes
3. Clicks "Export Selected"
4. Progress indicator: "Rendering 1/3...", "Rendering 2/3..."
5. Each reference rendered to canvas → PNG blob
6. All blobs bundled into ZIP
7. ZIP auto-downloads as `cue-exports-{timestamp}.zip`

### Dependencies
- Add `jszip` package for client-side ZIP creation
- Reuse existing canvas render logic

### Technical Implementation
```typescript
async function exportMultiple(referenceIds: string[]) {
  const zip = new JSZip();
  
  for (let i = 0; i < referenceIds.length; i++) {
    setProgress(`Rendering ${i + 1}/${referenceIds.length}...`);
    const blob = await renderReferenceToBlob(referenceIds[i]);
    zip.file(`${referenceName}-${i + 1}.png`, blob);
  }
  
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, `cue-exports-${Date.now()}.zip`);
}
```

---

## 5. Image Frame Type

### Add Frame Buttons
Current: "Add Frame" button  
New: Two buttons side by side:
- **Add Frame** (existing): Adds cue frame (3D model view)
- **Add Image**: Adds image frame (overlay layer)

### Image Frame Properties

```typescript
interface ImageSettings {
  imageUrl: string | null;           // Uploaded image URL or null
  backgroundColor: string;           // Hex color (#ffffff)
  objectFit: 'custom' | 'cover' | 'contain';
  rotation3d: {
    x: number;  // degrees, -180 to 180
    y: number;
    z: number;
  };
  opacity: number;                   // 0 to 1
  blendMode: BlendMode;
}

type BlendMode = 
  | 'normal' 
  | 'multiply' 
  | 'screen' 
  | 'overlay' 
  | 'darken' 
  | 'lighten'
  | 'color-dodge'
  | 'color-burn';
```

### Width/Height Behavior by Object Fit
- **Custom**: Width and height editable independently (absolute pixel values)
- **Cover**: Linked - maintains uploaded image aspect ratio
- **Contain**: Linked - maintains uploaded image aspect ratio

When switching to cover/contain with an uploaded image, auto-calculate locked ratio.

### Image Frame Controls Panel
When image frame selected, show in controls panel:

```
┌─────────────────────────────────┐
│  IMAGE FRAME                    │
├─────────────────────────────────┤
│  ┌───────────────────────────┐  │
│  │  Drop image here          │  │  ← Upload dropzone
│  │  or click to browse       │  │
│  └───────────────────────────┘  │
│                                 │
│  Background Color  [████] #fff  │  ← Color picker
│                                 │
│  Object Fit  [Custom     ▼]     │  ← Dropdown
│                                 │
│  Width   [____] px   🔗         │  ← Link icon toggles
│  Height  [____] px              │     for cover/contain
│                                 │
│  ─── 3D Rotation ───            │
│  X  [─────●─────] 0°            │
│  Y  [─────●─────] 0°            │
│  Z  [─────●─────] 0°            │
│                                 │
│  Opacity  [─────●───] 100%      │
│                                 │
│  Blend Mode  [Normal     ▼]     │
└─────────────────────────────────┘
```

### Canvas Rendering
Image frames render as HTML/CSS with:
```css
.image-frame {
  transform: perspective(1000px) 
             rotateX(Xdeg) 
             rotateY(Ydeg) 
             rotateZ(Zdeg);
  opacity: 0.8;
  mix-blend-mode: multiply;
  background-color: #fff;
  background-image: url(...);
  background-size: cover | contain | auto;
}
```

---

## 6. Frames List UI

Location: Bottom of Image Extractor canvas area

### Layout
```
┌────────────────────────────────────────────────────────────┐
│  FRAMES                                        [+Frame][+Image] │
├────────────────────────────────────────────────────────────┤
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                   │
│  │ ≡    │  │ ≡    │  │ ≡    │  │ ≡    │   ← Drag handles  │
│  │[thumb]│  │[thumb]│  │[thumb]│  │[thumb]│                   │
│  │ 🎯   │  │ 🖼️   │  │ 🎯   │  │ 🖼️   │   ← Type icons    │
│  │ 👁️ 🗑️│  │ 👁️ 🗑️│  │ 👁️ 🗑️│  │ 👁️ 🗑️│   ← Controls      │
│  └──────┘  └──────┘  └──────┘  └──────┘                   │
│   Frame 1   Frame 2   Frame 3   Frame 4                   │
│  [selected]                                                │
└────────────────────────────────────────────────────────────┘
```

### Frame Item Controls
- **Drag handle (≡)**: Reorder frames (dnd-kit or similar)
- **Thumbnail**: Mini preview of frame content
- **Type icon**: 🎯 for cue frame, 🖼️ for image frame
- **Eye icon (👁️)**: Toggle visibility (frontend state only, not saved to DB)
- **Trash icon (🗑️)**: Delete with confirmation

### Selection Behavior
- **Click frame**: Toggles selection, highlights frame in canvas
- **Shift+click**: Range select multiple frames
- Selected frames show blue border in canvas preview

### Stack Order
- List order = render order
- First item (left) = bottom of stack
- Last item (right) = top of stack
- Drag to reorder updates z-index in real-time

### Canvas Highlight (when selected)
```css
.frame-selected {
  outline: 2px solid #3b82f6;  /* blue-500 */
  outline-offset: 2px;
}
```

### Frontend State
```typescript
interface FrameListState {
  selectedIds: Set<string>;      // Currently selected frames
  hiddenIds: Set<string>;        // Frames hidden from preview (not persisted)
}
```

---

## 7. Database Schema Changes

### Migration: 005_add_image_frame_support.sql

```sql
-- Add frame_type column to distinguish cue vs image frames
ALTER TABLE extractor_frames 
  ADD COLUMN frame_type VARCHAR(20) DEFAULT 'cue' 
  CHECK (frame_type IN ('cue', 'image'));

-- Add image_settings JSONB for image frame properties
ALTER TABLE extractor_frames 
  ADD COLUMN image_settings JSONB DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN extractor_frames.frame_type IS 'Frame type: cue (3D model) or image (overlay)';
COMMENT ON COLUMN extractor_frames.image_settings IS 'Image frame settings: imageUrl, backgroundColor, objectFit, rotation3d, opacity, blendMode';
```

### image_settings JSONB Structure
```json
{
  "imageUrl": "https://storage.example.com/image.png",
  "backgroundColor": "#ffffff",
  "objectFit": "cover",
  "rotation3d": { "x": 0, "y": 0, "z": 0 },
  "opacity": 1,
  "blendMode": "normal"
}
```

### Updated TypeScript Types

File: `src/types/extractor.ts`

```typescript
// Frame type discriminator
type FrameType = 'cue' | 'image';

// Image-specific settings
interface ImageSettings {
  imageUrl: string | null;
  backgroundColor: string;
  objectFit: 'custom' | 'cover' | 'contain';
  rotation3d: { x: number; y: number; z: number };
  opacity: number;
  blendMode: string;
}

// Updated ExtractorFrame (discriminated union)
interface BaseFrame {
  id: string;
  order: number;
  transform: FrameTransform;
}

interface CueFrame extends BaseFrame {
  frameType: 'cue';
  cue: CueSettings;
}

interface ImageFrame extends BaseFrame {
  frameType: 'image';
  imageSettings: ImageSettings;
}

type ExtractorFrame = CueFrame | ImageFrame;
```

### Backward Compatibility
- All existing frames automatically get `frame_type = 'cue'` (default)
- `image_settings` is NULL for cue frames
- No data migration required - purely additive changes
- Frontend code uses discriminated union for type safety

---

## Implementation Todos

### Dashboard Features
1. Add search input and filter chips to dashboard page
2. Create ProductPreviewDialog component with lazy 3D loading
3. Update ProductCard to show Preview button instead of icon

### Zoom & HDRI
4. Reduce inertiaDamping and wheelZoomSpeed in scene-manager.ts
5. Add HDRI X/Y rotation sliders to editor-controls-panel.tsx

### Multi-Download
6. Install jszip dependency
7. Create DownloadMultipleDialog component
8. Implement exportMultiple function with progress

### Image Frames
9. Run database migration for frame_type and image_settings
10. Update TypeScript types in extractor.ts
11. Create ImageFrameControls component
12. Add "Add Image" button to image-extractor.tsx
13. Implement image frame rendering in frame-canvas.tsx

### Frames List
14. Create FramesList component with drag-and-drop
15. Add selection highlighting to canvas
16. Implement hide/show toggle (frontend only)
17. Wire up delete with confirmation

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/dashboard/page.tsx` | Add search/filter UI |
| `src/components/products/product-card.tsx` | Replace icon with Preview button |
| `src/components/products/product-preview-dialog.tsx` | NEW: Fullscreen preview dialog |
| `src/lib/three/scene-manager.ts` | Reduce zoom momentum values |
| `src/components/editor/editor-controls-panel.tsx` | Add HDRI X/Y sliders |
| `src/components/editor/image-extractor.tsx` | Add Image button, Download Multiple |
| `src/components/editor/download-multiple-dialog.tsx` | NEW: Multi-download modal |
| `src/components/editor/frame-canvas.tsx` | Image frame rendering, selection highlight |
| `src/components/editor/frames-list.tsx` | NEW: Bottom frames list with controls |
| `src/components/editor/image-frame-controls.tsx` | NEW: Image frame control panel |
| `src/types/extractor.ts` | Add ImageSettings, update ExtractorFrame |
| `supabase/migrations/005_add_image_frame_support.sql` | NEW: Schema migration |
| `package.json` | Add jszip dependency |
