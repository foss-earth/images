import type { ImageSessionBroker, ImageOperationScope, ImageEstimate, ImageFile } from "../index.js";
import type { EncodedImageFile, HeldDecodedImage } from "./transport.js";
export interface WholeImageTexture { dispose(): void }
/** The caller supplies cache/transport/decode and the single renderer's uploads. */
export interface WholeImagePorts<T extends WholeImageTexture> {
  broker: ImageSessionBroker;
  /** Dedicated source operation scope, from that broker, never shared with an unrelated load. */
  scope: ImageOperationScope;
  maxTextureSide: number;
  overlap?: boolean;
  obtain(file: ImageFile, declaredBytes: number): Promise<EncodedImageFile>;
  decode(file: EncodedImageFile, declared: ImageFile): Promise<HeldDecodedImage>;
  /** Upload adapters reserve their actual staging in scope before allocating. */
  whenReady(texture: T, signal: AbortSignal): Promise<void>;
}
export interface LoadedWholeImage<T extends WholeImageTexture> {
  texture: T;
  estimate: ImageEstimate;
  /** Ends this dedicated operation; releases texture and every reservation. */
  dispose(): void;
}
