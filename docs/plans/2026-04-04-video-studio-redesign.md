# Video Studio Redesign

## Problem

The current Video Extractor has limited camera control — a fixed horizontal cue, linear pan along cue length, fixed camera height, and a manual duration slider that doesn't reflect actual camera travel. Users need full creative control over cue positioning, camera movement, and background styling to produce cinematic product videos.

## Proposed Approach

Transform the Video Extractor into a "Video Studio" with three pillars:

1. **Cue Setup** — Position the cue using Image Extractor-style interactive controls
2. **Camera Movement** — Full start/end camera animation with presets and custom paths
3. **Background System** — Stackable frame layers on wall and table surfaces

All configurations saveable as Studio Templates (DB-backed, like Image Extractor references).

---

## 1. Cue Setup

### Remove Duration Slider

Duration is no longer a user-set value. Video length is derived from:

```
videoDuration = cameraPathLength / cameraSpeed
```

Where `cameraPathLength` is the Euclidean distance between start and end camera positions, and `cameraSpeed` is user-controlled. Display the calculated duration as a read-only label.

### Cue Position Controls (Image Extractor Parity)

| Control    | Description                    | Range         | Default |
|------------|--------------------------------|---------------|---------|
| `spinY`    | Model horizontal rotation      | 0–2π rad      | 0       |
| `phi`      | Camera vertical orbit angle    | 0–π rad       | π/2     |
| `zoom`     | Camera distance multiplier     | 0.5–3.0       | 1.0     |
| `offsetX`  | Horizontal model shift         | -1.0 to 1.0   | 0       |
| `offsetY`  | Vertical model shift           | -1.0 to 1.0   | 0       |
| `cueScale` | Model size scale               | 4–12×         | 8       |
| `spinSpeed`| Continuous Y-rotation speed    | 0–1 (0=none)  | 0       |

**Interactive Preview:** Left-drag = spinY, vertical-drag = phi, scroll = zoom, right-drag = offset. Same interaction model as Image Extractor's cue frame editing.

### Cue Orientation

Currently the cue is forced horizontal (`rotation.z = -π/2`). The new system inherits the cue's natural orientation and lets `spinY` and `phi` control framing — matching Image Extractor behavior exactly.

---

## 2. Camera Movement System

### Camera Position Parameters

Each camera position (start and end) is defined by:

| Parameter   | Description               | Range           | Unit    |
|-------------|---------------------------|-----------------|---------|
| `distance`  | Z-axis distance (far↔close)| 0.5–5.0        | units   |
| `panX`      | Horizontal offset          | -2.0 to 2.0    | units   |
| `panY`      | Vertical offset (up↔down)  | -2.0 to 2.0    | units   |
| `dutchTilt` | Camera roll angle          | -45° to 45°    | degrees |

The user sets **Start** and **End** values independently. The camera interpolates between them during recording.

### Camera Computation

```
// Start camera position
startPos = {
  x: cueCenter.x + start.panX,
  y: cueCenter.y + start.panY,
  z: cueCenter.z + start.distance
}
// End camera position
endPos = {
  x: cueCenter.x + end.panX,
  y: cueCenter.y + end.panY,
  z: cueCenter.z + end.distance
}
// Interpolation per frame
t = easing(frameIndex / totalFrames)
camPos = lerp(startPos, endPos, t)
camRoll = lerp(start.dutchTilt, end.dutchTilt, t)
camera.position.set(camPos.x, camPos.y, camPos.z)
camera.up.set(sin(camRoll), cos(camRoll), 0)
camera.lookAt(cueCenter)
```

### Movement Presets

Predefined start→end combinations:

| Preset             | Start                          | End                          |
|--------------------|--------------------------------|------------------------------|
| Dolly In           | distance=4, rest=0             | distance=1.5, rest=0         |
| Dolly Out          | distance=1.5, rest=0           | distance=4, rest=0           |
| Pan Right          | panX=-1.5, rest=default        | panX=1.5, rest=default       |
| Pan Left           | panX=1.5, rest=default         | panX=-1.5, rest=default      |
| Vertical Rise      | panY=-1.0, rest=default        | panY=1.0, rest=default       |
| Diagonal Sweep     | panX=-1.5, panY=-1.0           | panX=1.5, panY=1.0           |
| Cinematic Approach | distance=4, panY=-0.5, tilt=-10| distance=1.5, panY=0, tilt=5 |
| Orbit Tilt         | dutchTilt=0°, rest=default     | dutchTilt=20°, rest=default  |

