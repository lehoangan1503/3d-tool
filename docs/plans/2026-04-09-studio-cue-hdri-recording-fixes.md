# Video Studio: Isolated Cue HDRI, Recording View & Reset Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate cue HDRI lighting from studio surface lighting, show camera view during recording, and fix post-recording scene rotation bug.

**Architecture:** The cue gets its own HDRI environment applied directly to cue materials (`material.envMap`) with rotation X/Y controls, independent of the studio light. Studio light (Studio White + color) remains on wall/table surfaces only via the existing `getSurfaceEnvMap()` path. Recording switches to camera view so users see real-time output matching the final video. After recording, accumulated cue spin state is properly reset.

**Tech Stack:** Three.js (r150+), React, Next.js, TypeScript, shadcn/ui

---

## Summary of Issues

1. **Cue HDRI isolation**: Currently `scene.environment` applies to everything. The cue needs its own HDRI with rotation X/Y controls (like main product page), separate from studio surface lighting.
2. **Recording view mismatch**: During recording, the user stays on whatever view they were on (Scene/Camera). The canvas is resized to recording resolution (2560×1440), distorting the preview. Users should see camera view moving in real-time.
3. **Post-recording rotation bug**: `spinCueInstances()` accumulates `spinY`/`spinX` on `this.currentCueConfig` during recording. After recording, the spin state isn't reset, causing the cue to start at the wrong angle on subsequent recordings.

---

### Task 1: Add Cue HDRI Config to VideoStudioConfig

**Files:**
- Modify: `src/types/video-studio.ts:221-255`
- Modify: `src/types/video-studio.ts:395-420` (migration)

**Step 1: Add cueHdri field to VideoStudioConfig**

In `src/types/video-studio.ts`, add a `cueHdri` field to `VideoStudioConfig`:

```typescript
export interface VideoStudioConfig {
  // ... existing fields ...
  hdriConfig: { layers: HdriLayer[] };   // Studio light (surfaces only)
  hdriIntensity: number;
  cueHdri: {                              // NEW — cue-only HDRI
    hdriType: string;                     // HDRI filename (e.g. "bloem_train_track_clear_2k.hdr")
    rotationX: number;                    // 0-360 degrees
    rotationY: number;                    // 0-360 degrees
    intensity: number;                    // 0-3
  };
  // ... rest of fields ...
}
```

Update `DEFAULT_STUDIO_CONFIG`:
```typescript
cueHdri: {
  hdriType: "bloem_train_track_clear_2k.hdr",
  rotationX: 0,
  rotationY: 300,
  intensity: 1.0,
},
```

**Step 2: Add migration for old configs without cueHdri**

In the `migrateStudioConfig()` function, add:
```typescript
if (!migrated.cueHdri) {
  migrated.cueHdri = {
    hdriType: "bloem_train_track_clear_2k.hdr",
    rotationX: 0,
    rotationY: 300,
    intensity: 1.0,
  };
}
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors about missing `cueHdri` in places that create `VideoStudioConfig` objects

**Step 4: Fix any type errors** by adding `cueHdri` to all config construction sites

**Step 5: Commit**
```bash
git add -A && git commit -m "feat(studio): add cueHdri config field for isolated cue HDRI lighting"
```

---

### Task 2: Apply HDRI to Cue Materials Only (Not scene.environment)

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` — `setHdriLayers()`, add `setCueHdri()`, modify `setupStudioFromStudioConfig()`

**Step 1: Add cueEnvRT field and setCueHdri method**

Add a new private field:
```typescript
private cueEnvRT: THREE.WebGLRenderTarget | null = null;
private lastCueHdriKey: string = '';
```

Add a new method `setCueHdri(config)` that:
1. Loads the HDRI file (or uses cache)
2. Applies rotation X/Y
3. Processes through PMREMGenerator
4. Walks all cue model materials and sets `material.envMap = cueEnvRT.texture`
5. Sets `material.envMapIntensity = config.intensity`
6. Does NOT set `scene.environment`

**Step 2: Modify setHdriLayers to NOT set scene.environment**

