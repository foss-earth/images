/*
 * Baseline JPEG encoding for encodeJpeg. It writes the bytes jpeg-js 0.4.4's
 * encode() writes for the same pixels and quality: a JFIF header, 4:4:4
 * YCbCr, the standard quantization and Huffman tables, no comments or EXIF.
 *
 * Derived from jpeg-js 0.4.4, lib/encoder.js
 * (https://github.com/jpeg-js/jpeg-js), "JPEG encoder ported to JavaScript
 * and optimized by Andreas Ritter, www.bytestrom.eu, 11/2009" from Adobe's
 * ActionScript encoder, which carries this notice:
 *
 *  Copyright (c) 2008, Adobe Systems Incorporated
 *  All rights reserved.
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions are
 *  met:
 *
 *  * Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 *  * Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 *  * Neither the name of Adobe Systems Incorporated nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
 *  IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 *  THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 *  PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 *  CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 *  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 *  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 *  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 *  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 *  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * jpeg-js is Copyright (c) 2014, Eugene Ware, under the BSD 3-Clause
 * License in LICENSES/jpeg-js.txt.
 *
 * Changed by the FOSS Earth contributors in 2026, keeping jpeg-js's
 * arithmetic:
 * - The Huffman, category and colour tables are built once, and the
 *   quantization tables once per quality, rather than on every call.
 * - Blocks, coefficients and tables are typed arrays.
 * - Bits go through an accumulator into a growing byte array, not one call
 *   per bit into an Array.
 * - It reads RGB, so the caller need not expand it to RGBA first.
 * - It can write 2^27 bytes or more. jpeg-js cannot: its Array of output
 *   bytes stops growing there, with "RangeError: Invalid array length".
 */

const ZIGZAG = Int32Array.from([
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
]);
const DC_LUM_CODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_CODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const DC_CHR_CODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHR_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_CHR_CODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHR_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const YQT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const UVQT = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const AASF = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];

function huffmanTable(nrcodes, values) {
  const code = new Int32Array(256), length = new Int32Array(256);
  let codevalue = 0, at = 0;
  for (let k = 1; k <= 16; k++) {
    for (let j = 1; j <= nrcodes[k]; j++) { code[values[at]] = codevalue; length[values[at]] = k; at++; codevalue++; }
    codevalue *= 2;
  }
  return { code, length };
}
const YDC = huffmanTable(DC_LUM_CODES, DC_LUM_VALUES), UVDC = huffmanTable(DC_CHR_CODES, DC_CHR_VALUES);
const YAC = huffmanTable(AC_LUM_CODES, AC_LUM_VALUES), UVAC = huffmanTable(AC_CHR_CODES, AC_CHR_VALUES);

// category[32767 + v] and the value bits bitcode[32767 + v] for v != 0.
const CATEGORY = new Int32Array(65535), BITCODE = new Int32Array(65535);
for (let cat = 1, lower = 1, upper = 2; cat <= 15; cat++, lower <<= 1, upper <<= 1) {
  for (let nr = lower; nr < upper; nr++) { CATEGORY[32767 + nr] = cat; BITCODE[32767 + nr] = nr; }
  for (let nr = -(upper - 1); nr <= -lower; nr++) { CATEGORY[32767 + nr] = cat; BITCODE[32767 + nr] = upper - 1 + nr; }
}

const YUV = new Int32Array(2048);
for (let i = 0; i < 256; i++) {
  YUV[i] = 19595 * i; YUV[i + 256] = 38470 * i; YUV[i + 512] = 7471 * i + 0x8000;
  YUV[i + 768] = -11059 * i; YUV[i + 1024] = -21709 * i; YUV[i + 1280] = 32768 * i + 0x807fff;
  YUV[i + 1536] = -27439 * i; YUV[i + 1792] = -5329 * i;
}

const quantCache = new Map();
function quantTables(quality) {
  if (quality <= 0) quality = 1;
  if (quality > 100) quality = 100;
  let tables = quantCache.get(quality);
  if (tables) return tables;
  const sf = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
  const yTable = new Int32Array(64), uvTable = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    yTable[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((YQT[i] * sf + 50) / 100)));
    uvTable[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((UVQT[i] * sf + 50) / 100)));
  }
  const fdY = new Float64Array(64), fdUV = new Float64Array(64);
  for (let row = 0, k = 0; row < 8; row++) for (let col = 0; col < 8; col++, k++) {
    fdY[k] = 1.0 / (yTable[ZIGZAG[k]] * AASF[row] * AASF[col] * 8.0);
    fdUV[k] = 1.0 / (uvTable[ZIGZAG[k]] * AASF[row] * AASF[col] * 8.0);
  }
  tables = { yTable, uvTable, fdY, fdUV };
  if (quantCache.size >= 128) quantCache.clear();
  quantCache.set(quality, tables);
  return tables;
}

