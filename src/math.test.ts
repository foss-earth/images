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
