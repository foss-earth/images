import { describe, it, expect } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import { decodePng, encodePng } from "../node/codecs.mjs";

// encodePng scores all five row filters in one pass and decodePng runs each filter in its own loop; both must give
// what trying one filter at a time, one byte at a time, gives.
const paeth = (left: number, above: number, upLeft: number) => {
  const p = left + above - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft;
};
const predictor = (filter: number, left: number, above: number, upLeft: number) =>
  [0, left, above, (left + above) >> 1, paeth(left, above, upLeft)][filter];

/** Rows with the filter given for each, or for every row the one whose bytes sum to the least as signed bytes, the earlier on ties. */
function filterRows(pixels: Uint8Array, width: number, height: number, channels: number, filters?: number[]): Buffer {
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rows = [0, 1, 2, 3, 4].map(filter => Uint8Array.from({ length: stride }, (_, x) => {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0, above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      return (pixels[y * stride + x] - predictor(filter, left, above, upLeft)) & 0xff;
    }));
    const scores = rows.map(row => row.reduce((sum, value) => sum + (value < 128 ? value : 256 - value), 0));
    const filter = filters?.[y] ?? scores.indexOf(Math.min(...scores));
    raw[y * (stride + 1)] = filter;
    raw.set(rows[filter] ?? pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
};
/** Each chunk's type and body, after checking its CRC. */
function chunks(png: Buffer) {
  const out: { type: string; body: Buffer }[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), end = offset + 12 + length;
    expect(png.readUInt32BE(end - 4)).toBe(crc32(png.subarray(offset + 4, end - 4)));
    out.push({ type: png.toString("ascii", offset + 4, offset + 8), body: png.subarray(offset + 8, end - 4) });
    offset = end;
  }
  return out;
}
function pngOf(width: number, height: number, colourType: number, raw: Buffer): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length); out.write(type, 4); body.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, body.length + 8)), body.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr.set([8, colourType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => Math.imul(i + seed, 0x9e3779b1) >>> 24);

describe("PNG row filters", () => {
  it("keeps, for each row, the filter whose bytes are smallest, the earlier on ties", () => {
    const contents: Record<string, (width: number, height: number) => Uint8Array> = {
      noise: (width, height) => bytes(width * height * 3, width + height),
      small: (width, height) => bytes(width * height * 3, 7).map(value => value & 3),
      flat: (width, height) => new Uint8Array(width * height * 3).fill(200),
      "repeated rows": (width, height) => Uint8Array.from({ length: width * height * 3 }, (_, i) => bytes(width * 3, 3)[i % (width * 3)]),
      "repeated pixels": (width, height) => Uint8Array.from({ length: width * height * 3 }, (_, i) => bytes(height * 3, 5)[Math.floor(i / (width * 3)) * 3 + i % 3]),
      diagonal: (width, height) => Uint8Array.from({ length: width * height * 3 }, (_, i) => (Math.floor(i / 3) % width + Math.floor(i / (width * 3))) * 17 & 255),
      "a row of each": (width, height) => Uint8Array.from({ length: width * height * 3 }, (_, i) => {
        const y = Math.floor(i / (width * 3));
        return [bytes(1, i)[0], 9, (i % (width * 3)) * 5 & 255, y * 40 & 255, 128][y % 5];
      }),
    };
    for (const [width, height] of [[1, 1], [1, 6], [6, 1], [2, 2], [13, 9], [64, 5]]) for (const [name, content] of Object.entries(contents)) {
      const rgb = content(width, height), png = encodePng({ width, height, rgb });
      const idat = chunks(png).filter(chunk => chunk.type === "IDAT").map(chunk => chunk.body);
      expect(inflateSync(Buffer.concat(idat)).equals(filterRows(rgb, width, height, 3)), `${name} ${width}x${height}`).toBe(true);
      // The same pixels at a byte offset, in a Buffer, or followed by more bytes.
      const offset = new Uint8Array(rgb.length + 9); offset.set(rgb, 5);
      for (const copy of [offset.subarray(5, 5 + rgb.length), Buffer.from(rgb), offset.subarray(5)]) expect(encodePng({ width, height, rgb: copy }).equals(png)).toBe(true);
      expect(encodePng({ width, height, rgb: Uint8ClampedArray.from(rgb) as unknown as Uint8Array }).equals(png)).toBe(true);
    }
  });
  it("undoes every filter, in every colour type, from any row", () => {
    for (const [colourType, channels] of [[0, 1], [2, 3], [4, 2], [6, 4]]) for (const [width, height] of [[1, 1], [1, 7], [7, 1], [5, 6], [33, 5]]) {
      const pixels = bytes(width * height * channels, colourType * 31 + width);
      const expected = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
        const p = Math.floor(i / 4) * channels, c = i % 4;
        if (c === 3) return channels === 2 || channels === 4 ? pixels[p + channels - 1] : 255;
        return channels <= 2 ? pixels[p] : pixels[p + c];
      });
      for (const filters of [0, 1, 2, 3, 4].map(filter => new Array<number>(height).fill(filter)).concat([Array.from({ length: height }, (_, y) => (y * 3 + colourType) % 5)])) {
        const decoded = decodePng(pngOf(width, height, colourType, filterRows(pixels, width, height, channels, filters)));
        expect(decoded.rgba.equals(expected), `type ${colourType} ${width}x${height} filters ${filters.join("")}`).toBe(true);
      }
    }
  });
  it("checks for cancellation once a row, before that row's filter", () => {
    const width = 4, height = 6, pixels = bytes(width * height * 3, 1);
    const decodeCounting = (png: Buffer, abortAt = Infinity) => {
      let reads = 0, error: unknown = null;
      const signal = { get aborted() { return ++reads >= abortAt; }, reason: new Error("stopped") } as unknown as AbortSignal;
      try { decodePng(png, { signal }); } catch (caught) { error = caught; }
      return { reads, error };
    };
    const good = decodeCounting(pngOf(width, height, 2, filterRows(pixels, width, height, 3, [0, 1, 2, 3, 4, 0])));
    expect(good.error).toBeNull();
    for (const row of [0, 3, height - 1]) {
      const filters = [0, 1, 2, 3, 4, 0]; filters[row] = 5;
      const png = pngOf(width, height, 2, filterRows(pixels, width, height, 3, filters)), bad = decodeCounting(png);
      expect((bad.error as Error).message).toBe("Invalid PNG row filter");
      // The rows after the bad one and the check after the last row are not reached.
      expect(good.reads - bad.reads).toBe(height - row);
      expect((decodeCounting(png, bad.reads).error as Error).message).toBe("stopped");
    }
  });
});
