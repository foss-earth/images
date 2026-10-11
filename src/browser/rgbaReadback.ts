import type { ImageOperationScope, ImageSessionBroker } from "../session.js";
import type { Reservation } from "../pools.js";
import type { HeldDecodedImage } from "./transport.js";

/** A fresh RGBA8 surface: no resizing, orientation, resampling or GPU upload. */
export interface RgbaReadbackSurface {
  /** Returns one independently allocated, exact-size RGBA array, without a copy. */
  read(image: ImageBitmap): Uint8ClampedArray | Promise<Uint8ClampedArray>;
  /** Idempotent. Called only after read settles, even after scope cancellation. */
  dispose(): void;
  /** Resolution proves backing storage retired. Rejection is not proof. */
  readonly retired?: Promise<void>;
}
/** A factory that allocated before failing must preserve its retirement proof. */
export class RgbaSurfaceCreationError extends AggregateError {
  readonly retired: Promise<void>;
  readonly retryCleanup: () => void;
  constructor(failures: readonly unknown[], retired: Promise<void>, retryCleanup: () => void) {
    super(failures, `RGBA surface creation failed: ${failures[0] instanceof Error ? failures[0].message : "allocation failed"}`);
    this.retired = retired; this.retryCleanup = retryCleanup;
    this.name = "RgbaSurfaceCreationError";
  }
}
export interface HeldRgbaImage {
  readonly width: number;
  readonly height: number;
  /** Remains readable through retained use; accessing after final close rejects. */
  readonly data: Uint8ClampedArray;
  /** Acquire before nonabortable native use; cannot retain a closing image. */
  retain(): () => void;
  /** Idempotent close request; scope invalidation requests it too. */
  close(): void;
}
export interface RgbaReadbackOptions {
  broker: ImageSessionBroker;
  scope: ImageOperationScope;
  /** Borrowed. This helper ends its hold, never closes the owner's image. */
  image: HeldDecodedImage;
  priority: number;
  label: string;
  /** Supplied realm; reserves canvas and output bytes before calling this port. */
  createSurface(width: number, height: number): RgbaReadbackSurface;
  /** Late retirement cleanup cannot reject an already completed readback. */
  onCleanupFailure?(error: unknown): void;
}

function attempt(action: () => void, failures: unknown[]): void {
  try { action(); } catch (error) { failures.push(error); }
}
function throwFailures(failures: unknown[]): never {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "Image RGBA readback and cleanup failed.");
}

