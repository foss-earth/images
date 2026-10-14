import { colourIsSrgb, type ImageColourMetadata } from "./color.js";
import { readImageHeader, type ImageHeader } from "./headers.js";

/**
 * What a JPEG's or PNG's own bytes say about how to show it, read before it
 * is decoded: its header, and whether it can be partly transparent, has more
 * than one frame, or declares colour other than sRGB. A viewer that shows
 * only static opaque sRGB names what it cannot show instead of stripping or
 * converting it.
 */
export interface EncodedImageFacts {
  readonly header: ImageHeader;
  /** An alpha channel or a transparency chunk: some pixels may not be opaque. */
  readonly alpha: boolean;
  /** An animated PNG. */
  readonly animated: boolean;
  /** Bits per sample. */
  readonly bitDepth: number;
  /** Colour components: 1 grey, 3 colour, 4 CMYK or YCCK. */
  readonly components: number;
  readonly colour: ImageColourMetadata;
  /** A PNG cICP chunk's colour primaries and transfer characteristics (ITU-T H.273). */
  readonly cicp: { readonly primaries: number; readonly transfer: number } | null;
}

/** Inflated colour profile bytes kept at most, whatever a file claims. */
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;

const latin1 = (bytes: Uint8Array, start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
const u32 = (bytes: Uint8Array, at: number): number => bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1];

/** An ICC profile's description, enough to tell sRGB from anything else. */
export function iccProfileDescription(icc: Uint8Array): string {
  if (icc.length < 132) return "unreadable profile";
  const tags = u32(icc, 128);
  if (132 + tags * 12 > icc.length) return "unreadable profile";
  for (let index = 0; index < tags; index++) {
    const at = 132 + index * 12;
    if (latin1(icc, at, at + 4) !== "desc") continue;
    const offset = u32(icc, at + 4);
    if (offset + 28 > icc.length) return "unreadable profile";
    const type = latin1(icc, offset, offset + 4);
    if (type === "desc") return latin1(icc, offset + 12, offset + 12 + Math.max(0, u32(icc, offset + 8) - 1)).replace(/\0+$/, "");
    if (type === "mluc") {
      const length = u32(icc, offset + 20), start = offset + u32(icc, offset + 24);
      let text = "";
      for (let at = start; at + 1 < Math.min(start + length, icc.length); at += 2) text += String.fromCharCode(u16(icc, at));
      return text.replace(/\0+$/, "");
    }
  }
  return "unnamed profile";
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== "function") return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROFILE_BYTES) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

async function pngFacts(bytes: Uint8Array, header: ImageHeader): Promise<EncodedImageFacts | null> {
  const bitDepth = bytes[24], colourType = bytes[25];
  const components = colourType === 0 || colourType === 4 ? 1 : 3;
  let alpha = colourType === 4 || colourType === 6;
  let animated = false;
  let cicp: EncodedImageFacts["cicp"] = null;
  const colour: { srgbChunk: boolean; iccProfileName: string | null; gamma: number | null } = { srgbChunk: false, iccProfileName: null, gamma: null };
  let at = 8, reachedData = false;
  while (at + 12 <= bytes.length) {
    const length = u32(bytes, at);
    const type = latin1(bytes, at + 4, at + 8), body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IDAT" || type === "IEND") { reachedData = true; break; }
    if (length > bytes.length - at - 12) return null;
    if (type === "tRNS") alpha = true;
    else if (type === "acTL") animated = true;
    else if (type === "sRGB") colour.srgbChunk = true;
    else if (type === "gAMA" && length === 4) colour.gamma = u32(body, 0) / 100000;
    else if (type === "cICP" && length === 4) cicp = { primaries: body[0], transfer: body[1] };
    else if (type === "iCCP") {
      const end = body.indexOf(0);
      const name = end > 0 ? latin1(body, 0, end) : "unnamed profile";
      const profile = end > 0 && body[end + 1] === 0 ? await inflate(body.subarray(end + 2)) : null;
      colour.iccProfileName = profile ? iccProfileDescription(profile) : name;
    }
    at += 12 + length;
  }
  // Facts after the bytes ran out could still hide transparency or animation.
  if (!reachedData) return null;
  return { header, alpha, animated, bitDepth, components, colour, cicp };
}

function jpegFacts(bytes: Uint8Array, header: ImageHeader): EncodedImageFacts | null {
  const profile: { index: number; bytes: Uint8Array }[] = [];
  let bitDepth = 8, components = 3, reachedData = false;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    const length = u16(bytes, at + 2), body = at + 4, end = at + 2 + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker === 0xe2 && latin1(bytes, body, body + 12) === "ICC_PROFILE\0") profile.push({ index: bytes[body + 12], bytes: bytes.subarray(body + 14, end) });
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      bitDepth = bytes[body];
      components = bytes[body + 5];
    }
    if (marker === 0xda) { reachedData = true; break; }
    at = end;
  }
  if (!reachedData) return null;
  let iccProfileName: string | null = null;
  if (profile.length) {
    profile.sort((a, b) => a.index - b.index);
    const total = profile.reduce((sum, part) => sum + part.bytes.byteLength, 0);
    const icc = new Uint8Array(total);
    let offset = 0;
    for (const part of profile) { icc.set(part.bytes, offset); offset += part.bytes.byteLength; }
    iccProfileName = iccProfileDescription(icc);
  }
  return { header, alpha: false, animated: false, bitDepth, components, colour: { srgbChunk: false, iccProfileName, gamma: null }, cicp: null };
}

/** The facts of a JPEG or PNG, or null when the bytes are neither or are cut short before the image data. */
export async function readEncodedImageFacts(bytes: Uint8Array): Promise<EncodedImageFacts | null> {
  const header = readImageHeader(bytes);
  if (!header) return null;
  return header.kind === "image/png" ? pngFacts(bytes, header) : jpegFacts(bytes, header);
}

/**
 * Why an image cannot be shown as static opaque sRGB at 8 bits per channel,
 * as it is stored, or null when it can. Orientation other than none or 1 is
 * refused too: the image would have to be turned before it is shown.
 */
export function staticOpaqueSrgbProblem(facts: EncodedImageFacts): string | null {
  const { header } = facts;
  if (header.orientation !== null && header.orientation !== 1) return `It carries EXIF orientation ${header.orientation}, which turns or mirrors it; only unturned images are supported so far.`;
  if (facts.animated) return "It is an animated PNG; only still images are supported.";
  if (facts.alpha) return "It can be partly transparent; only opaque images are supported so far.";
  if (facts.components === 4) return "Its colour is CMYK; only sRGB images are supported so far.";
  if (facts.bitDepth > 8) return `It has ${facts.bitDepth} bits per channel; only 8-bit images are supported so far, and showing it would round its values.`;
  if (facts.cicp && !(facts.cicp.primaries === 1 && facts.cicp.transfer === 13)) {
    return `Its colour is declared with primaries ${facts.cicp.primaries} and transfer ${facts.cicp.transfer}, not sRGB; only sRGB images are supported so far.`;
  }
  const srgb = colourIsSrgb(facts.colour);
  if (!srgb.ok) return `Its ${srgb.reason}; only sRGB images are supported so far.`;
  return null;
}
