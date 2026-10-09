import { deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
export { srgbToLinear, linearToSrgb, toLinearImage, toSrgbImage, applyOrientation, colourIsSrgb, dropOpaqueAlpha } from "../dist/color.js";

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
