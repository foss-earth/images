import type { ImageKind } from "./headers.js";
import type { ResourcePools } from "./pools.js";

/** Common records only. A representation owns its spatial fields and validator. */
export type ImageExtensions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export interface ImageIdentity { id: string; revision: string }
export interface ImageAttribution { text: string; license?: string; url?: string }
/**
 * What a representation is for. Spheres have a `preview` and an `immersion`
 * representation; a rectangle photograph has one primary `image` representation.
 */
export type ImageRepresentationRole = "preview" | "immersion" | "image";
/** The roles a sphere representation may have. Sphere validators accept only these. */
export type SphereRepresentationRole = Extract<ImageRepresentationRole, "preview" | "immersion">;
export const SPHERE_REPRESENTATION_ROLES: readonly SphereRepresentationRole[] = Object.freeze(["preview", "immersion"]);
/** The common fields of any representation, spherical or rectangle. */
export interface ImageRepresentationRecord<Role extends ImageRepresentationRole = ImageRepresentationRole> {
  id: string;
  role: Role;
  projection: string;
  mimeType: ImageKind;
  encodedBytes: number;
  extensions?: ImageExtensions;
}
/** A sphere representation, the record the sphere owners extend. */
export type ImageRepresentation = ImageRepresentationRecord<SphereRepresentationRole>;
export interface ImageAsset<R extends ImageRepresentation = ImageRepresentation> extends ImageIdentity {
  type: "panorama-image";
  colorSpace: "srgb";
  alpha: "opaque";
  attribution: ImageAttribution;
  representations: readonly R[];
  extensions?: ImageExtensions;
}
/** A rectangle photograph's primary representation; `@foss-earth/rectangle-image` owns its fields and validator. */
export type RectangleRepresentationRecord = ImageRepresentationRecord<"image"> & { projection: "rectangle" };
/**
 * A rectangle photograph: one `image` representation in pixels of its own plane.
 * Its validator lives with the rectangle representation, not with sphere assets,
 * which keep requiring a cube preview.
 */
export interface RectangleImageAsset<R extends RectangleRepresentationRecord = RectangleRepresentationRecord> extends ImageIdentity {
  type: "rectangle-image";
  colorSpace: "srgb";
  alpha: "opaque";
  attribution?: ImageAttribution;
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
export interface RepresentationHooks<R extends ImageRepresentationRecord = ImageRepresentation> {
  readonly projection: string;
  validate(record: unknown, context: { path: string; baseUrl: string | null }): RepresentationValidation<R>;
  files(record: R): Iterable<ImageFile>;
  /** Owner's relative declared-field address for publication diagnostics. */
  filePath?(record: R, file: ImageFile, enumerationIndex: number): string;
  estimate(record: R, context: { maxTextureSide: number }): ImageEstimate;
}
/**
 * Linear-light RGB by direction, for spherical preparation. The caller applies
 * source orientation once before sampling. A rectangle image samples by plane
 * position through its own representation; it does not use this.
 */
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
