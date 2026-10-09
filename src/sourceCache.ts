/** Common retained source lifecycle; spatial formats and upload construction are host ports. */
import type { ImageIdentity } from "./contracts.js";
import type { ImageOperationScope, ImageSessionBroker } from "./session.js";

export interface CachedImageSource {
  /** Idempotent; a late result must be safe to dispose after its operation aborts. */
  dispose(): void;
    settleReplacement(): void;
}
export interface ImageSourceHold<T> {
  readonly resource: T;
  /** Idempotent. A zero-reference ready source may remain inside the kept budget. */
  release(): void;
  /** Explicit visibility acknowledgement, also after release if still cached. Idempotent; loading alone never settles it. */
  settleReplacement(): void;
}
export interface ImageSourceRequest { priority: number; overlap: boolean }
export interface ImageSourceAcquireOptions<T> {
  signal?: AbortSignal;
  priority?: number;
  overlap?: boolean;
  /** Known source GPU cost lets admission evict idle sources before the factory reserves. */
  estimatedGpuBytes?: number;
  load(scope: ImageOperationScope, request: ImageSourceRequest): Promise<T>;
}
export interface ImageSourceCacheStats {
  loadingSources: number; cachedSources: number; referencedSources: number;
  heldReferences: number; waiting: number; keptSources: number; keptGpuBytes: number;
}
export interface ImageSourceCache<T extends CachedImageSource> {
  acquire(key: string, options: ImageSourceAcquireOptions<T>): Promise<ImageSourceHold<T>>;
  setKeptGpuBytes(bytes: number): void;
  /** Least recently used idle sources yield admission room; never discards a holder. */
  evictUnused(requiredGpuBytes: number, overlap?: boolean): boolean;
  stats(): ImageSourceCacheStats;
  dispose(): void;
}
export function imageSourceKey(asset: ImageIdentity, representation: { id: string }): string {
  return `${asset.id}@${asset.revision}/${representation.id}`;
}
const byteCount = (bytes: number): void => { if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Source cache budgets and costs must be nonnegative integer bytes."); };

/** One cache per supplied session, preserving the original refcounts/idle LRU. No clock or renderer. */
export function createImageSourceCache<T extends CachedImageSource>(options: {
  broker: ImageSessionBroker;
  keptGpuBytes: number;
  gpuBytes(resource: T): number;
  /** For example, a host may release an inactive progressive atlas instead of retaining it. */
  retainable?(resource: T): boolean;
}): ImageSourceCache<T> {
  byteCount(options.keptGpuBytes);
  interface Entry {
    key: string; scope: ImageOperationScope; promise: Promise<T>; resource: T | null;
    gpuBytes: number; references: number; waiting: number; used: number; dead: boolean; failure?: { error: unknown }; offScope(): void;
  }
  const entries = new Map<string, Entry>();
  let disposed = false, serial = 0, keptGpuBytes = options.keptGpuBytes;
  const idle = (): Entry[] => [...entries.values()].filter(entry => !entry.dead && entry.resource !== null && entry.references === 0 && entry.waiting === 0).sort((a, b) => a.used - b.used);
  const end = (entry: Entry): void => {
    if (entry.dead) return;
    entry.dead = true; if (entries.get(entry.key) === entry) entries.delete(entry.key);
    entry.offScope(); entry.scope.dispose();
  };
  const trim = (): void => {
    const candidates = idle(); let bytes = candidates.reduce((sum, entry) => sum + entry.gpuBytes, 0);
    const errors: unknown[] = [];
    for (const entry of candidates) {
      if (bytes <= keptGpuBytes && options.broker.pools.fits("sourceGpu", 0) && (options.retainable?.(entry.resource!) ?? true)) continue;
      bytes -= entry.gpuBytes; try { end(entry); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Idle image source disposal failed.");
  };
  const evictUnused = (requiredGpuBytes: number, overlap = false): boolean => {
    byteCount(requiredGpuBytes);
    for (const entry of idle()) {
      if (options.broker.pools.fits("sourceGpu", requiredGpuBytes, { overlap })) break;
      end(entry);
    }
    return options.broker.pools.fits("sourceGpu", requiredGpuBytes, { overlap });
  };
  return {
    acquire(key, request) {
      if (disposed) return Promise.reject(new Error("The image source cache is disposed."));
      if (!key) return Promise.reject(new Error("An image source needs a stable key."));
      if (request.signal?.aborted) return Promise.reject(request.signal.reason);
      let current = entries.get(key);
      if (current && !current.scope.isCurrent()) { end(current); current = undefined; }
      if (!current) {
        if (request.estimatedGpuBytes !== undefined) evictUnused(request.estimatedGpuBytes, request.overlap === true);
        const scope = options.broker.scope();
        const entry: Entry = { key, scope, promise: null as unknown as Promise<T>, resource: null, gpuBytes: 0, references: 0, waiting: 0, used: ++serial, dead: false, offScope() {} };
        const ended = (): void => { entry.dead = true; if (entries.get(key) === entry) entries.delete(key); entry.offScope(); };
        entry.offScope = () => scope.signal.removeEventListener("abort", ended);
        scope.signal.addEventListener("abort", ended, { once: true }); entries.set(key, entry);
        entry.promise = Promise.resolve().then(() => {
          scope.signal.throwIfAborted();
          return request.load(scope, { priority: request.priority ?? 0, overlap: request.overlap === true });
        }).then(resource => {
          if (!scope.adopt(resource)) { scope.signal.throwIfAborted(); throw new Error("The source completed after its cache entry ended."); }
          const bytes = options.gpuBytes(resource); byteCount(bytes);
          entry.resource = resource; entry.gpuBytes = bytes;
          return resource;
        }).catch(error => {
          // Scope abort synchronously rejects waiters. Preserve the causal
          // factory error instead of replacing it with a generic scope end.
          entry.failure = { error };
          try { end(entry); } catch (cleanup) { throw new AggregateError([error, cleanup], "Image source creation and disposal failed."); }
          throw error;
        });
        current = entry;
      }
      const entry = current; entry.waiting += 1; entry.used = ++serial;
      return new Promise<ImageSourceHold<T>>((resolve, reject) => {
        let settled = false;
        const off = (): void => { request.signal?.removeEventListener("abort", abort); entry.scope.signal.removeEventListener("abort", abort); };
        const abort = (): void => {
          if (settled) return; settled = true; off(); entry.waiting -= 1;
          const reason = request.signal?.aborted ? request.signal.reason : entry.failure ? entry.failure.error : entry.scope.signal.reason ?? new Error("Image acquisition ended.");
          try { if (entry.waiting === 0 && entry.references === 0 && !entry.resource) end(entry); else trim(); }
          catch (cleanup) { reject(new AggregateError([reason, cleanup], "Image acquisition and disposal failed.")); return; }
          reject(reason);
        };
        request.signal?.addEventListener("abort", abort, { once: true }); entry.scope.signal.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted || !entry.scope.isCurrent()) { abort(); return; }
        void entry.promise.then(resource => {
          if (settled) return;
          if (request.signal?.aborted || !entry.scope.isCurrent()) { abort(); return; }
          settled = true; off(); entry.waiting -= 1; entry.references += 1; entry.used = ++serial;
          let released = false, replacementSettled = false;
          resolve({ resource,
            // A released incoming preview may remain cached while an immersion
            // still borrows its outgoing source. Handback acknowledges that
            // old source later, without reacquiring the incoming preview.
            settleReplacement() { if (!replacementSettled && !entry.dead) { replacementSettled = true; resource.settleReplacement(); } },
            release() { if (released) return; released = true; entry.references -= 1; entry.used = ++serial; if (!entry.dead) trim(); },
          });
        }, error => { if (settled) return; settled = true; off(); entry.waiting -= 1; reject(error); });
      });
    },
    setKeptGpuBytes(bytes) { byteCount(bytes); keptGpuBytes = bytes; trim(); },
    evictUnused,
    stats() {
      const values = [...entries.values()], kept = idle();
      return { loadingSources: values.filter(entry => !entry.resource).length, cachedSources: values.filter(entry => entry.resource).length,
        referencedSources: values.filter(entry => entry.references > 0).length, heldReferences: values.reduce((sum, entry) => sum + entry.references, 0),
        waiting: values.reduce((sum, entry) => sum + entry.waiting, 0), keptSources: kept.length, keptGpuBytes: kept.reduce((sum, entry) => sum + entry.gpuBytes, 0) };
    },
    dispose() {
      if (disposed) return; disposed = true;
      const errors: unknown[] = []; for (const entry of [...entries.values()]) { try { end(entry); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Image source cache disposal failed.");
    },
  };
}
