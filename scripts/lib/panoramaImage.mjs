/**
 * Image work for scripts/prepare-panorama.mjs: PNG and JPEG codecs, the
 * metadata preparation must honour once (EXIF orientation, ICC profile, GPano
 * XMP), linear-light resampling, and the format's cube faces. Pure functions
 * over buffers; the CLI does the files.
 *
 * Conventions are docs/proposals/panorama-scenes.md §2: equirectangular u
 * right, v down, centre forward; cube faces by the table below.
 */
import { deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";

// ─── sRGB ↔ linear ─────────────────────────────────────────────────────

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToLinear(byte) {
  return TO_LINEAR[byte];
}

export function linearToSrgb(value) {
  const c = Math.min(1, Math.max(0, value));
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** RGB bytes → linear-light float RGB. */
export function toLinearImage({ width, height, rgb }) {
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = TO_LINEAR[rgb[i]];
  return { width, height, data };
}

/** Linear-light float RGB → RGB bytes: the one output conversion. */
export function toSrgbImage({ width, height, data }) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) rgb[i] = linearToSrgb(data[i]);
  return { width, height, rgb };
}

// ─── PNG ───────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGB PNG with an sRGB chunk, each row filtered with the smallest of the five filters. */
export function encodePng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const line = rgb.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let bestFilter = 0, bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= 3 ? line[x - 3] : 0;
        const above = up ? up[x] : 0;
        const upLeft = up && x >= 3 ? up[x - 3] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = above;
        else if (filter === 3) predictor = (left + above) >> 1;
        else if (filter === 4) {
          const p = left + above - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft;
        }
        const value = (line[x] - predictor) & 0xff;
        out[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { bestScore = score; bestFilter = filter; }
    }
    raw[y * (stride + 1)] = bestFilter;
    candidates[bestFilter].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    // Rendering intent 0, perceptual: the pixels are sRGB.
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Decodes an 8-bit, non-interlaced greyscale, RGB or RGBA PNG to RGBA, with
 * what it says about colour: an ICC profile's name, an sRGB chunk, gamma,
 * and any XMP packet.
 */
export function decodePng(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0, height = 0, channels = 0, colourType = -1;
  const idat = [];
  const colour = { iccProfileName: null, srgbChunk: false, gamma: null };
  let xmp = null;
  while (offset < data.length) {
    const len = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = body.subarray(8);
      colourType = colorType;
      if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
        throw new Error("PNG input must be 8-bit greyscale, RGB or RGBA without interlacing; convert it first");
      }
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "iCCP") {
      // The chunk's own name is free text; the profile's description says what it is.
      const nameEnd = body.indexOf(0);
      colour.iccProfileName = iccDescription(inflateSync(body.subarray(nameEnd + 2)));
    }
    else if (type === "sRGB") colour.srgbChunk = true;
    else if (type === "gAMA") colour.gamma = body.readUInt32BE(0) / 100000;
    else if (type === "iTXt" && body.toString("latin1", 0, body.indexOf(0)) === "XML:com.adobe.xmp") {
      // keyword\0 compression-flag compression-method language\0 translated\0 text
      let cursor = body.indexOf(0) + 3;
      cursor = body.indexOf(0, cursor) + 1;
      cursor = body.indexOf(0, cursor) + 1;
      xmp = body[body.indexOf(0) + 1] === 1 ? inflateSync(body.subarray(cursor)).toString("utf8") : body.toString("utf8", cursor);
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const grey = colourType === 0 || colourType === 4;
    rgba[i * 4] = pixels[s];
    rgba[i * 4 + 1] = grey ? pixels[s] : pixels[s + 1];
    rgba[i * 4 + 2] = grey ? pixels[s] : pixels[s + 2];
    rgba[i * 4 + 3] = channels === 2 ? pixels[s + 1] : channels === 4 ? pixels[s + 3] : 255;
  }
  return { width, height, rgba, colour, xmp, orientation: 1 };
}

// ─── JPEG ──────────────────────────────────────────────────────────────

