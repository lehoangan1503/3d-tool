# Custom Cue Frame Video Studio Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update Custom Cue Frame (Image Extractor shadow simulator) to match Video Studio's wall/surface dimensions, component controls, seamless shadow rendering, and export quality.

**Architecture:** 
1. Update `setFrameShadow()` in extractor-scene-manager.ts to use L-shaped shadow mesh matching video studio dimensions
2. Update shadow-simulate-dialog.tsx to make camera gizmo pickable and use matching dimensions  
3. Ensure wall/floor use MeshBasicMaterial (unaffected by HDRI)
4. Fix export quality to render using same settings as simulator preview

**Tech Stack:** Three.js, React, TypeScript

---

## Current State Analysis

### Dimensions Comparison

| Surface | Image Extractor | Video Studio | Target |
|---------|-----------------|--------------|--------|
| Wall Width | 30 | 34 | 34 |
| Wall Height | 20 | 24 | 24 |
| Floor Width | 30 | 36 | 36 |
| Floor Depth | 30 | 14 | 14 |
| Wall Z | -3 | -5.5 | -5.5 |
| Floor Y | -1.18 | -7.5 | **-1.18** (keep for cue frame) |
| Wall Y Center | 4.8 | 4.5 | **4.8** (keep for cue frame) |

### Key Issues to Fix

1. **Wall/Surface Size Mismatch** - Current 30x30 floor + 30x20 wall vs video studio 34x24 wall + 34x12 table
2. **Camera Not Pickable** - `selectableRoots` excludes `cameraGizmo` (line 388-389)
3. **Separate Shadow Planes** - Wall and floor shadows are separate meshes causing visible seam
4. **Export Quality** - Export extractor doesn't apply shadow settings with same quality as simulator

---

## Task 1: Update ExtractorSceneManager setFrameShadow Dimensions

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts:1570-1651`

**Step 1: Update floor and wall dimensions to match video studio**

Update `setFrameShadow()` method to use video studio dimensions:

```typescript
// OLD: lines 1580-1592 (floor base)
if (!this.frameFloorBase) {
  this.frameFloorBase = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),  // OLD
    new THREE.MeshBasicMaterial({ color: new THREE.Color(wallColor) })
  );
  this.frameFloorBase.rotation.x = -Math.PI / 2;
  this.frameFloorBase.position.y = -1.182;
  this.scene.add(this.frameFloorBase);
}

// NEW: Update to use video studio dimensions
if (!this.frameFloorBase) {
  this.frameFloorBase = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 14),  // Match video studio: width=36, depth=14
    new THREE.MeshBasicMaterial({ color: new THREE.Color(wallColor) })
  );
  this.frameFloorBase.rotation.x = -Math.PI / 2;
  this.frameFloorBase.position.set(0, -1.182, 4);  // Centered floor with depth offset
  this.scene.add(this.frameFloorBase);
}
```

```typescript
// OLD: lines 1596-1600 (shadow floor)
if (!this.frameShadowFloor) {
  this.frameShadowFloor = createShadowFloor(30, 30);  // OLD
  this.frameShadowFloor.position.y = -1.18;
  this.scene.add(this.frameShadowFloor);
}

// NEW: Use L-shaped shadow mesh for seamless shadow
if (!this.frameShadowFloor) {
  // Use L-shaped shadow mesh matching video studio
  this.frameShadowFloor = createLShapedShadowMesh(
    36,      // width (matching floor/wall)
    24,      // wall height
    14,      // floor depth
    -1.18,   // corner Y (where wall meets floor)
    -3,      // wall Z position
    config.intensity
  );
  this.scene.add(this.frameShadowFloor);
}
```

```typescript
// OLD: lines 1604-1616 (wall base)
if (!this.frameWallBase) {
  this.frameWallBase = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 20),  // OLD
    new THREE.MeshBasicMaterial({ color: new THREE.Color(wallColor) })
  );
  this.frameWallBase.position.set(0, 4.8, -3);
  this.scene.add(this.frameWallBase);
}

