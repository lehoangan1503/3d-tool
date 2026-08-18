import * as THREE from 'three';
import type {
  CameraKeyframe,
  CameraLookMode,
  CameraPathConfig,
  CameraShapeParams,
  CameraWaypoint,
} from '@/types/video-studio';
import {
  createCameraWaypoint,
  getCameraPathSpan,
  isCameraPathActive,
  normalizeLookMode,
} from '@/types/video-studio';

/**
 * Camera path sampling.
 *
 * Without a custom path the recording camera lerps from `cameraStart` to `cameraEnd`.
 *
 * With a path, the camera instead follows a Catmull-Rom spline through the waypoints of a
 * shape generated around the CUE — independent of the camera, so a circle is perfectly
 * round. The recorded move is the span of that curve between the user's picked start and
 * end waypoints.
 *
 * Two properties matter for recording quality:
 *
 *  1. **Arc-length parameterisation.** A raw Catmull-Rom `getPoint(t)` advances unevenly —
 *     it crawls where points are dense and races where they are sparse, which makes the
 *     easing curve meaningless. `curve.getPointAt(t)` uses the arc-length LUT so `t` maps
 *     to distance travelled, giving constant speed and correct easing.
 *
 *  2. **Zero per-frame allocation.** The recording loop renders at up to 120 fps with the
 *     scene graph frozen; allocating Vector3/Quaternion per frame would introduce GC
 *     pauses that show up as dropped frames. Every sampler mutates pre-allocated scratch
 *     objects and writes into a caller-owned keyframe.
 */

const ARC_LENGTH_DIVISIONS = 400;

export interface CameraPathSampler {
  /** Total path length in world units — drives recording duration. */
  readonly length: number;
  /** Sample the path at t ∈ [0,1], writing position + rotation into `out`. */
  sample(t: number, out: CameraKeyframe): void;
}

/** Reusable scratch — safe because sample() is only ever called from one render loop. */
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _matrix = new THREE.Matrix4();
const _lookAt = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function writeEuler(q: THREE.Quaternion, out: CameraKeyframe): void {
  _euler.setFromQuaternion(q, 'XYZ');
  out.rotationX = _euler.x;
  out.rotationY = _euler.y;
  out.rotationZ = _euler.z;
}

/**
 * Straight start→end sampler — the legacy behaviour, kept as a fast path.
 * Reproduces the original per-component lerp exactly, including Euler-lerped rotation.
 */
function createLinearSampler(start: CameraKeyframe, end: CameraKeyframe): CameraPathSampler {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const startRX = start.rotationX ?? 0, endRX = end.rotationX ?? 0;
  const startRY = start.rotationY ?? 0, endRY = end.rotationY ?? 0;
  const startRZ = start.rotationZ ?? 0, endRZ = end.rotationZ ?? 0;

  return {
    length: Math.sqrt(dx * dx + dy * dy + dz * dz),
    sample(t: number, out: CameraKeyframe): void {
      out.x = start.x + dx * t;
      out.y = start.y + dy * t;
      out.z = start.z + dz * t;
      out.rotationX = startRX + (endRX - startRX) * t;
      out.rotationY = startRY + (endRY - startRY) * t;
      out.rotationZ = startRZ + (endRZ - startRZ) * t;
    },
  };
}

/**
 * Control points for the recorded move: the curve's span from startIndex to endIndex.
 *
 * A span covering the entire closed loop keeps `closed` so the curve joins last→first and
 * the orbit is seamless. Any partial span is an open arc, since a trimmed piece of a circle
 * must not wrap back to its own beginning.
 */
function buildControlPoints(path: CameraPathConfig): { points: CameraKeyframe[]; closed: boolean } {
  const span = getCameraPathSpan(path);
  const isFullLoop = path.closed && span.length === path.waypoints.length;
  return { points: span, closed: isFullLoop };
}

/**
 * Build a CatmullRomCurve3 from a path config.
 *
 * THREE only supports 'centripetal' | 'chordal' | 'catmullrom'. Our extra 'linear' option
 * maps to catmullrom with tension 0 — with zero tension the Catmull-Rom basis degenerates
 * to straight segments between control points, which is exactly the hard-cornered zigzag
 * look, without needing a second curve class.
 */
function buildCurve(
  controlPoints: CameraKeyframe[],
  path: CameraPathConfig,
  closed: boolean
): THREE.CatmullRomCurve3 {
  const threeCurveType: THREE.CurveType =
    path.curveType === 'linear' ? 'catmullrom' : path.curveType;
  const tension = path.curveType === 'linear' ? 0 : path.tension;
  return new THREE.CatmullRomCurve3(
    controlPoints.map(p => new THREE.Vector3(p.x, p.y, p.z)),
    closed,
    threeCurveType,
    tension
  );
}

