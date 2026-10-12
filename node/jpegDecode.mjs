/*
 * Sequential JPEG decoding for decodeJpeg. It returns the RGBA bytes jpeg-js
 * 0.4.4 returns from decode(data, { useTArray: true, formatAsRGBA: true })
 * with the same memory and resolution limits, and fails where it would
 * fail. It decodes baseline and extended sequential Huffman frames of one
 * or three 8-bit components. For anything else (progressive or arithmetic
 * coding, other precisions, two or four components, and damaged or unusual
 * streams it does not follow jpeg-js through) it returns null, and the
 * caller decodes with jpeg-js itself.
 *
 * Derived from jpeg-js 0.4.4, lib/decoder.js
 * (https://github.com/jpeg-js/jpeg-js), which carries this notice:
 *
 *    Copyright 2011 notmasteryet
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 *
 * A copy of the License is in LICENSES/Apache-2.0.txt. jpeg-js is
 * Copyright (c) 2014, Eugene Ware, under the BSD 3-Clause License in
 * LICENSES/jpeg-js.txt.
 *
 * Changed by the FOSS Earth contributors in 2026, keeping jpeg-js's
 * arithmetic:
 * - Huffman codes are read from a 32-bit buffer through a 9-bit lookup
 *   table and canonical code ranges, not one bit at a time down a tree.
 * - Each block is inverse-transformed as soon as it is decoded, into one
 *   byte plane per component, rather than every block's coefficients being
 *   kept until the end; a sequential scan codes each block once.
 * - YCbCr becomes RGBA in one pass, with tables of the same products.
 * - jpeg-js's memory accounting is tallied, not enforced by allocation.
 * - Everything outside the sequential path is left to jpeg-js.
 */

const ZIGZAG = Int32Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
  // A damaged block's run can take k up to 78. jpeg-js then stores to
  // dctZigZag[k] === undefined, which changes nothing; here, slot 64.
  64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
]);
const dctCos1 = 4017, dctSin1 = 799, dctCos3 = 3406, dctSin3 = 2276, dctCos6 = 1567, dctSin6 = 3784, dctSqrt2 = 5793, dctSqrt1d2 = 2896;

// jpeg-js's products for each byte value, as the same doubles.
const CR_R = new Float64Array(256), CB_G = new Float64Array(256), CR_G = new Float64Array(256), CB_B = new Float64Array(256);
for (let v = 0; v < 256; v++) { CR_R[v] = 1.402 * (v - 128); CB_G[v] = 0.3441363 * (v - 128); CR_G[v] = 0.71413636 * (v - 128); CB_B[v] = 1.772 * (v - 128); }

/** Thrown where jpeg-js would do something this decoder does not reproduce. */
class UseJpegJs extends Error {}
const LOOKAHEAD = 9;

/**
 * The pixels jpeg-js would return, or null where jpeg-js has to decode the
 * file itself (its result or error is then the answer).
 * @param {Uint8Array} data
 * @param {{ maxMemoryUsageInMB: number, maxResolutionInMP: number }} options as passed to jpeg-js
 * @returns {{ width: number, height: number, data: Uint8Array } | null}
 */
export function decodeSequentialJpeg(data, { maxMemoryUsageInMB, maxResolutionInMP }) {
  try {
    return decode(data, maxMemoryUsageInMB * 1024 * 1024, maxResolutionInMP * 1000 * 1000);
  } catch (error) {
    if (error instanceof UseJpegJs) return null;
    throw error;
  }
}

