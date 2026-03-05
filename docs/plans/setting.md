Complete Node Setup for This Leather Type

1. Primary Grain Pattern - Voronoi Texture
   This creates the main polygonal cells you see:

Scale: 80-120 (adjust for cell size)
Randomness: 1.0
Distance: F1
Feature: Distance
Connect to ColorRamp → Position black at 0.45, white at 0.55 (creates sharp grain edges)

2. Cell Edge Definition - Voronoi Texture (same coordinate)

Scale: Same as above (80-120)
Randomness: 1.0
Distance: Edge Distance or use F2-F1
Feature: Distance to Edge
Connect to ColorRamp → Position for thin, crisp edges (0.0 to 0.05)
This creates the wrinkle lines between grain polygons

3. Grain Size Variation - Voronoi Texture

Scale: 30-50 (larger cells)
Randomness: 1.0
Use Distance output → ColorRamp → Mix with main grain (Factor: 0.3-0.4)
This creates the size variation you see in natural leather

4. Fine Surface Texture - Noise Texture
   For the subtle micro-texture within each grain cell:

Scale: 400-600
Detail: 8-10
Roughness: 0.6
Distortion: 0.5
Very subtle mix (Factor: 0.15-0.2)

5. Large Wrinkles/Creases - Noise Texture

Scale: 3-8
Detail: 2-3
Roughness: 0.7
Distortion: 2.0
Mix with Overlay at Factor: 0.25

6. Wave Texture (Optional but Recommended)
   For directional grain flow:

Wave Type: Bands
Bands Direction: Y or Z
Scale: 15-25
Distortion: 3-5 (high distortion breaks up regularity)
Use as subtle directional bias (Factor: 0.1-0.15)

Complete Shader Network
TEXTURE COORDINATE (UV) → MAPPING →

├─ VORONOI 1 (Scale: 100, F1 Distance)
│ → ColorRamp (sharp) →
│
├─ VORONOI 2 (Scale: 100, Edge Distance)
│ → ColorRamp (thin edges) →
│ → MIX (Multiply) with Voronoi 1 →
│
├─ VORONOI 3 (Scale: 40, for variation)
│ → ColorRamp →
│ → MIX (Overlay, 0.3) →
│
├─ NOISE (Scale: 500, fine detail)
│ → ColorRamp (subtle) →
│ → MIX (Add, 0.15) →
│
└─ NOISE (Scale: 5, creases)
→ ColorRamp →
→ MIX (Overlay, 0.25) →

ALL COMBINED → Final ColorRamp (contrast) → BUMP NODE (Strength: 0.4-0.8)
→ Normal Input (Principled BSDF)
Roughness Setup (Realistic Specs)
For high-quality leather like this cowhide:
Base Roughness: 0.35-0.45
Roughness Variation:
NOISE TEXTURE:

- Scale: 80-120 (matches grain)
- Detail: 4
- Roughness: 0.5

→ ColorRamp (0.3 to 0.7 range)
→ MIX with base value 0.4 (Factor: 0.3)
→ Roughness Input
This creates shinier grain tops and rougher grain valleys.
Principled BSDF - Real Leather Specs
For Premium Cowhide:

Base Color: RGB (0.15, 0.10, 0.08) to (0.25, 0.18, 0.14) - brown tones
Roughness: 0.4 (with variation as above)
Specular: 0.5
Sheen: 0.3-0.5 (important for leather!)
Sheen Tint: 0.2-0.4
Clearcoat: 0.0 (unless finished leather, then 0.1-0.3)
IOR: 1.45-1.5

For Matte/Unfinished Leather:

Roughness: 0.6-0.7
Sheen: 0.5-0.7
Specular: 0.4

For Polished/Finished Leather:

Roughness: 0.2-0.35
Clearcoat: 0.3-0.5
Clearcoat Roughness: 0.1-0.2

Critical Settings for Realism
Bump Node:

Strength: 0.5-0.8 (higher for pronounced grain)
Distance: 0.1

ColorRamp for Edge Sharpness:
For the grain edges (Voronoi Edge Distance):

Black stop: 0.0
White stop: 0.03-0.08 (very narrow range = sharp edges)
Interpolation: Linear or Ease

Mapping Node (Important!):

Scale X: 1.0
Scale Y: 1.0-1.2 (slight stretch can add realism)
Scale Z: 1.0
Rotation: Random 15-45° on Z-axis breaks up pattern

Advanced Technique: Dual-Scale Bump
For maximum realism, use TWO bump nodes:
Bump 1 (Macro detail - grain pattern):

Strength: 0.6
Connect to Normal input of Bump 2

Bump 2 (Micro detail - fine texture):

Strength: 0.2
Connect to Normal input of Principled BSDF

This gives you layered detail like real leather!
