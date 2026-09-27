import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkImage, readImageHeader } from "./imageHeaders";

const media = new URL("../../public/examples/panorama-scenes/media/", import.meta.url);
const face = new Uint8Array(readFileSync(new URL("cardinal-grid/preview-64/px.jpg", media)));
const whole = new Uint8Array(readFileSync(new URL("cardinal-grid/immersion-1024.jpg", media)));

/** A JPEG with an APP1 Exif segment carrying `orientation`, inserted after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number, little: boolean): Uint8Array {
  const u16 = (value: number) => (little ? [value & 255, value >> 8] : [value >> 8, value & 255]);
  const u32 = (value: number) => (little ? [value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24] : [value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const segment = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

describe("panorama image headers", () => {
  it("reads a prepared face's and a whole image's size without decoding them", () => {
    expect(readImageHeader(face)).toEqual({ kind: "image/jpeg", width: 64, height: 64, orientation: null });
    expect(readImageHeader(whole)).toMatchObject({ width: 1024, height: 512 });
  });

  it("reads EXIF orientation in either byte order", () => {
    expect(readImageHeader(withOrientation(face, 6, true))?.orientation).toBe(6);
    expect(readImageHeader(withOrientation(face, 3, false))?.orientation).toBe(3);
  });

  it("accepts what is declared and refuses a wrong type, size, served type or orientation", () => {
    const declared = { mimeType: "image/jpeg" as const, width: 64, height: 64 };
    expect(checkImage(face, declared, "image/jpeg")).toBeNull();
    expect(checkImage(face, declared, null)).toBeNull();
    expect(checkImage(face, { ...declared, mimeType: "image/png" }, null)).toContain("is a image/jpeg file");
    expect(checkImage(face, { ...declared, width: 128, height: 128 }, null)).toContain("is 64×64 pixels, declared 128×128");
    expect(checkImage(face, declared, "image/png")).toContain("served as image/png");
    expect(checkImage(withOrientation(face, 6, true), declared, null)).toContain("EXIF orientation 6");
    expect(checkImage(withOrientation(face, 1, true), declared, null)).toBeNull();
    expect(checkImage(new Uint8Array([1, 2, 3]), declared, null)).toContain("not a readable JPEG or PNG");
  });

  it("reads a PNG's size from IHDR", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 8, 0, 0, 0, 4, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
    expect(readImageHeader(png)).toEqual({ kind: "image/png", width: 2048, height: 1024, orientation: null });
  });
});