Currently `setHdriLayers` sets `this.scene.environment = rt.texture`. Change it to:
- Generate the studio light env map
- Store it as the studio surface env map (replacing `getSurfaceEnvMap()` to use studio light color/intensity)
- Apply to wall/table materials only
- Do NOT set `scene.environment` (leave it null)

**Step 3: Modify setupStudioFromStudioConfig**

After setting up the studio, call `setCueHdri(config.cueHdri)` to apply the cue's own HDRI.

**Step 4: Modify updateStudioPreviewConfig**

When config changes, call `setCueHdri(config.cueHdri)` to live-update the cue HDRI.

**Step 5: Helper method to apply envMap to cue materials**

```typescript
private applyCueEnvMap(envMap: THREE.Texture | null, intensity: number): void {
  if (!this.clonedModel) return;
  this.clonedModel.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
      child.material.envMap = envMap;
      child.material.envMapIntensity = intensity;
      child.material.needsUpdate = true;
    }
  });
  // Also apply to instanced meshes
  for (const im of this.instancedMeshes) {
    if (im.material instanceof THREE.MeshStandardMaterial) {
      im.material.envMap = envMap;
      im.material.envMapIntensity = intensity;
      im.material.needsUpdate = true;
    }
  }
}
```

**Step 6: Dispose cueEnvRT in dispose()**

**Step 7: Type-check and browser verify**

Run: `npx tsc --noEmit`
Then verify in browser: cue reflects HDRI, surfaces stay white

**Step 8: Commit**
```bash
git add -A && git commit -m "feat(studio): isolated cue HDRI lighting separate from studio surfaces"
```

---

### Task 3: Add Cue HDRI UI Controls

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx` — add Cue HDRI section

**Step 1: Rename "HDRI Lights" section to "Studio Lights"**

The existing HDRI Lights panel controls studio surface lighting. Rename button text.

**Step 2: Add "Cue HDRI" collapsible section**

Add a new collapsible section (like the existing HDRI Lights) with:
- HDRI Type dropdown (same HDRI_OPTIONS_FALLBACK list, but excluding Studio White)
- Rotation X (Vertical) slider: 0-360°
- Rotation Y (Horizontal) slider: 0-360°
- Intensity slider: 0-3

Wire to `config.cueHdri` field.

**Step 3: Type-check and browser verify**

Run: `npx tsc --noEmit`
Verify: New "Cue HDRI" section appears, dropdowns and sliders work, cue reflects correct HDRI

**Step 4: Commit**
```bash
git add -A && git commit -m "feat(studio): add Cue HDRI UI controls with rotation and intensity"
```

---

### Task 4: Fix Recording View — Show Camera View During Recording

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx` — `handleRecord()`
- Modify: `src/lib/three/extractor-scene-manager.ts` — `startStudioRecording()` and `_startStudioRecordingLoop()`

**Step 1: Save and restore view mode around recording**

In `handleRecord()`:
```typescript
const prevViewMode = viewMode;
setViewMode("camera"); // Force camera view during recording
// ... recording ...
// In finally block:
setViewMode(prevViewMode); // Restore previous view
```

**Step 2: Use offscreen canvas for recording, main canvas for preview**

The core issue is that `this.renderer.setSize(qp.width, qp.height)` resizes the visible canvas to recording resolution. Instead:

Option A (simpler): During recording, keep the main canvas at container size, but capture at recording resolution using a separate offscreen renderer.

Option B (simplest): During recording, keep the main canvas at container size. Render each frame TWICE: once to the main canvas at container size (for user to see), and once to a hidden canvas at recording resolution (for MediaRecorder). 

Option C (recommended): Create a second WebGLRenderer with an OffscreenCanvas (or hidden canvas) at recording resolution for MediaRecorder. Main renderer stays at container size, showing camera view. Both renderers share the same scene and camera.

**CHOSEN APPROACH — Option C (dual renderer):**

