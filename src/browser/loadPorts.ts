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
  /** Host readiness uses the same renderer. Upload adapters reserve staging in
   * broker.pools directly and retain submitted tickets until GPU completion;
   * scope abort cannot free bytes still consumed by nonabortable work. */
  whenReady(texture: T, signal: AbortSignal): Promise<void>;
}
export interface LoadedWholeImage<T extends WholeImageTexture> {
  texture: T;
  estimate: ImageEstimate;
  /** Host calls after atomic visibility swap and outgoing-source disposal. */
  settleReplacement(): void;
  /** Ends this operation. Nonabortable retained work releases its charge on completion. */
  dispose(): void;
}
