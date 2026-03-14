# Dashboard Config Sections Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add isolated config sections for Leather Cylinder and Joint Top to the dashboard, fix broken Lighting & Environment controls (clearcoat + bodyRoughness do nothing), and persist all new settings to the database.

**Architecture:** Extend `ProductConfig` + `ThreeJSSettingsJson` with new per-part config fields. Add material detection helpers for the leather cylinder. Fix `updateModelMaterials()` to actually apply clearcoat/bodyRoughness to ALL meshes, and add dedicated update methods for cylinder and joint. Add new dashboard UI sections with sliders. Both mobile and desktop layouts must be updated.

**Tech Stack:** Next.js, Three.js, TypeScript, Supabase (DB), Tailwind CSS

---

## Bugs to Fix

1. **Clearcoat slider does nothing** — `updateClearcoat()` calls `updateModelMaterials()` but ALL clearcoat application code is commented out (scene-manager.ts ~line 293)
2. **Body Roughness slider does nothing for smooth products** — same issue, roughness code commented out (~line 290). For leather products, roughnessMap regeneration works but the base roughness on meshes is never set.

## What Exists Today

- `ProductConfig` (product.ts): `ambientLight`, `hemisphereLight`, `clearcoat`, `bodyRoughness`, `leatherRoughness`, `leatherSheen`, `normalStrength`, `textureScale`
- `ThreeJSSettingsJson` (product.ts): `lighting.{ambientLight, hemisphereLight, clearcoat, bodyRoughness}`, `material.{leatherRoughness, sheen, normalStrength, textureScale}`
- `TOP_CAP_CONFIG` (leather-config.ts): has `roughness: 0` but no clearcoat/metalness
- Leather cylinder: exists in GLB model, comment says "Cylinder object not Mesh" — needs verification. Either fix traversal or add cylinder-specific matching.
- Dashboard: "Lighting & Environment" section has 4 controls (ambient, hemisphere, clearcoat, bodyRoughness). Leather sections commented out.

---

### Task 1: Extend Data Types for Per-Part Config

**Files:**
- Modify: `src/types/product.ts`

**Step 1: Add new fields to ProductConfig**

Add after `textureScale` field:

```typescript
// Joint Top settings (isolated config)
jointRoughness: number;      // 0-1 range (Three.js native)
jointClearcoat: number;      // 0-1 range
jointMetalness: number;      // 0-1 range

// Leather Cylinder settings (isolated config)  
cylinderRoughness: number;   // 0-1 range
cylinderClearcoat: number;   // 0-1 range
cylinderMetalness: number;   // 0-1 range
cylinderColor: string;       // hex color string
```

**Step 2: Add to ThreeJSSettingsJson**

Add new sections to the JSON structure:

```typescript
joint: {
  roughness: number;
  clearcoat: number;
  metalness: number;
};
cylinder: {
  roughness: number;
  clearcoat: number;
  metalness: number;
  color: string;
};
```

**Step 3: Update configToSettingsJson and settingsJsonToConfig**

Add the new sections to both conversion functions, with backward-compatible defaults for existing DB records that don't have these fields.

**Step 4: Update DEFAULT_SMOOTH_CONFIG and DEFAULT_LEATHER_CONFIG**

Add default values:
- Joint: roughness=0, clearcoat=0.5, metalness=0.3
- Cylinder: roughness=0.4, clearcoat=0.1, metalness=0, color="#1A1A1A"

**Step 5: Run type check**

```bash
npx tsc --noEmit
```

Expected: Type errors in scene-manager.ts and editor-client.tsx (they don't use the new fields yet — that's fine)

**Step 6: Commit**

```bash
git add src/types/product.ts
git commit -m "feat: add joint and cylinder config fields to ProductConfig and ThreeJSSettingsJson"
```

---

### Task 2: Add Cylinder Material Detection + Update Top Cap Config Type

**Files:**
- Modify: `src/lib/three/leather-config.ts`

**Step 1: Add CylinderLeatherConfigType interface**

```typescript
export interface CylinderLeatherConfigType {
  enabled: boolean;
  materialNames: string[];
  roughness: number;
  clearcoat: number;
  metalness: number;
  color: string;
}
```

**Step 2: Add CYLINDER_LEATHER_CONFIG constant**

```typescript
export const CYLINDER_LEATHER_CONFIG: CylinderLeatherConfigType = {
  enabled: true,
  materialNames: ["outside", "butt_body", "leather", "cylinder", "wrap", "body", "Mat_Leather"],
  roughness: 0.4,
  clearcoat: 0.1,
  metalness: 0,
  color: "#1A1A1A",
};
```

**Step 3: Add isCylinderLeatherMaterial() helper**

```typescript
export function isCylinderLeatherMaterial(materialName: string, meshName = ""): boolean {
  if (!CYLINDER_LEATHER_CONFIG.enabled) return false;
  const nameLower = (materialName || "").toLowerCase();
  const meshLower = (meshName || "").toLowerCase();
  return CYLINDER_LEATHER_CONFIG.materialNames.some((keyword) => {
    const keyLower = keyword.toLowerCase();
    return nameLower.includes(keyLower) || meshLower.includes(keyLower);
  });
}
```

**Step 4: Add clearcoat + metalness to TopCapConfigType**

Add `clearcoat: number` and `metalness: number` to the interface and config constant (defaults: clearcoat=0.5, metalness=0.3).

**Step 5: Commit**

```bash
git add src/lib/three/leather-config.ts
git commit -m "feat: add cylinder leather config and detection helpers"
```

---

### Task 3: Fix updateModelMaterials + Add Cylinder/Joint Update Methods

