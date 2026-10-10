import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, decodeJpeg, encodeJpeg, inspectImageDecode, ImageDecodeLimitError } from "../node/codecs.mjs";

const png = encodePng({ width: 2, height: 1, rgb: new Uint8Array([1, 2, 3, 4, 5, 6]) });
const chunk = (type: string, body: Buffer) => {
  // Decoder fixtures only: CRC is immaterial to the allocation path under test.
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4);
  return Buffer.concat([head, body, Buffer.alloc(4)]);
};
const insert = (...chunks: Buffer[]) => Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
const bounded = { maxPixels: 2, maxEncodedBytes: 2000, maxMemoryBytes: 2 * 1024 * 1024, maxMetadataBytes: 128, maxChunks: 12 };

describe("caller-bounded public codecs", () => {
  it("preserves PNG output and makes its complete reservation observable", () => {
    const plan = inspectImageDecode(png, bounded);
    expect(plan.pixels).toBe(2); expect(plan.rgbaBytes).toBe(8);
    expect(plan.workingBytes).toBeGreaterThan(plan.rgbaBytes + png.length);
    expect([...decodePng(png, bounded).rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(() => decodePng(png, { ...bounded, maxMemoryBytes: plan.workingBytes - 1 })).toThrow(ImageDecodeLimitError);
  });
  it.each(["maxPixels", "maxEncodedBytes", "maxChunks"] as const)("rejects %s admission before decode", key => {
    expect(() => decodePng(png, { ...bounded, [key]: 1 })).toThrow(ImageDecodeLimitError);
  });
  it.each([0, -1, Infinity, NaN, 1.5])("rejects non-finite/integral budgets (%s)", maxPixels => {
    expect(() => decodePng(png, { maxPixels })).toThrow(RangeError);
  });
  it("bounds IDAT expansion to declared rows even with a tiny compressed bomb", () => {
    const oversized = Buffer.concat([png.subarray(0, 33), chunk("IDAT", deflateSync(Buffer.alloc(1000000))), chunk("IEND", Buffer.alloc(0))]);
    expect(() => decodePng(oversized, bounded)).toThrow(/inflation exceeds declared/);
  });
  it("bounds ICC inflation before parsing its profile", () => {
    const icc = Buffer.concat([Buffer.from("profile\0\0"), deflateSync(Buffer.alloc(1000000))]);
    expect(() => decodePng(insert(chunk("iCCP", icc)), bounded)).toThrow(/metadata inflation/);
  });
  it("bounds compressed XMP inflation and cumulative uncompressed metadata", () => {
    const head = Buffer.from("XML:com.adobe.xmp\0\x01\0\0\0", "latin1");
    expect(() => decodePng(insert(chunk("iTXt", Buffer.concat([head, deflateSync(Buffer.alloc(1000000))]))), bounded)).toThrow(/metadata inflation/);
    const plain = Buffer.from("XML:com.adobe.xmp\0\0\0\0\0" + "x".repeat(80));
    expect(() => decodePng(insert(chunk("iTXt", plain), chunk("iTXt", plain)), bounded)).toThrow(/metadata budget/);
  });
  it("rejects truncated chunks, wrong row length and invalid filters", () => {
    expect(() => decodePng(png.subarray(0, png.length - 2), bounded)).toThrow(/Truncated/);
    const replace = (raw: Buffer) => Buffer.concat([png.subarray(0, 33), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    expect(() => decodePng(replace(Buffer.alloc(6)), bounded)).toThrow(/row length/);
    expect(() => decodePng(replace(Buffer.from([5, 1, 2, 3, 4, 5, 6])), bounded)).toThrow(/filter/);
  });
  it("passes a caller memory/resolution budget to JPEG, preserving old calls", () => {
    const jpeg = encodeJpeg({ width: 8, height: 8, rgb: new Uint8Array(192).fill(50) }, 90);
    const options = { ...bounded, maxPixels: 64, maxEncodedBytes: 4000 };
    expect(decodeJpeg(jpeg, options).width).toBe(8); expect(decodeJpeg(jpeg).height).toBe(8);
    expect(() => decodeJpeg(jpeg, { ...options, maxPixels: 63 })).toThrow(ImageDecodeLimitError);
    expect(() => decodeJpeg(jpeg, { ...options, maxMemoryBytes: 100 })).toThrow(ImageDecodeLimitError);
    expect(() => decodeJpeg(jpeg, { ...options, maxMetadataBytes: 1 })).toThrow(/metadata budget/);
  });
  it("honors cancellation before any decode work", () => {
    const controller = new AbortController(); controller.abort(new Error("host cancelled"));
    expect(() => decodePng(png, { ...bounded, signal: controller.signal })).toThrow("host cancelled");
    expect(() => inspectImageDecode(png, { signal: controller.signal })).toThrow("host cancelled");
  });
});
