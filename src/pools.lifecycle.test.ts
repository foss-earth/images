import { describe, expect, it, vi } from "vitest";
import { createResourcePools, ResourceCapacityError } from "./pools.js";
import { createImageSessionBroker } from "./session.js";

const limits = { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 30 };
describe("retained nonabortable charges and host capacity wake", () => {
  it("keeps charges after owner release until every nonabortable hold ends", () => {
    const pools = createResourcePools(limits), result = pools.reserve("decoded", 40, "active decode");
    if (!result.ok) throw new Error(result.reason);
    const one = result.reservation.retain(), two = result.reservation.retain();
    result.reservation.release(); result.reservation.release();
    expect(pools.stats().decoded.reserved).toBe(40);
    expect(result.reservation.resize(0)).toBe(false);
    expect(() => result.reservation.retain()).toThrow("released by its owner");
    one(); one(); expect(pools.stats().decoded.reserved).toBe(40);
    two(); two(); expect(pools.live()).toEqual([]);
  });
  it("coalesces actual available capacity and skips removed subscribers", async () => {
    const pools = createResourcePools(limits), wake = vi.fn(), removed = vi.fn();
    const off = pools.subscribeAvailable(wake), offRemoved = pools.subscribeAvailable(removed);
    const result = pools.reserve("sourceGpu", 30, "replacement", { overlap: true });
    if (!result.ok) throw new Error(result.reason);
    result.reservation.resize(20); result.reservation.settle(); result.reservation.release();
    pools.setLimits({ ...limits, encoded: 200 }); offRemoved();
    expect(wake).not.toHaveBeenCalled(); await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1); expect(removed).not.toHaveBeenCalled();
    pools.setLimits({ ...limits, encoded: 50 }); await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
    pools.setLimits(limits); off(); await Promise.resolve(); expect(wake).toHaveBeenCalledTimes(1);
  });
  it("identifies capacity refusal separately from invalid media", () => {
    const broker = createImageSessionBroker({ pools: limits, requests: 1, decodes: 1 });
    try { broker.scope().reserve("decoded", 101, "too much"); throw new Error("Expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(ResourceCapacityError); expect((error as ResourceCapacityError).pool).toBe("decoded"); }
    finally { broker.dispose(); }
  });
});