**Files:**
- Modify: `src/lib/three/scene-manager.ts`

**Step 1: Import new configs**

Add `CYLINDER_LEATHER_CONFIG`, `isCylinderLeatherMaterial` to the import from `./leather-config`.

**Step 2: Add private state for cylinder and joint configs**

```typescript
private currentCylinderConfig = {
  roughness: CYLINDER_LEATHER_CONFIG.roughness,
  clearcoat: CYLINDER_LEATHER_CONFIG.clearcoat,
  metalness: CYLINDER_LEATHER_CONFIG.metalness,
  color: CYLINDER_LEATHER_CONFIG.color,
};
private currentJointConfig = {
  roughness: TOP_CAP_CONFIG.roughness,
  clearcoat: (TOP_CAP_CONFIG as any).clearcoat ?? 0.5,
  metalness: (TOP_CAP_CONFIG as any).metalness ?? 0.3,
};
```

**Step 3: Fix updateModelMaterials() — restore clearcoat + roughness application**

The key fix: ALL meshes with MeshPhysicalMaterial should get clearcoat applied. The leather/cylinder/joint/rubber parts each get their specific overrides.

Rewrite the traversal logic:

```
For each mesh with MeshPhysicalMaterial:
  1. if isCylinderLeatherMaterial → apply cylinder config (roughness, clearcoat, metalness, color)
  2. else if isTopCap/isTopCapFace → apply joint config (roughness, clearcoat, metalness)
  3. else if isRubber → keep GLB defaults (no overrides)
  4. else → apply body config (bodyRoughness/255, clearcoat/100)
```

**Step 4: Add updateCylinderConfig() method**

```typescript
updateCylinderConfig(config: { roughness?: number; clearcoat?: number; metalness?: number; color?: string }) {
  if (config.roughness !== undefined) this.currentCylinderConfig.roughness = config.roughness;
  if (config.clearcoat !== undefined) this.currentCylinderConfig.clearcoat = config.clearcoat;
  if (config.metalness !== undefined) this.currentCylinderConfig.metalness = config.metalness;
  if (config.color !== undefined) this.currentCylinderConfig.color = config.color;
  this.updateModelMaterials();
}
```

**Step 5: Add updateJointConfig() method**

```typescript
updateJointConfig(config: { roughness?: number; clearcoat?: number; metalness?: number }) {
  if (config.roughness !== undefined) this.currentJointConfig.roughness = config.roughness;
  if (config.clearcoat !== undefined) this.currentJointConfig.clearcoat = config.clearcoat;
  if (config.metalness !== undefined) this.currentJointConfig.metalness = config.metalness;
  this.updateModelMaterials();
}
```

**Step 6: Add model object enumeration logging in loadModel()**

After `this.model = gltf.scene;`, add:
```typescript
this.model.traverse((child) => {
  if (child instanceof THREE.Mesh) {
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    console.log(`[SceneManager] GLB mesh: "${child.name}" materials: [${mats.map(m => m.name).join(', ')}]`);
  }
});
```

**Step 7: Update applySurface() similarly**

In the material application section, apply cylinder/joint configs to their respective materials (roughness, clearcoat, metalness, color).

**Step 8: Run type check**

```bash
npx tsc --noEmit
```

**Step 9: Commit**

```bash
git add src/lib/three/scene-manager.ts
git commit -m "fix: restore clearcoat/roughness application, add cylinder/joint update methods"
```

---

### Task 4: Add Dashboard UI Sections

**Files:**
- Modify: `src/components/editor/editor-client.tsx`

**Step 1: Add "Leather Cylinder" section — Desktop layout**

After the "Lighting & Environment" CollapsibleCard (~line 736), add a new CollapsibleCard:

- Title: "Leather Cylinder"
- Icon: `<Palette />`
- Controls:
  - Roughness: number input, 0-1 step 0.01, maps to `config.cylinderRoughness`
  - Clearcoat: number input, 0-1 step 0.01, maps to `config.cylinderClearcoat`
  - Metalness: number input, 0-1 step 0.01, maps to `config.cylinderMetalness`
  - Color: color input (`<input type="color">`), maps to `config.cylinderColor`

**Step 2: Add "Joint Top" section — Desktop layout**

After the Leather Cylinder section:

- Title: "Joint Top"
- Icon: `<Settings />`
- Controls:
  - Roughness: number input, 0-1 step 0.01, maps to `config.jointRoughness`
  - Clearcoat: number input, 0-1 step 0.01, maps to `config.jointClearcoat`
  - Metalness: number input, 0-1 step 0.01, maps to `config.jointMetalness`

**Step 3: Duplicate both sections for Mobile layout**

Same controls but with `-mobile` id suffixes, placed after the mobile "Lighting & Environment" section (~line 518).

**Step 4: Wire up useEffect to call scene-manager**

In the existing `useEffect` that watches `config` changes (~line 98), add:

```typescript
sceneManager.updateCylinderConfig({
  roughness: config.cylinderRoughness,
  clearcoat: config.cylinderClearcoat,
  metalness: config.cylinderMetalness,
  color: config.cylinderColor,
});
sceneManager.updateJointConfig({
  roughness: config.jointRoughness,
  clearcoat: config.jointClearcoat,
  metalness: config.jointMetalness,
});
```

Also add to `handleSceneReady` callback.

**Step 5: Run type check**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/components/editor/editor-client.tsx
git commit -m "feat: add Leather Cylinder and Joint Top config sections to dashboard"
```

---

### Task 5: Final Verification

**Step 1: Full type check**

```bash
npx tsc --noEmit
```

Expected: 0 errors

**Step 2: Build**

```bash
npm run build
```

Expected: Build succeeds

**Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```
