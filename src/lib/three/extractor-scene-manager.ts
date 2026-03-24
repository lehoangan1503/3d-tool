import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type {
  ImageExtractorConfig,
  VideoExtractorConfig,
  PartViewConfig,
} from '@/types/extractor';
import {
  createFabricTexture,
  createStudioBackdrop,
  createShadowFloor,
} from './studio-background';

/**
 * Detect best supported video format for MediaRecorder
 */
function getSupportedMimeType(): string {
  const types = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];

  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return 'video/webm'; // Fallback
}

/**
 * Specialized Three.js scene manager for high-quality image and video extraction.
 * Creates an offscreen WebGL renderer with preserveDrawingBuffer for canvas capture.
 */
export class ExtractorSceneManager {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private model: THREE.Group | null = null;
  private clonedModel: THREE.Group | null = null;
  private pmremGenerator: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private isDisposed = false;

  // Studio elements (for video)
  private backdrop: THREE.Mesh | null = null;
  private shadowFloor: THREE.Mesh | null = null;
  private spotLight: THREE.SpotLight | null = null;
  private fillLights: THREE.PointLight[] = [];

  // Animation state
  private animationFrameId: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  constructor(
    private width: number = 2048,
    private height: number = 2048
  ) {
    // Create offscreen renderer with preserveDrawingBuffer for canvas capture
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1); // Fixed for consistent output
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(2, 0, 2);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.setupBasicLighting();
  }

  private setupBasicLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.scene.add(hemi);
  }

  setupStudioLighting(config: VideoExtractorConfig) {
    this.clearStudioElements();

    // Key spotlight
    this.spotLight = new THREE.SpotLight(0xffffff, 2);
    this.spotLight.position.set(3, 4, 2);
    this.spotLight.angle = Math.PI / 4;
    this.spotLight.penumbra = 0.5;
    this.spotLight.decay = 1.5;
    this.spotLight.distance = 20;
    this.spotLight.castShadow = true;
    this.spotLight.shadow.mapSize.width = 2048;
    this.spotLight.shadow.mapSize.height = 2048;
    this.spotLight.shadow.camera.near = 0.5;
    this.spotLight.shadow.camera.far = 20;
    this.spotLight.shadow.bias = -0.0001;
    this.spotLight.shadow.radius = config.shadowBlur;
    this.scene.add(this.spotLight);

    // Fill lights
    const fillPositions: [number, number, number][] = [
      [-2, 1, 2],
      [0, -2, 3],
      [2, 0, -1],
    ];
    fillPositions.forEach(([x, y, z]) => {
      const fill = new THREE.PointLight(0xffffff, 0.3);
      fill.position.set(x, y, z);
      this.fillLights.push(fill);
      this.scene.add(fill);
    });

    // Fabric backdrop
    const fabricTexture = createFabricTexture(
      1024,
      1024,
      config.backgroundColor
    );
    this.backdrop = createStudioBackdrop(fabricTexture);
    this.scene.add(this.backdrop);

    // Shadow floor
    if (config.enableShadow) {
      this.shadowFloor = createShadowFloor();
      this.scene.add(this.shadowFloor);
    }
  }

  private clearStudioElements() {
    if (this.spotLight) {
      this.scene.remove(this.spotLight);
      this.spotLight.dispose();
      this.spotLight = null;
    }
    this.fillLights.forEach((light) => {
      this.scene.remove(light);
      light.dispose();
    });
    this.fillLights = [];
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      (this.backdrop.material as THREE.Material).dispose();
      this.backdrop.geometry.dispose();
      this.backdrop = null;
    }
    if (this.shadowFloor) {
      this.scene.remove(this.shadowFloor);
      (this.shadowFloor.material as THREE.Material).dispose();
      this.shadowFloor.geometry.dispose();
      this.shadowFloor = null;
    }
  }

  async loadHDRI(hdriUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const loader = new RGBELoader();
      loader.load(
        hdriUrl,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          const rt = this.pmremGenerator.fromEquirectangular(texture);
          texture.dispose();

          if (this.envRenderTarget) {
            this.envRenderTarget.dispose();
          }
          this.envRenderTarget = rt;
          this.scene.environment = rt.texture;
          resolve();
        },
        undefined,
        reject
      );
    });
  }

  setModel(sourceModel: THREE.Group) {
    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    this.clonedModel = sourceModel.clone(true);

    this.clonedModel.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });

    this.model = this.clonedModel;
    this.scene.add(this.clonedModel);
  }

  private disposeModel(model: THREE.Group) {
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  private positionCameraForPart(partConfig: PartViewConfig, partCenterY: number) {
    const { cameraDistance, cameraAngleX, cameraAngleY, zoom } = partConfig;

    const x = cameraDistance * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
    const y = partCenterY + cameraDistance * Math.sin(cameraAngleX);
    const z = cameraDistance * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, partCenterY, 0);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  captureFrame(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  async captureImageParts(config: ImageExtractorConfig): Promise<string> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    this.renderer.setSize(config.width, config.height);
    this.camera.aspect = config.width / config.height;
    this.camera.updateProjectionMatrix();

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = config.width;
    outputCanvas.height = config.height;
    const ctx = outputCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, config.width, config.height);

    const box = new THREE.Box3().setFromObject(this.model);
    const modelHeight = box.max.y - box.min.y;
    const modelCenter = box.getCenter(new THREE.Vector3());

    const partYPositions = {
      bottomBump: modelCenter.y - modelHeight * 0.4,
      centerCue: modelCenter.y,
      topCap: modelCenter.y + modelHeight * 0.4,
    };

    this.model.rotation.set(0, Math.PI / 4, 0);

    for (const [partName, partConfig] of Object.entries(config.parts)) {
      const partKey = partName as keyof typeof config.parts;
      const partCenterY = partYPositions[partKey];

      this.positionCameraForPart(partConfig, partCenterY);
      this.renderer.render(this.scene, this.camera);

      const { x, y, width, height } = partConfig.bounds;
      const destX = x * config.width;
      const destY = y * config.height;
      const destW = width * config.width;
      const destH = height * config.height;

      ctx.drawImage(
        this.renderer.domElement,
        0,
        0,
        config.width,
        config.height,
        destX,
        destY,
        destW,
        destH
      );
    }

    let dataUrl: string;
    switch (config.format) {
      case 'jpeg':
        dataUrl = outputCanvas.toDataURL('image/jpeg', config.quality);
        break;
      case 'webp':
        dataUrl = outputCanvas.toDataURL('image/webp', config.quality);
        break;
      default:
        dataUrl = outputCanvas.toDataURL('image/png');
    }

    return dataUrl;
  }

  async startVideoRecording(
    config: VideoExtractorConfig,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    return new Promise((resolve, reject) => {
      this.renderer.setSize(config.width, config.height);
      this.camera.aspect = config.width / config.height;
      this.camera.updateProjectionMatrix();

      this.setupStudioLighting(config);
      this.model!.rotation.set(0, 0, -config.cueAngle);

      const stream = this.renderer.domElement.captureStream(config.fps);
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: getSupportedMimeType(),
        videoBitsPerSecond: config.bitrate,
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const mimeType = getSupportedMimeType();
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        resolve(blob);
      };

      this.mediaRecorder.onerror = () => {
        reject(new Error('Recording failed'));
      };

      const totalFrames = config.fps * config.duration;
      let currentFrame = 0;
      const cameraDistance = 2;

      const animate = () => {
        if (this.isDisposed || currentFrame >= totalFrames) {
          this.mediaRecorder?.stop();
          this.animationFrameId = null;
          return;
        }

        const progress = currentFrame / totalFrames;
        onProgress?.(Math.round(progress * 100));

        this.model!.rotation.y += config.rotationSpeed / config.fps;

        const panY =
          config.panStartY + (config.panEndY - config.panStartY) * progress;
        this.camera.position.set(
          cameraDistance * Math.cos(Math.PI / 6),
          panY,
          cameraDistance * Math.sin(Math.PI / 6)
        );
        this.camera.lookAt(0, panY, 0);

        this.renderer.render(this.scene, this.camera);

        currentFrame++;
        this.animationFrameId = requestAnimationFrame(animate);
      };

      this.mediaRecorder.start();
      animate();
    });
  }

  stopRecording() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.isDisposed = true;
    this.stopRecording();
    this.clearStudioElements();

    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }

    this.pmremGenerator.dispose();
    this.renderer.dispose();
  }
}
