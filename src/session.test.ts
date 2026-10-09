import { describe, expect, it } from "vitest";
import { createImageSessionBroker, createOperationLimiter } from "./session.js";
import { createResourcePools } from "./pools.js";

const limits = { pools: { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 30 }, requests: 1, decodes: 1 };
describe("one session's image resources", () => {
  it("accounts previews, active images and replacement overlap together", () => {
    const broker = createImageSessionBroker(limits);
    const preview = broker.scope(), active = broker.scope(), replacement = broker.scope();
    preview.reserve("sourceGpu", 20, "preview");
    active.reserve("sourceGpu", 50, "active");
    const incoming = replacement.reserve("sourceGpu", 30, "replacement", { overlap: true });
    expect(() => preview.reserve("sourceGpu", 1, "other format")).toThrow("sourceGpu");
    active.dispose();
    expect(() => replacement.reserve("sourceGpu", 1, "second replacement", { overlap: true })).toThrow("overlap");
    incoming.settle();
    expect(broker.pools.stats().sourceGpu.reserved).toBe(50);
    expect(broker.pools.stats().overlap.reserved).toBe(0);
    broker.dispose(); broker.dispose();
    expect(broker.pools.live()).toEqual([]);
  });
  it("rejects late decode/upload after replacement and releases every reservation", () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    scope.reserve("decoded", 20, "decode");
    let closed = 0;
    broker.invalidate();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.adopt({ dispose: () => { closed += 1; } })).toBe(false);
    expect(closed).toBe(1);
    expect(broker.pools.stats().decoded.reserved).toBe(0);
    expect(broker.scope().generation).toBe(1);
    broker.dispose();
  });
  it("releases other scopes even if one adapter fails during disposal", () => {
    const broker = createImageSessionBroker(limits), first = broker.scope(), second = broker.scope();
    first.reserve("decoded", 10, "one"); second.reserve("encoded", 10, "two");
    first.adopt({ dispose: () => { throw new Error("backend failure"); } });
    expect(() => broker.invalidate()).toThrow("disposal failed");
    expect(second.signal.aborted).toBe(true);
    expect(broker.pools.live()).toEqual([]);
  });
  it("reduces limits without discarding in-use allocations", () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    scope.reserve("decoded", 80, "held");
    broker.setLimits({ ...limits, pools: { ...limits.pools, decoded: 50 } });
    expect(broker.pools.stats().decoded.reserved).toBe(80);
    expect(() => scope.reserve("decoded", 1, "another")).toThrow();
    scope.dispose();
    expect(broker.pools.stats().decoded.reserved).toBe(0);
  });
  it("rejects invalid byte counts and budgets", () => {
    const pools = createResourcePools(limits.pools);
    for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pools.fits("encoded", bytes)).toBe(false);
      expect(pools.reserve("encoded", bytes, "invalid").ok).toBe(false);
    }
    expect(() => createImageSessionBroker({ ...limits, decodes: 0 })).toThrow();
    expect(() => createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: -1 } })).toThrow();
  });
});
describe("shared image work queues", () => {
  it("prioritizes waiting work, cancels queued work and releases the active slot on error", async () => {
    const queue = createOperationLimiter(() => 1), signal = new AbortController(), cancelled = new AbortController();
    let release!: () => void;
    const order: number[] = [];
    const first = queue.run(0, signal.signal, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const low = queue.run(1, signal.signal, async () => { order.push(1); });
    const high = queue.run(10, signal.signal, async () => { order.push(10); throw new Error("failed"); });
    const cancel = queue.run(20, cancelled.signal, async () => { order.push(20); });
    const rejected = expect(cancel).rejects.toBeDefined();
    cancelled.abort();
    const failed = expect(high).rejects.toThrow("failed");
    release(); await Promise.all([first, low, failed, rejected]);
    expect(order).toEqual([10, 1]);
    expect(queue.stats()).toEqual({ active: 0, queued: 0 });
  });
});
