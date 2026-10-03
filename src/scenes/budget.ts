/**
 * Byte accounting for panoramas (§4): exact RGBA8 mip-chain sizes, independent
 * reservation pools, and the choice of a whole representation that fits.
 * Every pool is a user parameter (`scene.panorama.*MiB`); nothing here
 * decides a size.
 */
import type { ResolvedRepresentation, ResolvedTiledCube } from "./format";

export const MIB = 1024 * 1024;
/** RGBA8: four bytes a texel. */
const BYTES_PER_TEXEL = 4;
const CUBE_LAYERS = 6;

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/** Exact bytes of an RGBA8 chain: 4 × Σ W_l × H_l over the allocated levels, per layer. */
export function rgba8Bytes(width: number, height: number, levels = mipLevelCount(width, height), layers = 1): number {
  let texels = 0;
  for (let level = 0; level < levels; level++) texels += Math.max(1, width >> level) * Math.max(1, height >> level);
  return BYTES_PER_TEXEL * texels * layers;
}

/**
 * Where a tiled cube's tiles go: one atlas of `slots` stored tiles,
 * `perRow` to a row, as many as `memoryBytes` holds within the device's
 * largest texture side. Slot columns and rows are bytes in the display
 * table, so neither passes 255. Null when not even one tile fits.
 */
export interface TileAtlasLayout {
  stored: number;
  slots: number;
  perRow: number;
  width: number;
  height: number;
  /** Exact bytes: the atlas, without mips, and the display table. */
  gpuBytes: number;
}

/** Slot columns and rows are table bytes. */
const MOST_SLOTS_A_SIDE = 255;

export function tileAtlasLayout(representation: Pick<ResolvedTiledCube, "tileSize" | "gutter" | "faceSize">, memoryBytes: number, maxTextureSide = Number.POSITIVE_INFINITY): TileAtlasLayout | null {
  const stored = representation.tileSize + 2 * representation.gutter;
  const tileBytes = BYTES_PER_TEXEL * stored * stored;
  const aSide = Math.min(MOST_SLOTS_A_SIDE, Math.floor(maxTextureSide / stored));
  const wanted = Math.floor(memoryBytes / tileBytes);
  if (aSide < 1 || wanted < 1) return null;
  const perRow = Math.min(aSide, Math.ceil(Math.sqrt(wanted)));
  const rows = Math.min(aSide, Math.ceil(wanted / perRow));
  const slots = Math.min(wanted, perRow * rows);
  const cells = representation.faceSize / representation.tileSize;
  const tableBytes = BYTES_PER_TEXEL * 6 * cells * 2 * cells;
  return { stored, slots, perRow, width: perRow * stored, height: rows * stored, gpuBytes: BYTES_PER_TEXEL * perRow * stored * rows * stored + tableBytes };
}

/** A tiled cube's tile count: 6 · Σ 4^level. */
export function tiledCubeTileCount(representation: Pick<ResolvedTiledCube, "levelBytes">): number {
  return 6 * representation.levelBytes.reduce((sum, _bytes, level) => sum + 4 ** level, 0);
}

/**
 * GPU bytes a representation needs once uploaded with its full mip chain; for
 * a tiled cube, the atlas `tileMemoryBytes` lays out, which holds part of it.
 */
export function representationGpuBytes(representation: ResolvedRepresentation, tileMemoryBytes = 0, maxTextureSide = Number.POSITIVE_INFINITY): number {
  if (representation.projection === "tiled-cube") return tileAtlasLayout(representation, tileMemoryBytes, maxTextureSide)?.gpuBytes ?? 0;
  return representation.projection === "cube"
    ? rgba8Bytes(representation.faceSize, representation.faceSize, undefined, CUBE_LAYERS)
    : rgba8Bytes(representation.width, representation.height);
}

/** Decoded bytes one image of the representation holds at once: a face, the whole image, or a stored tile. */
export function representationDecodedBytes(representation: ResolvedRepresentation): number {
  if (representation.projection === "tiled-cube") return BYTES_PER_TEXEL * (representation.tileSize + 2 * representation.gutter) ** 2;
  return representation.projection === "cube"
    ? BYTES_PER_TEXEL * representation.faceSize * representation.faceSize
    : BYTES_PER_TEXEL * representation.width * representation.height;
}

