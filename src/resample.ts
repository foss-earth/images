import type { LinearImage } from "./color.js";

/**
 * Exact area-average resize of a linear image: each output texel is the mean of the source area it covers.
 * An area's far edge, (i + 1) × the scale, can round past the source's last column or row, as 265 × (531 / 265)
 * does: nothing beyond them is read, where once a row of undefined made the last output row NaN.
 */
export function resizeArea(image: LinearImage, outWidth: number, outHeight: number): LinearImage {
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
