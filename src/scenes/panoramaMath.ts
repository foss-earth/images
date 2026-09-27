/**
 * The panorama visual contract as pure float64 math: frames, image pose, cube
 * and equirectangular conventions, the flat window, coverage and handoff.
 * docs/proposals/panorama-scenes.md §2–3 and
 * docs/validation/panorama-visual-contract.md define every formula here; the
 * CPU reference is scripts/render-orb-appearances.mjs. The shaders in
 * src/engine/babylon/panorama/ evaluate the same expressions in float32.
 */
import { DEG_TO_RAD, RAD_TO_DEG, geodeticToEcef, ecefToGeodetic, type EcefCoord } from "../camera/cameraMath";

export type Vec3 = readonly [number, number, number];
/** Row-major 3×3: `m[row][column]`, applied to column vectors. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));
/** The angle between two directions, degrees, stable for small and large angles alike. */
export const angleDeg = (a: Vec3, b: Vec3): number => Math.atan2(length(cross(a, b)), dot(a, b)) * RAD_TO_DEG;
export const vec3 = (p: EcefCoord): Vec3 => [p.x, p.y, p.z];
export const ecef = (v: Vec3): EcefCoord => ({ x: v[0], y: v[1], z: v[2] });

export function mulMat3(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

export function transpose3(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function mulMat3Mat3(a: Mat3, b: Mat3): Mat3 {
  const bt = transpose3(b);
  return [
    [dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
    [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
    [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
  ];
}

// ─── Geographic frames ────────────────────────────────────────────────

/**
 * East, north and up at a WGS84 longitude and latitude, as ECEF unit vectors.
 * At a pole the longitude still chooses the meridian, as the format specifies.
 */
export interface EnuFrame {
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function enuFrame(longitudeDeg: number, latitudeDeg: number): EnuFrame {
  const lon = longitudeDeg * DEG_TO_RAD;
  const lat = latitudeDeg * DEG_TO_RAD;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

/** Rows east, north, up: ECEF direction → ENU components. */
export function ecefToEnuMatrix(frame: EnuFrame): Mat3 {
  return [frame.east, frame.north, frame.up];
}

export function geodeticPoint(longitudeDeg: number, latitudeDeg: number, heightMeters: number): Vec3 {
  return vec3(geodeticToEcef(latitudeDeg * DEG_TO_RAD, longitudeDeg * DEG_TO_RAD, heightMeters));
}

export function pointGeodetic(point: Vec3): { longitudeDeg: number; latitudeDeg: number; heightMeters: number } {
  const { latRad, lonRad, altMeters } = ecefToGeodetic(point[0], point[1], point[2]);
  return { longitudeDeg: lonRad * RAD_TO_DEG, latitudeDeg: latRad * RAD_TO_DEG, heightMeters: altMeters };
}

/** A heading clockwise from north and a pitch above the horizon, as an ENU direction. */
export function enuDirection(headingDeg: number, pitchDeg: number): Vec3 {
  const h = headingDeg * DEG_TO_RAD, p = pitchDeg * DEG_TO_RAD;
  return [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
}

/**
 * The heading and pitch of an ENU direction. At a vertical look the heading is
 * undefined; `fallbackHeadingDeg` keeps the last defined one, as §5 requires.
 */
export function enuHeadingPitch(direction: Vec3, fallbackHeadingDeg = 0): { headingDeg: number; pitchDeg: number } {
  const horizontal = Math.hypot(direction[0], direction[1]);
  const pitchDeg = Math.atan2(direction[2], horizontal) * RAD_TO_DEG;
  if (horizontal < 1e-12) return { headingDeg: fallbackHeadingDeg, pitchDeg };
  const heading = Math.atan2(direction[0], direction[1]) * RAD_TO_DEG;
  return { headingDeg: (heading + 360) % 360, pitchDeg };
}

// ─── Image pose ────────────────────────────────────────────────────────

const rotationX = (a: number): Mat3 => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const rotationY = (a: number): Mat3 => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rotationZ = (a: number): Mat3 => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

export interface ImagePose {
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * R = Rz(−heading) Rx(pitch) Ry(roll): image-local direction (X right, Y
 * forward, Z up) → capture ENU. Sampling applies its inverse, the transpose.
 */
export function imagePoseMatrix(pose: ImagePose): Mat3 {
  return mulMat3Mat3(mulMat3Mat3(rotationZ(-pose.headingDeg * DEG_TO_RAD), rotationX(pose.pitchDeg * DEG_TO_RAD)), rotationY(pose.rollDeg * DEG_TO_RAD));
}

/** ECEF world direction → image-local direction: Rᵀ · (ECEF → capture ENU). */
export function contentMatrix(frame: EnuFrame, pose: ImagePose): Mat3 {
  return mulMat3Mat3(transpose3(imagePoseMatrix(pose)), ecefToEnuMatrix(frame));
}

// ─── Source conventions ────────────────────────────────────────────────

/** The equirectangular direction of normalized image coordinates, u right and v down, centre forward. */
export function equirectDirection(u: number, v: number): Vec3 {
  const theta = 2 * Math.PI * (u - 0.5);
  const phi = Math.PI * (0.5 - v);
  return [Math.sin(theta) * Math.cos(phi), Math.cos(theta) * Math.cos(phi), Math.sin(phi)];
}

export function equirectCoordinates(direction: Vec3): { u: number; v: number } {
  const d = normalize(direction);
  return { u: 0.5 + Math.atan2(d[0], d[1]) / (2 * Math.PI), v: 0.5 - Math.asin(Math.max(-1, Math.min(1, d[2]))) / Math.PI };
}

export type CubeFaceName = "px" | "nx" | "py" | "ny" | "pz" | "nz";
export const CUBE_FACE_NAMES: readonly CubeFaceName[] = ["px", "nx", "py", "ny", "pz", "nz"];

/** The format's face table (§2): forward, right and the direction of the image's top edge. */
export const SOURCE_CUBE_FACES: Readonly<Record<CubeFaceName, { f: Vec3; r: Vec3; t: Vec3 }>> = {
  px: { f: [1, 0, 0], r: [0, -1, 0], t: [0, 0, 1] },
  nx: { f: [-1, 0, 0], r: [0, 1, 0], t: [0, 0, 1] },
  py: { f: [0, 1, 0], r: [1, 0, 0], t: [0, 0, 1] },
  ny: { f: [0, -1, 0], r: [-1, 0, 0], t: [0, 0, 1] },
  pz: { f: [0, 0, 1], r: [1, 0, 0], t: [0, -1, 0] },
  nz: { f: [0, 0, -1], r: [1, 0, 0], t: [0, 1, 0] },
};

export function sourceCubeDirection(face: CubeFaceName, u: number, v: number): Vec3 {
  const { f, r, t } = SOURCE_CUBE_FACES[face];
  return normalize(add(f, add(scale(r, 2 * u - 1), scale(t, 1 - 2 * v))));
}

/** The source face and coordinates a direction lands on. */
export function sourceCubeLookup(direction: Vec3): { face: CubeFaceName; u: number; v: number } {
  let face: CubeFaceName = "px";
  let best = -Infinity;
  for (const name of CUBE_FACE_NAMES) {
    const along = dot(direction, SOURCE_CUBE_FACES[name].f);
    if (along > best) { best = along; face = name; }
  }
  const { r, t } = SOURCE_CUBE_FACES[face];
  return { face, u: (dot(direction, r) / best + 1) / 2, v: (1 - dot(direction, t) / best) / 2 };
}

/**
 * WebGPU samples cube textures as Vulkan does: layer order +X −X +Y −Y +Z −Z,
 * and per major axis the (sc, tc) components below, with t = 0 on a layer's
 * first row. gpuweb §texture-sampling defers to that table.
 */
const GPU_CUBE_LAYERS: ReadonlyArray<{ axis: 0 | 1 | 2; sign: 1 | -1; sc: (s: Vec3) => number; tc: (s: Vec3) => number }> = [
  { axis: 0, sign: 1, sc: s => -s[2], tc: s => -s[1] },
  { axis: 0, sign: -1, sc: s => s[2], tc: s => -s[1] },
  { axis: 1, sign: 1, sc: s => s[0], tc: s => s[2] },
  { axis: 1, sign: -1, sc: s => s[0], tc: s => -s[2] },
  { axis: 2, sign: 1, sc: s => s[0], tc: s => -s[1] },
  { axis: 2, sign: -1, sc: s => -s[0], tc: s => -s[1] },
];

export function gpuCubeLookup(sample: Vec3): { layer: number; u: number; v: number } {
  const magnitudes = sample.map(Math.abs);
  const axis = magnitudes[0] >= magnitudes[1] && magnitudes[0] >= magnitudes[2] ? 0 : magnitudes[1] >= magnitudes[2] ? 1 : 2;
  const sign = sample[axis] >= 0 ? 1 : -1;
  const layer = GPU_CUBE_LAYERS.findIndex(entry => entry.axis === axis && entry.sign === sign);
  const entry = GPU_CUBE_LAYERS[layer];
  const rc = magnitudes[axis];
  return { layer, u: (entry.sc(sample) / rc + 1) / 2, v: (entry.tc(sample) / rc + 1) / 2 };
}

/**
 * The format's faces are WebGPU's with Y and Z exchanged: sampling the GPU cube
 * with (x, z, y) of an image-local direction lands on the same texel of the
 * same source face. Each face therefore uploads unrotated into the layer below,
 * and the shaders swap the two components. panoramaMath.test.ts proves it.
 */
export const GPU_LAYER_SOURCE_FACES: readonly CubeFaceName[] = ["px", "nx", "pz", "nz", "py", "ny"];

export function gpuSampleVector(imageDirection: Vec3): Vec3 {
  return [imageDirection[0], imageDirection[2], imageDirection[1]];
}

// ─── Window mapping ────────────────────────────────────────────────────

/** Camera to displayed marker, the quantities every mapping and test shares. */
export interface OrbGeometry {
  /** Unit axis from the camera to the marker centre; null inside the sphere. */
  axis: Vec3 | null;
  distance: number;
  radius: number;
  /** asin(R/d), or π/2 at or inside the surface. */
  alpha: number;
  inside: boolean;
}

export function orbGeometry(cameraToMarker: Vec3, radius: number): OrbGeometry {
  const distance = length(cameraToMarker);
  if (distance <= radius) return { axis: distance > 0 ? scale(cameraToMarker, 1 / distance) : null, distance, radius, alpha: Math.PI / 2, inside: true };
  return { axis: scale(cameraToMarker, 1 / distance), distance, radius, alpha: Math.asin(radius / distance), inside: false };
}

/**
 * The flat (rectilinear) window: which world direction a covered view ray
 * shows. Identity inside the sphere and once α ≥ βR; otherwise
 * D ∝ a + (tan βR / tan α)(v − (a·v)a)/(a·v), which is
 * θ = atan(tan δ tan βR / tan α) written without angles. Null for a ray the
 * orb does not cover.
 */
export function flatWindowDirection(geometry: OrbGeometry, ray: Vec3, previewHalfAngleRad: number): Vec3 | null {
  if (!(previewHalfAngleRad > 0 && previewHalfAngleRad < Math.PI / 2)) throw new RangeError("the flat window's half angle must be in (0, 90) degrees");
  const v = normalize(ray);
  if (geometry.inside && geometry.distance < geometry.radius) return v;
  const a = geometry.axis!;
  const c = dot(a, v);
  if (geometry.inside) return c >= 0 ? v : null;
  if (c < Math.cos(geometry.alpha) - 1e-12) return null;
  if (geometry.alpha >= previewHalfAngleRad) return v;
  const k = sub(v, scale(a, c));
  if (length(k) < 1e-15) return a;
  const gain = Math.tan(previewHalfAngleRad) / Math.tan(geometry.alpha);
  return normalize(add(a, scale(k, gain / c)));
}

/** The reference's angular form of the same window, kept to cross-check the vector form. */
export function flatWindowTheta(delta: number, alpha: number, previewHalfAngleRad: number): number {
  if (alpha >= previewHalfAngleRad) return delta;
  const rho = Math.min(1, Math.max(0, Math.sin(delta) * Math.cos(alpha) / (Math.cos(delta) * Math.sin(alpha))));
  return Math.atan2(rho * Math.sin(previewHalfAngleRad), Math.cos(previewHalfAngleRad));
}

/**
 * The continuous fisheye-to-flat blend (§3). Part of the contract; the
 * fisheye appearance itself is a stage 3 renderer alternative.
 */
export function blendedWindowTheta(delta: number, alpha: number, options: {
  previewHalfAngleRad: number; fisheyeHalfAngleRad: number; blendStartRad: number; blendEndRad: number;
}): number {
  const { previewHalfAngleRad: betaR, fisheyeHalfAngleRad: betaF, blendStartRad, blendEndRad } = options;
  if (!(blendStartRad > 0 && blendStartRad < blendEndRad && blendEndRad <= betaR && betaF > 0 && betaF <= Math.PI / 2)) {
    throw new RangeError("blend needs 0 < start < end <= flat half angle and 0 < fisheye half angle <= 90 degrees");
  }
  const q = Math.min(1, Math.max(0, (alpha - blendStartRad) / (blendEndRad - blendStartRad)));
  const weight = q * q * (3 - 2 * q);
  if (weight === 1 && alpha >= betaR) return delta;
  const flat = flatWindowTheta(delta, alpha, betaR);
  if (weight === 1) return flat;
  const rho = Math.min(1, Math.max(0, Math.sin(delta) * Math.cos(alpha) / (Math.cos(delta) * Math.sin(alpha))));
  const fisheye = Math.asin(Math.min(1, rho * Math.sin(betaF)));
  return (1 - weight) * fisheye + weight * flat;
}

// ─── Views, coverage and handoff ───────────────────────────────────────

/** A perspective view: orthonormal forward, right and up, vertical FOV and aspect (width / height). */
export interface ViewBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  verticalFovRad: number;
  aspect: number;
}

/** The ray through normalized viewport coordinates, x right and y down, both 0 to 1. */
export function viewRay(view: ViewBasis, x: number, y: number): Vec3 {
  if (!(view.verticalFovRad > 0 && view.verticalFovRad < Math.PI) || !(view.aspect > 0)) {
    throw new RangeError("a perspective view needs 0 < vertical FOV < 180 degrees and a positive aspect");
  }
  const tanHalf = Math.tan(view.verticalFovRad / 2);
  return normalize(add(view.forward, add(scale(view.right, (2 * x - 1) * tanHalf * view.aspect), scale(view.up, (1 - 2 * y) * tanHalf))));
}

export const VIEWPORT_CORNERS: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];

/**
 * Whether the orb's silhouette covers the whole viewport: every corner ray in
 * the cap a·v ≥ cos α (hemisphere at the surface, everything inside).
 */
export function viewportCovered(geometry: OrbGeometry, view: ViewBasis): boolean {
  if (geometry.inside && geometry.distance < geometry.radius) return true;
  const a = geometry.axis;
  if (!a) return true;
  const threshold = geometry.inside ? 0 : Math.cos(geometry.alpha);
  return VIEWPORT_CORNERS.every(([x, y]) => dot(a, viewRay(view, x, y)) >= threshold - 1e-12);
}

/** Largest angle from the axis to a viewport corner, radians; ≥ π/2 means an exterior sphere can never cover it. */
export function maximumCornerAngle(axis: Vec3, view: ViewBasis): number {
  return Math.max(...VIEWPORT_CORNERS.map(([x, y]) => Math.acos(Math.max(-1, Math.min(1, dot(axis, viewRay(view, x, y)))))));
}

/** Coverage and ray equality: the frame where the orb can hand off to fullscreen rendering. */
export function handoffReady(geometry: OrbGeometry, view: ViewBasis, previewHalfAngleRad: number): boolean {
  if (!viewportCovered(geometry, view)) return false;
  return geometry.inside || geometry.alpha >= previewHalfAngleRad;
}

/**
 * The virtual radius at which a fixed-axis exterior expansion first hands
 * off: α must reach both βR and every corner angle. Null when a corner is at
 * or beyond 90° from the axis: then only a fade can enter.
 */
export function expansionTargetRadius(distance: number, axis: Vec3, view: ViewBasis, previewHalfAngleRad: number, margin = 1e-4): number | null {
  const corner = maximumCornerAngle(axis, view);
  const needed = Math.max(previewHalfAngleRad, corner) + margin;
  if (needed >= Math.PI / 2) return null;
  return distance * Math.sin(needed);
}

// ─── Sizes ─────────────────────────────────────────────────────────────

/** On-axis projected diameter in the viewport's pixels: H R / (d tan(vFov/2)). A centre-density approximation. */
export function projectedDiameterPx(radius: number, distance: number, verticalFovRad: number, viewportHeightPx: number): number {
  return viewportHeightPx * radius / (Math.max(distance, radius) * Math.tan(verticalFovRad / 2));
}

/** The radius whose projected diameter is `diameterPx`: the inverse of the above. */
export function radiusForDiameterPx(diameterPx: number, distance: number, verticalFovRad: number, viewportHeightPx: number): number {
  return diameterPx * distance * Math.tan(verticalFovRad / 2) / viewportHeightPx;
}

/** Cube face texels for a disc of this diameter at the flat window's centre: diameter / tan βR, times the density asked for. */
export function previewFaceTexels(diameterPx: number, previewHalfAngleRad: number, texelsPerPixel: number): number {
  return diameterPx / Math.tan(previewHalfAngleRad) * texelsPerPixel;
}

/** Cube face texels to show a fullscreen view at `texelsPerPixel` at its centre. */
export function immersionFaceTexels(viewportHeightPx: number, verticalFovRad: number, texelsPerPixel: number): number {
  return viewportHeightPx / Math.tan(verticalFovRad / 2) * texelsPerPixel;
}

/** Equirectangular width for the same centre density: 2π texels per radian of the view's centre. */
export function immersionEquirectWidth(viewportHeightPx: number, verticalFovRad: number, texelsPerPixel: number): number {
  return Math.PI * viewportHeightPx / Math.tan(verticalFovRad / 2) * texelsPerPixel;
}

// ─── Marker placement ──────────────────────────────────────────────────

export interface CaptureLocation {
  longitudeDeg: number;
  latitudeDeg: number;
}

/**
 * Where a ground-relative marker's surface is sampled: the ENU anchor on the
 * ellipsoid (a computational height of zero, never a capture height), moved
 * east and north in ECEF, back to longitude and latitude.
 */
export function groundQueryPoint(capture: CaptureLocation, eastMeters: number, northMeters: number): { longitudeDeg: number; latitudeDeg: number } {
  const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
  const anchor = geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, 0);
  const moved = add(anchor, add(scale(frame.east, eastMeters), scale(frame.north, northMeters)));
  const { longitudeDeg, latitudeDeg } = pointGeodetic(moved);
  return { longitudeDeg, latitudeDeg };
}

/** A ground-relative marker's centre once the displayed surface height there is known. */
export function groundRelativeMarker(queryPoint: { longitudeDeg: number; latitudeDeg: number }, surfaceHeightMeters: number, offsetMeters: number): Vec3 {
  return geodeticPoint(queryPoint.longitudeDeg, queryPoint.latitudeDeg, surfaceHeightMeters + offsetMeters);
}

/** A capture-relative marker's centre: the known capture point, moved in its ENU frame. */
export function captureRelativeMarker(capture: CaptureLocation, captureHeightMeters: number, eastMeters: number, northMeters: number, offsetMeters: number): Vec3 {
  const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
  const origin = geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, captureHeightMeters);
  return add(origin, add(scale(frame.east, eastMeters), add(scale(frame.north, northMeters), scale(frame.up, offsetMeters))));
}

/** Degrees to radians and back, for callers that only import this module. */
export { DEG_TO_RAD, RAD_TO_DEG };
