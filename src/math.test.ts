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
  it("gives a whole horizontal pass then a vertical one's float32 values, bit for bit, halvings included", () => {
    const twoPass = ({ width, height, data }: { width: number; height: number; data: Float32Array }, outWidth: number, outHeight: number) => {
      const horizontal = new Float32Array(outWidth * height * 3), out = new Float32Array(outWidth * outHeight * 3), sx = width / outWidth, sy = height / outHeight;
      for (let x = 0; x < outWidth; x++) for (let px = Math.floor(x * sx); px < Math.min(Math.ceil((x + 1) * sx), width); px++) {
        const weight = (Math.min((x + 1) * sx, px + 1) - Math.max(x * sx, px)) / sx;
        for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) horizontal[(y * outWidth + x) * 3 + c] += data[(y * width + px) * 3 + c] * weight;
      }
      for (let y = 0; y < outHeight; y++) for (let py = Math.floor(y * sy); py < Math.min(Math.ceil((y + 1) * sy), height); py++) {
        const weight = (Math.min((y + 1) * sy, py + 1) - Math.max(y * sy, py)) / sy;
        for (let i = 0; i < outWidth * 3; i++) out[y * outWidth * 3 + i] += horizontal[py * outWidth * 3 + i] * weight;
      }
      return out;
    };
    for (const [width, height, outWidth, outHeight] of [[40, 22, 20, 11], [1062, 531, 531, 265], [25, 12, 11, 5], [37, 23, 10, 7], [9, 5, 13, 8], [7, 3, 7, 3], [6, 4, 0, 2]]) {
      const data = new Float32Array(width * height * 3);
      // Pairs of rows of float32 subnormals, where halving a value is not exact, among ordinary values and -0.
      for (let index = 0; index < data.length; index++) {
        data[index] = Math.floor(index / (width * 6)) % 3 === 1 ? (index * 7 % 5) * 2 ** -149 : index % 97 === 0 ? -0 : 2.5 * Math.sin(index * 12.9898) - 0.25;
      }
      const fast = resizeArea({ width, height, data }, outWidth, outHeight).data, plain = twoPass({ width, height, data }, outWidth, outHeight);
      expect(new Uint32Array(fast.buffer), `${width}x${height} -> ${outWidth}x${outHeight}`).toEqual(new Uint32Array(plain.buffer));
    }
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
  it("keeps sphere roles by default and admits the rectangle image role only when an owner names it", () => {
    const rectangle = { id: "photo", role: "image", mimeType: "image/png", encodedBytes: 10 };
    const sphere = new ImageRecordChecker();
    expect(checkImageRepresentationBase(sphere, rectangle, "$.image")).toBeNull();
    expect(sphere.errors).toEqual([{ path: "$.image.role", message: 'must be one of "preview", "immersion"' }]);
    const owner = new ImageRecordChecker();
    expect(checkImageRepresentationBase(owner, rectangle, "$.image", ["image"] as const)?.role).toBe("image");
    expect(checkImageRepresentationBase(owner, { ...rectangle, role: "preview" }, "$.other", ["image"] as const)).toBeNull();
    expect(owner.errors).toEqual([{ path: "$.other.role", message: 'must be one of "image"' }]);
  });
});