Selecting a preset populates start/end fields. User can further tweak values after selection (preset becomes "Custom" if modified).

### Speed & Easing

**Camera Speed:** Single slider controlling movement rate. Video duration is derived:

```
pathLength = euclideanDistance(startPos, endPos)
           + abs(start.dutchTilt - end.dutchTilt) * TILT_WEIGHT
videoDuration = pathLength / cameraSpeed
totalFrames = videoDuration * fps
```

Minimum duration clamped to 3s, maximum to 30s. Displayed as read-only label.

**Easing Presets (built-in):**

| Name                | CSS Cubic-Bezier            | Feel                        |
|---------------------|-----------------------------|-----------------------------|
| Linear              | `linear`                    | Constant speed              |
| Ease-In             | `cubic-bezier(0.4, 0, 1, 1)` | Slow start, fast end      |
| Ease-Out            | `cubic-bezier(0, 0, 0.2, 1)` | Fast start, slow end      |
| Ease-In-Out         | `cubic-bezier(0.4, 0, 0.2, 1)` | Smooth acceleration     |
| Cinematic Slow-Start| `cubic-bezier(0.7, 0, 0.3, 1)` | Dramatic slow build     |
| Dramatic Reveal     | `cubic-bezier(0.1, 0, 0.1, 1)` | Very slow start, hold   |

**Custom Easing:** Users can save custom easing presets to the DB (`camera_easing_presets` table), scoped per user.

---

## 3. Background System

### Architecture

Wall and Table each have an independent root container with stackable child layers. Layers composite bottom-to-top into a Canvas2D texture, applied to the corresponding 3D mesh material's `map`.

### Layer Types

**A. Color Layer**
- Native color picker (`<input type="color">`) + hex text input
- Opacity slider (0–100%)

**B. Gradient Layer**
- Pick from 45 modern gradient presets
- Organized in 3 tabs (shadcn-style tab UI):
  - **Cold** (15): blues, teals, purples, icy tones
  - **Warm** (15): oranges, reds, golds, sunset tones
  - **Neutral** (15): grays, monochromes, earth tones
- Each preset: 2-color or 3-color linear gradient with angle
- Opacity slider (0–100%)
- Gradient direction adjustable after selection

**C. Image Layer**
- Upload custom image
- Object fit: cover / contain / custom
- Opacity slider (0–100%)

### Per-Layer Controls

- Enable/disable toggle (eye icon)
- Opacity slider (0–100%)
- Blend mode dropdown (10 modes: normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light)
- Reorder layers (up/down buttons)
- Delete layer (except base root layer)

### Rendering Pipeline

```
1. Create offscreen Canvas2D (match 3D mesh UV resolution)
2. For each layer bottom-to-top:
   a. Set globalAlpha = layer.opacity
   b. Set globalCompositeOperation = mapBlendMode(layer.blendMode)
   c. Draw layer content:
      - Color: fillRect with solid color
      - Gradient: createLinearGradient with preset stops
      - Image: drawImage with object-fit logic
   d. Reset composite operation
3. Create THREE.CanvasTexture from result
4. Apply to mesh.material.map
5. material.needsUpdate = true
```

### UI Layout

Two collapsible sections in the sidebar:

```
▼ Wall Background
  [Layer 1: Color #1a1a1a] [👁] [opacity: 100%] [blend: normal]
  [Layer 2: Gradient "Arctic"] [👁] [opacity: 60%] [blend: screen]
  [+ Add Layer ▾]  → Color | Gradient | Image

▼ Table Background
  [Layer 1: Color #0d0d0d] [👁] [opacity: 100%] [blend: normal]
  [+ Add Layer ▾]  → Color | Gradient | Image
```

---

## 4. Studio Templates (Database)

### New Table: `video_studio_templates`

```sql
CREATE TABLE video_studio_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

**Config JSONB structure:**

```typescript
interface VideoStudioConfig {
  // Cue setup
  cuePosition: {
    spinY: number
    phi: number
    zoom: number
    offsetX: number
    offsetY: number
    cueScale: number
    spinSpeed: number
  }