/** Canonical Huffman decoding tables from DHT counts (lengths 1..16) and values. */
function huffmanTable(counts, values) {
  const lookup = new Int32Array(1 << LOOKAHEAD); // (length << 8) | value; 0: a longer code
  const maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    valptr[length] = k; mincode[length] = code;
    for (let i = 0; i < n; i++, k++, code++) {
      // jpeg-js's tree builder throws once it places a code of all 1-bits,
      // and codes that overrun their length pass through one first.
      if (code === (1 << length) - 1) throw new UseJpegJs("Huffman code of all 1-bits");
      if (length <= LOOKAHEAD) {
        const shift = LOOKAHEAD - length, start = code << shift;
        for (let fill = 0; fill < 1 << shift; fill++) lookup[start + fill] = (length << 8) | values[k];
      }
    }
    maxcode[length] = n ? code - 1 : -1;
    code <<= 1;
  }
  return { lookup, maxcode, valptr, mincode, values };
}

function decode(data, maxMemoryBytes, maxPixels) {
  const length = data.length;
  let offset = 0;
  const need = bytes => { if (offset + bytes > length) throw new UseJpegJs("truncated"); };
  const u16 = () => { const value = (data[offset] << 8) | data[offset + 1]; offset += 2; return value; };
  // jpeg-js's running total of tracked allocations, which throws past its limit.
  let requested = 0;
  const request = bytes => { requested += bytes; if (requested > maxMemoryBytes) throw new UseJpegJs("over jpeg-js's memory limit"); };

  need(2);
  if (u16() !== 0xffd8) throw new UseJpegJs("SOI not found");
  const quant = [], dcTables = [], acTables = [];
  let frame = null, resetInterval = 0, scanned = false;
  need(2);
  let marker = u16();
  while (marker !== 0xffd9) {
    if ((marker >= 0xffe0 && marker <= 0xffef) || marker === 0xfffe) {
      need(2);
      const size = u16();
      if (size < 2) throw new UseJpegJs("segment length");
      need(size - 2);
      offset += size - 2;
    } else if (marker === 0xffdb) {
      // jpeg-js gives every component the table its index names at the end
      // of the file; this decoder uses it at the scan.
      if (scanned) throw new UseJpegJs("DQT after a scan");
      need(2);
      const end = u16() + offset - 2;
      while (offset < end) {
        need(1);
        const spec = data[offset++], table = new Int32Array(64);
        request(64 * 4);
        if (spec >> 4 === 0) { need(64); for (let j = 0; j < 64; j++) table[ZIGZAG[j]] = data[offset++]; }
        else if (spec >> 4 === 1) { need(128); for (let j = 0; j < 64; j++) table[ZIGZAG[j]] = u16(); }
        else throw new UseJpegJs("DQT table spec");
        quant[spec & 15] = table;
      }
    } else if (marker === 0xffc0 || marker === 0xffc1) {
      if (frame) throw new UseJpegJs("two frames");
      need(8);
      offset += 2;
      const precision = data[offset++];
      const height = u16(), width = u16(), count = data[offset++];
      if (precision !== 8) throw new UseJpegJs(`${precision}-bit samples`);
      if (height * width > maxPixels) throw new UseJpegJs("over jpeg-js's resolution limit");
      if (width === 0 || height === 0) throw new UseJpegJs("no pixels");
      if (count !== 1 && count !== 3) throw new UseJpegJs(`${count} components`);
      need(3 * count);
      const components = [];
      for (let i = 0; i < count; i++) {
        const id = data[offset], h = data[offset + 1] >> 4, v = data[offset + 1] & 15;
        if (h <= 0 || v <= 0) throw new UseJpegJs("sampling factor");
        if (components.some(entry => entry.id === id)) throw new UseJpegJs("two components with one id");
        components.push({ id, h, v, q: data[offset + 2], scanned: false });
        offset += 3;
      }
      frame = prepare(width, height, components, request);
    } else if (marker >= 0xffc2 && marker <= 0xffcf && marker !== 0xffc4) {
      throw new UseJpegJs(marker === 0xffc2 ? "progressive" : `marker ${marker.toString(16)}`);
    } else if (marker === 0xffc4) {
      need(2);
      const size = u16();
      for (let i = 2; i < size;) {
        need(17);
        const spec = data[offset++], counts = data.subarray(offset, offset + 16);
        let total = 0;
        for (let j = 0; j < 16; j++) total += counts[j];
        request(16 + total);
        need(16 + total);
        const table = huffmanTable(counts, data.subarray(offset + 16, offset + 16 + total));
        offset += 16 + total;
        i += 17 + total;
        (spec >> 4 === 0 ? dcTables : acTables)[spec & 15] = table;
      }
    } else if (marker === 0xffdd) {
      need(4);
      offset += 2; resetInterval = u16();
    } else if (marker === 0xffdc) {
      need(4);
      offset += 4;
    } else if (marker === 0xffda) {
      if (!frame) throw new UseJpegJs("scan before frame");
      need(3);
      offset += 2;
      const count = data[offset++], scan = [];
      need(2 * count + 3);
      for (let i = 0; i < count; i++) {
        const component = frame.components.find(entry => entry.id === data[offset]);
        if (!component || component.scanned) throw new UseJpegJs("a component missing or in two scans");
        const spec = data[offset + 1];
        component.dc = dcTables[spec >> 4]; component.ac = acTables[spec & 15]; component.qt = quant[component.q];
        if (!component.dc || !component.ac || !component.qt) throw new UseJpegJs("a table missing");
        component.scanned = true;
        scan.push(component);
        offset += 2;
      }
      offset += 3; // spectral selection and successive approximation, which a sequential scan ignores
      scanned = true;
      offset = decodeScan(data, offset, frame, scan, resetInterval);
    } else if (marker === 0xffff) {
      if (data[offset] !== 0xff) offset--;
    } else if (marker !== 0xff00) { // jpeg-js passes over FF00 too
      throw new UseJpegJs(`marker ${marker.toString(16)}`);
    }
    need(2);
    marker = u16();
  }
  if (!frame) throw new UseJpegJs("no frame");
  for (const component of frame.components) if (!component.scanned) throw new UseJpegJs("a component never scanned");
  for (const c of frame.components) request(c.stride * c.blocksPerColumn * 8);
  request(frame.width * frame.height * 4);
  request(frame.width * frame.height * frame.components.length);
  return toRgba(frame);
}

