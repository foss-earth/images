import type { ImageEstimate, ImageFile } from "../index.js";
import type { EncodedImageFile, HeldDecodedImage } from "./transport.js";
import type { LoadedWholeImage, WholeImagePorts, WholeImageTexture } from "./loadPorts.js";

/** One representation's single file, its costs and its upload into the host's renderer. */
export interface WholeImageLoad<T extends WholeImageTexture> {
  file: ImageFile;
  /** Declared total encoded bytes; 0 when the size is unknown. */
  encodedBytes: number;
  /** Called inside the load, so a refusal still ends the scope. */
  estimate(): ImageEstimate;
  /**
   * Settles only after the supplied uploader has stopped reading the bitmap.
   * The common decoder's retain holds pixels through settlement and stale-output
   * cleanup; a decoder without retain keeps its own, unqualified lifetime.
   */
  upload(image: ImageBitmap, label: string): Promise<T>;
  label: string;
  /** Names the representation in errors, such as "rectangle image". */
  kind: string;
}

/**
 * Reserves the source's GPU bytes, then reads, decodes and uploads one image
 * file through the host's services. A stale or cancelled load releases what it
 * holds, including a texture that arrives late, and reports every failure.
 */
export async function loadWholeImage<T extends WholeImageTexture>(load: WholeImageLoad<T>, ports: WholeImagePorts<T>): Promise<LoadedWholeImage<T>> {
  const { scope } = ports;
  let encoded: EncodedImageFile | undefined;
  let decoded: HeldDecodedImage | undefined;
  let releaseInput: (() => void) | undefined;
  let unownedTexture: T | undefined;
  let loaded: LoadedWholeImage<T> | undefined;
  const failures: unknown[] = [];
  const outputFailures: unknown[] = [];
  const inputFailures: unknown[] = [];
  function requireCurrent(): void {
    scope.signal.throwIfAborted();
    if (!scope.isCurrent()) throw new Error(`Stale ${load.kind} upload.`);
  }
  function endOutput(): void {
    const texture = unownedTexture; unownedTexture = undefined;
    try { texture?.dispose(); } catch (cleanup) { outputFailures.push(cleanup); }
    try { scope.dispose(); } catch (cleanup) { outputFailures.push(cleanup); }
  }
  try {
    requireCurrent();
    const estimate = load.estimate();
    const gpu = scope.reserve("sourceGpu", estimate.sourceGpu, load.label, { overlap: ports.overlap });
    encoded = await ports.obtain(load.file, load.encodedBytes);
    requireCurrent();
    decoded = await ports.decode(encoded, load.file);
    requireCurrent();
    const body = encoded;
    encoded = undefined;
    body.release();
    requireCurrent();
    // Acquire before invoking the host: it can synchronously end the scope or
    // enqueue work that still reads pixels after cancellation.
    releaseInput = decoded.retain?.();
    requireCurrent();
    unownedTexture = await load.upload(decoded.image, load.label);
    requireCurrent();
    const texture = unownedTexture; unownedTexture = undefined;
    if (!scope.adopt(texture)) { scope.signal.throwIfAborted(); throw new Error(`Stale ${load.kind} upload.`); }
    await ports.whenReady(texture, scope.signal);
    requireCurrent();
    loaded = { texture, estimate, settleReplacement: () => gpu.settle(), dispose: () => scope.dispose() };
  } catch (error) { failures.push(error); }
  if (failures.length) endOutput();
  try { encoded?.release(); } catch (cleanup) { inputFailures.push(cleanup); }
  try { decoded?.close(); } catch (cleanup) { inputFailures.push(cleanup); }
  // A stale texture disposer has already run while its native input was held.
  try { releaseInput?.(); } catch (cleanup) { inputFailures.push(cleanup); }
  if (!failures.length && !inputFailures.length) {
    try { requireCurrent(); } catch (error) { failures.push(error); }
  }
  if (failures.length || inputFailures.length) endOutput();
  const errors = [...failures, ...outputFailures, ...inputFailures];
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, `${load.kind[0].toUpperCase()}${load.kind.slice(1)} loading and cleanup failed.`);
  return loaded!;
}