/** The EXIF orientation (1–8), the ICC profile's description and the XMP packet of a JPEG, without decoding pixels. */
export function readJpegMetadata(data) {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  let orientation = 1;
  let xmp = null;
  const iccChunks = [];
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const size = data.readUInt16BE(offset + 2);
    const body = data.subarray(offset + 4, offset + 2 + size);
    if (marker === 0xe1 && body.toString("latin1", 0, 6) === "Exif\0\0") orientation = readExifOrientation(body.subarray(6)) ?? orientation;
    else if (marker === 0xe1 && body.toString("latin1", 0, 29) === "http://ns.adobe.com/xap/1.0/\0") xmp = body.toString("utf8", 29);
    else if (marker === 0xe2 && body.toString("latin1", 0, 12) === "ICC_PROFILE\0") iccChunks.push({ index: body[12], bytes: body.subarray(14) });
    offset += 2 + size;
  }
  const icc = iccChunks.length ? Buffer.concat(iccChunks.sort((a, b) => a.index - b.index).map(chunk => chunk.bytes)) : null;
  return { orientation, xmp, iccProfileName: icc ? iccDescription(icc) : null };
}

function readExifOrientation(tiff) {
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = at => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = at => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

/** An ICC profile's 'desc' text, enough to tell sRGB from anything else. */
function iccDescription(icc) {
  const tags = icc.readUInt32BE(128);
  for (let i = 0; i < tags; i++) {
    const at = 132 + i * 12;
    if (icc.toString("latin1", at, at + 4) !== "desc") continue;
    const offset = icc.readUInt32BE(at + 4);
    const type = icc.toString("latin1", offset, offset + 4);
    if (type === "desc") return icc.toString("latin1", offset + 12, offset + 12 + icc.readUInt32BE(offset + 8) - 1).replace(/\0+$/, "");
    if (type === "mluc") {
      const length = icc.readUInt32BE(offset + 20), start = icc.readUInt32BE(offset + 24);
      return Buffer.from(icc.subarray(offset + start, offset + start + length)).swap16().toString("utf16le").replace(/\0+$/, "");
    }
  }
  return "unnamed profile";
}

export function decodeJpeg(data) {
  const metadata = readJpegMetadata(data);
  const decoded = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
  return {
    width: decoded.width,
    height: decoded.height,
    rgba: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    colour: { iccProfileName: metadata.iccProfileName, srgbChunk: false, gamma: null },
    xmp: metadata.xmp,
    orientation: metadata.orientation,
  };
}

export function encodeJpeg({ width, height, rgb }, quality) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return jpeg.encode({ width, height, data: rgba }, quality).data;
}

export function sniffImage(data) {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

// ─── Normalization ─────────────────────────────────────────────────────

/** Applies an EXIF orientation (1–8) to RGBA pixels, once, so nothing downstream rotates again. */
export function applyOrientation({ width, height, rgba }, orientation) {
  if (orientation === 1) return { width, height, rgba };
  if (!(orientation >= 2 && orientation <= 8)) throw new Error(`unknown EXIF orientation ${orientation}`);
  const swap = orientation >= 5;
  const outWidth = swap ? height : width, outHeight = swap ? width : height;
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    // Where the displayed pixel (x, y) is stored.
    let sx, sy;
    switch (orientation) {
      case 2: sx = width - 1 - x; sy = y; break;
      case 3: sx = width - 1 - x; sy = height - 1 - y; break;
      case 4: sx = x; sy = height - 1 - y; break;
      case 5: sx = y; sy = x; break;
      case 6: sx = y; sy = height - 1 - x; break;
      case 7: sx = width - 1 - y; sy = height - 1 - x; break;
      default: sx = width - 1 - y; sy = x; break;
    }
    rgba.copy(out, (y * outWidth + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

/**
 * Whether colour data can be taken as sRGB without an ICC engine: untagged,
 * tagged sRGB, or gamma ≈ 1/2.2. Anything else must be converted before
 * preparation; the tool refuses rather than guess.
 */
export function colourIsSrgb(colour) {
  if (colour.srgbChunk) return { ok: true, reason: "sRGB chunk" };
  if (colour.iccProfileName) {
    return /srgb|iec\s*61966-2[.-]1/i.test(colour.iccProfileName)
      ? { ok: true, reason: `ICC profile "${colour.iccProfileName}"` }
      : { ok: false, reason: `ICC profile "${colour.iccProfileName}" is not sRGB` };
  }
  if (colour.gamma !== null && Math.abs(colour.gamma - 1 / 2.2) > 0.01) return { ok: false, reason: `gamma ${colour.gamma} is not sRGB's` };
  return { ok: true, reason: "untagged, taken as sRGB" };
}

/** RGBA → RGB, refusing any pixel that is not opaque. */
export function dropOpaqueAlpha({ width, height, rgba }) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] !== 255) throw new Error(`pixel ${i % width},${Math.floor(i / width)} is not opaque; version 1 panoramas are opaque`);
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, rgb };
}

