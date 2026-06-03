"""
Generate tiling PBR maps recreating the reference embossed lizard-skin
pattern (Adobe Stock 1898441528).

TRUE structure of the reference:
  * The dominant feature is STACKED HORIZONTAL ROWS (thin horizontal
    rectangles) separated by strong dark grooves — like a ribcage / venetian
    blinds bowing in a radial fan.
  * Each horizontal row is sub-divided by LIGHTER vertical cross-lines into a
    strip of small rectangular brick segments  ->  row reads as: |▭|▭|▭|▭|
  * Rows fan/curve radially (they bow around an off-frame center).
  * Toward the side edges the big rectangular rows dissolve into a FINE NET of
    tiny near-square pebble scales (denser, more uniform mesh).

Final base color = black leather (glossy / glazed).

Outputs (2048x2048, seamless in X so it wraps around the cue):
  scales_basecolor.png, scales_height.png, scales_normal.png,
  scales_roughness.png, scales_ao.png
"""
import numpy as np
import bpy
import os

RES = 2048
OUT = "/Users/an/Documents/cue-customizer-nextjs/public/models/lizard-bakes"

yy, xx = np.mgrid[0:RES, 0:RES].astype(np.float64)
u = xx / RES          # 0..1 around the cue (must tile seamlessly in x)
v = yy / RES          # 0..1 along the cue length

# ----------------------------------------------------------------------------
# Tileable value-noise (wraps in x) for organic distortion
# ----------------------------------------------------------------------------
def tile_noise(fx_, fy_, seed, res=RES):
    rng = np.random.default_rng(seed)
    g = rng.standard_normal((fy_ + 1, fx_))
    g = np.concatenate([g, g[:, :1]], axis=1)          # wrap last col == first
    fx = (np.arange(res) / res) * fx_
    fy = (np.arange(res) / res) * fy_
    x0 = np.floor(fx).astype(int); y0 = np.floor(fy).astype(int)
    tx = fx - x0; ty = fy - y0
    sx = tx*tx*tx*(tx*(tx*6-15)+10); sy = ty*ty*ty*(ty*(ty*6-15)+10)
    x1 = (x0+1) % fx_; y1 = np.minimum(y0+1, fy_); x0m = x0 % fx_
    a = g[np.ix_(y0, x0m)]; b = g[np.ix_(y0, x1)]
    c = g[np.ix_(y1, x0m)]; d = g[np.ix_(y1, x1)]
    sxg = sx[None, :]; syg = sy[:, None]
    top = a*(1-sxg) + b*sxg; bot = c*(1-sxg) + d*sxg
    return top*(1-syg) + bot*syg

def smooth_groove(coord, half, soft):
    """Return 1 on the cell top, falling to 0 in the groove.
    coord: distance-from-cell-center in cell units (-0.5..0.5).
    half: half-width of the flat top. soft: groove softness."""
    d = (np.abs(coord) - half) / max(soft, 1e-4)
    return np.clip(1.0 - d, 0.0, 1.0)

# ----------------------------------------------------------------------------
# RADIAL FAN coordinate frame.
# Reference rows bow around a center off the left/bottom. We build:
#   rad  = distance from fan center  -> drives the HORIZONTAL row stacking
#   ang  = angle around fan center   -> drives the vertical sub-divisions
# Keep x-seamless by deriving ang from u (periodic) and only mildly using fan.
# ----------------------------------------------------------------------------
# gentle global warp so nothing is mechanical
wv = tile_noise(3, 5, 101) * 0.015
wu = tile_noise(5, 4, 102) * 0.012
uw = (u + wu) % 1.0
vw = v + wv

# Fan: center below-left of frame; rows are arcs of constant radius.
cx0, cy0 = -0.35, 1.55                      # fan center (outside frame)
dx = uw - cx0
dy = vw - cy0
rad = np.sqrt(dx*dx + dy*dy)                # ~0.8..2.2 across frame
ang = np.arctan2(dy, dx)                    # angular position along a row

# normalize radius to a 0..1 band coordinate across the visible frame
rad_n = (rad - rad.min()) / (rad.max() - rad.min() + 1e-9)

# ----------------------------------------------------------------------------
# Edge->center blend factor: 0 in dorsal center (big rows), 1 at side edges
# (fine net). Use distance of u from the central ridge plus lower area.
# ----------------------------------------------------------------------------
ridge = np.clip(np.abs((uw - 0.5) * 2.0), 0, 1)          # 0 center .. 1 sides
lower = np.clip((vw - 0.6) / 0.4, 0, 1)                   # bottom becomes net
# keep the bold dorsal rows over more of the center; net only at far edges
edge = np.clip(ridge*1.25 + lower*0.45 - 0.30 - tile_noise(4,4,103)*0.12, 0, 1)
edge = edge**1.6

# ============================================================================
# LAYER A — big rectangular ROWS (the dominant ribcage of horizontal scales)
# ============================================================================
# number of horizontal rows along the radius (thin -> many). Fewer rows => the
# central dorsal scales read BOLD and prominent like the reference.
ROWS = 34.0
row_c = rad_n * ROWS
row_cell = row_c - np.floor(row_c) - 0.5                  # -0.5..0.5 within row

# vertical sub-division count grows with radius so columns stay ~constant width
SUBCOLS = 46.0
# angular span is small; scale ang to get ~SUBCOLS bricks across the frame
ang_span = ang.max() - ang.min() + 1e-9
col_c = (ang - ang.min()) / ang_span * SUBCOLS
col_cell = col_c - np.floor(col_c) - 0.5