// NEW: Update to video studio dimensions
if (!this.frameWallBase) {
  this.frameWallBase = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 24),  // Match video studio: width=36, height=24
    new THREE.MeshBasicMaterial({ color: new THREE.Color(wallColor) })
  );
  this.frameWallBase.position.set(0, 10.82, -3);  // Y = -1.18 + 24/2 = 10.82 (wall center)
  this.scene.add(this.frameWallBase);
}
```

**Step 2: Remove separate wall shadow mesh (using L-shaped instead)**

```typescript
// OLD: lines 1618-1627 (wall shadow overlay)
// ── Shadow overlay on back wall ───────────────────────────────────────────
if (!this.frameWallShadow) {
  const wallShadowMat = new THREE.ShadowMaterial({ opacity: config.intensity, transparent: true, depthWrite: false });
  this.frameWallShadow = new THREE.Mesh(new THREE.PlaneGeometry(30, 20), wallShadowMat);
  this.frameWallShadow.position.set(0, 4.8, -2.99);
  this.frameWallShadow.receiveShadow = true;
  this.scene.add(this.frameWallShadow);
}

// NEW: Remove this block entirely - L-shaped mesh handles both wall and floor shadows
// (Delete lines 1618-1627)
```

**Step 3: Update shadow light camera frustum**

```typescript
// OLD: lines 1636-1639
this.frameShadowLight.shadow.camera.left = -12;
this.frameShadowLight.shadow.camera.right = 12;
this.frameShadowLight.shadow.camera.top = 12;
this.frameShadowLight.shadow.camera.bottom = -12;

// NEW: Expand frustum to cover larger surfaces
this.frameShadowLight.shadow.camera.left = -20;
this.frameShadowLight.shadow.camera.right = 20;
this.frameShadowLight.shadow.camera.top = 20;
this.frameShadowLight.shadow.camera.bottom = -20;
```

**Step 4: Update clearFrameShadow to remove frameWallShadow**

```typescript
// In clearFrameShadow() method, remove frameWallShadow handling since we no longer use it
// This line can stay but will be a no-op since frameWallShadow is no longer created
```

**Step 5: Run build to verify no TypeScript errors**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds or only unrelated warnings

**Step 6: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts
git commit -m "feat(extractor): update setFrameShadow to use L-shaped shadow mesh

- Use L-shaped shadow mesh for seamless wall+floor shadow
- Update wall dimensions to 36x24 (matching video studio)
- Update floor dimensions to 36x14 (matching video studio)
- Expand shadow camera frustum to -20/20
- Remove separate wall shadow plane (L-shape handles both)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Update Shadow Simulator Dialog Dimensions

**Files:**
- Modify: `src/components/editor/shadow-simulate-dialog.tsx:210-253`

**Step 1: Update SCALE and surface dimensions**

```typescript
// OLD: lines 210-253 (studio surfaces setup)
// ── Studio surfaces — match extractor setFrameShadow positions × SCALE ───
const wallColor = cfg.wallColor ?? "#ffffff";
const wallGradientEnd = cfg.wallGradientEnd;

// Floor: extractor y=-1.18, no z-offset → scaled: y = -1.18×SCALE
// Wall: extractor z=-3, y_center=4.8 → scaled: z=-3×SCALE, y_center=4.8×SCALE
const floorY = -1.18 * SCALE;
const wallZ = -3 * SCALE;
const wallYCenter = 4.8 * SCALE;
// Plane sizes: just large enough to fill recordingCam view frustum + margin
const floorSize = 60;  // recordingCam at z=14 sees ~21 units wide at y=-8.26 → 60 is ample
const wallSize = 80;   // wall at z=-21 sees ~33 units wide → 80 is ample

const floorBase = new THREE.Mesh(
  new THREE.PlaneGeometry(floorSize, floorSize),
  makeStudioMat(wallColor, wallGradientEnd)
);
floorBase.rotation.x = -Math.PI / 2;
floorBase.position.set(0, floorY - 0.002, 0);
scene.add(floorBase);

const floorShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(floorSize, floorSize),
  new THREE.ShadowMaterial({ opacity: cfg.intensity, transparent: true, depthWrite: false })
);
floorShadow.rotation.x = -Math.PI / 2;
floorShadow.position.set(0, floorY, 0);
floorShadow.receiveShadow = true;
scene.add(floorShadow);

const wallBase = new THREE.Mesh(
  new THREE.PlaneGeometry(wallSize, wallSize),
  makeStudioMat(wallColor, wallGradientEnd)
);
wallBase.position.set(0, wallYCenter, wallZ - 0.002);
scene.add(wallBase);

const wallShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(wallSize, wallSize),
  new THREE.ShadowMaterial({ opacity: cfg.intensity, transparent: true, depthWrite: false })
);
wallShadow.position.set(0, wallYCenter, wallZ);
wallShadow.receiveShadow = true;
scene.add(wallShadow);
```

**NEW: Replace with L-shaped shadow mesh matching video studio**

```typescript
// ── Studio surfaces — match extractor setFrameShadow dimensions × SCALE ───
const wallColor = cfg.wallColor ?? "#ffffff";
const wallGradientEnd = cfg.wallGradientEnd;

// Match extractor dimensions (36 wide, 24 tall wall, 14 deep floor)
const wallWidth = 36 * SCALE;
const wallHeight = 24 * SCALE;
const floorDepth = 14 * SCALE;
const cornerY = -1.18 * SCALE;
const wallZ = -3 * SCALE;
const wallYCenter = cornerY + (wallHeight / 2); // Wall center Y

// White floor base (MeshBasicMaterial - unaffected by HDRI)
const floorBase = new THREE.Mesh(
  new THREE.PlaneGeometry(wallWidth, floorDepth),
  makeStudioMat(wallColor, wallGradientEnd)
);
floorBase.rotation.x = -Math.PI / 2;
floorBase.position.set(0, cornerY - 0.002, wallZ + floorDepth / 2);
scene.add(floorBase);

// White wall base (MeshBasicMaterial - unaffected by HDRI)
const wallBase = new THREE.Mesh(
  new THREE.PlaneGeometry(wallWidth, wallHeight),
  makeStudioMat(wallColor, wallGradientEnd)
);
wallBase.position.set(0, wallYCenter, wallZ - 0.002);
scene.add(wallBase);

// L-shaped shadow mesh for seamless shadow across wall + floor
const lShapeShadow = createLShapedShadowMesh(
  wallWidth / SCALE,   // Convert back to scene units
  wallHeight / SCALE,
  floorDepth / SCALE,
  cornerY / SCALE,
  wallZ / SCALE,
  cfg.intensity
);
lShapeShadow.scale.setScalar(SCALE);
scene.add(lShapeShadow);

// Keep references for later updates
const floorShadow = lShapeShadow; // Use L-shape as the shadow mesh
const wallShadow = null; // No separate wall shadow needed
```

**Step 2: Add import for createLShapedShadowMesh**

At the top of the file, add:

```typescript
// After existing Three.js imports, add:
import { createLShapedShadowMesh } from "@/lib/three/studio-background";
```

**Step 3: Run build to verify**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/components/editor/shadow-simulate-dialog.tsx
git commit -m "feat(shadow-dialog): use L-shaped shadow mesh for seamless shadows

- Replace separate floor/wall shadow planes with single L-shaped mesh
- Match dimensions to extractor: 36x24 wall, 36x14 floor
- Import createLShapedShadowMesh from studio-background

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Make Camera Gizmo Pickable and Controllable

**Files:**
- Modify: `src/components/editor/shadow-simulate-dialog.tsx:386-436`

**Step 1: Add cameraGizmo to selectableRoots**

```typescript
// OLD: lines 386-390
// ── Selection + Blender-style G/R/S hotkeys ────────────────────────────────
// Camera gizmo is not selectable — it's locked to the frame's camera settings
const selectableRoots: THREE.Object3D[] = [
  lightSphere, ...(modelClone ? [modelClone] : []),
];

