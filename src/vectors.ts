/** Shared image-local vectors and image pose, with no geographic or renderer dependency. */
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
export const angleDeg = (a: Vec3, b: Vec3): number => Math.atan2(length(cross(a, b)), dot(a, b)) * (180 / Math.PI);
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
  return mulMat3Mat3(mulMat3Mat3(rotationZ(-pose.headingDeg * (Math.PI / 180)), rotationX(pose.pitchDeg * (Math.PI / 180))), rotationY(pose.rollDeg * (Math.PI / 180)));
}