/** Uses the existing decode queue and pool. Native work is never raced against abort. */
export async function readbackDecodedImage(options: RgbaReadbackOptions): Promise<HeldRgbaImage> {
  const { broker, scope, image } = options;
  const requireCurrent = (): void => {
    scope.signal.throwIfAborted();
    if (!scope.isCurrent()) throw new Error("Stale image RGBA readback.");
  };
  requireCurrent();
  const { width, height } = image.image;
  const bytes = 4 * width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(bytes)) throw new RangeError("RGBA readback requires positive whole dimensions and an exact byte count.");
  if (!image.retain) throw new Error("RGBA readback requires a reliable decoded native-input hold.");
  let canvas: Reservation | null = null, output: Reservation | null = null;
  let endCanvas: (() => void) | null = null, endOutput: (() => void) | null = null, endInput: (() => void) | null = null;
  let surface: RgbaReadbackSurface | null = null;
  let canvasRetirement: Promise<void> | undefined;
  let pixels: Uint8ClampedArray | null = null;
  const failures: unknown[] = [];
  const releaseOutput = (): void => {
    pixels = null;
    const held = endOutput; endOutput = null;
    if (held) attempt(held, failures);
    if (output) { const owned = output; output = null; attempt(() => owned.release(), failures); }
  };
  try {
    canvas = scope.reserve("decoded", bytes, `${options.label} RGBA canvas`);
    output = scope.reserve("decoded", bytes, `${options.label} RGBA output`);
    endCanvas = canvas.retain(); endOutput = output.retain();
    endInput = image.retain();
    pixels = await broker.decodes.run(options.priority, scope.signal, async () => {
      requireCurrent();
      surface = options.createSurface(width, height);
      requireCurrent();
      return await surface.read(image.image);
    });
    // Cross-realm typed arrays are valid. No wider backing allocation or alias
    // is accepted under this exact independent-output accounting contract.
    if (!ArrayBuffer.isView(pixels) || Object.prototype.toString.call(pixels) !== "[object Uint8ClampedArray]" || pixels.byteLength !== bytes || pixels.byteOffset !== 0 || pixels.buffer.byteLength !== bytes) throw new Error("RGBA readback did not return its admitted independent pixel allocation.");
    requireCurrent();
  } catch (error) {
    failures.push(error);
    if (error instanceof RgbaSurfaceCreationError) canvasRetirement = error.retired;
  }
  // A canvas still being read is never disposed early. All native work above
  // has settled before attempting its cleanup or releasing its retained grant.
  let uncertainCanvas = false;
  if (surface) {
    const owned = surface as RgbaReadbackSurface; surface = null;
    try { canvasRetirement = owned.retired; } catch (error) { failures.push(error); uncertainCanvas = true; }
    try { owned.dispose(); } catch (error) { failures.push(error); uncertainCanvas = true; }
  }
  const finishCanvas = (): void => {
    const retained = endCanvas; endCanvas = null;
    if (retained) attempt(retained, failures);
    if (canvas) { const owned = canvas; canvas = null; attempt(() => owned.release(), failures); }
  };
  if (canvasRetirement) {
    // A failed reset cannot turn still-allocated canvas pixels into free capacity.
    // The one retained grant survives cancellation and even broker disposal.
    void Promise.resolve(canvasRetirement).then(() => {
      const before = failures.length;
      finishCanvas();
      if (failures.length > before) {
        try { options.onCleanupFailure?.(new AggregateError(failures.slice(before), "Late canvas retirement cleanup failed.")); }
        catch (error) { failures.push(error); }
      }
    }, error => {
      try { options.onCleanupFailure?.(error); } catch (reportError) { failures.push(reportError); }
      // Rejected cleanup has no retirement proof; keep the native allocation charged.
    });
    // Give an already reported retirement its queued settlement before ending
    // the borrowed bitmap hold. Unresolved/rejected proof stays quarantined;
    // this never waits for unknown native retirement.
    await Promise.resolve();
  } else if (!uncertainCanvas) finishCanvas();
  // Foreign throwing disposal without a retirement port is conservatively charged.
  if (!failures.length) { try { requireCurrent(); } catch (error) { failures.push(error); } }
  // Late output cleanup precedes ending the decoded input's native hold.
  if (failures.length) releaseOutput();
  const retainedInput = endInput; endInput = null;
  if (retainedInput) attempt(retainedInput, failures);
  if (!failures.length) { try { requireCurrent(); } catch (error) { failures.push(error); } }
  if (failures.length) { releaseOutput(); throwFailures(failures); }

  let closing = false, closed = false, users = 0;
  const finish = (): void => {
    if (closed || !closing || users > 0) return;
    closed = true; releaseOutput();
    if (failures.length) throwFailures(failures);
  };
  const close = (): void => { closing = true; finish(); };
  const held: HeldRgbaImage = {
    width, height,
    get data() { if (closed || !pixels) throw new Error("The RGBA image is closed."); return pixels; },
    retain() {
      if (closing || closed) throw new Error("Cannot retain a closing RGBA image.");
      users += 1; let released = false;
      return () => { if (released) return; released = true; users -= 1; finish(); };
    },
    close,
  };
  try {
    if (!scope.adopt({ dispose: close })) { requireCurrent(); throw new Error("Stale image RGBA readback."); }
    requireCurrent(); return held;
  } catch (error) {
    const errors = [error]; attempt(close, errors); throwFailures(errors);
  }
}

export interface CanvasRgbaSurfaceOptions {
  width: number;
  height: number;
  /** Return a fresh canvas from the host's Document or OffscreenCanvas realm. */
  createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement;
}
/** Faithful drawImage/getImageData path; no ambient Document/constructor access. */
export function createCanvasRgbaSurface(options: CanvasRgbaSurfaceOptions): RgbaReadbackSurface {
  const canvas = options.createCanvas(options.width, options.height);
  let disposed = false, released = false;
  let resolveRetired!: () => void;
  const retired = new Promise<void>(resolve => { resolveRetired = resolve; });
  const dispose = (): void => {
    if (released) return;
    disposed = true;
    const failures: unknown[] = [];
    attempt(() => { canvas.width = 0; }, failures);
    attempt(() => { canvas.height = 0; }, failures);
    attempt(() => {
      if (canvas.width === 0 || canvas.height === 0) { released = true; resolveRetired(); }
      else if (!failures.length) failures.push(new Error("RGBA canvas storage did not retire after reset."));
    }, failures);
    if (failures.length) throwFailures(failures);
  };
  try {
    canvas.width = options.width; canvas.height = options.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error("A 2D canvas is not available to read image RGBA pixels.");
    return {
      retired,
      read(image) {
        if (disposed) throw new Error("The RGBA readback surface is disposed.");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, options.width, options.height).data;
      },
      dispose,
    };
  } catch (error) {
    const failures = [error]; attempt(dispose, failures);
    throw new RgbaSurfaceCreationError(failures, retired, dispose);
  }
}
