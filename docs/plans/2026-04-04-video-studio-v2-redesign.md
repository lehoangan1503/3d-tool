# Video Studio v2 — 3D Camera Gizmo, Multi-Cue Instancing & Frame-Based Backgrounds

## Problem

The current Video Studio's slider-based camera controls (start/end positions) are abstract and hard to customize. Users can't visualize what the camera path looks like in 3D space. Background controls are inflexible (blend modes, no independent frame positioning). Only one cue is supported.

## Proposed Approach

A three-pillar redesign:
1. **3D Camera Gizmo** — a visible, draggable camera object in a toggleable "scene view" with Blender-style axis-locking
2. **Multi-Cue Instancing** — up to 4 cue copies using InstancedMesh for near-zero extra VRAM
3. **Frame-Based Backgrounds** — wall and table surfaces with up to 4 positioned/rotated/scaled frames each

---

## 1. Camera System

### Two-View Toggle

- **Scene View**: God-view of the full 3D studio (wall, table, cues, camera frustum). User drags the camera object around the scene.
- **Camera View**: Shows exactly what the camera sees — the final video output.
- Toggle between views with a button in the preview toolbar.

### Camera Gizmo (Scene View)

- Camera rendered as a wireframe frustum (pyramid + rectangle outline) in bright cyan
- Dotted line connects camera to its look-at target (main cue center)
- Frustum updates in real-time as user drags
- God-view uses independent OrbitControls for scene navigation

### Axis-Lock Interaction (Blender-style)

- **No key held**: Free movement — camera translates on XZ plane with mouse drag
- **Hold X**: Lock to cue's X-axis (left↔right across cue). Visual: red axis line.
- **Hold Y**: Lock to cue's Y-axis (bottom↔top along cue). Visual: green axis line.
- **Hold Z**: Lock to cue's Z-axis (close↔far from cue). Visual: blue axis line.
- Scroll wheel in scene view: adjusts god-view zoom (not studio camera distance)

### Direction Presets (Dropdown)

| Preset    | Axes | Description                     |
|-----------|------|---------------------------------|
| Fixed     | —    | Camera stays still              |
| Slide X   | X    | Left↔right across cue           |
| Slide Y   | Y    | Bottom↔top along cue            |
| Dolly Z   | Z    | Close↔far from cue              |
| Cross XY  | XY   | Diagonal across + along         |
| Depth XZ  | XZ   | Across + depth                  |
| Along YZ  | YZ   | Along cue + depth               |
| Free XYZ  | XYZ  | Unconstrained path              |

### Start/End Keyframes

```typescript
interface CameraKeyframe {
  cuePercent: number;       // 0–100: position along cue length (0%=bottom, 100%=top)
  distanceFromCue: number;  // 0.5–5.0: how far from cue
  offsetX: number;          // -2.0 to 2.0: horizontal offset
}
```

- "Set Start" / "Set End" buttons capture current gizmo position
- "Lock Distance" toggle: when on, start and end share one distance value
- Duration = path length ÷ camera speed (clamped 3–30s)
- 6 easing presets (Linear, Ease In, Ease Out, Ease In-Out, Cinematic Slow-Start, Dramatic Reveal)

### Bounding Constraint

Camera position is clamped so the camera's view frustum never shows beyond the wall and table surface edges. After every position update, compute frustum corners at the wall/table depth and clamp inward if any corner exceeds surface bounds.

---

## 2. Cue System

### Main Cue (always present)

