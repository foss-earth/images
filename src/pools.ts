import { MIB } from "./bytes.js";

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
    if (!(bytes >= 0) || !Number.isFinite(bytes)) return { ok: false, pool, reason: `${bytes} is not a byte count` };
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