// NEW: Make camera gizmo selectable and controllable
// ── Selection + Blender-style G/R/S hotkeys ────────────────────────────────
const selectableRoots: THREE.Object3D[] = [
  lightSphere, cameraGizmo, ...(modelClone ? [modelClone] : []),
];
```

**Step 2: Update syncCameraFromGizmo to actually sync camera position**

```typescript
// OLD: lines 334-336
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const syncCameraFromGizmo = () => {
  // No-op: recordingCam is fixed to frame camera settings
};

// NEW: Sync recordingCam position when camera gizmo is moved
const syncCameraFromGizmo = () => {
  // Update recording camera to match gizmo position
  recordingCam.position.copy(cameraGizmo.position);
  // Recompute lookAt to maintain focus on model center
  const lookTarget = new THREE.Vector3(
    cueSettings.offsetX * SCALE,
    cueSettings.offsetY * SCALE,
    0
  );
  recordingCam.lookAt(lookTarget);
  cameraGizmo.lookAt(lookTarget);
  recordingCam.updateProjectionMatrix();
  camHelper.update();
  
  // Derive new phi and zoom from camera position (for saving back)
  const camY = cameraGizmo.position.y / SCALE;
  const camZ = cameraGizmo.position.z / SCALE;
  const dist = Math.sqrt(camY * camY + camZ * camZ);
  const newPhi = Math.acos(camY / dist);
  // Note: phi changes affect the preview; full save requires CueSettings update
};
```

**Step 3: Remove eslint-disable comment since function is now used**

Delete the line: `// eslint-disable-next-line @typescript-eslint/no-unused-vars`

**Step 4: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/components/editor/shadow-simulate-dialog.tsx
git commit -m "feat(shadow-dialog): make camera gizmo pickable and controllable

- Add cameraGizmo to selectableRoots array
- Implement syncCameraFromGizmo to update preview camera position
- Camera can now be selected and moved like light and cue

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Expose Camera Position Changes to Parent

**Files:**
- Modify: `src/components/editor/shadow-simulate-dialog.tsx`

**Step 1: Add camera position callback to props interface**

```typescript
// OLD: lines 38-47
interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shadowConfig: CueShadowConfig;
  onConfigChange: (cfg: CueShadowConfig) => void;
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
  /** Frame camera/model settings so the preview matches the final output 1:1 */
  cueSettings: { phi: number; zoom: number; offsetX: number; offsetY: number; spinY: number };
}

// NEW: Add callback for camera position changes
interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shadowConfig: CueShadowConfig;
  onConfigChange: (cfg: CueShadowConfig) => void;
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
  /** Frame camera/model settings so the preview matches the final output 1:1 */
  cueSettings: { phi: number; zoom: number; offsetX: number; offsetY: number; spinY: number };
  /** Optional callback when camera position is changed via gizmo */
  onCameraChange?: (phi: number, zoom: number) => void;
}
```

**Step 2: Destructure new prop**

```typescript
// In component function signature, add onCameraChange:
export function ShadowSimulateDialog({
  open,
  onOpenChange,
  shadowConfig,
  onConfigChange,
  onSave,
  extractorRef,
  cueSettings,
  onCameraChange,  // ADD THIS
}: ShadowSimulateDialogProps) {
```

**Step 3: Update syncCameraFromGizmo to call onCameraChange**

```typescript
const syncCameraFromGizmo = () => {
  recordingCam.position.copy(cameraGizmo.position);
  const lookTarget = new THREE.Vector3(
    cueSettings.offsetX * SCALE,
    cueSettings.offsetY * SCALE,
    0
  );
  recordingCam.lookAt(lookTarget);
  cameraGizmo.lookAt(lookTarget);
  recordingCam.updateProjectionMatrix();
  camHelper.update();
  
  // Derive new phi from camera position
  const camY = cameraGizmo.position.y / SCALE;
  const camZ = cameraGizmo.position.z / SCALE;
  const dist = Math.sqrt(camY * camY + camZ * camZ);
  const newPhi = Math.acos(Math.max(-1, Math.min(1, camY / dist)));
  // Derive zoom from distance change (original dist was 2)
  const newZoom = 2 / dist;
  
  // Notify parent of camera changes
  if (onCameraChange) {
    setTimeout(() => onCameraChange(newPhi, newZoom), 0);
  }
};
```

