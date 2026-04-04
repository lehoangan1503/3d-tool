import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { CameraKeyframe, CueConfig } from "@/types/video-studio";

export class SceneViewControls {
  private orbitControls: OrbitControls | null = null;
  private activeAxis: "x" | "y" | "z" | null = null;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private isDisposed = false;

  // Bound listeners for cleanup
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;

  constructor(
    private esm: ExtractorSceneManager,
    private canvas: HTMLCanvasElement,
    private onCameraKeyframeChange: (kf: CameraKeyframe) => void,
    private getCueConfig: () => CueConfig
  ) {
    // Setup OrbitControls for god camera
    const godCam = esm.getGodCamera();
    if (godCam) {
      this.orbitControls = new OrbitControls(godCam, canvas);
      this.orbitControls.enableDamping = true;
      this.orbitControls.dampingFactor = 0.1;
      this.orbitControls.target.set(0, 2, 0);
      this.orbitControls.minDistance = 3;
      this.orbitControls.maxDistance = 30;
      this.orbitControls.maxPolarAngle = Math.PI * 0.85;
    }

    // Bind listeners
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);

    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    canvas.addEventListener("mousedown", this.boundMouseDown);
    window.addEventListener("mousemove", this.boundMouseMove);
    window.addEventListener("mouseup", this.boundMouseUp);
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === "x") this.activeAxis = "x";
    else if (key === "y") this.activeAxis = "y";
    else if (key === "z") this.activeAxis = "z";
  }

  private handleKeyUp(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    if (
      (key === "x" && this.activeAxis === "x") ||
      (key === "y" && this.activeAxis === "y") ||
      (key === "z" && this.activeAxis === "z")
    ) {
      this.activeAxis = null;
    }
  }

  private handleMouseDown(e: MouseEvent) {
    // Only handle left-click when an axis key is held
    // (OrbitControls handles regular drags on the god camera)
    if (e.button !== 0) return;
    if (this.activeAxis === null) return;

    e.preventDefault();
    e.stopPropagation();
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    // Disable orbit controls while axis-locked dragging
    if (this.orbitControls) this.orbitControls.enabled = false;
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isDragging) return;

    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    // Move studio camera with axis lock
    this.esm.moveStudioCamera(dx, dy, this.activeAxis);

    // Sync back to UI
    const cueConfig = this.getCueConfig();
    const kf = this.esm.getCameraKeyframeFromPosition(cueConfig);
    this.onCameraKeyframeChange(kf);
  }

  private handleMouseUp(_e: MouseEvent) {
    if (!this.isDragging) return;
    this.isDragging = false;

    // Re-enable orbit controls
    if (this.orbitControls) this.orbitControls.enabled = true;
  }

  /** Get the currently held axis for visual feedback in UI */
  getActiveAxis(): "x" | "y" | "z" | null {
    return this.activeAxis;
  }

  /** Enable/disable controls (disable during recording, etc.) */
  setEnabled(enabled: boolean): void {
    if (this.orbitControls) this.orbitControls.enabled = enabled;
  }

  /** Call each frame to update damping on OrbitControls */
  update(): void {
    if (this.orbitControls) this.orbitControls.update();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    this.canvas.removeEventListener("mousedown", this.boundMouseDown);
    window.removeEventListener("mousemove", this.boundMouseMove);
    window.removeEventListener("mouseup", this.boundMouseUp);

    if (this.orbitControls) {
      this.orbitControls.dispose();
      this.orbitControls = null;
    }
  }
}