/** In-place AAN forward DCT, then quantize into `du` in zigzag order (jpeg-js fDCTQuant + reorder). */
function fdctQuant(data, fdtbl, du) {
  for (let off = 0; off < 64; off += 8) {
    const d0 = data[off], d1 = data[off + 1], d2 = data[off + 2], d3 = data[off + 3], d4 = data[off + 4], d5 = data[off + 5], d6 = data[off + 6], d7 = data[off + 7];
    const tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6, tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;
    let tmp10 = tmp0 + tmp3; const tmp13 = tmp0 - tmp3; let tmp11 = tmp1 + tmp2; let tmp12 = tmp1 - tmp2;
    data[off] = tmp10 + tmp11; data[off + 4] = tmp10 - tmp11;
    const z1 = (tmp12 + tmp13) * 0.707106781;
    data[off + 2] = tmp13 + z1; data[off + 6] = tmp13 - z1;
    tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
    const z5 = (tmp10 - tmp12) * 0.382683433, z2 = 0.541196100 * tmp10 + z5, z4 = 1.306562965 * tmp12 + z5, z3 = tmp11 * 0.707106781;
    const z11 = tmp7 + z3, z13 = tmp7 - z3;
    data[off + 5] = z13 + z2; data[off + 3] = z13 - z2; data[off + 1] = z11 + z4; data[off + 7] = z11 - z4;
  }
  for (let off = 0; off < 8; off++) {
    const d0 = data[off], d1 = data[off + 8], d2 = data[off + 16], d3 = data[off + 24], d4 = data[off + 32], d5 = data[off + 40], d6 = data[off + 48], d7 = data[off + 56];
    const tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6, tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;
    let tmp10 = tmp0 + tmp3; const tmp13 = tmp0 - tmp3; let tmp11 = tmp1 + tmp2; let tmp12 = tmp1 - tmp2;
    data[off] = tmp10 + tmp11; data[off + 32] = tmp10 - tmp11;
    const z1 = (tmp12 + tmp13) * 0.707106781;
    data[off + 16] = tmp13 + z1; data[off + 48] = tmp13 - z1;
    tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
    const z5 = (tmp10 - tmp12) * 0.382683433, z2 = 0.541196100 * tmp10 + z5, z4 = 1.306562965 * tmp12 + z5, z3 = tmp11 * 0.707106781;
    const z11 = tmp7 + z3, z13 = tmp7 - z3;
    data[off + 40] = z13 + z2; data[off + 24] = z13 - z2; data[off + 8] = z11 + z4; data[off + 56] = z11 - z4;
  }
  for (let i = 0; i < 64; i++) {
    const q = data[i] * fdtbl[i];
    du[ZIGZAG[i]] = q > 0.0 ? (q + 0.5) | 0 : (q - 0.5) | 0;
  }
}

/**
 * The bytes jpeg-js 0.4.4's encode({ width, height, data }, quality) writes,
 * where data is `rgb` with an opaque alpha added. The caller passes whole
 * dimensions, a number for the quality, and at least width * height * 3
 * bytes of RGB.
 * @param {{ width: number, height: number, rgb: Uint8Array }} image
 * @param {number} quality
 * @returns {Buffer}
 */
