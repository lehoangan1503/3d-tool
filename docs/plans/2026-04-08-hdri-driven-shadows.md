# HDRI-Driven Shadows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all manual Three.js studio lights and make shadows derive automatically from HDRI layer directions — each HDRI layer creates a DirectionalLight that casts a shadow matching its direction.

**Architecture:** Each HDRI layer already has `rotationX` (elevation) and `rotationY` (azimuth). We reuse the existing `hdriRotationToPosition()` helper to compute a 3D position for a DirectionalLight per layer. The light intensity scales with the HDRI layer's intensity. Removing an HDRI layer removes its shadow light. The basic ambient/hemisphere lighting stays at minimal levels to prevent pitch-black areas. Studio light types, UI, helpers, and config are fully removed.

**Tech Stack:** Three.js (DirectionalLight, ShadowMaterial, PCFSoftShadowMap), React/Next.js, TypeScript

---

### Task 1: Remove StudioLight types and config from `types/video-studio.ts`

**Files:**
- Modify: `src/types/video-studio.ts`

**Step 1: Remove StudioLight type, factory, and constant**

Remove these exports:
- `StudioLightType` type alias (line 220)
- `MAX_STUDIO_LIGHTS` constant (line 222)
- `StudioLight` interface (lines 224-242)
- `createDefaultStudioLight` function (lines 244-252)

**Step 2: Remove `studioLights` from `VideoStudioConfig`**

Remove the `studioLights: StudioLight[]` field from the interface (line 271).
Remove `studioLights` from `DEFAULT_STUDIO_CONFIG` (line 291).

**Step 3: Remove studioLights migration logic**

In `migrateVideoStudioConfig`, remove lines 445-447 that populate `studioLights` for old configs.

**Step 4: Remove StudioLight from imports in `extractor-scene-manager.ts`**

Remove `StudioLight` from the import on line 23.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove StudioLight types, config, and defaults

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Remove studio light objects and helpers from `ExtractorSceneManager`

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Remove studio light instance fields**

Remove these private fields (lines 92-103):
- `spotLight`
- `spotLightBasePos`
- `fillLights`
- `directionalLight`
- `studioLightObjects` array

**Step 2: Remove studio light methods**

Remove these methods entirely:
- `clearStudioLights()` (lines 362-376)
- `createLightHelper()` (lines 378-428)
- `setupStudioLightsFromConfig()` (lines 431-506)
- `updateStudioLightsFromConfig()` (lines 509-544)

**Step 3: Update `getStudioLightHelpers()` to only return HDRI helpers**

Change to:
```typescript
getStudioLightHelpers(): THREE.Group[] {
  return this.hdriLightHelpers.map(e => e.helper);
}
```

**Step 4: Update `clearStudioElements()` to remove studio light cleanup**

Remove from `clearStudioElements()`:
- Call to `clearStudioLights()`
- `spotLight` cleanup block (lines 307-314)
- `fillLights` cleanup loop (lines 315-319)

Keep: `clearHdriLightHelpers()`, backdrop, shadowFloor, wallShadowPlane, tableSurface, backgroundLayerMeshes cleanup.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove studio light objects and methods from ExtractorSceneManager

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Add HDRI-driven shadow lights

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Add new field for HDRI shadow lights**

Add private field:
```typescript
private hdriShadowLights: Array<{
  layerId: string;
  light: THREE.DirectionalLight;
}> = [];
```

**Step 2: Add `clearHdriShadowLights()` method**

```typescript
private clearHdriShadowLights(): void {
  for (const entry of this.hdriShadowLights) {
    this.scene.remove(entry.light);
    if (entry.light.target.parent) {
      this.scene.remove(entry.light.target);
    }
    entry.light.dispose();
  }
  this.hdriShadowLights = [];
}
```

**Step 3: Add `setupHdriShadowLights()` method**

This method creates a DirectionalLight for each enabled HDRI layer, positioned based on that layer's rotation:

```typescript
private setupHdriShadowLights(config: VideoStudioConfig): void {
  this.clearHdriShadowLights();

  const shadow = config.shadow;
  if (!shadow.enabled) return;

  const layers = config.hdriConfig?.layers ?? [];
  for (const layer of layers) {
    if (layer.enabled === false) continue;

    // Compute light position from HDRI rotation (same as helper position)
    const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);

    const light = new THREE.DirectionalLight(0xffffff, (layer.intensity ?? 1) * 0.8);
    light.position.copy(pos);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 50;
    light.shadow.camera.left = -20;
    light.shadow.camera.right = 20;
    light.shadow.camera.top = 20;
    light.shadow.camera.bottom = -20;
    light.shadow.bias = -0.0005;
    light.shadow.radius = shadow.blur ?? 3;

    this.scene.add(light);
    this.scene.add(light.target);
    this.hdriShadowLights.push({ layerId: layer.id, light });
  }
}
```

**Step 4: Add `updateHdriShadowLights()` for live preview updates**

