import { describe, expect, it } from "vitest";
import { imagePoseMatrix, mulMat3, transpose3, angleDeg } from "./vectors.js";
import { resizeArea } from "./resample.js";
import { toLinearImage, toSrgbImage } from "./color.js";
import { ImageRecordChecker, checkImageRepresentationBase, resolveImageUrl } from "./records.js";

describe("common image math and records", () => {
  it("round trips a posed direction without any world or geographic service", () => {
    const pose = imagePoseMatrix({ headingDeg: 135, pitchDeg: 17, rollDeg: -6 });
    const direction = [0.2, 0.8, -0.4] as const;
    expect(angleDeg(mulMat3(transpose3(pose), mulMat3(pose, direction)), direction)).toBeLessThan(1e-10);
    expect(angleDeg(mulMat3(imagePoseMatrix({ headingDeg: 90, pitchDeg: 0, rollDeg: 0 }), [0, 1, 0]), [1, 0, 0])).toBeLessThan(1e-10);
  });
  it("area resamples in linear light before the single output conversion", () => {
    const source = toLinearImage({ width: 2, height: 1, rgb: new Uint8Array([0, 0, 0, 255, 255, 255]) });
    const resized = toSrgbImage(resizeArea(source, 1, 1));
    expect([...resized.rgb]).toEqual([188, 188, 188]);
  });
  it("reads nothing past the source's last row or column where an area's edge rounds beyond it", () => {
    // 531 / 265 × 265 rounds above 531 and 12 / 5 × 5 above 12: the last output row once read a row past the source and was NaN.
    for (const [width, height, outWidth, outHeight] of [[1062, 531, 531, 265], [25, 12, 11, 5]]) {
      expect((outHeight * (height / outHeight)) > height || (outWidth * (width / outWidth)) > width, `${width}x${height} -> ${outWidth}x${outHeight}`).toBe(true);
      const data = new Float32Array(width * height * 3);
      for (let index = 0; index < data.length; index++) data[index] = 0.25 + 0.5 * ((index * 7919) % 101) / 100;
      const resized = resizeArea({ width, height, data }, outWidth, outHeight);
      expect(resized.data.every(Number.isFinite), `${width}x${height} -> ${outWidth}x${outHeight}`).toBe(true);
      // The last row is the mean of the source area it covers, as every other is.
      const y = outHeight - 1, x = outWidth - 1, sx = width / outWidth, sy = height / outHeight;
      let sum = 0, area = 0;
      for (let py = Math.floor(y * sy); py < height; py++) {
        for (let px = Math.floor(x * sx); px < width; px++) {
          const weight = (Math.min((y + 1) * sy, py + 1) - Math.max(y * sy, py)) * (Math.min((x + 1) * sx, px + 1) - Math.max(x * sx, px));
          sum += data[(py * width + px) * 3] * weight;
          area += weight;
        }
      }
      expect(resized.data[(y * outWidth + x) * 3]).toBeCloseTo(sum / area, 5);
    }
    // One grey stays that grey to the last row and column.
    const grey = resizeArea({ width: 25, height: 12, data: new Float32Array(25 * 12 * 3).fill(0.5) }, 11, 5);
    expect(grey.data.every(value => Math.abs(value - 0.5) < 1e-6)).toBe(true);
  });
  it("validates shared records and resolves safe source URLs without accepting spatial fields itself", () => {
    const checker = new ImageRecordChecker();
    const record = checkImageRepresentationBase(checker, { id: "preview", role: "preview", mimeType: "image/jpeg", encodedBytes: 100, extensions: { "owner.data": { value: true } } }, "$.image");
    expect(record?.id).toBe("preview");
    expect(resolveImageUrl(checker, "face.jpg", "$.url", new URL("https://example.invalid/scenes/main.json"))).toBe("https://example.invalid/scenes/face.jpg");
    expect(checker.errors).toEqual([]);
    expect(resolveImageUrl(checker, "https://user:secret@example.invalid/image.jpg", "$.url", null)).toBeNull();
    expect(checker.errors.at(-1)?.message).toBe("must not carry credentials");
  });
});
