import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { CameraKeyframe, CueConfig } from "@/types/video-studio";

export interface SelectionInfo {
  type:
    | "camera"
    | "cue"
    | "wall"
    | "table"
    | "wallFrame"
    | "tableFrame"
    | null;
  frameId?: string;
  object?: THREE.Object3D;
}

const CLICK_THRESHOLD_PX = 5;
const HIGHLIGHT_COLOR = 0xffff00;

/** All selectable types support TransformControls (uniform x-y-z + free drag) */
const TRANSFORMABLE_TYPES = new Set([
  "camera",
  "cue",
  "wall",
  "table",
  "wallFrame",
  "tableFrame",
]);

export class SceneViewControls {
  private orbitControls: OrbitControls | null = null;
  private transformControls: TransformControls | null = null;
  private mouseDownX = 0;
  private mouseDownY = 0;
  private isDisposed = false;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  private currentSelection: SelectionInfo = { type: null };
  private highlightObjects: THREE.Object3D[] = [];
  private savedEmissives = new Map<THREE.Material, THREE.Color>();

  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  // Blender-like immediate drag state
  private activeHotkey: "g" | "r" | "s" | null = null;
  private hotkeyAxisLock: "x" | "y" | "z" | null = null;
  private hotkeyDragging = false;
  private hotkeyDragStartX = 0;
  private hotkeyDragStartY = 0;
  private hotkeyOriginalPos = new THREE.Vector3();
  private hotkeyOriginalRot = new THREE.Euler();
  private hotkeyOriginalScl = new THREE.Vector3();