/** jpeg-js prepareComponents, with one byte plane per component in place of its blocks. */
function prepare(width, height, components, request) {
  let maxH = 1, maxV = 1;
  for (const c of components) { if (c.h > maxH) maxH = c.h; if (c.v > maxV) maxV = c.v; }
  const mcusPerLine = Math.ceil(width / 8 / maxH), mcusPerColumn = Math.ceil(height / 8 / maxV);
  for (const c of components) {
    c.blocksPerLine = Math.ceil(Math.ceil(width / 8) * c.h / maxH);
    c.blocksPerColumn = Math.ceil(Math.ceil(height / 8) * c.v / maxV);
    c.allocatedRows = mcusPerColumn * c.v; // jpeg-js's block grid, padded to whole MCUs
    request(c.allocatedRows * mcusPerLine * c.h * 256);
  }
  for (const c of components) {
    c.stride = c.blocksPerLine << 3;
    c.plane = new Uint8Array(c.stride * (c.blocksPerColumn << 3));
    c.scaleX = c.h / maxH; c.scaleY = c.v / maxV;
    c.pred = 0;
  }
  return { width, height, components, mcusPerLine, mcusPerColumn };
}

/** One sequential scan, following jpeg-js decodeScan; returns the offset where parsing resumes. */
function decodeScan(data, start, frame, scan, resetInterval) {
  const length = data.length;
  let pos = start, acc = 0, bits = 0, atMarker = false, fakeBits = 0;
  // Where each of the last bytes loaded ends, so the offset jpeg-js's
  // byte-at-a-time reader would stand at can be found when an interval ends.
  const ends = new Int32Array(8);
  let loaded = 0, intervalStart = start;
  // Loads bytes into a 32-bit buffer, unstuffing FF 00. At a marker or the
  // end of the data it feeds zero bits and counts them: a read into them is
  // where jpeg-js throws "unexpected marker" or reads past the end.
  const fill = () => {
    while (bits <= 24) {
      let byte = 0;
      if (!atMarker) {
        if (pos >= length) atMarker = true;
        else {
          byte = data[pos];
          if (byte === 0xff) {
            if (data[pos + 1] === 0) pos += 2;
            else { atMarker = true; byte = 0; }
          } else pos++;
        }
      }
      if (atMarker) fakeBits += 8;
      ends[loaded++ & 7] = pos;
      acc = (acc << 8) | byte;
      bits += 8;
    }
  };
  const decodeHuffman = table => {
    if (bits < 16) fill();
    const entry = table.lookup[(acc >>> (bits - LOOKAHEAD)) & ((1 << LOOKAHEAD) - 1)];
    if (entry !== 0) { bits -= entry >> 8; return entry & 255; }
    for (let l = LOOKAHEAD + 1; l <= 16; l++) {
      const code = (acc >>> (bits - l)) & ((1 << l) - 1);
      if (code <= table.maxcode[l]) { bits -= l; return table.values[table.valptr[l] + code - table.mincode[l]]; }
    }
    throw new UseJpegJs("invalid Huffman sequence");
  };
  const receiveAndExtend = s => {
    if (s > 16) throw new UseJpegJs("magnitude category over 16");
    if (bits < s) fill();
    bits -= s;
    const n = (acc >>> bits) & ((1 << s) - 1);
    return n >= 1 << (s - 1) ? n : n + (-1 << s) + 1;
  };
  const zz = new Int32Array(65), p = new Int32Array(64);

  // jpeg-js decodeBaseline, then quantizeAndInverse for a block it shows.
  const block = (c, blockRow, blockCol) => {
    zz.fill(0);
    const t = decodeHuffman(c.dc);
    c.pred += t === 0 ? 0 : receiveAndExtend(t);
    zz[0] = c.pred;
    const ac = c.ac;
    for (let k = 1; k < 64;) {
      const rs = decodeHuffman(ac), s = rs & 15, r = rs >> 4;
      if (s === 0) { if (r < 15) break; k += 16; continue; }
      k += r;
      zz[ZIGZAG[k]] = receiveAndExtend(s);
      k++;
    }
    // Blocks that only pad the last MCUs are decoded but never shown.
    if (blockRow < c.blocksPerColumn && blockCol < c.blocksPerLine) idct(zz, c.qt, p, c.plane, (blockRow << 3) * c.stride + (blockCol << 3), c.stride);
  };

  const single = scan.length === 1;
  const mcuExpected = single ? scan[0].blocksPerLine * scan[0].blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
  const interval = resetInterval || mcuExpected;
  let mcu = 0;
  while (mcu < mcuExpected) {
    for (const c of scan) c.pred = 0;
    if (single) {
      const c = scan[0];
      for (let n = 0; n < interval; n++, mcu++) {
        const blockRow = (mcu / c.blocksPerLine) | 0, blockCol = mcu % c.blocksPerLine;
        if (blockRow >= c.allocatedRows) continue; // jpeg-js skips a block it never allocated
        block(c, blockRow, blockCol);
      }
    } else {
      const mcusPerLine = frame.mcusPerLine;
      for (let n = 0; n < interval; n++) {
        const mcuRow = (mcu / mcusPerLine) | 0, mcuCol = mcu % mcusPerLine;
        for (const c of scan) {
          for (let j = 0; j < c.v; j++) for (let k = 0; k < c.h; k++) block(c, mcuRow * c.v + j, mcuCol * c.h + k);
        }
        mcu++;
        if (mcu === mcuExpected) break;
      }
    }
    if (bits < fakeBits) throw new UseJpegJs("entropy-coded data ran into a marker");
    // jpeg-js stands after the last byte it took a bit from.
    const touched = loaded - (bits >> 3);
    let at = touched > 0 ? ends[(touched - 1) & 7] : intervalStart;
    if (mcu === mcuExpected) {
      do { if (data[at] === 0xff && data[at + 1] !== 0x00) break; at += 1; } while (at < length - 2);
    }
    const found = (data[at] << 8) | data[at + 1];
    if (found < 0xff00) throw new UseJpegJs("marker was not found");
    if (found >= 0xffd0 && found <= 0xffd7) {
      pos = intervalStart = at + 2;
      acc = 0; bits = 0; atMarker = false; fakeBits = 0; loaded = 0;
    } else {
      pos = at;
      break;
    }
  }
  if (mcu < mcuExpected) throw new UseJpegJs("scan ended before its last MCU");
  return pos;
}

