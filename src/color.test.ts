import { describe, expect, it } from "vitest";
import { applyOrientation, colourIsSrgb, dropOpaqueAlpha, linearToSrgb, toLinearImage, toSrgbImage } from "./color.js";

describe("common colour and orientation", () => {
  it("resamples values in linear light before the single output conversion", () => {
    const linear = toLinearImage({ width: 2, height: 1, rgb: new Uint8Array([0, 0, 0, 255, 255, 255]) });
    expect(linearToSrgb((linear.data[0] + linear.data[3]) / 2)).toBe(188);
    expect([...toSrgbImage(linear).rgb]).toEqual([0, 0, 0, 255, 255, 255]);
  });
  it("applies source orientation once and refuses transparent version-1 pixels", () => {
    const image = { width: 2, height: 1, rgba: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]) };
    const normalized = applyOrientation(image, 6);
    expect(normalized.width).toBe(1); expect(normalized.height).toBe(2);
    expect(applyOrientation(normalized, 1)).toEqual(normalized);
    expect([...dropOpaqueAlpha(normalized).rgb]).toEqual([10, 20, 30, 40, 50, 60]);
    expect(() => dropOpaqueAlpha({ ...image, rgba: new Uint8Array(8) })).toThrow("not opaque");
    expect(() => applyOrientation(image, 0)).toThrow("orientation");
  });
  it("converts each float32 as linearToSrgb does, around every output step", () => {
    const float = new Float32Array(1), bits = new Uint32Array(float.buffer), at = (pattern: number) => { bits[0] = pattern; return linearToSrgb(float[0]); };
    const patterns = [0, 1, 0x80000000, 0xbf800000, 0x3f7fffff, 0x3f800000, 0x3f800001, 0x40000000, 0x7f7fffff, 0x7f800000, 0x7f800001, 0x7fc00000, 0xff800000, 0xffc00000, 0xffffffff];
    for (let pattern = 0; pattern < 0x3f800000; pattern += 0x3f001) patterns.push(pattern);
    for (let k = 1; k <= 255; k++) {
      // The first pattern with an output of k or more, and its neighbours.
      let low = 0, high = 0x3f800000;
      while (low < high) { const middle = (low + high) >>> 1; if (at(middle) >= k) high = middle; else low = middle + 1; }
      for (let pattern = Math.max(0, low - 16); pattern <= low + 16; pattern++) patterns.push(pattern);
    }
    while (patterns.length % 3) patterns.push(0);
    // What a Uint8Array keeps of linearToSrgb's output: NaN, for NaN, becomes 0.
    const data = new Float32Array(new Uint32Array(patterns).buffer), expected = Uint8Array.from(patterns, at);
    expect(toSrgbImage({ width: patterns.length / 3, height: 1, data }).rgb).toEqual(expected);
    expect(toSrgbImage({ width: patterns.length / 3 - 1, height: 1, data: data.subarray(3) }).rgb).toEqual(expected.slice(3));
    expect([...toSrgbImage({ width: 2, height: 1, data: Float64Array.from([-1, 0.2, 0.5, 1, 2, NaN]) as unknown as Float32Array }).rgb]).toEqual([0, 124, 188, 255, 255, 0]);
  });
  it("orients and drops alpha as the per-pixel forms do, whatever the array's alignment", () => {
    const width = 70, height = 131, buffer = new ArrayBuffer(width * height * 4 + 4);
    const stored = (orientation: number, x: number, y: number) => [[x, y], [x, y], [width - 1 - x, y], [width - 1 - x, height - 1 - y], [x, height - 1 - y], [y, x], [y, height - 1 - x], [width - 1 - y, height - 1 - x], [width - 1 - y, x]][orientation];
    for (const byteOffset of [0, 1]) {
      const rgba = new Uint8Array(buffer, byteOffset, width * height * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : Math.imul(i, 0x9e3779b1) >>> 24;
      for (let orientation = 2; orientation <= 8; orientation++) {
        const oriented = applyOrientation({ width, height, rgba }, orientation), expected = new Uint8Array(rgba.length);
        for (let y = 0; y < oriented.height; y++) for (let x = 0; x < oriented.width; x++) {
          const [sx, sy] = stored(orientation, x, y);
          expected.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * oriented.width + x) * 4);
        }
        expect([oriented.width, oriented.height]).toEqual(orientation >= 5 ? [height, width] : [width, height]);
        expect(oriented.rgba, `orientation ${orientation}, byte offset ${byteOffset}`).toEqual(expected);
      }
      expect(dropOpaqueAlpha({ width, height, rgba }).rgb).toEqual(Uint8Array.from({ length: width * height * 3 }, (_, i) => rgba[Math.floor(i / 3) * 4 + i % 3]));
      rgba[(2 * width + 5) * 4 + 3] = 254;
      expect(() => dropOpaqueAlpha({ width, height, rgba })).toThrow("pixel 5,2 is not opaque");
    }
  });
  it("keeps unsupported colour profiles explicit", () => {
    expect(colourIsSrgb({ iccProfileName: "Display P3", gamma: null, srgbChunk: false }).ok).toBe(false);
    expect(colourIsSrgb({ iccProfileName: "sRGB", gamma: null, srgbChunk: false }).ok).toBe(true);
  });
});
