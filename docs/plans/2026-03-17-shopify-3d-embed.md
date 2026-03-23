# Shopify Product Page 3D Embed (metafield-driven)

## What we’re building
We will reuse the working Three.js preview logic from this repo (the `SceneManager` pipeline: load GLB → apply surface → apply HDRI + material tuning), but **the data source changes**:

- **Before (Next.js preview):** product + settings loaded from Supabase.
- **Now (Shopify):**
  - **Config JSON** comes from a **Shopify product metafield**.
  - **GLB model URL** comes from **Shopify product media** (3D model).
  - **All supporting assets** (HDRI, logos, default textures) are hosted in Shopify (theme assets or Shopify Files) and referenced by URL.

The Shopify theme will render **one container div** + include our JS.

---

## 1) Shopify Admin setup

### 1.1 Create a product metafield definition for the config JSON
**Admin → Settings → Custom data → Products → Add definition**

- Name: `Cue 3D Config`
- Namespace and key: `custom.cue_3d_config`
- Type: **JSON**
- Access: keep default (storefront readable)

This metafield will hold the exported JSON from our editor (see **Section 2**).

### 1.2 Add the 3D model to the product
In the Shopify product editor:
- Add media → upload the **.glb** as a **3D model**.

We will automatically pick the first `media_type == 'model'` item.

### 1.3 Gate the feature with a product tag
Add the tag:
- `3d`

We’ll use your Liquid gate:
```liquid
{% if product.tags contains '3d' %}
  <!-- mount our 3D code -->
{% endif %}
```

### 1.4 Upload all required assets into Shopify
You said you will wire this part; here’s the checklist of what must exist in Shopify:

**A) JS assets (theme assets, multi-file no-bundle):**
Upload these files from this repo’s `shopify/assets/` folder into your Shopify theme `assets/`:
- `cue-3d-init.js` (entry)
- `cue3d-three-scene-manager.js`
- `cue3d-three-material-detect.js`
- `cue3d-utils.js`

Optional (recommended):
- `cue-3d-viewer.css`

> Note: this modular approach is much easier to debug/extend than a single bundle.

**B) HDRI file(s):**
- One or more `.hdr` files hosted on Shopify Files/CDN.

**C) Normal map textures (optional):**
- If you want leather normal detail, set `texture_url` in the metafield JSON to a public normal-map URL (Shopify Files/CDN).

**D) Any default textures you rely on (optional):**
- If a product doesn’t provide a `surface_url`, decide a fallback in your JSON or in code.

> Important: Shopify asset URLs typically look like `/cdn/shop/t/<theme-id>/assets/<file>?v=<hash>` or `https://cdn.shopify.com/...`.
> You must also add a small `importmap` in Liquid so Three.js can be loaded from CDN (see Section 3.1).

---

## 2) Create the JSON config (metafield value)

### 2.1 Export JSON from your dashboard editor
In this repo, the editor UI already has:
- **Export → Copy JSON Metadata**

That exports a JSON object like:
```json
{
  "type": "leather",
  "surface_url": "https://...",
  "texture_type": "crocodile",
  "texture_url": null,
  "color": "black",
  "assets": {
    "logoUrl": "https://cdn.shopify.com/.../logo.png"
  },
  "config": {
    "toneMapping": "agx",
    "hdriExposure": 1,
    "hdriType": "https://cdn.shopify.com/.../bloem_train_track_clear_2k.hdr",
    "textureScale": 1,
    "lighting": {
      "ambient": 0.55,
      "hemisphere": 0.4,
      "clearcoat": 5,
      "bodyRoughness": 0
    },
    "leather": {
      "roughness": 120,
      "sheen": 80,
      "normalStrength": 3
    }
  }
}
```

### 2.2 Paste it into Shopify metafield
In the product editor:
- Metafields → `Cue 3D Config` → paste the JSON

### 2.3 Convert `hdriType` into an HDRI URL (recommended)
In Shopify, we want `hdriType` to be a **URL** to the `.hdr`, not just a filename.

Example:
```json
"hdriType": "https://cdn.shopify.com/s/files/.../bloem_train_track_clear_2k.hdr"
```

If you keep it as a filename, the current code will try to load it from `/hdri/<filename>` which does **not** exist on Shopify.

---

## 3) Theme implementation (Liquid)

### 3.1 Add a snippet (recommended)
Create a snippet file:
- `snippets/cue-3d-viewer.liquid`

Paste this:
```liquid
{% comment %}
  Cue 3D Viewer
  Requirements:
  - product.tags contains '3d'
  - product.metafields.custom.cue_3d_config is filled (JSON)
  - product has a 3D model media (media_type == 'model')
{% endcomment %}

{% if product.tags contains '3d' %}
  {% assign cfg = product.metafields.custom.cue_3d_config.value %}

  {% assign model_media = product.media | where: 'media_type', 'model' | first %}
  {% assign model_source = nil %}
  {% if model_media and model_media.sources %}
    {% assign model_source = model_media.sources | where: 'format', 'glb' | first %}
    {% if model_source == nil %}
      {% assign model_source = model_media.sources | first %}
    {% endif %}
  {% endif %}

  {% assign model_url = '' %}
  {% if model_source and model_source.url %}
    {% assign model_url = model_source.url %}
  {% endif %}

  {% if cfg != blank and model_url != blank %}
    <div
      id="cue-3d-viewer"
      class="cue-3d-viewer"
      data-cue-3d-viewer
      data-cue-model-url="{{ model_url | escape }}"
      data-cue-config='{{ cfg | json | escape }}'
      {% comment %} Optional: set to 1/true to log material detection + targeting {% endcomment %}
      data-cue-debug="0"
    ></div>

    {%- comment -%}
      IMPORTANT:
      - We load Three.js from CDN (no build).
      - Three addon modules use bare imports, so we must define an importmap BEFORE our module script.
    {%- endcomment -%}
    <script type="importmap">
      {
        "imports": {
          "three": "https://cdn.jsdelivr.net/npm/three@0.183.1/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.183.1/examples/jsm/"
        }
      }
    </script>

    <script type="module" src="{{ 'cue-3d-init.js' | asset_url }}"></script>

  {% else %}
    {%- comment -%} Missing metafield JSON or GLB model {%- endcomment -%}
  {% endif %}
{% endif %}
```

