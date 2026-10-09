import { describe, expect, it, vi } from "vitest";
import { createImageSourceCache, imageSourceKey, type CachedImageSource } from "./sourceCache.js";
import { createImageSessionBroker, type ImageOperationScope } from "./session.js";

const limits = { pools: { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 40 }, requests: 1, decodes: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Source extends CachedImageSource { bytes: number }
function source(scope: ImageOperationScope, bytes: number, overlap = false): Source {
  const grant = scope.reserve("sourceGpu", bytes, "source", { overlap });
  let disposed = false;
  return { bytes, settleReplacement: vi.fn(() => grant.settle()), dispose: vi.fn(() => { if (!disposed) { disposed = true; grant.release(); } }) };
}
function setup(keptGpuBytes = 100) {
  const broker = createImageSessionBroker(limits);
  const cache = createImageSourceCache<Source>({ broker, keptGpuBytes, gpuBytes: item => item.bytes });
  return { broker, cache };
}

describe("common retained image sources", () => {
  it("shares one factory while a cancelled consumer leaves the other load alive", async () => {
    const { broker, cache } = setup(), ready = deferred<Source>(), one = new AbortController();
    let scope!: ImageOperationScope;
    const load = vi.fn((operation: ImageOperationScope) => { scope = operation; return ready.promise; });
    const first = cache.acquire("same", { signal: one.signal, load });
    const failed = expect(first).rejects.toThrow("one left");
    const second = cache.acquire("same", { load });
    await Promise.resolve(); one.abort(new Error("one left")); await failed;
    expect(scope.signal.aborted).toBe(false); expect(load).toHaveBeenCalledTimes(1);
    const resource = source(scope, 30); ready.resolve(resource);
    const hold = await second;
    expect(hold.resource).toBe(resource); expect(cache.stats().heldReferences).toBe(1);
    hold.release(); hold.release(); expect(cache.stats().keptGpuBytes).toBe(30);
    cache.dispose(); broker.dispose(); expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
  it("aborts the final pending consumer and disposes its nonabortable late result", async () => {
    const { broker, cache } = setup(), ready = deferred<Source>(), controller = new AbortController();
    let scope!: ImageOperationScope;
    const result = cache.acquire("late", { signal: controller.signal, load: operation => { scope = operation; return ready.promise; } });
    const failed = expect(result).rejects.toThrow("left");
    await Promise.resolve(); controller.abort(new Error("left")); await failed;
    expect(scope.signal.aborted).toBe(true); expect(cache.stats().loadingSources).toBe(0);
    const resource: Source = { bytes: 20, dispose: vi.fn(), settleReplacement: vi.fn() };
    ready.resolve(resource); await vi.waitFor(() => expect(resource.dispose).toHaveBeenCalledTimes(1));
    cache.dispose(); broker.dispose();
  });
  it("preserves a factory failure and permits a fresh acquisition of the same key", async () => {
    const { broker, cache } = setup(), error = new Error("invalid source bytes");
    await expect(cache.acquire("retry", { load: async () => { throw error; } })).rejects.toBe(error);
    const hold = await cache.acquire("retry", { load: async operation => source(operation, 10) });
    expect(hold.resource.bytes).toBe(10); hold.release(); cache.dispose(); broker.dispose();
  });
  it("evicts idle LRU entries before source admission and never discards a holder", async () => {
    const { broker, cache } = setup(60);
    const a = await cache.acquire("a", { load: async operation => source(operation, 30) }); a.release();
    const b = await cache.acquire("b", { load: async operation => source(operation, 30) }); b.release();
    const aAgain = await cache.acquire("a", { load: async () => { throw new Error("Must reuse"); } }); aAgain.release();
    const c = await cache.acquire("c", { estimatedGpuBytes: 50, load: async operation => source(operation, 50) });
    expect(b.resource.dispose).toHaveBeenCalledTimes(1); expect(a.resource.dispose).not.toHaveBeenCalled();
    cache.setKeptGpuBytes(0); expect(a.resource.dispose).toHaveBeenCalledTimes(1); expect(c.resource.dispose).not.toHaveBeenCalled();
    expect(cache.evictUnused(60)).toBe(false); c.release();
    expect(c.resource.dispose).toHaveBeenCalledTimes(1); expect(broker.pools.live()).toEqual([]);
    cache.dispose(); broker.dispose();
  });
  it("settles overlap only after an explicit host visibility acknowledgement", async () => {
    const { broker, cache } = setup();
    const hold = await cache.acquire("incoming", { overlap: true, priority: 7, load: async (operation, request) => {
      expect(request).toEqual({ overlap: true, priority: 7 }); return source(operation, 30, request.overlap);
    } });
    expect(broker.pools.stats().overlap.reserved).toBe(30);
    hold.release(); expect(broker.pools.stats().overlap.reserved).toBe(30);
    hold.settleReplacement(); expect(broker.pools.stats().overlap.reserved).toBe(0);
    hold.settleReplacement(); expect(hold.resource.settleReplacement).toHaveBeenCalledTimes(1);
    cache.dispose(); broker.dispose();
  });
  it("invalidates held and pending sources with their one shared broker generation", async () => {
    const { broker, cache } = setup(), pending = deferred<Source>();
    const old = await cache.acquire("revision", { load: async operation => source(operation, 20) });
    const wait = cache.acquire("pending", { load: () => pending.promise });
    const failed = expect(wait).rejects.toThrow("operation ended"); await Promise.resolve();
    broker.invalidate(); await failed;
    expect(old.resource.dispose).toHaveBeenCalledTimes(1); old.release(); old.settleReplacement();
    const late: Source = { bytes: 0, dispose: vi.fn(), settleReplacement: vi.fn() }; pending.resolve(late);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledTimes(1));
    const next = await cache.acquire("revision", { load: async operation => source(operation, 20) });
    expect(next.resource).not.toBe(old.resource); next.release(); cache.dispose(); broker.dispose();
    expect(imageSourceKey({ id: "image", revision: "sha" }, { id: "preview" })).toBe("image@sha/preview");
  });
  it("does not retain a source the host marks ineligible", async () => {
    const broker = createImageSessionBroker(limits), cache = createImageSourceCache<Source>({ broker, keptGpuBytes: 100, gpuBytes: item => item.bytes, retainable: () => false });
    const hold = await cache.acquire("progressive", { load: async operation => source(operation, 10) });
    hold.release(); expect(hold.resource.dispose).toHaveBeenCalledTimes(1); expect(cache.stats().cachedSources).toBe(0);
    cache.dispose(); broker.dispose();
  });
  it("gives up idle sources after the shared GPU limit falls, preserving current holders", async () => {
    const { broker, cache } = setup();
    const held = await cache.acquire("shown", { load: async operation => source(operation, 20) });
    const idle = await cache.acquire("idle", { load: async operation => source(operation, 40) }); idle.release();
    broker.setLimits({ ...limits, pools: { ...limits.pools, sourceGpu: 30 } });
    cache.setKeptGpuBytes(100);
    expect(idle.resource.dispose).toHaveBeenCalledTimes(1); expect(held.resource.dispose).not.toHaveBeenCalled();
    expect(broker.pools.stats().sourceGpu.reserved).toBe(20);
    held.release(); cache.dispose(); broker.dispose();
  });
});