export function encodeBaselineJpeg({ width, height, rgb }, quality) {
  if (!quality) quality = 50;
  const { yTable, uvTable, fdY, fdUV } = quantTables(quality);
  let out = new Uint8Array(Math.max(4096, Math.ceil(width * height * 1.5) + 1024));
  let pos = 0;
  const byte = value => { out[pos++] = value; };
  const word = value => { out[pos++] = (value >> 8) & 0xff; out[pos++] = value & 0xff; };
  // Headers, as jpeg-js writes them.
  word(0xffd8);
  word(0xffe0); word(16); for (const b of [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]) byte(b); word(1); word(1); byte(0); byte(0);
  word(0xffdb); word(132); byte(0); for (let i = 0; i < 64; i++) byte(yTable[i]); byte(1); for (let i = 0; i < 64; i++) byte(uvTable[i]);
  word(0xffc0); word(17); byte(8); word(height); word(width); byte(3);
  for (const b of [1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]) byte(b);
  word(0xffc4); word(0x01a2);
  byte(0); for (let i = 0; i < 16; i++) byte(DC_LUM_CODES[i + 1]); for (let j = 0; j <= 11; j++) byte(DC_LUM_VALUES[j]);
  byte(0x10); for (let i = 0; i < 16; i++) byte(AC_LUM_CODES[i + 1]); for (let j = 0; j <= 161; j++) byte(AC_LUM_VALUES[j]);
  byte(1); for (let i = 0; i < 16; i++) byte(DC_CHR_CODES[i + 1]); for (let j = 0; j <= 11; j++) byte(DC_CHR_VALUES[j]);
  byte(0x11); for (let i = 0; i < 16; i++) byte(AC_CHR_CODES[i + 1]); for (let j = 0; j <= 161; j++) byte(AC_CHR_VALUES[j]);
  word(0xffda); word(12); for (const b of [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]) byte(b);

  // Entropy-coded data: an MSB-first bit accumulator with 0xFF stuffing.
  let acc = 0, bits = 0;
  const put = (code, length) => {
    acc = (acc << length) | code; bits += length;
    while (bits >= 8) {
      bits -= 8;
      const b = (acc >>> bits) & 0xff;
      out[pos++] = b;
      if (b === 0xff) out[pos++] = 0;
    }
    acc &= (1 << bits) - 1;
  };
  const du = new Int32Array(64);
  const block = (data, fdtbl, dc, HTDC, HTAC) => {
    fdctQuant(data, fdtbl, du);
    const diff = du[0] - dc;
    if (diff === 0) put(HTDC.code[0], HTDC.length[0]);
    else { const p = 32767 + diff, c = CATEGORY[p]; put(HTDC.code[c], HTDC.length[c]); put(BITCODE[p], c); }
    let end = 63;
    while (end > 0 && du[end] === 0) end--;
    if (end === 0) { put(HTAC.code[0], HTAC.length[0]); return du[0]; }
    for (let i = 1; i <= end;) {
      const startpos = i;
      while (du[i] === 0 && i <= end) i++;
      let zeroes = i - startpos;
      if (zeroes >= 16) {
        for (let m = zeroes >> 4; m > 0; m--) put(HTAC.code[0xf0], HTAC.length[0xf0]);
        zeroes &= 0xf;
      }
      const p = 32767 + du[i], c = CATEGORY[p], symbol = (zeroes << 4) + c;
      put(HTAC.code[symbol], HTAC.length[symbol]); put(BITCODE[p], c);
      i++;
    }
    if (end !== 63) put(HTAC.code[0], HTAC.length[0]);
    return du[0];
  };

  const Y = new Float64Array(64), U = new Float64Array(64), V = new Float64Array(64);
  let dcY = 0, dcU = 0, dcV = 0;
  const lastX = width - 1, lastY = height - 1;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      if (out.length - pos < 8192) { const grown = new Uint8Array(out.length * 2); grown.set(out.subarray(0, pos)); out = grown; }
      for (let row = 0, k = 0; row < 8; row++) {
        const sy = y + row > lastY ? lastY : y + row, base = sy * width;
        for (let col = 0; col < 8; col++, k++) {
          const sx = x + col > lastX ? lastX : x + col, p = (base + sx) * 3;
          const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
          Y[k] = ((YUV[r] + YUV[g + 256] + YUV[b + 512]) >> 16) - 128;
          U[k] = ((YUV[r + 768] + YUV[g + 1024] + YUV[b + 1280]) >> 16) - 128;
          V[k] = ((YUV[r + 1280] + YUV[g + 1536] + YUV[b + 1792]) >> 16) - 128;
        }
      }
      dcY = block(Y, fdY, dcY, YDC, YAC);
      dcU = block(U, fdUV, dcU, UVDC, UVAC);
      dcV = block(V, fdUV, dcV, UVDC, UVAC);
    }
  }
  // jpeg-js always pads with 1-bits, a whole 0xFF (stuffed) byte when aligned.
  const fill = 8 - bits;
  put((1 << fill) - 1, fill);
  if (out.length - pos < 2) { const grown = new Uint8Array(pos + 2); grown.set(out.subarray(0, pos)); out = grown; }
  word(0xffd9);
  return Buffer.from(out.subarray(0, pos));
}