/**
 * Spline sampler over start → waypoints → end.
 *
 * `lookMode` controls orientation. Both modes face the cue:
 *   level  — stay horizontal, yawing toward the cue axis at the camera's own height.
 *   center — aim at the cue's centre, tilting as needed.
 */
function createSplineSampler(
  path: CameraPathConfig,
  lookTarget: THREE.Vector3 | undefined
): CameraPathSampler {
  const { points: controlPoints, closed } = buildControlPoints(path);
  const curve = buildCurve(controlPoints, path, closed);
  curve.arcLengthDivisions = ARC_LENGTH_DIVISIONS;
  // Force the arc-length LUT to build now rather than on the first recorded frame.
  const length = curve.getLength();

  // Both modes aim at the cue; fall back to the origin when it is unknown.
  const target = lookTarget ? lookTarget.clone() : new THREE.Vector3(0, 0, 0);
  const mode = normalizeLookMode(path.lookMode);

  return {
    length,
    sample(t: number, out: CameraKeyframe): void {
      const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
      curve.getPointAt(clamped, _pos);
      out.x = _pos.x;
      out.y = _pos.y;
      out.z = _pos.z;

      if (mode === 'level') {
        // Aim at the cue's vertical axis at the CAMERA's own height. Using the camera's y
        // (rather than the cue's) makes the view direction horizontal by construction, so
        // the horizon never tips as the camera rises — while still pointing at the shaft.
        _lookAt.set(target.x, _pos.y, target.z);
        // Degenerate case: camera sits exactly on the cue axis, so there is no horizontal
        // direction to face. Nudge along -Z to keep the lookAt matrix well-defined.
        if (Math.abs(_lookAt.x - _pos.x) < 1e-6 && Math.abs(_lookAt.z - _pos.z) < 1e-6) {
          _lookAt.z -= 1;
        }
      } else {
        // center: aim at the cue's centre point, tilting up/down as needed.
        _lookAt.copy(target);
      }
      _matrix.lookAt(_pos, _lookAt, _up);
      _quat.setFromRotationMatrix(_matrix);
      writeEuler(_quat, out);
    },
  };
}

/**
 * Create the sampler for a recording. Falls back to the legacy straight-line lerp when no
 * custom path is configured, so existing templates record byte-identically.
 *
 * @param lookTarget World point to face when `path.lookMode === "target"` (normally the cue).
 */
export function createCameraPathSampler(
  start: CameraKeyframe,
  end: CameraKeyframe,
  path: CameraPathConfig | undefined,
  lookTarget?: THREE.Vector3
): CameraPathSampler {
  // No path, or a span too short to travel → legacy straight start→end lerp.
  if (!isCameraPathActive(path) || getCameraPathSpan(path!).length < 2) {
    return createLinearSampler(start, end);
  }
  return createSplineSampler(path!, lookTarget);
}

/**
 * Tessellate a path for the scene-view overlay line.
 * Returns the legacy straight segment when no custom path is active.
 */
export function getCameraPathPoints(
  path: CameraPathConfig | undefined,
  divisions = 200
): THREE.Vector3[] {
  if (!path || path.waypoints.length < 2) return [];
  return buildCurve(path.waypoints, path, path.closed).getPoints(divisions);
}

/**
 * Tessellate only the recorded span — drawn brighter than the full curve so the user can
 * see exactly which stretch will end up in the video.
 */
export function getCameraSpanPoints(
  path: CameraPathConfig | undefined,
  divisions = 160
): THREE.Vector3[] {
  if (!path || !isCameraPathActive(path)) return [];
  const { points, closed } = buildControlPoints(path);
  if (points.length < 2) return [];
  return buildCurve(points, path, closed).getPoints(divisions);
}

/**
 * Build a camera keyframe positioned at `point` and oriented per `lookMode`.
 *
 * Used when the user picks a start/end waypoint: the viewport camera jumps there facing the
 * same way the recording will, so what you see is the frame you get.
 */
