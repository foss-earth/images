/**
 * What a panorama file's own bytes say before it is decoded: its format by
 * signature, its pixel size from the header, and any EXIF orientation. The
 * loader checks these against the manifest's declarations (§2) so a decode
 * reservation rests on the header, not on an untrusted number, and so no
 * embedded rotation is applied on top of the manifest's image pose.
 */

export type ImageKind = "image/jpeg" | "image/png";

export interface ImageHeader {
  kind: ImageKind;
  width: number;
  height: number;
  /** EXIF orientation 1–8, or null when the file carries none. */
  orientation: number | null;
}

export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) return "image/png";
  return null;
}

function exifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0", then a TIFF header.
  if (end - start < 14 || String.fromCharCode(...bytes.subarray(start, start + 6)) !== "Exif\0\0") return null;
  const tiff = start + 6;
  if (!((bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49) || (bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d))) return null;
  const little = bytes[tiff] === 0x49;
  const u16 = (at: number) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = (at: number) => (little
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000
    : bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]));
  if (u16(tiff + 2) !== 42) return null;
  const offset = u32(tiff + 4);
  if (offset < 8) return null;
  const ifd = tiff + offset;
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let entry = 0; entry < count; entry++) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > end) return null;
    if (u16(at) === 0x0112 && u16(at + 2) === 3 && u32(at + 4) === 1) return u16(at + 8);
  }
  return null;
}

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  let orientation: number | null = null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    const body = at + 4;
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (marker === 0xe1) orientation = exifOrientation(bytes, body, at + 2 + length) ?? orientation;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return null;
      return { kind: "image/jpeg", height: (bytes[body + 1] << 8) | bytes[body + 2], width: (bytes[body + 3] << 8) | bytes[body + 4], orientation };
    }
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 33 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const u32 = (at: number) => bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
  if (u32(8) !== 13) return null;
  let orientation: number | null = null;
  // An eXIf chunk may carry an orientation too.
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = u32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    // Never allocate or inspect a chunk beyond the bytes actually received.
    if (length > bytes.length - at - 12) return null;
    if (type === "eXIf") {
      const tiff = new Uint8Array(6 + length);
      tiff.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
      tiff.set(bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length)), 6);
      orientation = exifOrientation(tiff, 0, tiff.length);
    }
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  return { kind: "image/png", width: u32(16), height: u32(20), orientation };
}

/** The header of a JPEG or PNG, or null when the bytes are neither or are cut short. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const kind = sniffImageKind(bytes);
  if (kind === "image/jpeg") return jpegHeader(bytes);
  if (kind === "image/png") return pngHeader(bytes);
  return null;
}

/**
 * Why a file cannot stand for what the manifest declares, or null when it
 * can: its signature and MIME type, its header size, and no orientation
 * other than 1, since preparation applies orientation once and the manifest's
 * pose governs every representation.
 */
export function checkImage(bytes: Uint8Array, declared: { mimeType: ImageKind; width: number; height: number }, contentType: string | null): string | null {
  const header = readImageHeader(bytes);
  if (!header) return `is not a readable JPEG or PNG (declared ${declared.mimeType})`;
  if (header.kind !== declared.mimeType) return `is a ${header.kind} file, declared ${declared.mimeType}`;
  const served = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (served.startsWith("image/") && served !== header.kind) return `was served as ${served} but is a ${header.kind} file`;
  if (header.width !== declared.width || header.height !== declared.height) {
    return `is ${header.width}×${header.height} pixels, declared ${declared.width}×${declared.height}`;
  }
  if (header.orientation !== null && header.orientation !== 1) {
    return `carries EXIF orientation ${header.orientation}; prepare it with scripts/prepare-panorama.mjs, which applies orientation once`;
  }
  return null;
}