### 3.2 Render the snippet in your product template
Depending on your theme:

**OS 2.0 (sections):**
- Add the snippet inside your main product section, typically:
  - `sections/main-product.liquid`

Example insertion:
```liquid
{% render 'cue-3d-viewer' %}
```

---

## 4) JavaScript init (Shopify, modular no-bundle)

We ship plain ES modules (no bundling) under `shopify/assets/` and upload them to Shopify theme `assets/`.

- Entry: `cue-3d-init.js`
- Viewer core: `cue3d-three-scene-manager.js`
- Helpers: `cue3d-three-material-detect.js`, `cue3d-utils.js`

### Inputs (single container)
The viewer reads everything from one container element:
- `data-cue-model-url` → GLB URL (Shopify product media)
- `data-cue-config` → metafield JSON string (same shape as your dashboard export)

### What it renders (preview only)
- Loads Three.js + addons from CDN (via importmap)
- Uses a **default studio IBL** (Three.js `RoomEnvironment`) if you don’t provide an HDRI
- If `config.hdriType` is set (absolute URL), loads it as the HDRI environment
- **Lighting: HDRI is the sole lighting source** (no ambient/hemisphere fill lights). A subtle bottom point light illuminates the bumper area.
- Loads GLB from `data-cue-model-url`
- Applies `surface_url` as the base map
- If `texture_url` is set, uses it as a normal map (tiling via `config.textureScale`)
- Applies tuning from:
  - `config.lighting` (body roughness + clearcoat — `ambient`/`hemisphere` values are ignored; HDRI is primary)
  - `config.leather` (roughness/sheen/normalStrength)
  - `config.joint` (top cap/joint roughness/clearcoat/metalness)
  - `config.cylinder` (wrap/cylinder roughness/clearcoat/metalness/color/normalScale/sheen)
- **Controls:**
  - Left-click drag: rotate model (turntable)
  - Right-click drag: pan camera vertically
  - Scroll wheel: zoom
  - Touch: pinch to zoom, single-finger drag to rotate
- **Auto surface targeting:**
  - If the GLB has a `cylinder`/`wrap` material with **no map**, we apply the surface to that wrap.
  - Otherwise we apply the surface to the “body/outside” materials.
  - You can override with `config.surfaceTarget`: `"auto" | "cylinder" | "body" | "all"`.

Debugging:
- Add `data-cue-debug="1"` on the container to log material detection + targeting decisions.

No dashboard/editor logic is included.

> If you ever need manual mounting, `cue-3d-init.js` exports `mountCue3DViewer(container)`.

---

## 5) Minimal CSS (optional but recommended)
Add to your theme CSS (or a small asset like `cue-3d-viewer.css`):
```css
.cue-3d-viewer {
  width: 100%;
  height: 420px;
  position: relative;
}

@media (min-width: 768px) {
  .cue-3d-viewer { height: 520px; }
}
```

---

## 6) Common issues / debugging checklist

1. **No model loads**
   - Confirm product has a 3D model media.
   - Confirm `model_url` is not blank (view-source and search for `data-cue-model-url`).

2. **Surface image not applied**
   - Confirm `surface_url` is a valid, public image URL.
   - Confirm the image server allows cross-origin image usage (Shopify CDN does).

3. **HDRI fails to load**
   - Confirm the `.hdr` URL is reachable in the browser.
   - Make sure the JS code treats `https://...` as a direct URL (not `/hdri/<encoded>`).

4. **Console logs**
   - The current viewer logs heavily (`[SceneManager] ...`). Use that to validate each stage:
     - constructor
     - HDRI load
     - GLB load
     - surface apply

---

## 7) Recommended “done” criteria
On a tagged product page:
- Container renders
- GLB loads from Shopify media
- HDRI loads from Shopify-hosted URL
- Surface image applies correctly
- Auto-rotate + drag rotation works
- No console errors in normal flow

---

## 8) No-build workflow (recommended)
There is **no bundling step** for the modular embed.

1. Upload the files in `shopify/assets/` to your theme’s `assets/` folder.
2. Use the Liquid snippet in Section 3.1 (importmap + `cue-3d-init.js`).

### Optional fallback: legacy single-bundle build
If you ever need a single-file bundle again, you can still run:
```bash
npm install
npm run build:shopify
```
Output:
- `dist/shopify/cue-3d-bundle.js`
- `dist/shopify/cue-3d-bundle.js.map`

But for debugging/extending features, prefer the modular files.