# Big-row scale: STRONG horizontal grooves (between rows), MEDIUM vertical.
# Wider flat tops + tighter grooves => bold raised rectangles with deep gaps.
row_top  = smooth_groove(row_cell, 0.40, 0.10)           # primary relief, bold
col_top  = smooth_groove(col_cell, 0.42, 0.09)           # secondary subdivide
# bricks: rows dominate; verticals cut clear notches so each row is segmented
bigA = row_top * (0.70 + 0.30*col_top)
# strongly dome the brick tops so they read as plump raised scales
bigA = bigA**0.5

# ============================================================================
# LAYER B — FINE NET of tiny near-square pebble scales (edges / lower area)
# ============================================================================
NET = 150.0
nx_c = uw * NET                                          # seamless in x
ny_c = (rad_n) * NET * 0.85
# hex-ish stagger for organic net
stag = (np.floor(ny_c) % 2.0) * 0.5
nxx = nx_c + stag
ncx = nxx - np.floor(nxx) - 0.5
ncy = ny_c - np.floor(ny_c) - 0.5
net_cell = (np.abs(ncx)/0.42)**2 + (np.abs(ncy)/0.42)**2
netB = np.clip(1.0 - net_cell, 0, 1)**0.6

# ============================================================================
# Combine A and B by the edge factor
# ============================================================================
height = bigA*(1.0 - edge) + netB*edge
# add second-order: even in the big-row zone, overlay a faint net so tops
# aren't glassy-flat (real scales have micro pebbling)
height = height*0.92 + (netB*0.08)*(1.0-edge)

# carve deep primary horizontal grooves globally (between rows) for contrast
row_groove = 1.0 - smooth_groove(row_cell, 0.40, 0.10)
height = height - row_groove*0.45*(1.0-edge)

# micro grain
height = height + tile_noise(600, 600, 111)*0.025
height = np.clip(height, 0.0, None)
height = (height - height.min())/(height.max()-height.min()+1e-9)
# subtle large undulation so the wrap isn't perfectly even
height = np.clip(height*0.9 + (tile_noise(3,4,121)*0.5+0.5)*0.1, 0, 1)

# ----------------------------------------------------------------------------
# NORMAL from height (x wraps)
# ----------------------------------------------------------------------------
H = height*7.0
dzdx = np.zeros_like(H); dzdy = np.zeros_like(H)
dzdx[:,1:-1] = (H[:,2:]-H[:,:-2])*0.5
dzdx[:,0]    = (H[:,1]-H[:,-1])*0.5
dzdx[:,-1]   = (H[:,0]-H[:,-2])*0.5
dzdy[1:-1,:] = (H[2:,:]-H[:-2,:])*0.5
dzdy[0,:]    = H[1,:]-H[0,:]; dzdy[-1,:] = H[-1,:]-H[-2,:]
nx = -dzdx; ny = -dzdy; nz = np.ones_like(H)
ln = np.sqrt(nx*nx+ny*ny+nz*nz); nx/=ln; ny/=ln; nz/=ln
normal = np.stack([nx*0.5+0.5, ny*0.5+0.5, nz*0.5+0.5], axis=-1)

# AO in grooves
ao = np.clip(height**0.8, 0, 1)*0.7 + 0.3

# Roughness: glossy scale tops, rougher grooves
rough = 0.6 - height*0.30 + tile_noise(300,300,131)*0.04
rough = np.clip(rough, 0.22, 0.85)

# Base color: black leather, scale tops a hair lighter charcoal than grooves
base_v = 0.018 + height*0.05
base_v = np.clip(base_v + tile_noise(600,600,141)*0.02, 0.0, 0.10)
base = np.stack([base_v*1.0, base_v*1.03, base_v*1.06], axis=-1)

# ----------------------------------------------------------------------------
# Save (colorspace BEFORE pixels — setting it after zeroes the buffer)
# ----------------------------------------------------------------------------
def save_img(name, arr_rgb, filepath, colorspace):
    h, w = arr_rgb.shape[:2]
    rgba = np.dstack([arr_rgb, np.ones((h, w, 1))]) if arr_rgb.shape[-1] == 3 else arr_rgb
    img = bpy.data.images.get(name)
    if img: bpy.data.images.remove(img)
    img = bpy.data.images.new(name, width=w, height=h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = colorspace
    flat = np.ascontiguousarray(np.flipud(rgba), dtype=np.float32).ravel()
    img.pixels.foreach_set(flat)
    img.filepath_raw = filepath; img.file_format = 'PNG'; img.save()
    return filepath

def gray(a): return np.dstack([a, a, a])

paths = {}
paths['basecolor'] = save_img('Scales_BaseColor', base, os.path.join(OUT,'scales_basecolor.png'), 'sRGB')
paths['height']    = save_img('Scales_Height', gray(height), os.path.join(OUT,'scales_height.png'), 'Non-Color')
paths['normal']    = save_img('Scales_Normal', normal, os.path.join(OUT,'scales_normal.png'), 'Non-Color')
paths['roughness'] = save_img('Scales_Roughness', gray(rough), os.path.join(OUT,'scales_roughness.png'), 'Non-Color')
paths['ao']        = save_img('Scales_AO', gray(ao), os.path.join(OUT,'scales_ao.png'), 'Non-Color')
print("SAVED:", paths)
