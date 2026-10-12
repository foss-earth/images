import zlib, { deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { decodeSequentialJpeg } from "./jpegDecode.mjs";
import { encodeBaselineJpeg } from "./jpegEncode.mjs";
import { readImageHeader } from "../dist/headers.js";
export { srgbToLinear, linearToSrgb, toLinearImage, toSrgbImage, applyOrientation, colourIsSrgb, dropOpaqueAlpha } from "../dist/color.js";

// ─── PNG ───────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// zlib computes the same CRC natively from Node 22.2 and 20.15.
const nativeCrc32 = zlib.crc32;

function crc32(bytes) {
  if (nativeCrc32) return nativeCrc32(bytes);
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

/** 8-bit RGB PNG with an sRGB chunk, each row filtered with the smallest of the five filters. */
export function encodePng({ width, height, rgb }) {
  const whole = rgb instanceof Uint8Array && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 1 && height >= 1 && rgb.length >= width * height * 3;
  const raw = whole ? filterRows(rgb, width, height) : filterRowsEach(rgb, width, height);
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
 * The rows deflate takes, as filterRowsEach writes them, from a Uint8Array holding every pixel: the five filters'
 * scores in one pass, the lowest kept (the earlier filter on a tie), and only its bytes written.
 */
function filterRows(rgb, width, height) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height), zero = new Uint8Array(stride);
  for (let y = 0, o = 0, d = 1; y < height; y++, o += stride, d += stride + 1) {
    // The first row's filters see a row of zeros above it.
    const up = y > 0 ? rgb : zero, u = y > 0 ? o - stride : 0;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    // The first pixel has zeros to its left, so Sub keeps its bytes and Paeth predicts the byte above.
    for (let x = 0; x < 3; x++) {
      const value = rgb[o + x], above = up[u + x], score = distance(value);
      s0 += score; s1 += score; s2 += distance(value - above); s3 += distance(value - (above >> 1)); s4 += distance(value - above);
    }
    for (let x = 3; x < stride; x++) {
      const value = rgb[o + x], above = up[u + x], left = rgb[o + x - 3], upLeft = up[u + x - 3];
      s0 += distance(value); s1 += distance(value - left); s2 += distance(value - above);
      s3 += distance(value - ((left + above) >> 1)); s4 += distance(value - paeth(left, above, upLeft));
    }
    let best = 0, score = s0;
    if (s1 < score) { best = 1; score = s1; }
    if (s2 < score) { best = 2; score = s2; }
    if (s3 < score) { best = 3; score = s3; }
    if (s4 < score) best = 4;
    raw[d - 1] = best;
    // A Uint8Array keeps each difference's low byte, as & 0xff does.
    if (best === 0) raw.set(rgb.subarray(o, o + stride), d);
    else if (best === 1) for (let x = 0; x < stride; x++) raw[d + x] = rgb[o + x] - (x >= 3 ? rgb[o + x - 3] : 0);
    else if (best === 2) for (let x = 0; x < stride; x++) raw[d + x] = rgb[o + x] - up[u + x];
    else if (best === 3) for (let x = 0; x < stride; x++) raw[d + x] = rgb[o + x] - (((x >= 3 ? rgb[o + x - 3] : 0) + up[u + x]) >> 1);
    else for (let x = 0; x < stride; x++) raw[d + x] = rgb[o + x] - paeth(x >= 3 ? rgb[o + x - 3] : 0, up[u + x], x >= 3 ? up[u + x - 3] : 0);
  }
  return raw;
}

/** A filtered byte's score, its distance from 0 as a signed byte: v < 128 ? v : 256 - v, v the difference's low byte. */
function distance(difference) {
  return Math.abs((difference << 24) >> 24);
}

/** The predictor of the Paeth filter: whichever neighbour is nearest left + above - upLeft, in that order on ties. */
function paeth(left, above, upLeft) {
  const p = left + above - upLeft;
  const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft;
}

/** The rows deflate takes, each filter written out in turn and the smallest kept: the form for any other pixels. */
function filterRowsEach(rgb, width, height) {
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
  return raw;
}

/** Finite codec-owned buffer reservations, not a process/RSS or GC guarantee. */
export const DEFAULT_IMAGE_DECODE_LIMITS = Object.freeze({
  maxEncodedBytes: 64 * 1024 * 1024, maxPixels: 400_000_000,
  maxMemoryBytes: 2048 * 1024 * 1024, maxMetadataBytes: 4 * 1024 * 1024, maxChunks: 100000,
});
export class ImageDecodeLimitError extends RangeError {
  constructor(code, message) { super(message); this.name = "ImageDecodeLimitError"; this.code = code; }
}
function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException("Image decode cancelled", "AbortError"); }
function decodeLimits(options = {}) {
  const limits = { ...DEFAULT_IMAGE_DECODE_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_IMAGE_DECODE_LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new RangeError(`${key} must be a positive safe integer`);
  checkAbort(limits.signal); return limits;
}
function within(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new ImageDecodeLimitError(code, `Image ${code} budget exceeded (${value} > ${maximum})`);
}
function pngChunks(data, limits) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  const chunks = []; let offset = 8, ended = false;
  while (offset < data.length) {
    checkAbort(limits.signal); within(chunks.length + 1, limits.maxChunks, "chunks");
    if (offset + 12 > data.length) throw new Error("Truncated PNG chunk");
    const length = data.readUInt32BE(offset), end = offset + 12 + length;
    if (end > data.length) throw new Error("Truncated PNG chunk body");
    const type = data.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, body: data.subarray(offset + 8, end - 4) }); offset = end;
    if (type === "IEND") { if (length !== 0 || offset !== data.length) throw new Error("Invalid PNG end"); ended = true; break; }
  }
  if (!ended || chunks[0]?.type !== "IHDR" || chunks[0].body.length !== 13 || chunks.filter(chunk => chunk.type === "IHDR").length !== 1) throw new Error("Invalid PNG header/end");
  const body = chunks[0].body, colourType = body[9];
  if (body[8] !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0 || ![0, 2, 4, 6].includes(colourType)) throw new Error("PNG input must be 8-bit greyscale, RGB or RGBA without interlacing; convert it first");
  return { chunks, width: body.readUInt32BE(0), height: body.readUInt32BE(4), colourType, channels: { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType] };
}
function inspect(data, limits) {
  within(data.byteLength, limits.maxEncodedBytes, "encoded");
  const header = readImageHeader(data);
  if (!header || header.width < 1 || header.height < 1) throw new Error("Invalid PNG/JPEG image header");
  const pixels = header.width * header.height; within(pixels, limits.maxPixels, "pixels");
  const rgbaBytes = pixels * 4;
  let workingBytes, png;
  if (header.kind === "image/png") {
    png = pngChunks(data, limits);
    const hasMetadata = png.chunks.some(chunk => ["iCCP", "iTXt"].includes(chunk.type));
    // Includes encoded input + IDAT concatenation; native output chunk headroom;
    // inflated rows + zlib output chunks; channel pixels; RGBA; bounded metadata.
    workingBytes = data.byteLength * 2 + (pixels * png.channels + header.height) * 2 + pixels * png.channels + rgbaBytes + 1024 * 1024 + (hasMetadata ? limits.maxMetadataBytes * 4 : 0);
    within(workingBytes, limits.maxMemoryBytes, "memory");
  } else {
    // jpeg-js's tracked-allocation budget (kept by jpegDecode.mjs, which
    // tallies it, or by jpeg-js) gets the rest. Input copies, comments and
    // metadata are charged separately; the reservation is conservative.
    const overhead = data.byteLength * 4 + limits.maxMetadataBytes * 4 + 1024 * 1024;
    workingBytes = Math.min(limits.maxMemoryBytes, overhead + pixels * 160 + rgbaBytes + 1024 * 1024);
    within(overhead + rgbaBytes, limits.maxMemoryBytes, "memory");
  }
  return { mimeType: header.kind, width: header.width, height: header.height, pixels, rgbaBytes, workingBytes, png };
}
/** Inspect without decoding. The reservation includes the returned RGBA buffer. */
export function inspectImageDecode(data, options) {
  const { png: _png, ...plan } = inspect(data, decodeLimits(options)); return plan;
}

