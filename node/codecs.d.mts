import type { Buffer } from "node:buffer";
import type { RgbImage, RgbaImage, ImageColourMetadata } from "../dist/color.js";
export { srgbToLinear, linearToSrgb, toLinearImage, toSrgbImage, applyOrientation, colourIsSrgb, dropOpaqueAlpha } from "../dist/color.js";
export { resizeArea } from "../dist/resample.js";
export interface DecodedFile extends RgbaImage {
  colour: ImageColourMetadata;
  xmp: string | null;
  orientation: number;
}
export interface ImageDecodeLimits {
  maxEncodedBytes: number; maxPixels: number; maxMemoryBytes: number;
  maxMetadataBytes: number; maxChunks: number;
}
export type ImageDecodeOptions = Partial<ImageDecodeLimits> & { signal?: AbortSignal };
export const DEFAULT_IMAGE_DECODE_LIMITS: Readonly<ImageDecodeLimits>;
export class ImageDecodeLimitError extends RangeError { readonly code: string; constructor(code: string, message: string) }
/** Codec-owned reservation including output; not process RSS or a GC guarantee. */
export interface ImageDecodePlan { mimeType: "image/png" | "image/jpeg"; width: number; height: number; pixels: number; rgbaBytes: number; workingBytes: number }
export function inspectImageDecode(bytes: Buffer, options?: ImageDecodeOptions): ImageDecodePlan;
export function encodePng(image: RgbImage): Buffer;
export function decodePng(bytes: Buffer, options?: ImageDecodeOptions): DecodedFile;
export function readJpegMetadata(bytes: Buffer, options?: ImageDecodeOptions): { orientation: number; xmp: string | null; iccProfileName: string | null };
export function decodeJpeg(bytes: Buffer, options?: ImageDecodeOptions): DecodedFile;
export function encodeJpeg(image: RgbImage, quality: number): Buffer;
export function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | null;
export function readGPano(xmp: string | null): Record<string, string | number> | null;
export function cropImage(image: Pick<RgbImage, "width" | "rgb">, x: number, y: number, width: number, height: number): RgbImage;
