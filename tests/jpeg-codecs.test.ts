import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { decodeJpeg, encodeJpeg, inspectImageDecode, DEFAULT_IMAGE_DECODE_LIMITS } from "../node/codecs.mjs";
import { decodeSequentialJpeg } from "../node/jpegDecode.mjs";

// node/jpegEncode.mjs and node/jpegDecode.mjs must give exactly what jpeg-js
// 0.4.4 gives: the same bytes, the same pixels, the same failures.
type JpegOptions = { useTArray: true; formatAsRGBA: boolean; maxMemoryUsageInMB: number; maxResolutionInMP: number };
type Decoded = { width: number; height: number; data: Uint8Array } | null;
const sequential = decodeSequentialJpeg as (data: Uint8Array, options: JpegOptions) => Decoded;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/jpeg/${name}.jpg`, import.meta.url));
const SEQUENTIAL = ["420-optimized", "422", "440", "411", "mixed-sampling", "chroma-larger", "grey", "grey-restart-5-blocks", "420-restart-3-blocks", "separate-scans", "rgb"];
const LEFT_TO_JPEG_JS = ["progressive", "arithmetic", "12-bit"];

/** The options decodeJpeg passes to jpeg-js for these bytes and limits. */
function jpegOptions(bytes: Buffer, options: Partial<typeof DEFAULT_IMAGE_DECODE_LIMITS> = {}): JpegOptions {
  const limits = { ...DEFAULT_IMAGE_DECODE_LIMITS, ...options }, plan = inspectImageDecode(bytes, options);
  const overhead = bytes.byteLength * 4 + limits.maxMetadataBytes * 4 + 1024 * 1024;
  return { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: (plan.workingBytes - overhead) / (1024 * 1024), maxResolutionInMP: limits.maxPixels / 1000000 };
}
/** Pixels as base64, or the error's message. */
function outcome(decode: () => Decoded): string {
  try { const decoded = decode(); return decoded ? `${decoded.width}x${decoded.height} ${Buffer.from(decoded.data).toString("base64")}` : "null"; }
  catch (error) { return `error: ${(error as Error).message}`; }
}
const viaNew = (bytes: Uint8Array, options: JpegOptions) => outcome(() => sequential(bytes, options) ?? jpeg.decode(bytes, options));
const viaJpegJs = (bytes: Uint8Array, options: JpegOptions) => outcome(() => jpeg.decode(bytes, options));

function random(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function photo(width: number, height: number, seed: number) {
  const next = random(seed), rgb = new Uint8Array(width * height * 3);
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 3) {
    const base = 128 + 100 * Math.sin(4 * x / width * Math.PI) * Math.cos(3 * y / height * Math.PI);
    const step = ((x >> 3) + (y >> 2)) & 1 ? 40 : -40, noise = (next() - 0.5) * 50;
    rgb[i] = clamp(base + step + noise); rgb[i + 1] = clamp(0.7 * base + noise); rgb[i + 2] = clamp(255 - base + noise - step);
  }
  return { width, height, rgb };
}
const withAlpha = ({ width, height, rgb }: { width: number; height: number; rgb: Uint8Array }) => {
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; }
  return { width, height, data: rgba };
};

describe("JPEG decoding", () => {
  it.each(SEQUENTIAL)("decodes %s to jpeg-js's exact pixels itself", name => {
    const bytes = fixture(name), options = jpegOptions(bytes), mine = sequential(bytes, options);
    expect(mine).not.toBeNull();
    const theirs = jpeg.decode(bytes, options);
    expect([mine?.width, mine?.height]).toEqual([theirs.width, theirs.height]);
    expect(Buffer.compare(Buffer.from(mine!.data), Buffer.from(theirs.data))).toBe(0);
    expect(Buffer.compare(decodeJpeg(bytes).rgba, Buffer.from(theirs.data))).toBe(0);
  });
  it.each(LEFT_TO_JPEG_JS)("leaves %s to jpeg-js", name => {
    expect(sequential(fixture(name), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 100 })).toBeNull();
  });
  it("decodes jpeg-js's own files as jpeg-js does", () => {
    for (const [width, height, quality] of [[1, 1, 90], [17, 9, 50], [64, 48, 100]]) {
      const bytes = encodeJpeg(photo(width, height, width), quality), options = jpegOptions(bytes);
      expect(sequential(bytes, options)).not.toBeNull();
      expect(viaNew(bytes, options)).toBe(viaJpegJs(bytes, options));
    }
  });

  it("keeps jpeg-js's memory and resolution limits", () => {
    const bytes = fixture("420-optimized"), options = jpegOptions(bytes);
    // The smallest memory limit jpeg-js accepts for this file, to within a byte.
    let low = 0, high = 1;
    while (low + 1 / (1024 * 1024) < high) { const middle = (low + high) / 2; if (viaJpegJs(bytes, { ...options, maxMemoryUsageInMB: middle }).startsWith("error")) low = middle; else high = middle; }
    for (const limit of [low, high]) expect(viaNew(bytes, { ...options, maxMemoryUsageInMB: limit })).toBe(viaJpegJs(bytes, { ...options, maxMemoryUsageInMB: limit }));
    expect(sequential(bytes, { ...options, maxMemoryUsageInMB: low })).toBeNull();
    expect(sequential(bytes, { ...options, maxMemoryUsageInMB: high })).not.toBeNull();
    for (const megapixels of [33 * 17 / 1e6, 33 * 17 / 1e6 - 1e-9]) {
      const limited = { ...options, maxResolutionInMP: megapixels }, theirs = viaJpegJs(bytes, limited);
      expect(viaNew(bytes, limited)).toBe(theirs);
      expect(sequential(bytes, limited) === null).toBe(theirs.startsWith("error"));
    }
  });

  it("fails where jpeg-js fails and decodes damaged files as jpeg-js does", () => {
    const options: JpegOptions = { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 100 };
    const next = random(7), pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
    const markers = (bytes: Buffer) => { const at: number[] = []; for (let i = 2; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] !== 0 && bytes[i + 1] !== 0xff) at.push(i); return at; };
    const bases = ["420-optimized", "420-restart-3-blocks", "grey-restart-5-blocks", "separate-scans"].map(fixture);
    bases.push(encodeJpeg(photo(24, 16, 3), 90));
    let sequentialDamaged = 0;
    for (let n = 0; n < 600; n++) {
      const base = pick(bases), kind = n % 6;
      let bytes: Buffer;
      if (kind === 0) { bytes = Buffer.from(base); bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256); }
      else if (kind === 1) bytes = base.subarray(0, Math.floor(next() * base.length));
      else if (kind === 2) { const at = Math.floor(next() * base.length); bytes = Buffer.concat([base.subarray(0, at), Buffer.from([pick([0, 0x12, 0xff, 0xd0])]), base.subarray(at)]); }
      else if (kind === 3) { const at = Math.floor(next() * base.length); bytes = Buffer.concat([base.subarray(0, at), base.subarray(at + 1 + Math.floor(next() * 4))]); }
      else if (kind === 4) { const at = pick(markers(base)); bytes = Buffer.concat([base.subarray(0, at), Buffer.from([0x12]), base.subarray(at)]); } // junk before a marker
      else { bytes = Buffer.from(base); const at = Math.floor(base.length * (0.5 + next() / 2)); bytes[Math.min(at, base.length - 3)] ^= 1 << Math.floor(next() * 8); }
      if (sequential(bytes, options)) sequentialDamaged++;
      expect(viaNew(bytes, options), `case ${n}`).toBe(viaJpegJs(bytes, options));
    }
    expect(sequentialDamaged).toBeGreaterThan(100);
  });

  it("leaves structures it does not follow to jpeg-js", () => {
    const options: JpegOptions = { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 100 };
    const bytes = fixture("422"), segment = (code: number) => { for (let i = 2; ;) { const length = bytes.readUInt16BE(i + 2); if (bytes[i + 1] === code) return bytes.subarray(i, i + 2 + length); i += 2 + length; } };
    const sof = segment(0xc0), dqt = segment(0xdb), dht = segment(0xc4);
    const duplicateId = Buffer.from(bytes); duplicateId[duplicateId.indexOf(sof) + 13] = duplicateId[duplicateId.indexOf(sof) + 10];
    // 16-bit codes that fill the first table's code space, which the scan
    // never uses: the last is all 1-bits, and jpeg-js refuses the table.
    const counts = dht.subarray(5, 21), total = counts.reduce((sum, count) => sum + count, 0);
    const space = counts.reduce((left, count, i) => left - count * 2 ** (15 - i), 2 ** 16);
    expect(space).toBeGreaterThan(0); expect(counts[15] + space).toBeLessThan(256);
    const filled = Buffer.concat([dht.subarray(0, 20), Buffer.from([counts[15] + space]), dht.subarray(21, 21 + total), Buffer.alloc(space), dht.subarray(21 + total)]);
    filled.writeUInt16BE(dht.readUInt16BE(2) + space, 2);
    const cases = {
      "a table redefined after the scan": Buffer.concat([bytes.subarray(0, -2), Buffer.from(dqt).fill(1, 5), bytes.subarray(-2)]),
      "a second frame": Buffer.concat([bytes.subarray(0, bytes.indexOf(sof)), sof, bytes.subarray(bytes.indexOf(sof))]),
      "two components with one id": duplicateId,
      "a Huffman code of all 1-bits": Buffer.concat([bytes.subarray(0, bytes.indexOf(dht)), filled, bytes.subarray(bytes.indexOf(dht) + dht.length)]),
    };
    for (const [name, damaged] of Object.entries(cases)) {
      expect(sequential(damaged, options), name).toBeNull();
      expect(viaNew(damaged, options), name).toBe(viaJpegJs(damaged, options));
    }
  });
});

describe("JPEG encoding", () => {
  it("writes the bytes jpeg-js writes", () => {
    for (const [width, height] of [[0, 0], [1, 1], [8, 8], [17, 9], [64, 48], [194, 194], [301, 77]]) {
      for (const quality of [1, 10, 49, 50, 50.5, 80, 90, 100, 0, -3, 150, NaN]) {
        const image = photo(width, height, width * 31 + height);
        expect(Buffer.compare(encodeJpeg(image, quality), jpeg.encode(withAlpha(image), quality).data), `${width}x${height} q${quality}`).toBe(0);
      }
    }
    for (const value of [0, 255]) {
      const flat = { width: 40, height: 24, rgb: new Uint8Array(40 * 24 * 3).fill(value) };
      expect(Buffer.compare(encodeJpeg(flat, 90), jpeg.encode(withAlpha(flat), 90).data)).toBe(0);
    }
  });
  it("hands jpeg-js inputs that are not whole sizes and RGB bytes", () => {
    const image = photo(20, 10, 1);
    const short = { ...image, rgb: image.rgb.subarray(0, 590) };
    expect(Buffer.compare(encodeJpeg(short, 90), jpeg.encode(withAlpha({ ...image, rgb: Uint8Array.from({ length: 600 }, (_, i) => short.rgb[i] ?? 0) }), 90).data)).toBe(0);
    expect(Buffer.compare(encodeJpeg(image, "90" as unknown as number), jpeg.encode(withAlpha(image), "90" as unknown as number).data)).toBe(0);
  });
});
