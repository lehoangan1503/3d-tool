# Scene View Interactive Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Scene View from a passive preview into a Blender-like interactive 3D editor with selectable/draggable objects, frame planes on surfaces, smooth camera movement, and two-way sync with the dashboard controls.

**Architecture:** Replace the compositor-based tiled textures with individual 3D plane meshes for each BackgroundFrame. Add THREE.Raycaster + TransformControls for click-to-select + drag-to-move on all scene objects. Camera always lookAt cue Y-center with smooth lerp interpolation. Two-way binding: 3D scene ↔ dashboard sliders sync in real-time.

**Tech Stack:** Three.js (Raycaster, TransformControls from three/examples), React state lifting, existing SceneViewControls class extension.

---

## Phase 1: Fix Tiling Bug + Surface Rendering

### Task 1: Fix wall/table texture tiling — use ClampToEdge, 2048×2048 canvas

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` lines 1200-1217

**Changes:**

In `setupStudioFromStudioConfig()`, change wall texture setup from:
```typescript
const wallTex = compositeSurfaceFrames(config.wallSurface, 1024, 1024, wallImages);
wallTex.wrapS = THREE.RepeatWrapping;
wallTex.wrapT = THREE.RepeatWrapping;
wallTex.repeat.set(5, 5);
```
to:
```typescript
const wallTex = compositeSurfaceFrames(config.wallSurface, 2048, 2048, wallImages);
wallTex.wrapS = THREE.ClampToEdgeWrapping;
wallTex.wrapT = THREE.ClampToEdgeWrapping;
wallTex.repeat.set(1, 1);
```

Same for table texture — change from `1024, 1024` + `repeat(4, 4)` to `2048, 2048` + `ClampToEdgeWrapping` + `repeat(1, 1)`.

**Step: Commit**
```
git commit -m "fix: wall/table texture tiling — use ClampToEdge with 2048×2048 canvas"
```

---

## Phase 2: Frame Planes on Surfaces

### Task 2: Add frame plane mesh management to ExtractorSceneManager

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Changes:**

Add new private fields:
```typescript
// Frame plane meshes (for interactive scene view)
private wallFramePlanes: THREE.Mesh[] = [];
private tableFramePlanes: THREE.Mesh[] = [];
```

Add new methods:

**`createFramePlaneMaterial(frame: BackgroundFrame, loadedImages?: Map<string, HTMLImageElement>): THREE.MeshBasicMaterial`**
Creates a material for a frame plane based on its type:
- `"color"` → `new THREE.MeshBasicMaterial({ color: frame.color, transparent: true, opacity: frame.opacity, side: THREE.DoubleSide, depthWrite: false })`
- `"gradient"` → Render gradient to a small canvas (256×256), create CanvasTexture, use as `map`
- `"image"` → Use loaded image as texture

**`buildFramePlanes(surface: SurfaceConfig, parentMesh: THREE.Mesh, isTable: boolean, loadedImages?: Map<string, HTMLImageElement>): THREE.Mesh[]`**
For each enabled frame in `surface.frames`:
1. Create a PlaneGeometry sized to `frame.width * parentWidth × frame.height * parentHeight`
2. Create material via `createFramePlaneMaterial`
3. Position the plane:
   - **Wall frames**: x = `(frame.x - 0.5) * wallWidth`, y = `(0.5 - frame.y) * wallHeight`, z = `parentZ + 0.01 * (index + 1)` (slightly in front to avoid z-fighting)
   - **Table frames**: Same mapping but on the horizontal table plane (rotate -90° X like table)
4. Apply rotation: `mesh.rotation.z = frame.rotation * Math.PI / 180` (for wall) or `mesh.rotation.y` for table
5. Set `mesh.userData = { type: 'wallFrame' | 'tableFrame', frameId: frame.id, frameIndex: index }`
6. Add mesh to scene
7. Return array of meshes

**`clearFramePlanes()`**: Remove all wallFramePlanes and tableFramePlanes from scene, dispose geometry/material.

**`updateFramePlanes(config: VideoStudioConfig, wallImages, tableImages)`**: Calls clearFramePlanes, then buildFramePlanes for wall and table.

Update `setupStudioFromStudioConfig()`:
- After creating wall/table meshes, call `buildFramePlanes` for both
- Store mesh references to `this.wallFramePlanes` and `this.tableFramePlanes`

Also update `clearStudioElements()` to call `clearFramePlanes()`.

**Step: Commit**
```
git commit -m "feat(esm): frame planes as 3D meshes on wall/table surfaces"
```

---

### Task 3: Set userData on all selectable scene objects

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Changes:**

In `setupStudioFromStudioConfig()`:
- After creating wall backdrop: `this.backdrop.userData = { type: 'wall' };`
- After creating table surface: `this.tableSurface.userData = { type: 'table' };`
- After setting up cue instances, mark them: iterate `this.instancedMeshes` and set `mesh.userData = { type: 'cue' }`

In `initSceneView()`:
- Create a visible camera gizmo mesh (small box + cone group) instead of relying solely on CameraHelper:
```typescript
// Camera gizmo — visible, selectable proxy for the studio camera
const gizmoGroup = new THREE.Group();