/** Bounded 8-bit non-interlaced PNG decoding. Inflation is capped before allocation. */
export function decodePng(data, options) {
  const limits = decodeLimits(options), plan = inspect(data, limits);
  if (plan.mimeType !== "image/png") throw new Error("not a PNG");
  const { width, height, channels, colourType, chunks } = plan.png;
  const idat = [], colour = { iccProfileName: null, srgbChunk: false, gamma: null };
  let xmp = null, metadataBytes = 0;
  const metadata = (body, compressed) => {
    const remaining = limits.maxMetadataBytes - metadataBytes;
    if (remaining <= 0) throw new ImageDecodeLimitError("metadata", "Image metadata budget exceeded");
    let result;
    if (compressed) {
      try { result = inflateSync(body, { maxOutputLength: remaining }); }
      catch (error) { if (error.code === "ERR_BUFFER_TOO_LARGE") throw new ImageDecodeLimitError("metadata", "Image metadata inflation exceeds budget"); throw error; }
    } else { within(body.length, remaining, "metadata"); result = body; }
    metadataBytes += result.length; return result;
  };
  for (const { type, body } of chunks) {
    checkAbort(limits.signal);
    if (type === "IDAT") idat.push(body);
    else if (type === "iCCP") {
      const end = body.indexOf(0);
      if (end < 0 || body[end + 1] !== 0) throw new Error("Invalid PNG ICC chunk");
      colour.iccProfileName = iccDescription(metadata(body.subarray(end + 2), true));
    } else if (type === "sRGB") colour.srgbChunk = true;
    else if (type === "gAMA") { if (body.length !== 4) throw new Error("Invalid PNG gamma"); colour.gamma = body.readUInt32BE(0) / 100000; }
    else if (type === "iTXt") {
      const end = body.indexOf(0);
      if (end < 0 || end + 3 > body.length) throw new Error("Invalid PNG text chunk");
      if (body.toString("latin1", 0, end) !== "XML:com.adobe.xmp") continue;
      const flag = body[end + 1];
      let languageEnd = body.indexOf(0, end + 3), translatedEnd = languageEnd < 0 ? -1 : body.indexOf(0, languageEnd + 1);
      if (translatedEnd < 0 || flag > 1 || body[end + 2] !== 0) throw new Error("Invalid PNG XMP chunk");
      xmp = metadata(body.subarray(translatedEnd + 1), flag === 1).toString("utf8");
    }
  }
  const expected = (width * channels + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch (error) { if (error.code === "ERR_BUFFER_TOO_LARGE") throw new ImageDecodeLimitError("pixels", "PNG inflation exceeds declared image dimensions"); throw error; }
  if (raw.length !== expected) throw new Error("PNG row length differs from declared dimensions");
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    checkAbort(limits.signal);
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error("Invalid PNG row filter");
    unfilterRow(filter, raw, y * (stride + 1) + 1, pixels, y * stride, stride, channels, y > 0);
  }
  // RGBA rows are already RGBA.
  const rgba = colourType === 6 ? pixels : expandToRgba(pixels, width * height, colourType);
  checkAbort(limits.signal);
  return { width, height, rgba, colour, xmp, orientation: 1 };
}