/** GPano fields from an XMP packet, as numbers where they are numbers. */
export function readGPano(xmp) {
  if (!xmp) return null;
  const fields = {};
  for (const match of xmp.matchAll(/GPano:(\w+)\s*=\s*"([^"]*)"|<GPano:(\w+)>([^<]*)<\/GPano:\w+>/g)) {
    const name = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    fields[name] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return Object.keys(fields).length ? fields : null;
}

// ─── Resampling (linear light) ─────────────────────────────────────────

/** Exact area-average resize of a linear image: each output texel is the mean of the source area it covers. */
export function resizeArea(image, outWidth, outHeight) {
  const { width, height, data } = image;
  const horizontal = new Float32Array(outWidth * height * 3);
  const sx = width / outWidth;
  for (let x = 0; x < outWidth; x++) {
    const start = x * sx, end = (x + 1) * sx;
    for (let px = Math.floor(start); px < Math.ceil(end); px++) {
      const weight = (Math.min(end, px + 1) - Math.max(start, px)) / sx;
      for (let y = 0; y < height; y++) {
        const s = (y * width + px) * 3, d = (y * outWidth + x) * 3;
        horizontal[d] += data[s] * weight;
        horizontal[d + 1] += data[s + 1] * weight;
        horizontal[d + 2] += data[s + 2] * weight;
      }
    }
  }
  const out = new Float32Array(outWidth * outHeight * 3);
  const sy = height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    const start = y * sy, end = (y + 1) * sy;
    for (let py = Math.floor(start); py < Math.ceil(end); py++) {
      const weight = (Math.min(end, py + 1) - Math.max(start, py)) / sy;
      const s0 = py * outWidth * 3, d0 = y * outWidth * 3;
      for (let i = 0; i < outWidth * 3; i++) out[d0 + i] += horizontal[s0 + i] * weight;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/** Halvings of an equirectangular image down to 64 wide: area averages, so each level is a correct prefilter. */
export function equirectPyramid(image) {
  const levels = [image];
  while (levels.at(-1).width > 64 && levels.at(-1).height > 1) {
    const last = levels.at(-1);
    levels.push(resizeArea(last, Math.max(1, Math.floor(last.width / 2)), Math.max(1, Math.floor(last.height / 2))));
  }
  return levels;
}

/** Bilinear sample with longitude wrapping and latitude clamped. */
export function sampleEquirect(level, u, v, out) {
  const { width, height, data } = level;
  const fx = u * width - 0.5;
  const fy = Math.min(height - 1, Math.max(0, v * height - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const y1 = Math.min(height - 1, y0 + 1);
  const xa = ((x0 % width) + width) % width, xb = (xa + 1) % width;
  for (let c = 0; c < 3; c++) {
    const top = data[(y0 * width + xa) * 3 + c] * (1 - tx) + data[(y0 * width + xb) * 3 + c] * tx;
    const bottom = data[(y1 * width + xa) * 3 + c] * (1 - tx) + data[(y1 * width + xb) * 3 + c] * tx;
    out[c] = top * (1 - ty) + bottom * ty;
  }
}

/** The format's cube face table (§2): forward f, right r, top t, in image-local axes (X right, Y forward, Z up). */
export const CUBE_FACES = {
  px: { f: [1, 0, 0], r: [0, -1, 0], t: [0, 0, 1] },
  nx: { f: [-1, 0, 0], r: [0, 1, 0], t: [0, 0, 1] },
  py: { f: [0, 1, 0], r: [1, 0, 0], t: [0, 0, 1] },
  ny: { f: [0, -1, 0], r: [-1, 0, 0], t: [0, 0, 1] },
  pz: { f: [0, 0, 1], r: [1, 0, 0], t: [0, -1, 0] },
  nz: { f: [0, 0, -1], r: [1, 0, 0], t: [0, 1, 0] },
};
export const CUBE_FACE_NAMES = ["px", "nx", "py", "ny", "pz", "nz"];

export function equirectUv(x, y, z) {
  const n = Math.hypot(x, y, z);
  return [0.5 + Math.atan2(x, y) / (2 * Math.PI), 0.5 - Math.asin(Math.max(-1, Math.min(1, z / n))) / Math.PI];
}

/**
 * One cube face of `size` texels from an equirectangular pyramid, in linear
 * light: each texel averages a supersampled grid read from the level whose
 * texels are nearest the face texel's footprint at the face centre.
 */
export function renderCubeFace(pyramid, face, size) {
  const { f, r, t } = CUBE_FACES[face];
  const ratio = pyramid[0].width / 4 / size;
  const level = Math.max(0, Math.min(pyramid.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))));
  const source = pyramid[level];
  const residual = source.width / 4 / size;
  const samples = residual > 1.5 ? 3 : 2;
  const data = new Float32Array(size * size * 3);
  const colour = [0, 0, 0];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let red = 0, green = 0, blue = 0;
    for (let sj = 0; sj < samples; sj++) for (let si = 0; si < samples; si++) {
      const a = 2 * ((i + (si + 0.5) / samples) / size) - 1;
      const b = 1 - 2 * ((j + (sj + 0.5) / samples) / size);
      const [u, v] = equirectUv(f[0] + a * r[0] + b * t[0], f[1] + a * r[1] + b * t[1], f[2] + a * r[2] + b * t[2]);
      sampleEquirect(source, u, v, colour);
      red += colour[0]; green += colour[1]; blue += colour[2];
    }
    const n = samples * samples, d = (j * size + i) * 3;
    data[d] = red / n; data[d + 1] = green / n; data[d + 2] = blue / n;
  }
  return { width: size, height: size, data };
}

/**
 * One face of a tiled cube (src/scenes/tiles/cubeTiling.ts) of `size`
 * texels, in linear light, with `gutter` more texels on every side sampled
 * at the face's own coordinates continued past its edge: inside the face
 * they are a neighbouring tile's texels, past its edge the next face's. A
 * face position s in −1…1 is the direction f + w(s)·r + w(t)·t, with
 * w(s) = tan(s·π/4) for "equi-angular" and s for "gnomonic". Each texel
 * averages a supersampled grid, as renderCubeFace does, so every level is
 * resampled from the source by the same rule.
 */
export function renderTileFace(pyramid, face, size, warp, gutter) {
  const { f, r, t } = CUBE_FACES[face];
  const side = size + 2 * gutter;
  const ratio = pyramid[0].width / 4 / size;
  const level = Math.max(0, Math.min(pyramid.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))));
  const source = pyramid[level];
  const residual = source.width / 4 / size;
  const samples = residual > 1.5 ? 3 : 2;
  const equiAngular = warp === "equi-angular";
  const data = new Float32Array(side * side * 3);
  const colour = [0, 0, 0];
  const warped = s => (equiAngular ? Math.tan((s * Math.PI) / 4) : s);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    let red = 0, green = 0, blue = 0;
    for (let sj = 0; sj < samples; sj++) for (let si = 0; si < samples; si++) {
      const a = warped(2 * ((i - gutter + (si + 0.5) / samples) / size) - 1);
      const b = warped(1 - 2 * ((j - gutter + (sj + 0.5) / samples) / size));
      const [u, v] = equirectUv(f[0] + a * r[0] + b * t[0], f[1] + a * r[1] + b * t[1], f[2] + a * r[2] + b * t[2]);
      sampleEquirect(source, u, v, colour);
      red += colour[0]; green += colour[1]; blue += colour[2];
    }
    const n = samples * samples, d = (j * side + i) * 3;
    data[d] = red / n; data[d + 1] = green / n; data[d + 2] = blue / n;
  }
  return { width: side, height: side, data };
}

