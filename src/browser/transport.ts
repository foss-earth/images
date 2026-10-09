import type { ImageOperationScope, ImageSessionBroker } from "../session.js";
import { checkImage, type ImageKind } from "../headers.js";

export interface ImageTransferLimits { responseBytes: number; timeoutMs: number }
export interface EncodedImageFile {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  release(): void;
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
      const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(Math.ceil(limits.timeoutMs))]);
      const response = await options.fetch(options.url, { credentials: "omit", mode: "cors", signal });
      if (!response.ok) throw new Error(`${options.url} answered ${response.status}`);
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
          return { bytes, contentType: response.headers.get("content-type"), release: () => reserved.release() };
        } finally { staging.release(); }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    });
  } catch (error) { reserved.release(); throw error; }
}

export interface HeldDecodedImage { readonly image: ImageBitmap; close(): void }
/** Header-based allocation and one decode queue, without spatial or GPU initialization. */
export async function decodeImageFile(options: {
  file: EncodedImageFile;
  declared: { mimeType: ImageKind; width: number; height: number };
  priority: number; broker: ImageSessionBroker; scope: ImageOperationScope;
  decode: (bytes: Uint8Array, mimeType: ImageKind) => Promise<ImageBitmap>;
}): Promise<HeldDecodedImage> {
  const { file, declared, scope, broker } = options;
  const problem = checkImage(file.bytes, declared, file.contentType);
  if (problem) throw new Error(problem);
  const reservation = scope.reserve("decoded", 4 * declared.width * declared.height, "decoded image");
  try {
    const image = await broker.decodes.run(options.priority, scope.signal, () => options.decode(file.bytes, declared.mimeType));
    let closed = false;
    const close = (): void => { if (closed) return; closed = true; try { image.close(); } finally { reservation.release(); } };
    if (!scope.adopt({ dispose: close })) { scope.signal.throwIfAborted(); throw new Error("Stale image decode."); }
    return { image, close };
  } catch (error) { reservation.release(); throw error; }
}
