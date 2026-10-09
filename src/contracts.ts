import type { ImageKind } from "./headers.js";
import type { ResourcePools } from "./pools.js";

/** Common records only. A representation owns its spatial fields and validator. */
export type ImageExtensions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export interface ImageIdentity { id: string; revision: string }
export interface ImageAttribution { text: string; license?: string; url?: string }
export interface ImageRepresentation {
  id: string;
  role: "preview" | "immersion";
  projection: string;
  mimeType: ImageKind;
  encodedBytes: number;
  extensions?: ImageExtensions;
}
export interface ImageAsset<R extends ImageRepresentation = ImageRepresentation> extends ImageIdentity {
  type: "panorama-image";
  colorSpace: "srgb";
  alpha: "opaque";
  attribution: ImageAttribution;
  representations: readonly R[];
  extensions?: ImageExtensions;
}
export interface ImageDiagnostic { path: string; message: string }
export interface ImageFile { url: string; mimeType: ImageKind; width: number; height: number }
/** Peak costs are bytes; staging/replacement are included in the corresponding pools. */
export interface ImageEstimate {
  encoded: number;
  decoded: number;
  sourceGpu: number;
  uploadOutstanding: number;
}
export type RepresentationValidation<R> =
  | { ok: true; representation: R; warnings: readonly ImageDiagnostic[] }
  | { ok: false; errors: readonly ImageDiagnostic[] };
export interface RepresentationHooks<R extends ImageRepresentation = ImageRepresentation> {
  readonly projection: string;
  validate(record: unknown, context: { path: string; baseUrl: string | null }): RepresentationValidation<R>;
  files(record: R): Iterable<ImageFile>;
  /** Owner's relative declared-field address for publication diagnostics. */
  filePath?(record: R, file: ImageFile, enumerationIndex: number): string;
  estimate(record: R, context: { maxTextureSide: number }): ImageEstimate;
}
/** Linear-light RGB. The caller applies source orientation once before sampling. */
export interface SourceSampler {
  sample(direction: readonly [number, number, number], footprintRadians: number, out: Float32Array | Float64Array | number[]): void;
}
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly colorSpace: "srgb";
  readonly alpha: "opaque";
  close(): void;
}
/** Passed by the host; implementations never create another full session budget. */
export interface ImageOperationContext {
  pools: ResourcePools;
  signal: AbortSignal;
  generation: number;
}

/** Explicit preparation policy supplied by the source adapter; target formats do not import it. */
export interface ImageSamplingPlan {
  source: SourceSampler;
  /** Supersampling grid, samples per axis, inherited from the prepared source. */
  samplesPerAxis: number;
  /** Angular sample footprint in radians. */
  footprintRadians: number;
}