- Inherits the product's actual cue model from the editor
- Controls: X/Y/Z position, uniform scale (4–12×), spinY (horizontal rotation)
- Spin speed slider (0–1): all cues spin at this rate during recording
- Acts as the reference point for camera movement (camera tracks this cue's geometry)

### Clone Cues (up to 3 additional, 4 total max)

- "Add Cue Copy" button (disabled when 4 total)
- Each clone: X/Y/Z position + uniform scale sliders
- No independent spin — all spin with main cue
- Delete button per clone

### InstancedMesh Implementation

- Single shared geometry + materials in GPU memory
- `THREE.InstancedMesh(geometry, material, 4)` per mesh part
- Multi-mesh models (shaft, bumper, wrap, etc.) → one InstancedMesh per part, grouped under parent
- Per-instance transform via `setMatrixAt(index, matrix4)`
- Transform matrix: position (x,y,z) + uniform scale + spinY rotation
- During recording: update all instance matrices per frame for spin
- `castShadow = true` works on InstancedMesh
- VRAM impact: ~0 extra for geometry (same as 1 cue)

### Bounding Box

Cues constrained within the studio box:
- X: -14 to +14 (wall half-width 17, with 3-unit margin)
- Y: -1.0 to +10 (table top to near wall top)
- Z: -5.0 to +3.0 (wall to camera side, with margin)

---

## 3. Background Frame System

### Concept

Wall and table are fixed 3D surfaces. Each surface has a base color + up to 4 frames composited on top via Canvas2D. Frames are flat rectangles (image, color, or gradient) with independent position, rotation, scale, opacity, and z-index stacking.

No blend modes. Frames draw on top with normal compositing and opacity control. Z-index controlled by array ordering (drag-to-reorder or up/down buttons).

### Frame Type

```typescript
interface BackgroundFrame {
  id: string;
  type: "color" | "gradient" | "image";
  // Content
  color?: string;
  gradient?: { presetId: string; angle: number };
  imageUrl?: string;
  // Transform (0–1 normalized to surface canvas)
  x: number;          // Center X (0=left, 1=right)
  y: number;          // Center Y (0=top, 1=bottom)
  width: number;      // 0–2 (1 = full surface width)
  height: number;     // 0–2 (1 = full surface height)
  rotation: number;   // Degrees (0–360)
  // Display
  opacity: number;    // 0–1
  enabled: boolean;
}
```

### Per-Surface Config

```typescript
interface SurfaceConfig {
  baseColor: string;
  frames: BackgroundFrame[];  // Ordered bottom-to-top, max 4
}
```

### Compositor Pipeline (Canvas2D)

1. Create offscreen canvas (e.g. 2048×2048)
2. Fill with `baseColor`
3. For each enabled frame (bottom-to-top):
   - Save canvas state → translate to center → rotate → set opacity → draw content → restore
4. Convert to `THREE.CanvasTexture` → apply to mesh material

### Controls (per frame, collapsible)

- Type toggle: Color | Gradient | Image
- Content controls (color picker / gradient grid+angle / image upload)
- Transform sliders: X, Y, Width, Height, Rotation
- Opacity slider
- Reorder: up/down buttons (z-index stacking)
- Delete button

---

## 4. Performance Budget

| Resource              | Budget                                       |
|-----------------------|----------------------------------------------|
| GPU Memory            | ~1 cue model (InstancedMesh, ~0 extra)       |
| Draw calls            | +4 instances (nearly free)                   |
| Background compositing| Canvas2D (CPU, debounced 500ms)              |
| Scene view overhead   | 1 extra camera + CameraHelper                |
| Total scene meshes    | Wall + Table + Shadow floor + Cue instances + Camera helper |

---

## 5. Files to Modify/Create

### Types
- `src/types/video-studio.ts` — BackgroundFrame, SurfaceConfig, CueInstance, updated CameraKeyframe

### Components
- `src/components/editor/video-studio/video-studio.tsx` — toggle view, god camera, updated layout
- `src/components/editor/video-studio/camera-controls-panel.tsx` — rewrite: presets, cue-% sliders, set start/end
- `src/components/editor/video-studio/cue-setup-panel.tsx` — rewrite: multi-cue with add/delete, instancing
- `src/components/editor/video-studio/background-panel.tsx` — rewrite: frame-based with base color
- `src/components/editor/video-studio/frame-controls.tsx` — new: per-frame controls (replaces layer-controls)
- `src/components/editor/video-studio/scene-view-controls.ts` — new: gizmo interaction + axis-lock
- `src/components/editor/video-studio/gradient-picker.tsx` — keep as-is (used by gradient frames)

### Core
- `src/lib/three/extractor-scene-manager.ts` — InstancedMesh support, god camera, CameraHelper, cue-% camera positioning, frustum clamping
- `src/lib/three/background-compositor.ts` — update for frame-based compositing (position/rotation/scale per frame)

### Remove
- `src/components/editor/video-studio/layer-controls.tsx` — replaced by frame-controls.tsx
- Blend mode types and utilities — no longer needed

---

## 6. UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Video Studio                          [Scene|Camera] ✕  │
├────────────────────────────────┬─────────────────────────┤
│                                │ ▸ Studio Templates      │
│                                │ ▸ Quality & Duration    │
│    3D Preview                  │ ▸ Camera Controls       │
│    (Scene View or Camera View) │   Direction: [Slide Y▾] │
│                                │   Start: 10% / 3.0m    │
│                                │   End: 90% / 1.8m      │
│                                │   [Set Start] [Set End] │
│                                │   Speed: ──●──          │
│                                │   Easing: [Ease In-Out] │
│                                │ ▸ Cues                  │
│                                │   Main: x/y/z/scale/spin│
│                                │   Cue 2: x/y/z/scale [✕]│
│                                │   [+ Add Cue Copy]      │
│                                │ ▸ Wall Background       │
│                                │   Base: [■ #1a1a1a]    │
│                                │   Frame 1 — Image [↑↓✕] │
│                                │   [+ Add Frame]         │
│                                │ ▸ Table Surface         │
│                                │   Base: [■ #2a2a2a]    │
│                                │   [+ Add Frame]         │
│                                │ ▸ HDRI Lighting         │
│                                │ ▸ Shadow                │
├────────────────────────────────┴─────────────────────────┤
│  [Reset]                           [Cancel]    [Record]  │
└──────────────────────────────────────────────────────────┘
```

### Scene View Key Hints

```
[X] X-axis  [Y] Y-axis  [Z] Z-axis  [Free] — hold key + drag camera
```