const body = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.3, 0.3),
  new THREE.MeshBasicMaterial({ color: 0xff6600, wireframe: false })
);
gizmoGroup.add(body);

const lens = new THREE.Mesh(
  new THREE.ConeGeometry(0.2, 0.35, 4),
  new THREE.MeshBasicMaterial({ color: 0xff9933 })
);
lens.rotation.x = Math.PI / 2;
lens.position.z = 0.3;
gizmoGroup.add(lens);

gizmoGroup.userData = { type: 'camera' };
this.cameraGizmo = gizmoGroup;
this.scene.add(gizmoGroup);
```

Add private field: `private cameraGizmo: THREE.Group | null = null;`

Update existing code that moves the studio camera to also sync the gizmo position:
- In `setCameraFromKeyframe()`: add `this.syncCameraGizmo()` call
- In `moveStudioCamera()`: add `this.syncCameraGizmo()` call

New method **`syncCameraGizmo()`**:
```typescript
private syncCameraGizmo(): void {
  if (!this.cameraGizmo) return;
  this.cameraGizmo.position.copy(this.camera.position);
  this.cameraGizmo.quaternion.copy(this.camera.quaternion);
}
```

Also expose a getter: `getCameraGizmo(): THREE.Group | null`

Expose `getSelectableObjects(): THREE.Object3D[]` that returns all objects with userData.type set (wall, table, cue, camera, wallFrame, tableFrame).

**Step: Commit**
```
git commit -m "feat(esm): selectable userData on all scene objects + camera gizmo mesh"
```

---

## Phase 3: Raycasting + Selection System

### Task 4: Add selection system to SceneViewControls

**Files:**
- Modify: `src/components/editor/video-studio/scene-view-controls.ts`

**Changes:**

Add to the class:
```typescript
private raycaster = new THREE.Raycaster();
private mouse = new THREE.Vector2();
private selectedObject: THREE.Object3D | null = null;
private onSelectionChange: (type: string | null, id?: string) => void;
```

Update constructor to accept the selection callback:
```typescript
constructor(
  private esm: ExtractorSceneManager,
  private canvas: HTMLCanvasElement,
  private onCameraKeyframeChange: (kf: CameraKeyframe) => void,
  private getCueConfig: () => CueConfig,
  onSelectionChange: (type: string | null, id?: string) => void
)
```

Add click handler (separate from drag):
```typescript
private handleClick(e: MouseEvent): void {
  // Only fire if this wasn't a drag (mousedown + mouseup within 5px)
  const rect = this.canvas.getBoundingClientRect();
  this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const godCam = this.esm.getGodCamera();
  if (!godCam) return;

  this.raycaster.setFromCamera(this.mouse, godCam);
  const selectables = this.esm.getSelectableObjects();
  const intersects = this.raycaster.intersectObjects(selectables, true);

  if (intersects.length > 0) {
    let obj = intersects[0].object;
    // Walk up to find userData.type
    while (obj && !obj.userData?.type && obj.parent) {
      obj = obj.parent;
    }
    if (obj?.userData?.type) {
      this.selectedObject = obj;
      this.onSelectionChange(obj.userData.type, obj.userData.frameId);
      return;
    }
  }
  // Click empty space = deselect
  this.selectedObject = null;
  this.onSelectionChange(null);
}
```

Track mousedown position to distinguish clicks from drags (< 5px movement = click).

**Step: Commit**
```
git commit -m "feat(scene-controls): raycasting selection system for all scene objects"
```

---

### Task 5: Add TransformControls for selected objects

**Files:**
- Modify: `src/components/editor/video-studio/scene-view-controls.ts`

**Changes:**

Import `TransformControls` from `three/examples/jsm/controls/TransformControls.js`.

Add fields:
```typescript
private transformControls: TransformControls | null = null;
private onObjectTransform: (type: string, changes: Record<string, number>, frameId?: string) => void;
```

Update constructor to accept transform callback.

When an object is selected (`handleClick`), attach TransformControls to it:
```typescript
private attachTransformControls(object: THREE.Object3D): void {
  this.detachTransformControls();

  const godCam = this.esm.getGodCamera();
  if (!godCam) return;

  this.transformControls = new TransformControls(godCam, this.canvas);
  this.transformControls.attach(object);

  // Set mode based on object type
  const type = object.userData.type;
  if (type === 'camera' || type === 'cue') {
    this.transformControls.setMode('translate');
  } else if (type === 'wallFrame' || type === 'tableFrame') {
    this.transformControls.setMode('translate');
    // Constrain to surface plane (wall = XY, table = XZ)
  }

  // Disable orbit while transforming
  this.transformControls.addEventListener('dragging-changed', (event) => {
    if (this.orbitControls) this.orbitControls.enabled = !event.value;
  });

  // Sync changes back to config on transform
  this.transformControls.addEventListener('objectChange', () => {
    this.syncTransformToConfig(object);
  });

  this.esm.getScene().add(this.transformControls.getHelper());
}
```

**`syncTransformToConfig(object)`**: Based on `object.userData.type`:
- `'camera'`: Update camera position → call `onObjectTransform('camera', { x, y, z })`, also sync CameraKeyframe
- `'cue'`: Read instance position from transform → `onObjectTransform('cue', { positionX, positionY, positionZ, scale })`
- `'wallFrame'` / `'tableFrame'`: Convert 3D position back to normalized (0-1) coordinates → `onObjectTransform(type, { x, y, width, height, rotation }, frameId)`

Clean up in `dispose()`: detach and dispose TransformControls.

**Step: Commit**
```
git commit -m "feat(scene-controls): TransformControls for camera, cue, and frame objects"
```

---

## Phase 4: Smooth Camera Movement + Y-Axis Centering

### Task 6: Smooth camera movement with lerp + always lookAt cue Y center

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Changes:**

Add target position for smooth interpolation:
```typescript
private cameraTargetPos = new THREE.Vector3();
private cameraSmoothEnabled = false;
```

Update `moveStudioCamera()`:
- Instead of directly setting `this.camera.position`, set `this.cameraTargetPos`
- The actual camera position interpolates toward the target each frame

New method **`updateCameraSmooth()`** — called each frame from the animation loop:
```typescript
updateCameraSmooth(): void {
  if (!this.cameraSmoothEnabled) return;
  this.camera.position.lerp(this.cameraTargetPos, 0.15);

  // Always lookAt cue Y center
  const mainCue = this.currentCueConfig?.instances.find(i => i.isMain)
    || this.currentCueConfig?.instances[0];
  if (mainCue) {
    const cueYCenter = mainCue.positionY + (mainCue.scale * 1.3) / 2 - 1.2;
    this.camera.lookAt(mainCue.positionX, cueYCenter, mainCue.positionZ);
  }

  this.camera.updateProjectionMatrix();
  if (this.cameraHelper) this.cameraHelper.update();
  this.syncCameraGizmo();
}
```

Call `updateCameraSmooth()` from the `render()` method or the preview animation loop.

Update `setCameraFromKeyframe()`:
- Set both `this.camera.position` AND `this.cameraTargetPos` (instant jump, no lerp)
- Always lookAt cue Y center instead of arbitrary target

Update `moveStudioCamera()`:
- Increase sensitivity from 0.01 to 0.03 for more responsive feel
- Set `this.cameraTargetPos` instead of `this.camera.position` directly
- Enable `cameraSmoothEnabled = true`

**Step: Commit**
```
git commit -m "feat(esm): smooth camera lerp + always lookAt cue Y-axis center"
```

---

## Phase 5: Camera Gizmo Size + CameraHelper Scale

### Task 7: Enlarge camera frustum helper + gizmo visibility

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Changes:**

In `initSceneView()`:
- Scale up the CameraHelper: `this.cameraHelper.scale.setScalar(1.5)` — makes frustum lines 50% bigger
- Scale up camera gizmo (from Task 3): make the box `0.6×0.45×0.45` and cone radius `0.3`, length `0.5`
- Add a bright outline ring or wireframe to make the gizmo more visible against dark backgrounds

Expose `getScene(): THREE.Scene` for TransformControls to add helpers.

**Step: Commit**
```
git commit -m "feat(esm): larger camera frustum helper + visible gizmo"
```

---

## Phase 6: Two-Way Sync — Dashboard ↔ Scene View

### Task 8: Update video-studio.tsx for selection + two-way binding

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx`

