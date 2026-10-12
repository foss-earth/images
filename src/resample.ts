import type { LinearImage } from "./color.js";

/**
 * Exact area-average resize of a linear image: each output texel is the mean of the source area it covers.
 * An area's far edge, (i + 1) × the scale, can round past the source's last column or row, as 265 × (531 / 265)
 * does: nothing beyond them is read, where once a row of undefined made the last output row NaN.
 *
 * Each output row pulls its source rows through the horizontal pass one at a time, in the order and float32
 * rounding of a horizontal pass over the whole image followed by a vertical one, so no intermediate image of
 * outWidth × height is kept. Exact halvings, every pyramid level, take a shorter path to the same values.
 */
export function resizeArea(image: LinearImage, outWidth: number, outHeight: number): LinearImage {
  if (!wholeSize(outWidth) || !wholeSize(outHeight) || !wholeSize(image.width) || !wholeSize(image.height)) return resizeAreaTwoPass(image, outWidth, outHeight);
  if (image.width === 2 * outWidth && image.height === 2 * outHeight) return halve(image, outWidth, outHeight);
  const { width, height, data } = image;
  const taps = axisTaps(width, outWidth);
  const stride = outWidth * 3, out = new Float32Array(outWidth * outHeight * 3), row = new Float32Array(stride);
  const sy = height / outHeight;
  // Source rows only move down, and a row an output row ends on is often the next one's first, so the last one is kept.
  let rowIndex = -1;
  for (let y = 0; y < outHeight; y++) {
    const start = y * sy, end = (y + 1) * sy, d0 = y * stride;
    for (let py = Math.floor(start), last = Math.min(Math.ceil(end), height); py < last; py++) {
      const weight = (Math.min(end, py + 1) - Math.max(start, py)) / sy;
      if (py !== rowIndex) { horizontalRow(data, py * width * 3, taps, outWidth, row); rowIndex = py; }
      for (let i = 0; i < stride; i++) out[d0 + i] = Math.fround(out[d0 + i] + row[i] * weight);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

const wholeSize = (value: number) => Number.isSafeInteger(value) && value >= 0;

interface Taps { first: Int32Array; count: Int32Array; offset: Int32Array; weights: Float64Array }

/** For each output column, its source columns floor(start) up to ceil(end), within the image, and their weights. */
function axisTaps(inSize: number, outSize: number): Taps {
  const s = inSize / outSize;
  const first = new Int32Array(outSize), count = new Int32Array(outSize), offset = new Int32Array(outSize + 1);
  const weights: number[] = [];
  for (let i = 0; i < outSize; i++) {
    const start = i * s, end = (i + 1) * s;
    const p0 = Math.floor(start), p1 = Math.min(Math.ceil(end), inSize);
    first[i] = p0; count[i] = Math.max(0, p1 - p0); offset[i] = weights.length;
    for (let p = p0; p < p1; p++) weights.push((Math.min(end, p + 1) - Math.max(start, p)) / s);
  }
  offset[outSize] = weights.length;
  return { first, count, offset, weights: Float64Array.from(weights) };
}

/** One source row through the horizontal pass, each sum rounded to float32 after every tap as a Float32Array does. */
function horizontalRow(data: Float32Array, rowStart: number, { first, count, offset, weights }: Taps, outWidth: number, out: Float32Array): void {
  for (let x = 0, d = 0; x < outWidth; x++, d += 3) {
    let r = 0, g = 0, b = 0;
    for (let k = 0, s = rowStart + first[x] * 3, w0 = offset[x], n = count[x]; k < n; k++, s += 3) {
      const w = weights[w0 + k];
      r = Math.fround(r + data[s] * w); g = Math.fround(g + data[s + 1] * w); b = Math.fround(b + data[s + 2] * w);
    }
    out[d] = r; out[d + 1] = g; out[d + 2] = b;
  }
}

/** A 2:1 halving, where every weight is exactly 0.5: each value is the two-pass sums' float32 roundings in turn. */
function halve({ width, data }: LinearImage, outWidth: number, outHeight: number): LinearImage {
  const out = new Float32Array(outWidth * outHeight * 3), rowIn = width * 3;
  for (let y = 0, d = 0; y < outHeight; y++) {
    for (let x = 0, s0 = 2 * y * rowIn, s1 = s0 + rowIn; x < outWidth; x++, s0 += 6, s1 += 6) {
      for (let c = 0; c < 3; c++, d++) {
        // Sums start at +0, as a new Float32Array does, which also turns a -0 product into +0.
        const top = Math.fround(Math.fround(0 + data[s0 + c] * 0.5) + data[s0 + 3 + c] * 0.5);
        const bottom = Math.fround(Math.fround(0 + data[s1 + c] * 0.5) + data[s1 + 3 + c] * 0.5);
        out[d] = Math.fround(Math.fround(0 + top * 0.5) + bottom * 0.5);
      }
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/** The plain horizontal-then-vertical form, kept for sizes that are not whole numbers. */
function resizeAreaTwoPass(image: LinearImage, outWidth: number, outHeight: number): LinearImage {
  const { width, height, data } = image;
  const horizontal = new Float32Array(outWidth * height * 3);
  const sx = width / outWidth;
  for (let x = 0; x < outWidth; x++) {
    const start = x * sx, end = (x + 1) * sx;
    for (let px = Math.floor(start), last = Math.min(Math.ceil(end), width); px < last; px++) {
      const weight = (Math.min(end, px + 1) - Math.max(start, px)) / sx;
      for (let y = 0; y < height; y++) {
        const s = (y * width + px) * 3, d = (y * outWidth + x) * 3;
        horizontal[d] += data[s] * weight;
        horizontal[d + 1] += data[s + 1] * weight;
        horizontal[d + 2] += data[s + 2] * weight;
      }
    }
  }
  const out = new Float32Array(outWidth * outHeight * 3);
  const sy = height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    const start = y * sy, end = (y + 1) * sy;
    for (let py = Math.floor(start), last = Math.min(Math.ceil(end), height); py < last; py++) {
      const weight = (Math.min(end, py + 1) - Math.max(start, py)) / sy;
      const s0 = py * outWidth * 3, d0 = y * outWidth * 3;
      for (let i = 0; i < outWidth * 3; i++) out[d0 + i] += horizontal[s0 + i] * weight;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}
