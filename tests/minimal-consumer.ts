import { createImageSessionBroker, createImageSourceCache, imageSourceKey, imageDimensionMismatch, ImageDimensionMismatch, type ImageAsset, type RepresentationHooks, type CachedImageSource, type ImageOperationScope } from "@foss-earth/images";
import { createCanvasRgbaSurface, readbackDecodedImage, ImageHttpStatusError, RgbaSurfaceCreationError, type HeldDecodedImage, type ImageFileService, type HeaderInferredImageFileService, type HeaderImageRequest, type RgbaReadbackOptions } from "@foss-earth/images/browser";

/** Old structural services are still valid without the optional extension. */
export function legacyImageService(obtain: ImageFileService["obtain"], decode: ImageFileService["decode"]): ImageFileService {
  return { obtain, decode };
}
export function inferReviewedMapFile(service: HeaderInferredImageFileService, request: HeaderImageRequest, scope: ImageOperationScope, priority: number) {
  return service.obtainInferred(request, 0, scope, undefined, priority);
}
export function readReviewedMapPixels(options: RgbaReadbackOptions) { return readbackDecodedImage(options); }
export function suppliedDocumentSurface(document: Document, width: number, height: number) {
  return createCanvasRgbaSurface({ width, height, createCanvas: () => document.createElement("canvas") });
}
export function retryFailedSurface(error: RgbaSurfaceCreationError): Promise<void> {
  error.retryCleanup(); return error.retired;
}
/** Missing-tile classification stays in Engine; common images reports status. */
export function statusOf(error: unknown): number | null { return error instanceof ImageHttpStatusError ? error.status : null; }
/** Engine may map this observation to missing; MIME/HTTP/decode errors return null. */
export function dimensionsOf(error: unknown): ImageDimensionMismatch | null { return imageDimensionMismatch(error); }
export function observedSizes(error: ImageDimensionMismatch): readonly [number, number, number, number] {
  return [error.actual.width, error.actual.height, error.expected.width, error.expected.height];
}

/** Acquire the new optional hold before nonabortable work, or take a legacy fallback. */
export async function useDecodedNativeInput(decoded: HeldDecodedImage, copy: (image: ImageBitmap) => Promise<void>): Promise<boolean> {
  if (!decoded.retain) return false;
  const release = decoded.retain();
  try { await copy(decoded.image); return true; }
  finally { release(); }
}

// A consumer registers its own spatial format; images has no catalogue dependency.
export function useImage(asset: ImageAsset, hooks: RepresentationHooks) {
  const broker = createImageSessionBroker({ pools: { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 20 }, requests: 1, decodes: 1 });
  const scope = broker.scope();
  const representation = asset.representations.find(record => record.projection === hooks.projection);
  if (representation) scope.reserve("decoded", hooks.estimate(representation, { maxTextureSide: 2048 }).decoded, asset.id);
  return () => broker.dispose();
}

export function shareSource<T extends CachedImageSource & { gpuBytes: number }>(asset: ImageAsset, representation: { id: string }, load: (scope: ImageOperationScope) => Promise<T>) {
  const broker = createImageSessionBroker({ pools: { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 20 }, requests: 1, decodes: 1 });
  const cache = createImageSourceCache<T>({ broker, keptGpuBytes: 40, gpuBytes: source => source.gpuBytes });
  return { source: cache.acquire(imageSourceKey(asset, representation), { priority: 1, load }), dispose() { cache.dispose(); broker.dispose(); } };
}