**Changes:**

Add state for active/selected panel:
```typescript
const [activePanel, setActivePanel] = useState<string | null>(null);
// 'camera' | 'cue' | 'wall' | 'table' | 'wallFrame:id' | 'tableFrame:id'
```

Update SceneViewControls construction to pass new callbacks:
```typescript
sceneViewControlsRef.current = new SceneViewControls(
  extractor,
  canvas,
  (kf) => setConfig(prev => ({ ...prev, cameraStart: kf })),
  () => configRef.current.cueConfig,
  // Selection callback
  (type, id) => {
    if (type) setActivePanel(id ? `${type}:${id}` : type);
    else setActivePanel(null);
  },
  // Transform callback — sync 3D changes back to config
  (type, changes, frameId) => {
    switch (type) {
      case 'camera':
        // Convert 3D position to CameraKeyframe
        const kf = extractorRef.current?.getCameraKeyframeFromPosition(configRef.current.cueConfig);
        if (kf) setConfig(prev => ({ ...prev, cameraStart: kf }));
        break;
      case 'cue':
        setConfig(prev => {
          const instances = [...prev.cueConfig.instances];
          const main = instances.findIndex(i => i.isMain);
          if (main >= 0) {
            instances[main] = { ...instances[main], ...changes };
          }
          return { ...prev, cueConfig: { ...prev.cueConfig, instances } };
        });
        break;
      case 'wallFrame':
        setConfig(prev => {
          const frames = prev.wallSurface.frames.map(f =>
            f.id === frameId ? { ...f, ...changes } : f
          );
          return { ...prev, wallSurface: { ...prev.wallSurface, frames } };
        });
        break;
      case 'tableFrame':
        // Same pattern for table
        break;
    }
  }
);
```

