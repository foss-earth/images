import { describe, expect, it } from "vitest";
import { createImageSessionBroker } from "../session.js";
import { fetchImageFile } from "./transport.js";

const limits = { pools: { encoded: 32, decoded: 32, sourceGpu: 32, uploadOutstanding: 32, overlap: 16 }, requests: 1, decodes: 1 };
describe("common bounded image transfer", () => {
  it("keeps the body reserved and releases assembly overlap", async () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    const file = await fetchImageFile({ broker, scope, url: "https://example.test/image.png", declaredBytes: 4, priority: 0, limits: { responseBytes: 10, timeoutMs: 1000 }, fetch: async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } }) });
    expect([...file.bytes]).toEqual([1, 2, 3, 4]);
    expect(broker.pools.stats().encoded).toMatchObject({ reserved: 4, peak: 8 });
    file.release(); file.release(); expect(broker.pools.live().length).toBe(0);
    broker.dispose();
  });
  it("refuses oversized responses and frees the declared reservation", async () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    await expect(fetchImageFile({ broker, scope, url: "https://example.test/large", declaredBytes: 2, priority: 0, limits: { responseBytes: 4, timeoutMs: 1000 }, fetch: async () => new Response(new Uint8Array(5)) })).rejects.toThrow("response limit");
    expect(broker.pools.live().length).toBe(0); broker.dispose();
  });
  it("abandons a late network completion after a scene replacement", async () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    let respond!: (response: Response) => void;
    const loading = fetchImageFile({ broker, scope, url: "https://example.test/late", declaredBytes: 2, priority: 0, limits: { responseBytes: 4, timeoutMs: 1000 }, fetch: () => new Promise(resolve => { respond = resolve; }) });
    await Promise.resolve(); await Promise.resolve();
    const rejected = expect(loading).rejects.toThrow();
    broker.invalidate(); respond(new Response(new Uint8Array(2))); await rejected;
    expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
});