**Step 4: Add ref to store onCameraChange**

```typescript
// Add near other refs (around line 119)
const onCameraChangeRef = useRef(onCameraChange);
useEffect(() => { onCameraChangeRef.current = onCameraChange; }, [onCameraChange]);
```

**Step 5: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/components/editor/shadow-simulate-dialog.tsx
git commit -m "feat(shadow-dialog): expose camera position changes to parent

- Add onCameraChange callback prop
- Calculate phi and zoom from gizmo position
- Call onCameraChange when camera gizmo is moved

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Update Frame Controls Panel to Handle Camera Changes

**Files:**
- Modify: `src/components/editor/frame-controls-panel.tsx:846-856`

**Step 1: Add onCameraChange handler to ShadowSimulateDialog**

```typescript
// OLD: lines 846-856
{shadowCfg.enabled && extractorRef && (
  <ShadowSimulateDialog
    open={shadowSimulateOpen}
    onOpenChange={setShadowSimulateOpen}
    shadowConfig={shadowCfg}
    onConfigChange={(cfg) => updateShadow(cfg)}
    onSave={(cfg) => {
      updateShadow(cfg);
      setShadowSimulateOpen(false);
    }}
    extractorRef={extractorRef}
    cueSettings={selectedFrame.cue}
  />
)}

// NEW: Add onCameraChange handler
{shadowCfg.enabled && extractorRef && (
  <ShadowSimulateDialog
    open={shadowSimulateOpen}
    onOpenChange={setShadowSimulateOpen}
    shadowConfig={shadowCfg}
    onConfigChange={(cfg) => updateShadow(cfg)}
    onSave={(cfg) => {
      updateShadow(cfg);
      setShadowSimulateOpen(false);
    }}
    extractorRef={extractorRef}
    cueSettings={selectedFrame.cue}
    onCameraChange={(phi, zoom) => {
      // Update frame's camera settings when simulator camera is moved
      onFrameChange({
        ...selectedFrame,
        cue: { ...selectedFrame.cue, phi, zoom },
      });
    }}
  />
)}
```

**Step 2: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/editor/frame-controls-panel.tsx
git commit -m "feat(frame-controls): connect camera changes from shadow simulator

- Pass onCameraChange callback to ShadowSimulateDialog
- Update frame's phi and zoom when camera gizmo is moved

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Fix Shadow Intensity Updates on L-Shaped Mesh

**Files:**
- Modify: `src/components/editor/shadow-simulate-dialog.tsx`

**Step 1: Store L-shaped mesh reference for intensity updates**

In the scene setup code, we need to keep a reference to update opacity:

```typescript
// After creating lShapeShadow, store reference in simObj
// Add to SimScene interface at top:
interface SimScene {
  // ... existing fields
  lShapeShadow: THREE.Mesh;  // ADD THIS
}

// In doInit, replace the floorShadow/wallShadow assignments:
simObj = {
  renderer, scene, camera, orbitControls, transformControls,
  shadowLight, lightSphere, cameraGizmo, recordingCam, camHelper,
  modelClone, floorBase, wallBase, 
  floorShadow: lShapeShadow,  // L-shape is the shadow receiver
  wallShadow: lShapeShadow,   // Same reference
  lShapeShadow,               // ADD explicit reference
  animFrameId: null, isDisposed: false,
};
```

**Step 2: Update intensity slider handler to modify L-shaped mesh**

Find where intensity slider updates the shadow opacity and ensure it updates the L-shaped mesh:

```typescript
// The existing code should work since floorShadow now references lShapeShadow
// Verify that intensity updates work:
(floorShadow.material as THREE.ShadowMaterial).opacity = cfg.intensity;
```