/** jpeg-js quantizeAndInverse, the same arithmetic, writing the 8x8 block into the plane. */
function idct(zz, qt, p, plane, base, stride) {
  let v0, v1, v2, v3, v4, v5, v6, v7, t;
  for (let i = 0; i < 64; i++) p[i] = zz[i] * qt[i];
  for (let i = 0; i < 8; ++i) {
    const row = 8 * i;
    if (p[1 + row] == 0 && p[2 + row] == 0 && p[3 + row] == 0 && p[4 + row] == 0 && p[5 + row] == 0 && p[6 + row] == 0 && p[7 + row] == 0) {
      t = (dctSqrt2 * p[0 + row] + 512) >> 10;
      p[0 + row] = t; p[1 + row] = t; p[2 + row] = t; p[3 + row] = t; p[4 + row] = t; p[5 + row] = t; p[6 + row] = t; p[7 + row] = t;
      continue;
    }
    v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
    v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
    v2 = p[2 + row];
    v3 = p[6 + row];
    v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
    v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
    v5 = p[3 + row] << 4;
    v6 = p[5 + row] << 4;
    t = (v0 - v1 + 1) >> 1; v0 = (v0 + v1 + 1) >> 1; v1 = t;
    t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8; v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8; v3 = t;
    t = (v4 - v6 + 1) >> 1; v4 = (v4 + v6 + 1) >> 1; v6 = t;
    t = (v7 + v5 + 1) >> 1; v5 = (v7 - v5 + 1) >> 1; v7 = t;
    t = (v0 - v3 + 1) >> 1; v0 = (v0 + v3 + 1) >> 1; v3 = t;
    t = (v1 - v2 + 1) >> 1; v1 = (v1 + v2 + 1) >> 1; v2 = t;
    t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12; v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12; v7 = t;
    t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12; v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12; v6 = t;
    p[0 + row] = v0 + v7; p[7 + row] = v0 - v7; p[1 + row] = v1 + v6; p[6 + row] = v1 - v6;
    p[2 + row] = v2 + v5; p[5 + row] = v2 - v5; p[3 + row] = v3 + v4; p[4 + row] = v3 - v4;
  }
  for (let i = 0; i < 8; ++i) {
    const col = i;
    if (p[1 * 8 + col] == 0 && p[2 * 8 + col] == 0 && p[3 * 8 + col] == 0 && p[4 * 8 + col] == 0 && p[5 * 8 + col] == 0 && p[6 * 8 + col] == 0 && p[7 * 8 + col] == 0) {
      t = (dctSqrt2 * p[i] + 8192) >> 14;
      p[0 * 8 + col] = t; p[1 * 8 + col] = t; p[2 * 8 + col] = t; p[3 * 8 + col] = t; p[4 * 8 + col] = t; p[5 * 8 + col] = t; p[6 * 8 + col] = t; p[7 * 8 + col] = t;
      continue;
    }
    v0 = (dctSqrt2 * p[0 * 8 + col] + 2048) >> 12;
    v1 = (dctSqrt2 * p[4 * 8 + col] + 2048) >> 12;
    v2 = p[2 * 8 + col];
    v3 = p[6 * 8 + col];
    v4 = (dctSqrt1d2 * (p[1 * 8 + col] - p[7 * 8 + col]) + 2048) >> 12;
    v7 = (dctSqrt1d2 * (p[1 * 8 + col] + p[7 * 8 + col]) + 2048) >> 12;
    v5 = p[3 * 8 + col];
    v6 = p[5 * 8 + col];
    t = (v0 - v1 + 1) >> 1; v0 = (v0 + v1 + 1) >> 1; v1 = t;
    t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12; v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12; v3 = t;
    t = (v4 - v6 + 1) >> 1; v4 = (v4 + v6 + 1) >> 1; v6 = t;
    t = (v7 + v5 + 1) >> 1; v5 = (v7 - v5 + 1) >> 1; v7 = t;
    t = (v0 - v3 + 1) >> 1; v0 = (v0 + v3 + 1) >> 1; v3 = t;
    t = (v1 - v2 + 1) >> 1; v1 = (v1 + v2 + 1) >> 1; v2 = t;
    t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12; v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12; v7 = t;
    t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12; v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12; v6 = t;
    p[0 * 8 + col] = v0 + v7; p[7 * 8 + col] = v0 - v7; p[1 * 8 + col] = v1 + v6; p[6 * 8 + col] = v1 - v6;
    p[2 * 8 + col] = v2 + v5; p[5 * 8 + col] = v2 - v5; p[3 * 8 + col] = v3 + v4; p[4 * 8 + col] = v3 - v4;
  }
  for (let y = 0, i = 0; y < 8; y++) {
    const o = base + y * stride;
    for (let x = 0; x < 8; x++, i++) {
      const sample = 128 + ((p[i] + 8) >> 4);
      plane[o + x] = sample < 0 ? 0 : sample > 0xff ? 0xff : sample;
    }
  }
}

