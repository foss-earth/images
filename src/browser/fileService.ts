import { imageHeaderError, readImageHeader, type ImageHeader } from "../headers.js";
import type { ImageFile } from "../contracts.js";
import type { SavedFiles } from "../mediaStore.js";
import type { ImageOperationScope, ImageSessionBroker } from "../session.js";
import { createOperationLimiter } from "../session.js";
import type { Reservation } from "../pools.js";
import { fetchImageFile, decodeImageFile, ImageDecodeFailure, type EncodedImageFile, type HeldDecodedImage, type ImageTransferLimits } from "./transport.js";

export interface CachedEncodedImageFile extends EncodedImageFile { readonly fromCache: boolean }
/** Reviewed source dimensions are required; only the MIME may come from bytes. */
export interface HeaderImageRequest extends Omit<ImageFile, "mimeType"> { mimeType?: ImageFile["mimeType"] }
export interface InferredImageFile {
  readonly file: ImageFile;
  readonly header: ImageHeader;
  readonly body: CachedEncodedImageFile;
}
export interface ImageFileService {
  obtain(file: ImageFile, declaredBytes: number, scope: ImageOperationScope, receivedChunk?: (bytes: number) => void, priority?: number): Promise<CachedEncodedImageFile>;
  decode(file: EncodedImageFile, declared: ImageFile, scope: ImageOperationScope, priority?: number): Promise<HeldDecodedImage>;
  /** Optional extension keeps existing structural service implementations valid. */
  obtainInferred?(file: HeaderImageRequest, declaredBytes: number, scope: ImageOperationScope, receivedChunk?: (bytes: number) => void, priority?: number): Promise<InferredImageFile>;
}
export interface HeaderInferredImageFileService extends ImageFileService {
  obtainInferred(file: HeaderImageRequest, declaredBytes: number, scope: ImageOperationScope, receivedChunk?: (bytes: number) => void, priority?: number): Promise<InferredImageFile>;
}
/** Shared cache/transport/header/decode path; groups and resource policy are supplied. */
export function createImageFileService(options: {
  broker: ImageSessionBroker;
  limits(): ImageTransferLimits;
  priority(): number;
  fetch: typeof fetch;
  decode(bytes: Uint8Array, mimeType: ImageFile["mimeType"]): Promise<ImageBitmap>;
  cache?: { files: SavedFiles; settled(): Promise<void> } | null;
}): HeaderInferredImageFileService {
  const cache = options.cache ?? null;
  const files = new WeakMap<EncodedImageFile, { url: string; kept: boolean }>();
  // IDB returns a complete cloned body, unlike the growing network stream.
  // Serialize bounded reads before allocation; six cube faces do not each
  // reserve the full response cap concurrently and falsely refuse one another.
  const cacheReads = createOperationLimiter(() => 1);
  const save = (file: ImageFile, body: EncodedImageFile): void => {
    if (!cache) return;
    // MediaStore retains the input view; the backend's Blob/native snapshot is
    // a separate copy. Charge both until persistence settles, including abort.
    const granted = options.broker.pools.reserve("encoded", body.bytes.byteLength, `${file.url} cache write`);
    if (!granted.ok) return; // Disk retention is optional; pixels still load.
    let releaseInput: () => void;
    try {
      if (body.retain) releaseInput = body.retain();
      else {
        const input = options.broker.pools.reserve("encoded", body.bytes.byteLength, `${file.url} retained cache input`);
        if (!input.ok) { granted.reservation.release(); return; }
        releaseInput = () => input.reservation.release();
      }
    } catch { granted.reservation.release(); return; }
    const finish = (): void => { try { releaseInput(); } finally { granted.reservation.release(); } };
    try { cache.files.put(file.url, body.bytes, body.contentType); }
    catch { finish(); return; }
    void Promise.resolve().then(() => cache.settled()).then(finish, finish);
  };
  function inspect(request: HeaderImageRequest, bytes: Uint8Array, contentType: string | null): { file: ImageFile; header: ImageHeader } | Error {
    const header = readImageHeader(bytes);
    if (!header) return new Error(`is not a readable JPEG or PNG${request.mimeType ? ` (declared ${request.mimeType})` : ""}`);
    const file: ImageFile = { url: request.url, width: request.width, height: request.height, mimeType: request.mimeType ?? header.kind };
    const problem = imageHeaderError(header, file, contentType);
    return problem ?? { file, header: header! };
  }
  async function obtain(request: HeaderImageRequest, declaredBytes: number, scope: ImageOperationScope, receivedChunk: ((bytes: number) => void) | undefined, priority: number): Promise<InferredImageFile> {
      const limits = options.limits();
      scope.signal.throwIfAborted();
      if (cache?.files.getBounded) {
        const cached = await cacheReads.run(priority, scope.signal, async (): Promise<InferredImageFile | null> => {
        let read: Reservation | null = null;
        let finishRead: (() => void) | null = null;
        try {
          const kept = await cache.files.getBounded!(request.url, { maxBytes: limits.responseBytes, admit(byteLength) {
            scope.signal.throwIfAborted();
            if (read || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limits.responseBytes || !options.broker.pools.fits("encoded", byteLength)) return false;
            read = scope.reserve("encoded", byteLength, `${request.url} cache read`); finishRead = read.retain();
            return true;
          } });
          scope.signal.throwIfAborted();
          const reservation = read as Reservation | null;
          if (kept && reservation) {
            // The bounded backend guarantees the same immutable body as admitted.
            if (kept.bytes.byteLength > reservation.bytes) throw new Error("Saved-file backend exceeded its admitted byte bound.");
            const checked = kept.bytes.byteLength > limits.responseBytes ? new Error("Saved image exceeds the response-byte limit.") : inspect(request, kept.bytes, kept.contentType);
            if (checked instanceof Error) cache.files.forget(request.url);
            else {
              reservation.resize(kept.bytes.byteLength);
              const body: CachedEncodedImageFile = { ...kept, fromCache: true, retain: () => reservation.retain(), release: () => reservation.release() };
              files.set(body, { url: request.url, kept: true });
              return { ...checked, body };
            }
          }
        } catch (error) { (read as Reservation | null)?.release(); throw error; }
        finally { (finishRead as (() => void) | null)?.(); }
        (read as Reservation | null)?.release();
        return null;
        });
        if (cached) return cached;
      }
      const fetched = await fetchImageFile({ url: request.url, declaredBytes, priority, broker: options.broker, scope, limits, fetch: options.fetch, receivedChunk });
      try {
        scope.signal.throwIfAborted();
        const checked = inspect(request, fetched.bytes, fetched.contentType);
        if (checked instanceof Error) throw checked;
        const body: CachedEncodedImageFile = { ...fetched, fromCache: false };
        files.set(body, { url: request.url, kept: false });
        save(checked.file, body); scope.signal.throwIfAborted();
        return { ...checked, body };
      } catch (error) { fetched.release(); throw error; }
  }
  return {
    async obtain(file, declaredBytes, scope, receivedChunk, priority = options.priority()) {
      return (await obtain(file, declaredBytes, scope, receivedChunk, priority)).body;
    },
    async obtainInferred(file, declaredBytes, scope, receivedChunk, priority = options.priority()) {
      if (!Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height) || file.width < 1 || file.height < 1 || !Number.isSafeInteger(4 * file.width * file.height)) throw new RangeError("Inferred image acquisition requires reviewed positive whole dimensions.");
      return obtain(file, declaredBytes, scope, receivedChunk, priority);
    },
    async decode(file, declared, scope, priority = options.priority()) {
      try { return await decodeImageFile({ file, declared, priority, broker: options.broker, scope, decode: options.decode }); }
      catch (error) {
        const origin = files.get(file);
        if (origin?.kept && scope.isCurrent() && error instanceof ImageDecodeFailure) cache?.files.forget(origin.url);
        throw error;
      }
    },
  };
}