/** Its largest texture side, checked against the device's limits before any decode; a tile for a tiled cube. */
export function representationMaxSide(representation: ResolvedRepresentation): number {
  if (representation.projection === "tiled-cube") return representation.tileSize + 2 * representation.gutter;
  return representation.projection === "cube" ? representation.faceSize : representation.width;
}

/** The texels a representation puts across a cube face's width, the density scale every projection shares. */
export function representationFaceTexels(representation: ResolvedRepresentation): number {
  // A face spans 90° of the 360° an equirectangular row covers.
  return representation.projection === "equirectangular" ? representation.width / 4 : representation.faceSize;
}

/** Pixels around the whole turn: an equirectangular image's width, or four cube faces. */
export function representationAroundPx(representation: ResolvedRepresentation): number {
  return 4 * representationFaceTexels(representation);
}

// ─── Pools ──────────────────────────────────────────────────────────────

export type PoolName = "sourceGpu" | "decoded" | "encoded" | "uploadOutstanding";
export const POOL_NAMES: readonly PoolName[] = ["sourceGpu", "decoded", "encoded", "uploadOutstanding"];

export interface PoolLimits {
  sourceGpu: number;
  decoded: number;
  encoded: number;
  uploadOutstanding: number;
  /** Source bytes that may coexist during a replacement: a subset cap inside sourceGpu, never extra room. */
  overlap: number;
}

export interface Reservation {
  readonly pool: PoolName;
  readonly bytes: number;
  readonly label: string;
  /** Counted against the overlap cap too, until `settle` or release. */
  readonly overlap: boolean;
  readonly released: boolean;
  /** Grows or shrinks in place, if the pool allows it; a streamed body grows as it arrives. */
  resize(bytes: number): boolean;
  /** The outgoing source is gone: stop counting this against the overlap cap. */
  settle(): void;
  /** Idempotent. */
  release(): void;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; pool: PoolName | "overlap"; reason: string };

export interface PoolStats {
  limit: number;
  reserved: number;
  peak: number;
  reservations: number;
}

export interface ResourcePools {
  reserve(pool: PoolName, bytes: number, label: string, options?: { overlap?: boolean }): ReserveResult;
  /** Whether `bytes` more would fit now, overlap included when asked. */
  fits(pool: PoolName, bytes: number, options?: { overlap?: boolean }): boolean;
  stats(): Record<PoolName | "overlap", PoolStats>;
  limits(): PoolLimits;
  /** New limits apply to the next reservation; returns the pools now over theirs. */
  setLimits(limits: PoolLimits): (PoolName | "overlap")[];
  /** Live reservations, for tests and the readings. */
  live(): readonly Reservation[];
}

function format(bytes: number): string {
  return `${(bytes / MIB).toFixed(bytes >= 10 * MIB ? 0 : 1)} MiB`;
}

