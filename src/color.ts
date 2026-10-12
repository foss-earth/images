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
  const table = data instanceof Float32Array ? srgbTable() : null;
  if (!table) {
    for (let i = 0; i < data.length; i++) rgb[i] = linearToSrgb(data[i]);
    return { width, height, rgb };
  }
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length), { shift, base, next } = table;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    if (b < FLOAT_ONE) { const j = b >>> shift; rgb[i] = b >= next[j] ? base[j] + 1 : base[j]; }
    else rgb[i] = b <= FLOAT_INFINITY ? 255 : 0; // 1 to +Infinity; NaN and negative values (sign bit set) give 0
  }
  return { width, height, rgb };
}

const FLOAT_ONE = 0x3f800000, FLOAT_INFINITY = 0x7f800000;
interface SrgbTable { shift: number; base: Uint8Array; next: Uint32Array }
let builtSrgbTable: SrgbTable | null | undefined;

/**
 * linearToSrgb for every float32 below 1, read from the float's bits. Each output k from 1 to 255 begins at a
 * threshold, the first bit pattern whose output is k or more, found by bisection with linearToSrgb itself, which
 * rises with its input. The patterns are bucketed by their top bits, with the bucket small enough to hold at
 * most one threshold, so a pattern's output is its bucket's first output, plus 1 at or after that threshold.
 * An output can only differ from the rising ideal within a few patterns of a threshold, so those are checked
 * against linearToSrgb; should any differ, toSrgbImage keeps calling linearToSrgb.
 */
function srgbTable(): SrgbTable | null {
  if (builtSrgbTable !== undefined) return builtSrgbTable;
  const float = new Float32Array(1), bits = new Uint32Array(float.buffer);
  const at = (pattern: number) => { bits[0] = pattern; return linearToSrgb(float[0]); };
  const thresholds = new Uint32Array(256);
  for (let k = 1; k <= 255; k++) {
    let low = 0, high = FLOAT_ONE;
    while (low < high) { const middle = (low + high) >>> 1; if (at(middle) >= k) high = middle; else low = middle + 1; }
    thresholds[k] = low;
  }
  builtSrgbTable = null;
  for (let shift = 15; shift >= 8 && !builtSrgbTable; shift--) {
    const buckets = (FLOAT_ONE >>> shift) + 1, base = new Uint8Array(buckets), next = new Uint32Array(buckets).fill(0xffffffff);
    let fits = true;
    for (let j = 0; j < buckets; j++) base[j] = at(Math.min(FLOAT_ONE - 1, j << shift));
    for (let k = 1; k <= 255 && fits; k++) {
      const t = thresholds[k], j = t >>> shift;
      if (j << shift === t) continue;
      if (next[j] !== 0xffffffff) fits = false;
      next[j] = t;
    }
    if (fits) builtSrgbTable = { shift, base, next };
  }
  const table = builtSrgbTable;
  if (!table) return null;
  for (let k = 1; k <= 255; k++) {
    for (let pattern = Math.max(0, thresholds[k] - 8); pattern <= Math.min(FLOAT_ONE - 1, thresholds[k] + 8); pattern++) {
      const j = pattern >>> table.shift;
      if ((pattern >= table.next[j] ? table.base[j] + 1 : table.base[j]) !== at(pattern)) return (builtSrgbTable = null);
    }
  }
  return table;
}

/** Applies an EXIF orientation (1–8) to RGBA pixels, once, so nothing downstream rotates again. */
export function applyOrientation({ width, height, rgba }: RgbaImage, orientation: number): RgbaImage {
  if (orientation === 1) return { width, height, rgba };
  if (!(orientation >= 2 && orientation <= 8)) throw new Error(`unknown EXIF orientation ${orientation}`);
  const swap = orientation >= 5;
  const outWidth = swap ? height : width, outHeight = swap ? width : height;
  const out = new Uint8Array(rgba.length);
  if (Number.isInteger(orientation) && wholePixels(width, height, rgba)) {
    // Whole pixels as 32-bit words: rows for the flips, 64-pixel squares for the transposes.
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height), dst = new Uint32Array(out.buffer, 0, width * height);
    if (!swap) {
      for (let y = 0; y < outHeight; y++) {
        const s = (orientation === 2 ? y : height - 1 - y) * width, d = y * outWidth;
        if (orientation === 4) dst.set(src.subarray(s, s + width), d);
        else for (let x = 0; x < outWidth; x++) dst[d + x] = src[s + width - 1 - x];
      }
    } else {
      for (let by = 0; by < outHeight; by += 64) for (let bx = 0; bx < outWidth; bx += 64) {
        for (let y = by, yEnd = Math.min(outHeight, by + 64); y < yEnd; y++) {
          const sx = orientation === 5 || orientation === 6 ? y : width - 1 - y;
          for (let x = bx, xEnd = Math.min(outWidth, bx + 64); x < xEnd; x++) dst[y * outWidth + x] = src[(orientation === 5 || orientation === 8 ? x : height - 1 - x) * width + sx];
        }
      }
    }
    return { width: outWidth, height: outHeight, rgba: out };
  }
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
  if (LITTLE_ENDIAN && wholePixels(width, height, rgba)) {
    // Whole pixels as 32-bit words, alpha in the top byte.
    const words = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    for (let i = 0, o = 0; i < words.length; i++, o += 3) {
      const v = words[i];
      if (v >>> 24 !== 255) throw new Error(`pixel ${i % width},${Math.floor(i / width)} is not opaque; version 1 panoramas are opaque`);
      rgb[o] = v; rgb[o + 1] = v >>> 8; rgb[o + 2] = v >>> 16;
    }
    return { width, height, rgb };
  }
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] !== 255) throw new Error(`pixel ${i % width},${Math.floor(i / width)} is not opaque; version 1 panoramas are opaque`);
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, rgb };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Whether width × height RGBA pixels can be read as aligned 32-bit words of `rgba`. */
function wholePixels(width: number, height: number, rgba: Uint8Array): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 0 && height >= 0
    && rgba instanceof Uint8Array && rgba.byteOffset % 4 === 0 && rgba.length >= width * height * 4;
}
