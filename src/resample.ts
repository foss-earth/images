import type { LinearImage } from "./color.js";

/** Exact area-average resize of a linear image: each output texel is the mean of the source area it covers. */
export function resizeArea(image: LinearImage, outWidth: number, outHeight: number): LinearImage {
  const { width, height, data } = image;
  const horizontal = new Float32Array(outWidth * height * 3);
  const sx = width / outWidth;
  for (let x = 0; x < outWidth; x++) {
    const start = x * sx, end = (x + 1) * sx;
    for (let px = Math.floor(start); px < Math.ceil(end); px++) {
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
    for (let py = Math.floor(start); py < Math.ceil(end); py++) {
      const weight = (Math.min(end, py + 1) - Math.max(start, py)) / sy;
      const s0 = py * outWidth * 3, d0 = y * outWidth * 3;
      for (let i = 0; i < outWidth * 3; i++) out[d0 + i] += horizontal[s0 + i] * weight;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}
