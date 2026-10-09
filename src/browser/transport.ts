import type { ImageOperationScope, ImageSessionBroker } from "../session.js";
import { imageHeaderError, readImageHeader, ImageDimensionMismatch, type ImageKind } from "../headers.js";
import { ResourceCapacityError } from "../pools.js";

export interface ImageTransferLimits { responseBytes: number; timeoutMs: number }
export interface EncodedImageFile {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  /** Common transfers implement it. A foreign source without this gets a separate active-decode input charge. */
  retain?(): () => void;
  release(): void;
}
/** Transport status only; representation owners decide missing versus retry. */
export class ImageHttpStatusError extends Error {
  constructor(readonly url: string, readonly status: number, options?: ErrorOptions) {
    super(`${url} answered ${status}`, options); this.name = "ImageHttpStatusError";
  }
}
/** Bounded common transfer; representation owners supply URLs and declared sizes. */
export async function fetchImageFile(options: {
  url: string; declaredBytes: number; priority: number;
  broker: ImageSessionBroker; scope: ImageOperationScope;
  limits: ImageTransferLimits; fetch: typeof fetch;
  receivedChunk?: (bytes: number) => void;
}): Promise<EncodedImageFile> {
  const { broker, scope, limits } = options;
  if (!Number.isSafeInteger(limits.responseBytes) || limits.responseBytes < 0 || !Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 0) throw new Error("Transfer limits must be nonnegative bytes and milliseconds.");
  const reserved = scope.reserve("encoded", options.declaredBytes, options.url);
  try {
    return await broker.requests.run(options.priority, scope.signal, async () => {
      // Fetch/reader cancellation is asynchronous (and injected readers may
      // be nonabortable). Keep active chunks charged until work has ended.
      const finishRead = reserved.retain();
      try {
        const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(Math.ceil(limits.timeoutMs))]);
        const response = await options.fetch(options.url, { credentials: "omit", mode: "cors", signal });
        // 204 is successful HTTP but has no image. End even an injected status
        // body before reporting it; preserve the typed status if cancel throws.
        if (!response.ok || response.status === 204) {
          let cleanup: unknown;
          try { await response.body?.cancel(); } catch (error) { cleanup = error; }
          scope.signal.throwIfAborted();
          throw new ImageHttpStatusError(options.url, response.status, cleanup === undefined ? undefined : { cause: cleanup });
        }
        const announced = Number(response.headers.get("content-length"));
        if (Number.isFinite(announced) && announced > limits.responseBytes) {
          await response.body?.cancel();
          throw new Error(`${options.url} exceeds the ${limits.responseBytes}-byte response limit.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error(`${options.url} has no body.`);
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            received += value.byteLength;
            if (received > limits.responseBytes) throw new Error(`${options.url} exceeds the ${limits.responseBytes}-byte response limit.`);
            if (received > reserved.bytes && !reserved.resize(received)) throw new Error(`${options.url} exceeds the shared encoded-bytes budget.`);
            chunks.push(value);
            options.receivedChunk?.(value.byteLength);
          }
          scope.signal.throwIfAborted();
          // The new contiguous body and old chunks coexist while copying. Charge both.
          const staging = scope.reserve("encoded", received, `${options.url} body assembly`);
          try {
            const bytes = new Uint8Array(received);
            let at = 0;
            for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
            chunks.length = 0;
            reserved.resize(received);
            return { bytes, contentType: response.headers.get("content-type"), retain: () => reserved.retain(), release: () => reserved.release() };
          } finally { staging.release(); }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
      } finally { finishRead(); }
    });
  } catch (error) { reserved.release(); throw error; }
}

export interface HeldDecodedImage {
  readonly image: ImageBitmap;
  /**
   * Optional for legacy supplied decoders. The common decoder implements it:
   * retain a live bitmap and its existing decoded charge through nonabortable
   * native input use. Acquire before starting that work; release only after
   * the work and late-output cleanup end. Cannot acquire after close begins.
   */
  retain?(): () => void;
  /** Idempotent close request; actual bitmap close waits for retained input users. */
  close(): void;
}
/** Capacity/cancellation refusals must not cause an intact cached file to be evicted. */
export class ImageDecodeFailure extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.name = "ImageDecodeFailure"; }
}
/** Header-based allocation and one decode queue, without spatial or GPU initialization. */
export async function decodeImageFile(options: {
  file: EncodedImageFile;
  declared: { mimeType: ImageKind; width: number; height: number };
  priority: number; broker: ImageSessionBroker; scope: ImageOperationScope;
  decode: (bytes: Uint8Array, mimeType: ImageKind) => Promise<ImageBitmap>;
}): Promise<HeldDecodedImage> {
  const { file, declared, scope, broker } = options;
  const problem = imageHeaderError(readImageHeader(file.bytes), declared, file.contentType);
  if (problem) throw problem;
  const reservation = scope.reserve("decoded", 4 * declared.width * declared.height, "decoded image");
  const pixelHold: { release: (() => void) | null } = { release: null };
  try {
    const image = await broker.decodes.run(options.priority, scope.signal, async () => {
      // Browser decode is not abortable. Both its input bytes and prospective
      // pixel allocation remain charged until it returns and a late result closes.
      pixelHold.release = reservation.retain();
      let releaseInput = file.retain?.();
      if (!releaseInput) {
        const input = broker.pools.reserve("encoded", file.bytes.byteLength, "foreign decode input");
        if (!input.ok) throw new ResourceCapacityError(input.pool, input.reason);
        releaseInput = () => input.reservation.release();
      }
      try { return await options.decode(file.bytes, declared.mimeType); }
      catch (error) { throw new ImageDecodeFailure(error); }
      finally { releaseInput(); }
    });
    if (image.width !== declared.width || image.height !== declared.height) {
      const dimension = new ImageDimensionMismatch(image, declared, "decoded");
      const mismatch = new ImageDecodeFailure(dimension);
      try { image.close(); }
      catch (cleanup) { throw new ImageDecodeFailure(new AggregateError([dimension, cleanup], "Decoded image dimensions and cleanup failed.")); }
      throw mismatch;
    }
    let closed = false, closing = false, inputUsers = 0;
    const finishClose = (): void => {
      if (closed || !closing || inputUsers > 0) return;
      closed = true;
      // The original reservation's retained charge survives owner release.
      // Even a throwing bitmap disposer must end it, after attempting close.
      try { image.close(); }
      finally { pixelHold.release?.(); pixelHold.release = null; reservation.release(); }
    };
    const close = (): void => { closing = true; finishClose(); };
    const retain = (): (() => void) => {
      if (closing || closed) throw new Error("Cannot retain a closing decoded image.");
      inputUsers += 1;
      let released = false;
      return () => { if (released) return; released = true; inputUsers -= 1; finishClose(); };
    };
    if (!scope.adopt({ dispose: close })) { scope.signal.throwIfAborted(); throw new Error("Stale image decode."); }
    return { image, retain, close };
  } catch (error) { pixelHold.release?.(); pixelHold.release = null; reservation.release(); throw error; }
}