In the control panel area, add visual indication of active panel:
- When `activePanel === 'camera'`, highlight/scroll-to Camera Controls section
- When `activePanel === 'wall'`, highlight Background Panel wall section
- When `activePanel === 'cue'`, highlight Cue Setup section

Dashboard slider changes already trigger `updateStudioPreviewConfig` which updates 3D positions. This completes the two-way binding:
- **Scene → Dashboard**: TransformControls drag → `onObjectTransform` → `setConfig` → re-render dashboard
- **Dashboard → Scene**: Slider change → `config` update → `updateStudioPreviewConfig` → 3D updates

**Step: Commit**
```
git commit -m "feat(ui): two-way sync — scene selection activates dashboard panel, transforms sync back"
```

---

### Task 9: Dashboard panel auto-scroll + highlight on selection

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx`

**Changes:**

Add refs for each panel section:
```typescript
const cuePanelRef = useRef<HTMLDivElement>(null);
const cameraPanelRef = useRef<HTMLDivElement>(null);
const wallPanelRef = useRef<HTMLDivElement>(null);
const tablePanelRef = useRef<HTMLDivElement>(null);
```

When `activePanel` changes, scroll to the corresponding section:
```typescript
useEffect(() => {
  if (!activePanel) return;
  const refMap: Record<string, React.RefObject<HTMLDivElement>> = {
    camera: cameraPanelRef,
    cue: cuePanelRef,
    wall: wallPanelRef,
    table: tablePanelRef,
  };
  const panelType = activePanel.split(':')[0];
  const ref = refMap[panelType];
  ref?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}, [activePanel]);
