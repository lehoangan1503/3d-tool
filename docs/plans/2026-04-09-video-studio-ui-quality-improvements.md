# Video Studio UI & Quality Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize texture assets, add new materials, hide temporarily-disabled UI features, fix video recording quality (2K default, 60fps, sharp textures), and add per-surface roughness control.

**Architecture:** Move HQ texture files from `old/` to proper `wall/`/`table/` subfolders. Update `textures.json` manifest with new textures (gray_cement, white_plastic) and label names. Hide frames UI, "Add Cue Copy", and Light Intensity. Replace HD/2K quality selector with 2K@60fps default + 120fps option. Fix first-frame blurriness by pre-rendering a warm-up frame. Add user-adjustable roughness slider per surface.

**Tech Stack:** Three.js, Next.js, React, TypeScript, Tailwind CSS

---

### Task 1: Move HQ textures from `old/` to proper folders

**Files:**
- Move: `public/textures/studio/old/plastered_wall_05_*` → `public/textures/studio/wall/plastered_wall_05/`
- Move: `public/textures/studio/old/denim_fabric_06_*` → `public/textures/studio/table/denim_fabric_06/`
- Delete: `public/textures/studio/old/` (after moving)
- Modify: `public/textures/studio/textures.json` — update hqOverrides paths

### Task 2: Update `textures.json` with new textures and labels

**Files:**
- Modify: `public/textures/studio/textures.json`

Add `white_plastic` and `gray_cement` to both wall and table categories. Each texture gets a `name` label. The `white_plastic` texture has only a diffuse map (`diff` → `plastic07_diffuse.jpg.png`). The `gray_cement` has basecolor and roughness (`diff` → `basecolor.png`, `roughness` → `roughness.png`).

### Task 3: Fix texture thumbnail path in `TexturePresetPicker`

**Files:**
- Modify: `src/components/editor/video-studio/background-panel.tsx`

The picker hardcodes `diff.jpg` but new textures use `.png`. Add a `thumbnail` field to manifest or try multiple extensions.

### Task 4: Update types — add roughness to SurfaceConfig, update quality presets

**Files:**
- Modify: `src/types/video-studio.ts`

- Add `roughness?: number` to `SurfaceConfig` (default from texture pack)
- Change `quality` type from `"hd" | "2k"` to `"2k" | "2k120"`
- Update `VIDEO_QUALITY_PRESETS`: remove `hd`, make `2k` 60fps, add `2k120` at 120fps
- Change defaults: `wallSurface.texturePreset = "white_plastic"`, `tableSurface.texturePreset = "white_plastic"`, `quality = "2k"`

### Task 5: Hide disabled UI features in background-panel

**Files:**
- Modify: `src/components/editor/video-studio/background-panel.tsx`

- Hide "Light Intensity" slider
- Hide frames list + "Add Frame" button
- Hide frame count badge
- Add roughness slider (0–1, step 0.01)

### Task 6: Hide "Add Cue Copy" in cue-setup-panel

**Files:**
- Modify: `src/components/editor/video-studio/cue-setup-panel.tsx`

### Task 7: Update quality selector in video-studio.tsx

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx`

Replace HD/2K selector with 2K 60fps / 2K 120fps options.

### Task 8: Apply roughness from config in extractor-scene-manager.ts

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

In `setupStudioFromStudioConfig` and `updateStudioPreviewConfig`, apply `config.wallSurface.roughness` and `config.tableSurface.roughness` to materials.

### Task 9: Fix blurry first 0-1s + FPS in recording

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

- Render a warm-up frame before starting MediaRecorder (forces GPU texture uploads/mipmaps)
- Enable mipmaps on JPG/PNG textures in studio-background.ts
- Use `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` during recording for sharper output

### Task 10: Enable mipmaps on all PBR textures

**Files:**
- Modify: `src/lib/three/studio-background.ts`

Add `tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;` to `loadTex` and `loadTexLinear`.