/** A `width` × `height` window of an sRGB image at (x, y). */
export function cropImage({ width, rgb }, x, y, cropWidth, cropHeight) {
  const out = new Uint8Array(cropWidth * cropHeight * 3);
  for (let row = 0; row < cropHeight; row++) out.set(rgb.subarray(((y + row) * width + x) * 3, ((y + row) * width + x + cropWidth) * 3), row * cropWidth * 3);
  return { width: cropWidth, height: cropHeight, rgb: out };
}

// ─── The cardinal/text fixture ─────────────────────────────────────────

// Stroke letters on a unit box, x right and y up, as seen from inside the sphere.
const LETTERS = {
  N: [[[0, 0], [0, 1], [0.7, 0], [0.7, 1]]],
  E: [[[0.7, 1], [0, 1], [0, 0], [0.7, 0]], [[0, 0.5], [0.55, 0.5]]],
  S: [[[0.7, 0.9], [0.55, 1], [0.15, 1], [0, 0.85], [0, 0.62], [0.15, 0.5], [0.55, 0.5], [0.7, 0.38], [0.7, 0.15], [0.55, 0], [0.15, 0], [0, 0.1]]],
  W: [[[0, 1], [0.18, 0], [0.35, 0.6], [0.52, 0], [0.7, 1]]],
};
const LETTER_COLOURS = { N: [230, 57, 70], E: [255, 209, 102], S: [72, 202, 228], W: [239, 131, 255] };

