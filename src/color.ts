export interface RgbImage { width: number; height: number; rgb: Uint8Array }
export interface RgbaImage { width: number; height: number; rgba: Uint8Array }
export interface LinearImage { width: number; height: number; data: Float32Array }
export interface ImageColourMetadata { srgbChunk: boolean; iccProfileName: string | null; gamma: number | null }

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToLinear(byte: number): number {
  return TO_LINEAR[byte];
}

export function linearToSrgb(value: number): number {
  const c = Math.min(1, Math.max(0, value));
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** RGB bytes → linear-light float RGB. */
export function toLinearImage({ width, height, rgb }: RgbImage): LinearImage {
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = TO_LINEAR[rgb[i]];
  return { width, height, data };
}

/** Linear-light float RGB → RGB bytes: the one output conversion. */
export function toSrgbImage({ width, height, data }: LinearImage): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i++) rgb[i] = linearToSrgb(data[i]);
  return { width, height, rgb };
}

/** Applies an EXIF orientation (1–8) to RGBA pixels, once, so nothing downstream rotates again. */
export function applyOrientation({ width, height, rgba }: RgbaImage, orientation: number): RgbaImage {
  if (orientation === 1) return { width, height, rgba };
  if (!(orientation >= 2 && orientation <= 8)) throw new Error(`unknown EXIF orientation ${orientation}`);
  const swap = orientation >= 5;
  const outWidth = swap ? height : width, outHeight = swap ? width : height;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    // Where the displayed pixel (x, y) is stored.
    let sx, sy;
    switch (orientation) {
      case 2: sx = width - 1 - x; sy = y; break;
      case 3: sx = width - 1 - x; sy = height - 1 - y; break;
      case 4: sx = x; sy = height - 1 - y; break;
      case 5: sx = y; sy = x; break;
      case 6: sx = y; sy = height - 1 - x; break;
      case 7: sx = width - 1 - y; sy = height - 1 - x; break;
      default: sx = width - 1 - y; sy = x; break;
    }
    out.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * outWidth + x) * 4);
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

/**
 * Whether colour data can be taken as sRGB without an ICC engine: untagged,
 * tagged sRGB, or gamma ≈ 1/2.2. Anything else must be converted before
 * preparation; the tool refuses rather than guess.
 */
export function colourIsSrgb(colour: ImageColourMetadata): { ok: boolean; reason: string } {
  if (colour.srgbChunk) return { ok: true, reason: "sRGB chunk" };
  if (colour.iccProfileName) {
    return /srgb|iec\s*61966-2[.-]1/i.test(colour.iccProfileName)
      ? { ok: true, reason: `ICC profile "${colour.iccProfileName}"` }
      : { ok: false, reason: `ICC profile "${colour.iccProfileName}" is not sRGB` };
  }
  if (colour.gamma !== null && Math.abs(colour.gamma - 1 / 2.2) > 0.01) return { ok: false, reason: `gamma ${colour.gamma} is not sRGB's` };
  return { ok: true, reason: "untagged, taken as sRGB" };
}

/** RGBA → RGB, refusing any pixel that is not opaque. */
export function dropOpaqueAlpha({ width, height, rgba }: RgbaImage): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] !== 255) throw new Error(`pixel ${i % width},${Math.floor(i / width)} is not opaque; version 1 panoramas are opaque`);
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, rgb };
}