In `startStudioRecording`:
1. Create a hidden canvas element at recording resolution
2. Create a second WebGLRenderer on that canvas
3. `captureStream()` from the hidden canvas for MediaRecorder
4. In the animation loop, render to BOTH:
   - Hidden canvas (recording quality) → feeds MediaRecorder
   - Main canvas (container size) → user sees camera view
5. After recording, dispose the hidden renderer

This way the user sees the camera moving during recording at the preview resolution, and the recorded output is at full quality.

**Step 3: Main canvas renders camera view during recording**

During the animation loop, after rendering to the offscreen canvas:
```typescript
// Render to main canvas at preview size (user sees this)
this.renderer.render(this.scene, this.camera);
```

The existing `setCameraFromKeyframe(interpolatedKeyframe)` already moves `this.camera`, so the main canvas shows the animated camera path.

**Step 4: Type-check and browser verify**

**Step 5: Commit**
```bash
git add -A && git commit -m "fix(studio): show camera view during recording using dual renderer"
```

---

### Task 5: Fix Post-Recording Scene Rotation Bug

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` — `_startStudioRecordingLoop()`

**Root Cause:** `spinCueInstances()` mutates `this.currentCueConfig.spinY/spinX` cumulatively during recording (each frame adds to it). After recording, `startStudioVideoPreview(config)` calls `setupCueInstances(config.cueConfig)` with the original config, but only sets `this.currentCueConfig = config` — the model's rotation was already mutated by hundreds of spin calls.

**Step 1: Save cue spin state before recording and restore after**

In `_startStudioRecordingLoop`, before the animation loop:
```typescript
// Save original spin state to restore after recording
const savedSpinY = this.currentCueConfig?.spinY || 0;
const savedSpinX = this.currentCueConfig?.spinX || 0;
const savedSpinZ = this.currentCueConfig?.spinZ || 0;
```

In `mediaRecorder.onstop`, before resolving:
```typescript
// Reset accumulated spin to pre-recording state
if (this.currentCueConfig) {
  this.currentCueConfig = {
    ...this.currentCueConfig,
    spinY: savedSpinY,
    spinX: savedSpinX,
    spinZ: savedSpinZ,
  };
}
// Reset model rotation
if (this.clonedModel) {
  this.clonedModel.rotation.set(savedSpinX, savedSpinY, savedSpinZ);
}
```

**Step 2: Also reset instanced meshes if applicable**

If using instanced meshes, reset their matrices too:
```typescript
this.setupCueInstances({
  ...this.currentCueConfig!,
  spinY: savedSpinY,
  spinX: savedSpinX,
  spinZ: savedSpinZ,
});
```

**Step 3: Type-check and browser verify**

Record 3 times in a row. After each recording, verify:
- Cue returns to original orientation
- Wall/table surface doesn't shift
- Camera preview resets to start position

**Step 4: Commit**
```bash
git add -A && git commit -m "fix(studio): reset cue spin state after recording to prevent rotation drift"
```

---

### Task 6: Final Integration Testing

**Step 1: Browser verification checklist**

Open: `http://localhost:3000/dashboard/products/432edb97-b466-476f-8afc-b36a3a05d814`

- [ ] Click "Extract video" → Video Studio opens
- [ ] **Cue HDRI section**: Dropdown shows HDRIs, Rotation X/Y sliders, Intensity slider
- [ ] Changing Cue HDRI rotation updates cue lighting in real-time
- [ ] **Studio Lights section**: Studio White with color picker, surfaces only
- [ ] Changing Studio White color does NOT affect cue reflections
- [ ] Surfaces remain white/evenly lit regardless of Cue HDRI choice
- [ ] Click Record → view switches to Camera view, shows camera path animation
- [ ] Recording progress matches what's shown on screen
- [ ] After recording finishes → view returns to previous mode
- [ ] Record again → cue is at original position (no rotation drift)
- [ ] Record 3x in a row → scene stays centered after each
- [ ] Switch to Camera tab → preview looks same as recorded output
- [ ] No console errors

**Step 2: Commit all and update plan**
```bash
git add -A && git commit -m "feat(studio): complete cue HDRI isolation, recording view, and spin reset"
```