function segmentDistance(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]);
}

/**
 * The reference renderer's synthetic panorama: sky and ground, a 30° grid,
 * polar details, and the letters N, E, S and W on the horizon, which read
 * backwards wherever a mapping mirrors the image.
 */
export function makeCardinalPanorama(width = 2048, height = width / 2) {
  const rgb = Buffer.alloc(width * height * 3);
  const letters = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  const letterSizeDeg = 16;
  for (let y = 0; y < height; y++) {
    const pitch = (0.5 - (y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const heading = ((x + 0.5) / width - 0.5) * 360;
      let colour;
      if (pitch >= 0) {
        const t = pitch / 90;
        colour = [150 - 110 * t, 190 - 120 * t, 235 - 60 * t];
      } else {
        const t = -pitch / 90;
        colour = [110 - 60 * t, 135 - 85 * t, 70 - 40 * t];
        if (pitch < -60 && (Math.floor(heading / 15) + Math.floor(pitch / 5)) % 2 === 0) colour = colour.map(c => c * 0.75);
      }
      if (pitch > 70 && Math.abs(((heading + 360) % 45) - 22.5) > 20) colour = [250, 250, 250];
      const gridHeading = Math.abs(((heading + 360) % 30) - 15);
      const gridPitch = Math.abs(((pitch + 180) % 30) - 15);
      if (gridHeading > 14.6 || gridPitch > 14.6) colour = colour.map(c => c * 0.55);
      if (Math.abs(pitch) < 0.35) colour = [255, 255, 255];
      for (const [name, centre] of letters) {
        let dh = heading - centre;
        dh = ((dh + 540) % 360) - 180;
        const lx = dh / letterSizeDeg + 0.35;
        const ly = (pitch - 4) / letterSizeDeg;
        if (lx < -0.2 || lx > 1 || ly < -0.2 || ly > 1.2) continue;
        let best = Infinity;
        for (const stroke of LETTERS[name]) {
          for (let i = 0; i + 1 < stroke.length; i++) best = Math.min(best, segmentDistance([lx, ly], stroke[i], stroke[i + 1]));
        }
        if (best < 0.075) colour = LETTER_COLOURS[name];
        else if (best < 0.11) colour = [20, 20, 20];
      }
      rgb.set(colour.map(c => Math.max(0, Math.min(255, Math.round(c)))), (y * width + x) * 3);
    }
  }
  return { width, height, rgb };
}