export function createResourcePools(initial: PoolLimits): ResourcePools {
  let limits = { ...initial };
  const reserved: Record<PoolName, number> = { sourceGpu: 0, decoded: 0, encoded: 0, uploadOutstanding: 0 };
  const peak: Record<PoolName | "overlap", number> = { sourceGpu: 0, decoded: 0, encoded: 0, uploadOutstanding: 0, overlap: 0 };
  let overlapReserved = 0;
  const live = new Set<Reservation>();

  const fits = (pool: PoolName, bytes: number, overlap = false): { ok: true } | { ok: false; pool: PoolName | "overlap"; reason: string } => {
    if (reserved[pool] + bytes > limits[pool]) {
      return { ok: false, pool, reason: `${format(bytes)} more would pass the ${format(limits[pool])} ${pool} limit, with ${format(reserved[pool])} reserved` };
    }
    if (overlap && pool === "sourceGpu" && overlapReserved + bytes > limits.overlap) {
      return { ok: false, pool: "overlap", reason: `${format(bytes)} of replacement would pass the ${format(limits.overlap)} overlap limit, with ${format(overlapReserved)} coexisting` };
    }
    return { ok: true };
  };

  const notePeak = (pool: PoolName): void => {
    peak[pool] = Math.max(peak[pool], reserved[pool]);
    peak.overlap = Math.max(peak.overlap, overlapReserved);
  };

  return {
    reserve(pool, bytes, label, options = {}) {
      if (!(bytes >= 0) || !Number.isFinite(bytes)) return { ok: false, pool, reason: `${label}: ${bytes} is not a byte count` };
      const overlap = options.overlap === true && pool === "sourceGpu";
      const check = fits(pool, bytes, overlap);
      if (!check.ok) return { ok: false, pool: check.pool, reason: `${label}: ${check.reason}` };
      reserved[pool] += bytes;
      if (overlap) overlapReserved += bytes;
      notePeak(pool);
      let current = bytes;
      let counted = overlap;
      let released = false;
      const reservation: Reservation = {
        pool,
        label,
        get bytes() { return current; },
        get overlap() { return counted; },
        get released() { return released; },
        resize(next) {
          if (released || !(next >= 0) || !Number.isFinite(next)) return false;
          const delta = next - current;
          if (delta > 0 && !fits(pool, delta, counted).ok) return false;
          reserved[pool] += delta;
          if (counted) overlapReserved += delta;
          current = next;
          notePeak(pool);
          return true;
        },
        settle() {
          if (released || !counted) return;
          counted = false;
          overlapReserved -= current;
        },
        release() {
          if (released) return;
          released = true;
          reserved[pool] -= current;
          if (counted) overlapReserved -= current;
          counted = false;
          live.delete(reservation);
        },
      };
      live.add(reservation);
      return { ok: true, reservation };
    },
    fits(pool, bytes, options = {}) {
      return fits(pool, bytes, options.overlap === true).ok;
    },
    stats() {
      const out = {} as Record<PoolName | "overlap", PoolStats>;
      for (const pool of ["sourceGpu", "decoded", "encoded", "uploadOutstanding"] as const) {
        out[pool] = { limit: limits[pool], reserved: reserved[pool], peak: peak[pool], reservations: [...live].filter(entry => entry.pool === pool).length };
      }
      out.overlap = { limit: limits.overlap, reserved: overlapReserved, peak: peak.overlap, reservations: [...live].filter(entry => entry.overlap).length };
      return out;
    },
    limits: () => ({ ...limits }),
    setLimits(next) {
      limits = { ...next };
      const over: (PoolName | "overlap")[] = (["sourceGpu", "decoded", "encoded", "uploadOutstanding"] as const).filter(pool => reserved[pool] > limits[pool]);
      if (overlapReserved > limits.overlap) over.push("overlap");
      return over;
    },
    live: () => [...live],
  };
}

// ─── Choosing a representation ─────────────────────────────────────────

export interface RepresentationChoice {
  representation: ResolvedRepresentation;
  /** Why it is not the one the requested density asked for, or null when it is. */
  limitation: string | null;
  /** The next larger representation, which was refused, and why; null when none is larger or the density is met. */
  next: { representation: ResolvedRepresentation; reason: string } | null;
}

/**
 * The smallest whole representation of `role` whose face density meets
 * `wantedFaceTexels`, among those `admissible` allows (device limits, the
 * dimensional cap, every reservation). Otherwise the largest admissible one
 * below it, with the reason; null when none is admissible.
 */
export function chooseRepresentation(
  representations: readonly ResolvedRepresentation[],
  role: ResolvedRepresentation["role"] | "any",
  wantedFaceTexels: number,
  admissible: (representation: ResolvedRepresentation) => string | null,
): RepresentationChoice | null {
  const candidates = representations
    .filter(entry => role === "any" || entry.role === role)
    .sort((a, b) => representationFaceTexels(a) - representationFaceTexels(b) || representationGpuBytes(a) - representationGpuBytes(b));
  const refusals: { representation: ResolvedRepresentation; reason: string }[] = [];
  let best: ResolvedRepresentation | null = null;
  for (const candidate of candidates) {
    const refusal = admissible(candidate);
    if (refusal) {
      refusals.push({ representation: candidate, reason: refusal });
      if (representationFaceTexels(candidate) >= wantedFaceTexels) break;
      continue;
    }
    best = candidate;
    if (representationFaceTexels(candidate) >= wantedFaceTexels) return { representation: candidate, limitation: null, next: null };
  }
  if (!best) return null;
  const chosen = best;
  const larger = candidates.filter(entry => representationFaceTexels(entry) > representationFaceTexels(chosen));
  const next = refusals.find(refusal => representationFaceTexels(refusal.representation) > representationFaceTexels(chosen)) ?? null;
  const limitation = larger.length === 0
    ? `the largest available is ${Math.round(representationFaceTexels(chosen))} texels per face, below the ${Math.round(wantedFaceTexels)} asked for`
    : `a larger representation does not fit: ${refusals.map(refusal => `${refusal.representation.id}: ${refusal.reason}`).join("; ")}`;
  return { representation: chosen, limitation, next };
}
