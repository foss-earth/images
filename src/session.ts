import { createResourcePools, type PoolLimits, type PoolName, type Reservation, type ResourcePools } from "./pools.js";

export interface OperationLimiter {
  run<T>(priority: number, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  stats(): { active: number; queued: number };
  pump(): void;
}
/** Common request/decode queue, isolated from the original mixed representation loader. */
export function createOperationLimiter(limit: () => number): OperationLimiter {
  let active = 0;
  const queue: { priority: number; start(): void; signal: AbortSignal }[] = [];
  const pump = (): void => {
    while (active < limit() && queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const next = queue.shift()!;
      if (next.signal.aborted) continue;
      active += 1;
      next.start();
    }
  };
  return {
    async run(priority, signal, work) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = queue.indexOf(entry);
          if (index >= 0) { queue.splice(index, 1); reject(signal.reason); }
        };
        const entry = { priority, start: () => { signal.removeEventListener("abort", onAbort); resolve(); }, signal };
        queue.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
        pump();
      });
      try { signal.throwIfAborted(); return await work(); }
      finally { active -= 1; pump(); }
    },
    stats: () => ({ active, queued: queue.length }),
    pump,
  };
}
export interface ImageSessionLimits { pools: PoolLimits; requests: number; decodes: number }
export interface ImageOperationScope {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  reserve(pool: PoolName, bytes: number, label: string, options?: { overlap?: boolean }): Reservation;
  /** A late result is disposed immediately; a current one belongs to this scope. */
  adopt<T extends { dispose(): void }>(resource: T): boolean;
  /** Idempotent; aborts queued work and releases every reservation and owned resource. */
  dispose(): void;
}
export interface ImageSessionBroker {
  readonly pools: ResourcePools;
  readonly requests: OperationLimiter;
  readonly decodes: OperationLimiter;
  scope(): ImageOperationScope;
  generation(): number;
  invalidate(): void;
  setLimits(limits: ImageSessionLimits): void;
  dispose(): void;
}
/** One host-created broker shared by previews, active images and replacements. No draw loop. */
export function createImageSessionBroker(initial: ImageSessionLimits): ImageSessionBroker {
  validateLimits(initial);
  let limits = { ...initial, pools: { ...initial.pools } };
  let generation = 0;
  let disposed = false;
  const scopes = new Set<ImageOperationScope>();
  const pools = createResourcePools(limits.pools);
  const requests = createOperationLimiter(() => limits.requests);
  const decodes = createOperationLimiter(() => limits.decodes);
  const invalidate = (): void => {
    generation += 1;
    const errors: unknown[] = [];
    for (const scope of [...scopes]) { try { scope.dispose(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Image session disposal failed.");
  };
  return {
    pools, requests, decodes,
    generation: () => generation,
    scope() {
      if (disposed) throw new Error("The image session is disposed.");
      const captured = generation;
      const controller = new AbortController();
      const reservations = new Set<Reservation>();
      const resources = new Set<{ dispose(): void }>();
      const current = (): boolean => !disposed && !controller.signal.aborted && captured === generation;
      const scope: ImageOperationScope = {
        generation: captured, signal: controller.signal, isCurrent: current,
        reserve(pool, bytes, label, options) {
          controller.signal.throwIfAborted();
          const result = pools.reserve(pool, bytes, label, options);
          if (!result.ok) throw new Error(result.reason);
          reservations.add(result.reservation);
          return result.reservation;
        },
        adopt(resource) {
          if (!current()) { resource.dispose(); return false; }
          resources.add(resource);
          return true;
        },
        dispose() {
          if (controller.signal.aborted) return;
          controller.abort(new Error("The image operation ended."));
          scopes.delete(scope);
          // Dispose every resource even when an adapter throws; reservations still release.
          try {
            const errors: unknown[] = [];
            for (const resource of resources) { try { resource.dispose(); } catch (error) { errors.push(error); } }
            resources.clear();
            if (errors.length) throw new AggregateError(errors, "Image resource disposal failed.");
          } finally {
            for (const reservation of reservations) reservation.release();
            reservations.clear();
          }
        },
      };
      scopes.add(scope);
      return scope;
    },
    invalidate,
    setLimits(next) { validateLimits(next); limits = { ...next, pools: { ...next.pools } }; pools.setLimits(limits.pools); requests.pump(); decodes.pump(); },
    dispose() { if (disposed) return; disposed = true; invalidate(); },
  };
}
function validateLimits(limits: ImageSessionLimits): void {
  for (const value of Object.values(limits.pools)) if (!Number.isFinite(value) || value < 0) throw new Error("Pool limits must be finite nonnegative byte counts.");
  for (const value of [limits.requests, limits.decodes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Request and decode limits must be positive integer counts.");
}