```

Wrap each panel section in a div with the ref and conditional highlight class:
```tsx
<div
  ref={cuePanelRef}
  className={cn(
    "transition-colors rounded-md p-1 -m-1",
    activePanel === 'cue' && "ring-1 ring-primary/50 bg-primary/5"
  )}
>
  <CueSetupPanel ... />
</div>
```

**Step: Commit**
```
git commit -m "feat(ui): auto-scroll + highlight active panel on scene selection"
```

---

## Phase 7: Update updateStudioPreviewConfig for Frame Planes

### Task 10: Sync frame planes on config change (not just full rebuild)

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Changes:**

Update `updateStudioPreviewConfig()` to also update frame plane positions/sizes when config changes without a full rebuild:

```typescript
updateStudioPreviewConfig(config: VideoStudioConfig): void {
  this.studioConfigRef = config;
  if (!this.model) return;

  // Update cue instances
  this.updateCueInstances(config.cueConfig);

  // Update camera from start keyframe
  this.setCameraFromKeyframe(config.cameraStart, config.cueConfig);
  this.camera.fov = 50;
  this.camera.updateProjectionMatrix();

  // Update frame plane positions (lightweight — no texture rebuild)
  this.updateFramePlaneTransforms(config);
}
```

New method `updateFramePlaneTransforms(config)`:
- For each wall frame plane, update its position/rotation/scale based on current config
- For each table frame plane, same
- This is the "lightweight" path — only moves existing planes, doesn't recreate textures
- If frame count changed (add/delete), trigger full rebuild

**Step: Commit**
```
git commit -m "feat(esm): lightweight frame plane transform updates on config change"
```

---

## Phase 8: Table Surface Default Position

### Task 11: Position table surface at bottom of wall by default

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` (setupStudioFromStudioConfig)
- Modify: `src/lib/three/studio-background.ts` (createTableSurface default position)

**Changes:**

Currently:
- Wall: position (0, 4.5, -5.5), size 34×22 → bottom edge at y = 4.5 - 11 = -6.5
- Table: position y = -1.2, rotated -90° X

Change table default to sit at the bottom edge of the wall:
- Wall bottom edge: `wallY - wallHeight/2`
- In `setupStudioFromStudioConfig`, after creating wall:
  ```typescript
  const wallBottom = this.backdrop.position.y - 11; // wallHeight/2
  this.tableSurface = createTableSurface(tableTex, 28, 5, wallBottom);
  ```
- Table extends forward from the wall bottom, creating a floor/shelf effect

Also update `createTableSurface` default yPosition from -0.4 to match.

**Step: Commit**
```
git commit -m "fix: table surface default position at bottom of wall"
```

---

## Phase 9: Cleanup + Polish

### Task 12: Remove compositor tiling code, clean up old repeat logic

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` — remove the old `loadTexture` method's repeat params if unused
- Verify: `background-compositor.ts` still works for the base color fill

**Step: Commit**
```
git commit -m "chore: remove legacy texture repeat/tiling code"
```

---

### Task 13: Visual verification

**Steps:**
1. Open browser → navigate to product editor → click "Extract video"
2. Verify wall background shows single gradient (no tiling/grid)
3. Scene View: click camera gizmo → TransformControls appear → drag moves camera smoothly
4. Scene View: click cue → TransformControls appear → drag moves cue → dashboard sliders update
5. Scene View: click wall → Background Panel highlights
6. Add a frame to wall → verify 3D plane appears on wall → click it → drag to reposition
7. Dashboard slider change → verify 3D scene updates in real-time
8. Camera always looks at cue Y center regardless of position
9. Record video → verify output looks correct

**Step: Commit**
```
git commit -m "fix: visual adjustments after interactive scene view implementation"
```