/**
 * One row's bytes from raw[s...] into pixels[o...], each filter in its own loop. With no row above, Up adds nothing
 * and Paeth adds the left byte as Sub does; with no byte to the left, Paeth adds the byte above as Up does.
 */
function unfilterRow(filter, raw, s, pixels, o, stride, channels, hasUp) {
  const u = o - stride;
  // A Uint8Array keeps each sum's low byte, as & 0xff does.
  if (filter === 0 || (filter === 2 && !hasUp)) pixels.set(raw.subarray(s, s + stride), o);
  else if (filter === 1 || (filter === 4 && !hasUp)) {
    for (let x = 0; x < channels; x++) pixels[o + x] = raw[s + x];
    for (let x = channels; x < stride; x++) pixels[o + x] = raw[s + x] + pixels[o + x - channels];
  } else if (filter === 2) {
    for (let x = 0; x < stride; x++) pixels[o + x] = raw[s + x] + pixels[u + x];
  } else if (filter === 3 && !hasUp) {
    for (let x = 0; x < channels; x++) pixels[o + x] = raw[s + x];
    for (let x = channels; x < stride; x++) pixels[o + x] = raw[s + x] + (pixels[o + x - channels] >> 1);
  } else if (filter === 3) {
    for (let x = 0; x < channels; x++) pixels[o + x] = raw[s + x] + (pixels[u + x] >> 1);
    for (let x = channels; x < stride; x++) pixels[o + x] = raw[s + x] + ((pixels[o + x - channels] + pixels[u + x]) >> 1);
  } else {
    for (let x = 0; x < channels; x++) pixels[o + x] = raw[s + x] + pixels[u + x];
    for (let x = channels; x < stride; x++) pixels[o + x] = raw[s + x] + paeth(pixels[o + x - channels], pixels[u + x], pixels[u + x - channels]);
  }
}