  constructor(
    private esm: ExtractorSceneManager,
    private canvas: HTMLCanvasElement,
    private onCameraKeyframeChange: (kf: CameraKeyframe) => void,
    private getCueConfig: () => CueConfig,
    private onSelectionChange?: (info: SelectionInfo) => void,
    private onObjectTransform?: (
      info: SelectionInfo,
      position: THREE.Vector3,
      rotation: THREE.Euler,
      scale: THREE.Vector3
    ) => void,
    private onTransformModeChange?: (mode: "translate" | "rotate" | "scale") => void,
    private onDragStart?: () => void,
    private onDragEnd?: () => void
  ) {
    const godCam = esm.getGodCamera();
    if (godCam) {
      this.orbitControls = new OrbitControls(godCam, canvas);
      this.orbitControls.enableDamping = true;
      this.orbitControls.dampingFactor = 0.1;
      this.orbitControls.target.set(0, 3, 0);

      this.transformControls = new TransformControls(godCam, canvas);
      this.transformControls.setMode("translate");
      this.transformControls.setSize(0.8);
      esm.getScene().add(this.transformControls.getHelper());

      this.transformControls.addEventListener(
        "dragging-changed",
        (event: { value: unknown }) => {
          if (this.orbitControls)
            this.orbitControls.enabled = !event.value;
          if (event.value) {
            // Pause spin during gizmo drag to prevent fighting
            this.esm.pauseSpin();
            this.onDragStart?.();
          } else {
            this.esm.resumeSpin();
            this.onDragEnd?.();
          }
        }
      );

      this.transformControls.addEventListener("objectChange", () => {
        if (
          this.currentSelection.type &&
          this.currentSelection.object &&
          this.onObjectTransform
        ) {
          const obj = this.currentSelection.object;
          this.onObjectTransform(
            { ...this.currentSelection },
            obj.position.clone(),
            obj.rotation.clone(),
            obj.scale.clone()
          );
        }
        // Keep frustum lines in sync when camera gizmo is dragged
        if (this.currentSelection.type === "camera") {
          this.esm.syncCameraFromGizmo();
        }
      });
    }

    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);

    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    canvas.addEventListener("mousedown", this.boundMouseDown);
    window.addEventListener("mouseup", this.boundMouseUp);
    canvas.addEventListener("mousemove", this.boundMouseMove);
  }

  // ---------------------------------------------------------------------------
  // Raycasting & Selection
  // ---------------------------------------------------------------------------

  private getNDC(e: MouseEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  private performRaycast(e: MouseEvent): SelectionInfo {
    const godCam = this.esm.getGodCamera();
    if (!godCam) return { type: null };

    this.mouse.copy(this.getNDC(e));
    this.raycaster.setFromCamera(this.mouse, godCam);

    const selectables = this.esm.getSelectableObjects();
    const intersects = this.raycaster.intersectObjects(selectables, true);

    for (const hit of intersects) {
      const info = this.resolveHit(hit.object);
      if (info) return info;
    }
    return { type: null };
  }

  /** Walk up the parent chain to find the selectable root with userData.type */
  private resolveHit(obj: THREE.Object3D): SelectionInfo | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      const ud = current.userData as Record<string, unknown>;
      if (ud?.type) {
        const t = ud.type as string;
        switch (t) {
          case "camera":
            return { type: "camera", object: current };
          case "cue":
            return { type: "cue", object: current };
          case "wall":
            return { type: "wall", object: current };
          case "table":
            return { type: "table", object: current };
          case "wallFrame":
            return {
              type: "wallFrame",
              frameId: ud.frameId as string | undefined,
              object: current,
            };
          case "tableFrame":
            return {
              type: "tableFrame",
              frameId: ud.frameId as string | undefined,
              object: current,
            };
        }
      }
      current = current.parent;
    }
    return null;
  }

  private setSelection(info: SelectionInfo): void {
    // Skip if same object already selected
    if (
      this.currentSelection.type === info.type &&
      this.currentSelection.object === info.object
    ) {
      return;
    }

    // Cancel any active hotkey drag before changing selection
    if (this.activeHotkey) {
      this.endHotkeyDrag(false);
    }

    this.clearHighlight();
    this.detachTransformControls();
    this.resetAxisLock();

    this.currentSelection = info;

    if (info.type && info.object) {
      this.applyHighlight(info);

      if (TRANSFORMABLE_TYPES.has(info.type) && this.transformControls) {
        this.transformControls.attach(info.object);
      }
    }

    this.onSelectionChange?.({ ...info });
  }

  // ---------------------------------------------------------------------------
  // Highlight helpers
  // ---------------------------------------------------------------------------

  private applyHighlight(info: SelectionInfo): void {
    if (!info.object) return;

    if (info.type === "camera") {
      // Tint camera gizmo children yellow via emissive
      info.object.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const mats = Array.isArray(child.material)
            ? child.material
            : [child.material];
          for (const mat of mats) {
            if ("emissive" in mat) {
              const m = mat as THREE.MeshStandardMaterial;
              this.savedEmissives.set(mat, m.emissive.clone());
              m.emissive.setHex(HIGHLIGHT_COLOR);
            }
          }
        }
      });
      return;
    }

    // For other objects, add a wireframe overlay
    const wireframe = this.createWireframeOverlay(info.object);
    if (wireframe) {
      info.object.add(wireframe);
      this.highlightObjects.push(wireframe);
    }
  }

  private createWireframeOverlay(
    source: THREE.Object3D
  ): THREE.Object3D | null {
    // Find the first mesh geometry in the object or its children
    let geo: THREE.BufferGeometry | null = null;
    if (source instanceof THREE.Mesh) {
      geo = source.geometry;
    } else {
      source.traverse((child) => {
        if (!geo && child instanceof THREE.Mesh) {
          geo = child.geometry;
        }
      });
    }
    if (!geo) return null;

    const wireGeo = new THREE.WireframeGeometry(geo);
    const wireMat = new THREE.LineBasicMaterial({
      color: HIGHLIGHT_COLOR,
      linewidth: 1,
      depthTest: true,
      transparent: true,
      opacity: 0.6,
    });
    const wireObj = new THREE.LineSegments(wireGeo, wireMat);
    wireObj.userData.__selectionHighlight = true;
    wireObj.raycast = () => {}; // Prevent highlight from intercepting raycasts
    return wireObj;
  }

  private clearHighlight(): void {
    // Remove wireframe overlays
    for (const obj of this.highlightObjects) {
      obj.parent?.remove(obj);
      if (obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    }
    this.highlightObjects = [];

    // Restore saved emissives (camera gizmo)
    for (const [mat, color] of this.savedEmissives) {
      if ("emissive" in mat) {
        (mat as THREE.MeshStandardMaterial).emissive.copy(color);
      }
    }
    this.savedEmissives.clear();
  }

  private detachTransformControls(): void {
    if (this.transformControls?.object) {
      this.transformControls.detach();
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleKeyDown(e: KeyboardEvent) {
    if (!this._enabled) return;
    if (e.repeat) return;
    const key = e.key.toLowerCase();

    // Axis lock while hotkey is active: G then X/Y/Z
    if ((key === "x" || key === "y" || key === "z") && this.activeHotkey && this.currentSelection.object) {
      this.hotkeyAxisLock = key as "x" | "y" | "z";
      // Also update TransformControls axis visibility for visual feedback
      this.setAxisLock(key as "x" | "y" | "z");
      return;
    }

    // G/R/S hotkey — activate immediate drag mode
    if ((key === "g" || key === "r" || key === "s") && this.currentSelection.object) {
      if (key === "s" && this.currentSelection.type === "camera") return;
      const mode = key === "g" ? "translate" : key === "r" ? "rotate" : "scale";
      this.activeHotkey = key;
      this.hotkeyAxisLock = null;
      this.hotkeyDragging = false;

      // Save original transform for relative delta computation
      const obj = this.currentSelection.object;
      this.hotkeyOriginalPos.copy(obj.position);
      this.hotkeyOriginalRot.copy(obj.rotation);
      this.hotkeyOriginalScl.copy(obj.scale);

      // Pause spin animation to prevent fighting with manual rotation
      this.esm.pauseSpin();

      // Hide TransformControls gizmo to avoid conflict
      if (this.transformControls) {
        this.transformControls.setMode(mode);
        this.transformControls.enabled = false;
      }
      if (this.orbitControls) this.orbitControls.enabled = false;
      this.onTransformModeChange?.(mode);
      this.resetAxisLock();
      return;
    }

    // Escape → cancel hotkey drag or deselect
    if (key === "escape") {
      if (this.activeHotkey && this.currentSelection.object) {
        // Cancel — restore original transform
        const obj = this.currentSelection.object;
        obj.position.copy(this.hotkeyOriginalPos);
        obj.rotation.copy(this.hotkeyOriginalRot);
        obj.scale.copy(this.hotkeyOriginalScl);
        this.endHotkeyDrag(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.setSelection({ type: null });
    }
  }

  private handleKeyUp(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    if ((key === "g" || key === "r" || key === "s") && this.activeHotkey === key) {
      // Commit the transform on key release
      this.endHotkeyDrag(true);
    }
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.activeHotkey || !this.currentSelection.object) return;

    if (!this.hotkeyDragging) {
      // Start dragging on first mouse move after hotkey press
      this.hotkeyDragging = true;
      this.hotkeyDragStartX = e.clientX;
      this.hotkeyDragStartY = e.clientY;
      this.onDragStart?.();
    }

    const dx = (e.clientX - this.hotkeyDragStartX) / this.canvas.clientWidth;
    const dy = (e.clientY - this.hotkeyDragStartY) / this.canvas.clientHeight;
    const obj = this.currentSelection.object;

    if (this.activeHotkey === "g") {
      // Translate: map screen-space delta to world-space
      const speed = 20;
      const pos = this.hotkeyOriginalPos.clone();
      const axis = this.hotkeyAxisLock;
      if (!axis || axis === "x") pos.x += dx * speed;
      if (!axis || axis === "y") pos.y -= dy * speed;
      if (axis === "z") pos.z += dx * speed;
      obj.position.copy(pos);
    } else if (this.activeHotkey === "r") {
      // Rotate: drag UP = increase value, drag DOWN = decrease value
      const angle = -dy * Math.PI * 2;
      const rot = this.hotkeyOriginalRot.clone();
      const axis = this.hotkeyAxisLock ?? "y";
      if (axis === "x") rot.x += angle;
      if (axis === "y") rot.y += angle;
      if (axis === "z") rot.z += angle;
      obj.rotation.copy(rot);
    } else if (this.activeHotkey === "s") {
      // Scale: horizontal mouse = uniform or axis scale
      const factor = 1 + dx * 2;
      const scl = this.hotkeyOriginalScl.clone();
      const axis = this.hotkeyAxisLock;
      if (!axis) {
        scl.multiplyScalar(factor);
      } else {
        if (axis === "x") scl.x *= factor;
        if (axis === "y") scl.y *= factor;
        if (axis === "z") scl.z *= factor;
      }
      obj.scale.copy(scl);
    }

    // Fire transform callback
    this.onObjectTransform?.(
      { ...this.currentSelection },
      obj.position.clone(),
      obj.rotation.clone(),
      obj.scale.clone()
    );
    if (this.currentSelection.type === "camera") {
      this.esm.syncCameraFromGizmo();
    }
  }

  private endHotkeyDrag(commit: boolean): void {
    if (this.hotkeyDragging && commit) {
      // Fire final transform to ensure config is fully synced before drag end
      if (this.currentSelection.object) {
        const obj = this.currentSelection.object;
        this.onObjectTransform?.(
          { ...this.currentSelection },
          obj.position.clone(),
          obj.rotation.clone(),
          obj.scale.clone()
        );
      }
      this.onDragEnd?.();
    } else if (this.hotkeyDragging) {
      // Cancel — fire transform to revert UI state
      if (this.currentSelection.object) {
        this.onObjectTransform?.(
          { ...this.currentSelection },
          this.currentSelection.object.position.clone(),
          this.currentSelection.object.rotation.clone(),
          this.currentSelection.object.scale.clone()
        );
      }
      this.onDragEnd?.();
    }
    this.activeHotkey = null;
    this.hotkeyAxisLock = null;
    this.hotkeyDragging = false;
    // Resume spin animation
    this.esm.resumeSpin();
    // Restore controls
    if (this.transformControls) this.transformControls.enabled = true;
    if (this.orbitControls) this.orbitControls.enabled = this._enabled;
    this.resetAxisLock();
  }

  private setAxisLock(axis: "x" | "y" | "z"): void {
    if (!this.transformControls) return;
    this.transformControls.showX = axis === "x";
    this.transformControls.showY = axis === "y";
    this.transformControls.showZ = axis === "z";
  }

  private resetAxisLock(): void {
    if (!this.transformControls) return;
    this.transformControls.showX = true;
    this.transformControls.showY = true;
    this.transformControls.showZ = true;
  }

  private handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if (this.activeHotkey) return; // Suppress during hotkey drag
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent) {
    if (!this._enabled) return;
    if (e.button !== 0) return;
    if (this.activeHotkey) return; // Suppress during hotkey drag
    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (Math.sqrt(dx * dx + dy * dy) >= CLICK_THRESHOLD_PX) return;

    // Don't select when TransformControls consumed the interaction
    if (this.transformControls?.dragging) return;

    const info = this.performRaycast(e);
    this.setSelection(info);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getSelection(): SelectionInfo {
    return { ...this.currentSelection };
  }

  /** Programmatically deselect the current object */
  deselect(): void {
    this.setSelection({ type: null });
  }

  private _enabled = true;

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (this.orbitControls) this.orbitControls.enabled = enabled;
    if (this.transformControls) this.transformControls.enabled = enabled;
    if (!enabled) {
      if (this.activeHotkey) this.endHotkeyDrag(false);
      this.setSelection({ type: null });
    }
  }

  setTransformMode(mode: "translate" | "rotate" | "scale"): void {
    if (this.transformControls) {
      this.transformControls.setMode(mode);
      this.onTransformModeChange?.(mode);
    }
  }

  getTransformMode(): "translate" | "rotate" | "scale" {
    return (this.transformControls?.mode as "translate" | "rotate" | "scale") ?? "translate";
  }

  /** Apply typed transform values to the currently selected object */
  applyTransform(
    position: THREE.Vector3,
    rotation: THREE.Euler,
    scale: THREE.Vector3
  ): void {
    if (!this.currentSelection.object) return;
    const obj = this.currentSelection.object;
    obj.position.copy(position);
    obj.rotation.copy(rotation);
    obj.scale.copy(scale);

    // Trigger the same sync as dragging
    this.onObjectTransform?.(
      { ...this.currentSelection },
      obj.position.clone(),
      obj.rotation.clone(),
      obj.scale.clone()
    );
    if (this.currentSelection.type === "camera") {
      this.esm.syncCameraFromGizmo();
    }
  }

  update(): void {
    if (this.orbitControls) this.orbitControls.update();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    this.canvas.removeEventListener("mousedown", this.boundMouseDown);
    window.removeEventListener("mouseup", this.boundMouseUp);
    this.canvas.removeEventListener("mousemove", this.boundMouseMove);

    this.clearHighlight();
    this.detachTransformControls();

    if (this.transformControls) {
      this.esm.getScene().remove(this.transformControls.getHelper());
      this.transformControls.dispose();
      this.transformControls = null;
    }

    if (this.orbitControls) {
      this.orbitControls.dispose();
      this.orbitControls = null;
    }
  }
}