**Step 3: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/components/editor/shadow-simulate-dialog.tsx
git commit -m "fix(shadow-dialog): update L-shaped mesh intensity correctly

- Store lShapeShadow reference in SimScene
- Intensity slider updates L-shaped shadow mesh opacity

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Ensure Export Quality Matches Simulator Preview

**Files:**
- Modify: `src/components/editor/image-extractor.tsx:604-640`

**Step 1: Update export extractor shadow map settings**

The export extractor needs higher quality shadow maps matching the simulator:

```typescript
// In renderReferenceToBlob function (around line 772), after setFrameShadow:
// OLD:
exportExtractor.setFrameShadow(frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW);

// NEW: Also configure high-quality shadow rendering for export
const shadow = frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW;
exportExtractor.setFrameShadow(shadow);
// Ensure shadow map quality matches simulator (4096x4096)
exportExtractor.setFrameShadowQuality(4096);
```

**Step 2: Add setFrameShadowQuality method to ExtractorSceneManager**

In `src/lib/three/extractor-scene-manager.ts`, add new method:

```typescript
/** Set shadow map resolution for frame shadow light */
setFrameShadowQuality(size: number): void {
  if (this.frameShadowLight) {
    this.frameShadowLight.shadow.mapSize.set(size, size);
    this.frameShadowLight.shadow.map?.dispose();
    this.frameShadowLight.shadow.map = null; // Force recreation
    this.frameShadowLight.shadow.camera.updateProjectionMatrix();
  }
}
```

**Step 3: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts src/components/editor/image-extractor.tsx
git commit -m "feat(extractor): add setFrameShadowQuality for high-res export

- Add setFrameShadowQuality method to control shadow map size
- Use 4096x4096 shadow maps during export for quality matching simulator

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Render Frame Before Export Capture

**Files:**
- Modify: `src/components/editor/image-extractor.tsx`

**Step 1: Add render call before captureFrame**

```typescript
// In export flow, add explicit render before capture:
// Around line 639, before captureFrame:

// Apply shadow settings
exportExtractor.setFrameShadow(frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW);
exportExtractor.setFrameShadowQuality(4096);

// Force a render to apply all settings before capture
exportExtractor.render();

// Then capture
const frameDataUrl = exportExtractor.captureFrame("png");
```

**Step 2: Add public render method to ExtractorSceneManager**

```typescript
/** Force render current scene (useful before capture) */
render(): void {
  this.renderer.render(this.scene, this.camera);
}
```

**Step 3: Run build**

Run: `npm run build 2>&1 | head -50`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts src/components/editor/image-extractor.tsx
git commit -m "feat(extractor): add render() method and call before capture

- Add public render() method to ExtractorSceneManager
- Call render() before captureFrame to ensure all settings applied

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Test Full Flow

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Manual testing checklist**

1. Open Image Extractor
2. Add a Cue Frame
3. Enable Studio Shadow
4. Open Shadow Simulator dialog
5. Verify:
   - [ ] Wall and floor have no visible seam where they meet
   - [ ] Shadow is seamless across wall and floor
   - [ ] Camera gizmo can be clicked and selected
   - [ ] Camera gizmo can be moved with G key
   - [ ] Light gizmo can be clicked and moved
   - [ ] Cue model can be clicked and moved
   - [ ] Wall and floor stay pure white regardless of HDRI
   - [ ] Save Shadow Settings saves the config
   - [ ] Download exports image matching preview quality

**Step 3: Commit final changes if any fixes needed**

```bash
git add -A
git commit -m "test: verify shadow simulator parity with video studio

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Summary

This plan addresses all four requirements:

1. **Wall/Surface Dimensions** - Updated to 36x24 wall, 36x14 floor matching video studio proportions
2. **Camera Pickable** - Added cameraGizmo to selectableRoots, implemented syncCameraFromGizmo
3. **Seamless Shadow** - Replaced separate wall/floor shadows with L-shaped shadow mesh
4. **Export Quality** - Added setFrameShadowQuality(4096) and explicit render() before capture