/** RGBA from greyscale (colour type 0), greyscale with alpha (4) or RGB (2) pixels. */
function expandToRgba(pixels, count, colourType) {
  const rgba = Buffer.alloc(count * 4);
  if (colourType === 2) {
    for (let i = 0, s = 0, d = 0; i < count; i++, s += 3, d += 4) {
      rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255;
    }
  } else {
    const alpha = colourType === 4;
    for (let i = 0, s = 0, d = 0; i < count; i++, d += 4) {
      const grey = pixels[s++];
      rgba[d] = grey; rgba[d + 1] = grey; rgba[d + 2] = grey; rgba[d + 3] = alpha ? pixels[s++] : 255;
    }
  }
  return rgba;
}

// ─── JPEG ──────────────────────────────────────────────────────────────

/** The EXIF orientation (1–8), the ICC profile's description and the XMP packet of a JPEG, without decoding pixels. */
export function readJpegMetadata(data, options) {
  const limits = decodeLimits(options); within(data.byteLength, limits.maxEncodedBytes, "encoded");
  let chunks = 0, metadataBytes = 0;
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  let orientation = 1;
  let xmp = null;
  const iccChunks = [];
  while (offset + 4 <= data.length) {
    checkAbort(limits.signal); within(++chunks, limits.maxChunks, "chunks");
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const size = data.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > data.length) throw new Error("Truncated JPEG segment");
    if (marker >= 0xe0 && marker <= 0xef) { metadataBytes += size - 2; within(metadataBytes, limits.maxMetadataBytes, "metadata"); }
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
  if (icc.length < 132) throw new Error("Truncated ICC profile");
  const tags = icc.readUInt32BE(128);
  if (132 + tags * 12 > icc.length) throw new Error("Truncated ICC tag table");
  for (let i = 0; i < tags; i++) {
    const at = 132 + i * 12;
    if (icc.toString("latin1", at, at + 4) !== "desc") continue;
    const offset = icc.readUInt32BE(at + 4);
    if (offset + 28 > icc.length) throw new Error("Truncated ICC description");
    const type = icc.toString("latin1", offset, offset + 4);
    if (type === "desc") return icc.toString("latin1", offset + 12, offset + 12 + icc.readUInt32BE(offset + 8) - 1).replace(/\0+$/, "");
    if (type === "mluc") {
      const length = icc.readUInt32BE(offset + 20), start = icc.readUInt32BE(offset + 24);
      return Buffer.from(icc.subarray(offset + start, offset + start + length)).swap16().toString("utf16le").replace(/\0+$/, "");
    }
  }
  return "unnamed profile";
}

export function decodeJpeg(data, options) {
  const limits = decodeLimits(options), plan = inspect(data, limits);
  if (plan.mimeType !== "image/jpeg") throw new Error("not a JPEG");
  const metadata = readJpegMetadata(data, limits);
  checkAbort(limits.signal);
  const overhead = data.byteLength * 4 + limits.maxMetadataBytes * 4 + 1024 * 1024;
  const jpegOptions = { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: (plan.workingBytes - overhead) / (1024 * 1024), maxResolutionInMP: limits.maxPixels / 1000000 };
  // jpegDecode.mjs returns jpeg-js's pixels, or null where jpeg-js decodes the file itself.
  const decoded = decodeSequentialJpeg(data, jpegOptions) ?? jpeg.decode(data, jpegOptions);
  checkAbort(limits.signal);
  if (decoded.width !== plan.width || decoded.height !== plan.height) throw new Error("JPEG decoded dimensions differ from inspected header");
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
  // jpegEncode.mjs writes jpeg-js's bytes; other inputs keep jpeg-js's handling.
  if (typeof quality === "number" && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 0 && height >= 0
    && rgb instanceof Uint8Array && rgb.length >= width * height * 3) return encodeBaselineJpeg({ width, height, rgb }, quality);
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

export { resizeArea } from "../dist/resample.js";

export function cropImage({ width, rgb }, x, y, cropWidth, cropHeight) {
  const out = new Uint8Array(cropWidth * cropHeight * 3);
  for (let row = 0; row < cropHeight; row++) out.set(rgb.subarray(((y + row) * width + x) * 3, ((y + row) * width + x + cropWidth) * 3), row * cropWidth * 3);
  return { width: cropWidth, height: cropHeight, rgb: out };
}
