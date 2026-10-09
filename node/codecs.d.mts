import type { Buffer } from "node:buffer";
import type { RgbImage, RgbaImage, ImageColourMetadata } from "../dist/color.js";
export { srgbToLinear, linearToSrgb, toLinearImage, toSrgbImage, applyOrientation, colourIsSrgb, dropOpaqueAlpha } from "../dist/color.js";
export { resizeArea } from "../dist/resample.js";
export interface DecodedFile extends RgbaImage {
  colour: ImageColourMetadata;
  xmp: string | null;
  orientation: number;
}
export function encodePng(image: RgbImage): Buffer;
export function decodePng(bytes: Buffer): DecodedFile;
export function readJpegMetadata(bytes: Buffer): { orientation: number; xmp: string | null; iccProfileName: string | null };
export function decodeJpeg(bytes: Buffer): DecodedFile;
export function encodeJpeg(image: RgbImage, quality: number): Buffer;
export function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | null;
export function readGPano(xmp: string | null): Record<string, string | number> | null;
export function cropImage(image: Pick<RgbImage, "width" | "rgb">, x: number, y: number, width: number, height: number): RgbImage;