```typescript
private updateHdriShadowLights(config: VideoStudioConfig): void {
  const shadow = config.shadow;
  const layers = (config.hdriConfig?.layers ?? []).filter(l => l.enabled !== false);

  // If count changed, do a full rebuild
  if (layers.length !== this.hdriShadowLights.length) {
    this.setupHdriShadowLights(config);
    return;
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const entry = this.hdriShadowLights[i];
    if (!entry) continue;

    const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);
    entry.light.position.copy(pos);
    entry.light.intensity = (layer.intensity ?? 1) * 0.8;
    entry.light.castShadow = shadow.enabled;
    entry.light.shadow.radius = shadow.blur ?? 3;
  }

  // Update shadow floor/wall opacity
  if (this.shadowFloor) {
    (this.shadowFloor.material as THREE.ShadowMaterial).opacity = shadow.intensity;
  }
  if (this.wallShadowPlane) {
    (this.wallShadowPlane.material as THREE.ShadowMaterial).opacity = shadow.intensity * 0.6;
  }
}
```

**Step 5: Wire into `clearStudioElements()`**

Add `this.clearHdriShadowLights()` call inside `clearStudioElements()`.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add HDRI-driven shadow lights per HDRI layer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Rewire `setupStudioFromStudioConfig` to use HDRI shadow lights

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Replace studio lights block in `setupStudioFromStudioConfig`**

Remove the entire block from line 1614 to line 1656 (studio lights setup + fill lights).

Replace with:
```typescript
// HDRI-driven shadow lights (one DirectionalLight per HDRI layer)
this.setupHdriShadowLights(config);
```

**Step 2: Remove the legacy `hasShadowLight` check block**

Remove lines 1733-1755 that check for shadow lights and add a fallback DirectionalLight — the HDRI shadow lights now handle this.

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: wire setupStudioFromStudioConfig to use HDRI shadow lights

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Rewire `updateStudioPreviewConfig` and `updateShadowFromConfig`

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Replace `updateShadowFromConfig`**

Replace the entire method body. Remove spotlight/spotLightBasePos references:

```typescript
private updateShadowFromConfig(config: VideoStudioConfig): void {
  this.updateHdriShadowLights(config);
}
```

**Step 2: Remove `updateStudioLightsFromConfig` call in `updateStudioPreviewConfig`**

Remove line 2011: `this.updateStudioLightsFromConfig(config);`

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: rewire preview config updates to HDRI shadow lights

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Remove `setupStudioLighting` legacy method's studio lights

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Remove spotLight + fill lights from `setupStudioLighting()`**

In `setupStudioLighting()` (line 219), remove:
- SpotLight creation (lines 237-250)
- Fill lights (lines 252-263)

Replace with HDRI shadow light setup based on the legacy config's HDRI rotation:
```typescript
// Create a single HDRI-driven shadow light from the HDRI rotation
if (config.enableShadow) {
  const rotY = config.hdriRotationY ?? 0;
  const pos = this.hdriRotationToPosition(0, rotY);
  const light = new THREE.DirectionalLight(0xffffff, 0.8);
  light.position.copy(pos);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 50;
  light.shadow.camera.left = -20;
  light.shadow.camera.right = 20;
  light.shadow.camera.top = 20;
  light.shadow.camera.bottom = -20;
  light.shadow.bias = -0.0005;
  light.shadow.radius = config.shadowBlur;
  this.scene.add(light);
  this.scene.add(light.target);
  this.hdriShadowLights.push({ layerId: 'legacy', light });
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "refactor: remove studio lights from legacy setupStudioLighting method

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Remove studio lights UI from `video-studio.tsx`

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx`

**Step 1: Remove studioLight handling from scene view transform callback**

Remove the `else if (info.type === "studioLight" ...)` block (lines 398-414).

**Step 2: Remove studioLight from section mapping**

Remove `studioLight: "lights"` from the `sectionMap` (line 312).

**Step 3: Remove `studioLights.length` from rebuild triggers**

Remove line 544: `(config.studioLights ?? []).length,`

**Step 4: Remove unused imports**

Remove `Lightbulb` from lucide-react imports if no longer used elsewhere. Check if it's used in the HDRI section heading — if so, keep it.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove studio lights UI references from video-studio

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Remove `studioLight` from `scene-view-controls.ts`

**Files:**
- Modify: `src/components/editor/video-studio/scene-view-controls.ts`

**Step 1: Remove `studioLight` from SelectionInfo type**

Remove `"studioLight"` from the type union (line 15).

**Step 2: Remove from TRANSFORMABLE_TYPES**

Remove `"studioLight"` from the Set (line 37).

**Step 3: Remove the studioLight case from raycast matching**

Remove the `case "studioLight":` block (lines 206-212).

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: remove studioLight from scene-view-controls

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Build verification and cleanup

**Files:**
- All modified files

**Step 1: Run TypeScript build**

```bash
npx tsc --noEmit
```

Expected: No errors. Fix any remaining references to removed fields.

**Step 2: Run next build**

```bash
npm run build
```

Expected: Build succeeds.

**Step 3: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve build errors from studio light removal

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