/** jpeg-js getData and copyToImageData (RGBA) in one pass. */
function toRgba({ width, height, components }) {
  const rgba = new Uint8Array(width * height * 4);
  const columns = components.map(c => { const index = new Int32Array(width); for (let x = 0; x < width; x++) index[x] = 0 | (x * c.scaleX); return index; });
  if (components.length === 1) {
    const [c] = components, cols = columns[0], plane = c.plane;
    for (let y = 0, j = 0; y < height; y++) {
      const row = (0 | (y * c.scaleY)) * c.stride;
      for (let x = 0; x < width; x++, j += 4) { const Y = plane[row + cols[x]]; rgba[j] = Y; rgba[j + 1] = Y; rgba[j + 2] = Y; rgba[j + 3] = 255; }
    }
    return { width, height, data: rgba };
  }
  const [c1, c2, c3] = components, [x1, x2, x3] = columns, p1 = c1.plane, p2 = c2.plane, p3 = c3.plane;
  for (let y = 0, j = 0; y < height; y++) {
    const r1 = (0 | (y * c1.scaleY)) * c1.stride, r2 = (0 | (y * c2.scaleY)) * c2.stride, r3 = (0 | (y * c3.scaleY)) * c3.stride;
    for (let x = 0; x < width; x++, j += 4) {
      const Y = p1[r1 + x1[x]], Cb = p2[r2 + x2[x]], Cr = p3[r3 + x3[x]];
      const R = Y + CR_R[Cr], G = Y - CB_G[Cb] - CR_G[Cr], B = Y + CB_B[Cb];
      // jpeg-js clamps to [0, 255] and stores the double in a Uint8Array, which truncates it.
      rgba[j] = R < 0 ? 0 : R > 255 ? 255 : R;
      rgba[j + 1] = G < 0 ? 0 : G > 255 ? 255 : G;
      rgba[j + 2] = B < 0 ? 0 : B > 255 ? 255 : B;
      rgba[j + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}
