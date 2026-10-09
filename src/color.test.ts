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
  it("keeps unsupported colour profiles explicit", () => {
    expect(colourIsSrgb({ iccProfileName: "Display P3", gamma: null, srgbChunk: false }).ok).toBe(false);
    expect(colourIsSrgb({ iccProfileName: "sRGB", gamma: null, srgbChunk: false }).ok).toBe(true);
  });
});
