// Three.js modules for cue customizer

export * from "./scene-manager";
export * from "./leather-config";
export * from "./leather-frame";
export * from "./leather-material";
export * from "./leather-overlay";

// Re-export key functions for convenience
export {
  isRubberMaterial,
  isTopCapMaterial,
  isTopCapFaceMaterial,
  RUBBER_CONFIG,
  TOP_CAP_CONFIG,
} from "./leather-config";

export {
  createRubberMaterial,
  createTopCapMaterial,
  createTopCapFaceMaterial,
  loadBumperLogo,
  loadTopCapLogo,
  loadAllLogos,
} from "./leather-material";