  // Camera movement
  cameraStart: CameraPosition
  cameraEnd: CameraPosition
  cameraSpeed: number
  easing: {
    type: "preset" | "custom"
    preset?: string        // preset name
    customValue?: string   // cubic-bezier string
  }

  // Backgrounds
  wallLayers: BackgroundLayer[]
  tableLayers: BackgroundLayer[]

  // Lighting
  hdriConfig: { layers: HdriLayer[] }

  // Output
  quality: "hd" | "2k"
  shadow: { enabled: boolean; intensity: number }
}

interface CameraPosition {
  distance: number
  panX: number
  panY: number
  dutchTilt: number
}

interface BackgroundLayer {
  id: string
  type: "color" | "gradient" | "image"
  color?: string
  gradient?: { presetId: string; angle: number }
  imageUrl?: string | null
  objectFit?: "cover" | "contain" | "custom"
  opacity: number
  blendMode: BlendMode
  enabled: boolean
}
```

### New Table: `camera_easing_presets`

```sql
CREATE TABLE camera_easing_presets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  easing_value TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
```

### UI Flow

- Template dropdown at top of Video Studio panel
- "Save" → saves current full config (upsert if editing existing)
- "Save As" → new template with name prompt
- Rename / Duplicate / Delete via context menu
- Default templates: "Classic Dolly", "Cinematic Reveal", "Product Showcase"

---

## 5. Preview System

### Real-time Preview

- Debounced config updates (300ms) to avoid excessive re-renders
- Preview canvas shows current cue position with camera start overlay
- GPU memory management:
  - Pause animation loop when Video Studio tab is not active
  - Shrink framebuffer to 1×1 on dispose
  - Use `WEBGL_lose_context` for forced cleanup
  - Cache HDRI textures across sessions
  - Dispose unused background textures on layer removal

### Preview Playback

- Play button runs a low-res preview animation (half resolution)
- Shows camera path as ghost line overlay on preview
- Progress scrubber to manually seek through animation timeline

---

## 6. Migration from Current System

### Breaking Changes

- Remove `duration` slider entirely
- Remove `cameraDollySpeed` (replaced by `cameraSpeed` + start/end positions)
- Remove `cameraEndFraction` (replaced by end camera position)
- Replace `backgroundLayers` with `wallLayers` + `tableLayers`
- Remove `backgroundType` field (unused, replaced by layer system)

### Preserved Controls

- Quality selector (HD/2K) — unchanged
- HDRI lighting (file + rotation) — unchanged
- Shadow toggle + intensity — unchanged
- Cue scale slider — unchanged (moved to cue setup section)

### Migration Path

- Existing video configs auto-migrate: `cameraDollySpeed` → approximate camera start/end
- Old `backgroundLayers` → migrate to `wallLayers` (table gets default black)

---

## 7. Files to Create/Modify

### New Files

- `src/components/editor/video-studio/` — New directory for modular components:
  - `video-studio.tsx` — Main container (replaces video-extractor.tsx)
  - `cue-setup-panel.tsx` — Cue positioning controls
  - `camera-controls-panel.tsx` — Camera start/end + presets + easing
  - `background-panel.tsx` — Wall/table layer management
  - `gradient-picker.tsx` — 45-gradient preset grid with tabs
  - `layer-controls.tsx` — Per-layer controls (opacity, blend, type)
  - `studio-template-selector.tsx` — Template load/save dropdown
  - `camera-preview-overlay.tsx` — Camera path visualization on preview
- `src/lib/three/background-compositor.ts` — Canvas2D layer compositing engine
- `src/lib/gradients.ts` — 45 gradient preset definitions
- `src/lib/easing.ts` — Easing preset definitions + cubic-bezier interpolation
- `src/types/video-studio.ts` — New type definitions
- `supabase/migrations/XXXX_video_studio_templates.sql` — DB migration

### Modified Files

- `src/lib/three/extractor-scene-manager.ts` — New camera animation system, background compositor integration
- `src/types/extractor.ts` — Add new shared types
- `src/components/editor/editor-client.tsx` — Swap VideoExtractor → VideoStudio component

### Deprecated

- `src/components/editor/video-extractor.tsx` — Replaced by `video-studio/` directory