export function cameraKeyframeLookingAt(
  point: CameraKeyframe,
  lookMode: CameraLookMode,
  target: THREE.Vector3
): CameraKeyframe {
  const pos = new THREE.Vector3(point.x, point.y, point.z);
  // Mirror the sampler exactly, so the preview frame matches what gets recorded.
  const lookAt =
    normalizeLookMode(lookMode) === 'level'
      ? new THREE.Vector3(target.x, point.y, target.z)
      : target.clone();
  if (Math.abs(lookAt.x - pos.x) < 1e-6 && Math.abs(lookAt.z - pos.z) < 1e-6) {
    lookAt.z -= 1;
  }
  const m = new THREE.Matrix4().lookAt(pos, lookAt, new THREE.Vector3(0, 1, 0));
  const e = new THREE.Euler().setFromRotationMatrix(m, 'XYZ');
  return { x: point.x, y: point.y, z: point.z, rotationX: e.x, rotationY: e.y, rotationZ: e.z };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape presets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A preset generates the WHOLE curve, anchored on the cue and sized by CameraShapeParams.
 *
 * Crucially it does NOT read the camera position. The earlier design bent a path between
 * wherever the camera happened to sit, which skewed every shape — a "circle" came out as a
 * lopsided ellipse. Generating around the cue instead makes a circle perfectly round, and
 * the camera's start/end are then *picked from* the finished curve.
 */
export interface CameraPathPreset {
  id: string;
  name: string;
  description: string;
  closed: boolean;
  curveType: CameraPathConfig['curveType'];
  lookMode: CameraPathConfig['lookMode'];
  /** Which shapeParams sliders are meaningful for this shape, in display order. */
  params: readonly (keyof CameraShapeParams)[];
  /** Generate the full curve around `center` (the cue). */
  generate: (center: THREE.Vector3, p: CameraShapeParams) => CameraWaypoint[];
}

/** Waypoint with no baked rotation — orientation comes from lookMode at sample time. */
function pointAt(x: number, y: number, z: number): CameraWaypoint {
  return createCameraWaypoint({ x, y, z, rotationX: 0, rotationY: 0, rotationZ: 0 });
}

export const CAMERA_PATH_PRESETS: CameraPathPreset[] = [
  {
    id: 'curve',
    name: 'Cong',
    description: 'Cung dọc — camera lượn từ dưới lên trên cây cue',
    closed: false,
    curveType: 'centripetal',
    lookMode: 'level',
    params: ['radius', 'height', 'amplitude'],
    generate: (center, p) => {
      // VERTICAL arc: the camera rises past the cue while bowing out in depth. `amplitude`
      // is how much of a half-turn it sweeps, so 0 is nearly straight up and 1 arcs from
      // below the cue to above it.
      const sweep = Math.PI * Math.max(0.05, p.amplitude);
      const STEPS = 8;
      const pts: CameraWaypoint[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const a = -sweep / 2 + (i / STEPS) * sweep;
        pts.push(pointAt(
          center.x,
          p.height + Math.sin(a) * p.radius,
          center.z + Math.cos(a) * p.radius
        ));
      }
      return pts;
    },
  },
  {
    id: 'circle',
    name: 'Tròn',
    description: 'Vòng tròn nằm ngang, hoàn hảo quanh cây cue',
    closed: true,
    curveType: 'centripetal',
    lookMode: 'level',
    params: ['radius', 'height'],
    generate: (center, p) => {
      // 8 evenly spaced points on a true circle centred on the cue. A Catmull-Rom through
      // them is round to well under 1% radial error, and stays easy to edit by hand.
      const SEGMENTS = 8;
      const pts: CameraWaypoint[] = [];
      for (let i = 0; i < SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        pts.push(pointAt(
          center.x + Math.sin(a) * p.radius,
          p.height,
          center.z + Math.cos(a) * p.radius
        ));
      }
      return pts;
    },
  },
  {
    id: 'zigzag',
    name: 'Zigzag',
    description: 'Gấp khúc dọc — leo lên và lắc qua lại',
    closed: false,
    curveType: 'linear',
    lookMode: 'level',
    params: ['radius', 'height', 'amplitude', 'segments'],
    generate: (center, p) => {
      // VERTICAL zigzag: climb past the cue, swinging left/right each step. `radius` is the
      // standoff distance, `amplitude` the lateral swing, and the climb spans `radius * 1.6`.
      const count = Math.max(2, Math.round(p.segments));
      const climb = p.radius * 1.6;
      const swing = p.radius * Math.max(0.05, p.amplitude);
      const pts: CameraWaypoint[] = [];
      for (let i = 0; i <= count; i++) {
        const f = i / count;
        const side = i % 2 === 0 ? 1 : -1;
        pts.push(pointAt(
          center.x + swing * side,
          p.height - climb / 2 + climb * f,
          center.z + p.radius
        ));
      }
      return pts;
    },
  },
  {
    id: 'spiral',
    name: 'Xoắn ốc',
    description: 'Xoắn dọc quanh cue, vừa xoay vừa lên cao',
    closed: false,
    curveType: 'centripetal',
    lookMode: 'level',
    params: ['radius', 'height', 'turns', 'rise'],
    generate: (center, p) => {
      // Vertical helix around the cue: angle advances with `turns` while height climbs by
      // `rise`, centred on `height` so the cue sits mid-climb rather than at the bottom.
      const turns = Math.max(0.25, p.turns);
      const STEPS = Math.max(6, Math.round(turns * 8));
      const pts: CameraWaypoint[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const f = i / STEPS;
        const a = f * Math.PI * 2 * turns;
        pts.push(pointAt(
          center.x + Math.sin(a) * p.radius,
          p.height - p.rise / 2 + f * p.rise,
          center.z + Math.cos(a) * p.radius
        ));
      }
      return pts;
    },
  },
];

export function getCameraPathPreset(id: string): CameraPathPreset | undefined {
  return CAMERA_PATH_PRESETS.find(p => p.id === id);
}

/** Slider bounds + labels for each shape parameter. */
export const CAMERA_SHAPE_PARAM_META: Record<
  keyof CameraShapeParams,
  { label: string; min: number; max: number; step: number; unit?: string }
> = {
  radius:    { label: 'Đường kính',   min: 2,   max: 20,  step: 0.5 },
  height:    { label: 'Độ cao',       min: -1,  max: 16,  step: 0.5 },
  amplitude: { label: 'Độ cong',      min: 0.05, max: 1,  step: 0.05 },
  segments:  { label: 'Số đoạn',      min: 2,   max: 12,  step: 1 },
  turns:     { label: 'Số vòng xoắn', min: 0.5, max: 4,   step: 0.25 },
  rise:      { label: 'Độ cao xoắn',  min: 1,   max: 24,  step: 0.5 },
};

/**
 * Regenerate a shape's waypoints around `center`, preserving the user's start/end picks
 * where the new point count still allows it.
 *
 * Called on preset switch and on every slider change, so sliders reshape the curve live.
 */
export function regenerateShape(
  shapeId: string,
  center: THREE.Vector3,
  params: CameraShapeParams,
  prevStartIndex = 0,
  prevEndIndex = -1
): {
  waypoints: CameraWaypoint[];
  startIndex: number;
  endIndex: number;
  closed: boolean;
  curveType: CameraPathConfig['curveType'];
  lookMode: CameraPathConfig['lookMode'];
} | null {
  const preset = getCameraPathPreset(shapeId);
  if (!preset) return null;
  const waypoints = preset.generate(center, params);
  const last = Math.max(0, waypoints.length - 1);
  return {
    waypoints,
    startIndex: Math.min(prevStartIndex, last),
    // -1 means "no previous pick" → default to the whole curve.
    endIndex: prevEndIndex < 0 ? last : Math.min(prevEndIndex, last),
    closed: preset.closed,
    curveType: preset.curveType,
    lookMode: preset.lookMode,
  };
}

/**
 * Delete every waypoint outside the picked start→end span, so the stored curve is exactly
 * what gets recorded. Indices are rebased onto the trimmed array.
 */
export function trimPathToSpan(path: CameraPathConfig): CameraPathConfig {
  const span = getCameraPathSpan(path);
  if (span.length < 2 || span.length === path.waypoints.length) return path;
  return {
    ...path,
    waypoints: span.map(w => ({ ...w })),
    startIndex: 0,
    endIndex: span.length - 1,
    // A trimmed arc is no longer a closed loop.
    closed: false,
  };
}

/**
 * Insert a new waypoint at the midpoint of the longest segment of the curve.
 * Placing it on the longest gap is what makes repeated clicks subdivide evenly instead of
 * piling points up at one end.
 */
export function insertWaypointOnLongestSegment(waypoints: CameraWaypoint[]): CameraWaypoint[] {
  if (waypoints.length < 2) return waypoints;
  let bestIdx = 1;
  let bestLen = -1;
  for (let i = 1; i < waypoints.length; i++) {
    const len = Math.hypot(
      waypoints[i].x - waypoints[i - 1].x,
      waypoints[i].y - waypoints[i - 1].y,
      waypoints[i].z - waypoints[i - 1].z
    );
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }
  const a = waypoints[bestIdx - 1];
  const b = waypoints[bestIdx];
  const mid = pointAt((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  const next = [...waypoints];
  next.splice(bestIdx, 0, mid);
  return next;
}

/** Shift every waypoint by a world-space delta — backs the "Chọn tất cả" move. */
export function translateWaypoints(
  waypoints: CameraWaypoint[],
  dx: number,
  dy: number,
  dz: number
): CameraWaypoint[] {
  return waypoints.map(w => ({ ...w, x: w.x + dx, y: w.y + dy, z: w.z + dz }));
}

/**
 * Centroid of the waypoints — the pivot that "rotate all" spins around.
 *
 * The mean of the control points, not the curve's arc centre: for the shapes here they
 * coincide (a circle's points are symmetric about its centre), and the mean is the
 * predictable choice for a hand-edited curve where points may be unevenly spaced.
 */
export function getWaypointsCenter(waypoints: CameraWaypoint[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  if (waypoints.length === 0) return c;
  for (const w of waypoints) c.x += w.x, c.y += w.y, c.z += w.z;
  return c.multiplyScalar(1 / waypoints.length);
}

/**
 * Scale every waypoint's distance from `center` by `factor` — resizes the curve in place.
 */
export function scaleWaypoints(
  waypoints: CameraWaypoint[],
  center: THREE.Vector3,
  factor: number
): CameraWaypoint[] {
  return waypoints.map(w => ({
    ...w,
    x: center.x + (w.x - center.x) * factor,
    y: center.y + (w.y - center.y) * factor,
    z: center.z + (w.z - center.z) * factor,
  }));
}

/**
 * Apply an absolute Euler rotation to the curve about `center`.
 *
 * The transform panel edits absolute angles, not deltas, so this rebuilds from `base` (the
 * un-rotated geometry) every time. Composing X→Y→Z in a fixed order keeps typing 90 into
 * one field idempotent, which a delta-based approach cannot guarantee.
 */
export function applyWaypointsEuler(
  base: CameraWaypoint[],
  center: THREE.Vector3,
  euler: { x: number; y: number; z: number }
): CameraWaypoint[] {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(euler.x, euler.y, euler.z, 'XYZ')
  );
  const v = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const we = new THREE.Euler();
  return base.map(w => {
    v.set(w.x - center.x, w.y - center.y, w.z - center.z).applyQuaternion(q).add(center);
    we.set(w.rotationX ?? 0, w.rotationY ?? 0, w.rotationZ ?? 0, 'XYZ');
    wq.setFromEuler(we).premultiply(q);
    we.setFromQuaternion(wq, 'XYZ');
    return {
      ...w,
      x: v.x, y: v.y, z: v.z,
      rotationX: we.x, rotationY: we.y, rotationZ: we.z,
    };
  });
}

/** Mean distance of the waypoints from their centroid — the curve's overall "size". */
export function getWaypointsRadius(waypoints: CameraWaypoint[], center: THREE.Vector3): number {
  if (waypoints.length === 0) return 0;
  let sum = 0;
  for (const w of waypoints) {
    sum += Math.hypot(w.x - center.x, w.y - center.y, w.z - center.z);
  }
  return sum / waypoints.length;
}

/**
 * Rotate every waypoint around `center` on a world axis.
 *
 * Rotating the curve means moving each point's POSITION about the pivot — unlike a normal
 * object rotation, which would only spin an object's own orientation in place. Each
 * waypoint's stored rotation is spun by the same delta so "interpolate" look mode stays
 * consistent with the new geometry.
 */
export function rotateWaypoints(
  waypoints: CameraWaypoint[],
  center: THREE.Vector3,
  axis: 'x' | 'y' | 'z',
  angle: number
): CameraWaypoint[] {
  const axisVec =
    axis === 'x' ? new THREE.Vector3(1, 0, 0) :
    axis === 'z' ? new THREE.Vector3(0, 0, 1) :
                   new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromAxisAngle(axisVec, angle);
  const v = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const we = new THREE.Euler();
  return waypoints.map(w => {
    v.set(w.x - center.x, w.y - center.y, w.z - center.z).applyQuaternion(q).add(center);
    we.set(w.rotationX ?? 0, w.rotationY ?? 0, w.rotationZ ?? 0, 'XYZ');
    wq.setFromEuler(we).premultiply(q);
    we.setFromQuaternion(wq, 'XYZ');
    return {
      ...w,
      x: v.x, y: v.y, z: v.z,
      rotationX: we.x, rotationY: we.y, rotationZ: we.z,
    };
  });
}
