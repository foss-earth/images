import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker } from "../session.js";
import { fetchImageFile, decodeImageFile, ImageHttpStatusError } from "./transport.js";
import { ImageDimensionMismatch, imageDimensionMismatch } from "../headers.js";

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
    broker.invalidate(); expect(broker.pools.stats().encoded.reserved).toBe(2);
    respond(new Response(new Uint8Array(2))); await rejected;
    expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
});

describe("typed status before common body acquisition", () => {
  for (const status of [404, 204, 429, 500]) {
    it(`reports ${status} without reading an image body`, async () => {
      const broker = createImageSessionBroker(limits), scope = broker.scope();
      const cancel = vi.fn();
      const response = new Response(status === 204 ? null : new ReadableStream<Uint8Array>({ cancel }), { status });
      const getReader = response.body ? vi.spyOn(response.body, "getReader") : null;
      const chunk = vi.fn();
      const error = await fetchImageFile({ broker, scope, url: "https://example.test/status", declaredBytes: 4, priority: 0, limits: { responseBytes: 10, timeoutMs: 1000 }, fetch: async () => response, receivedChunk: chunk }).catch(error => error);
      expect(error).toBeInstanceOf(ImageHttpStatusError); expect(error.status).toBe(status); expect(error.url).toBe("https://example.test/status");
      expect(imageDimensionMismatch(error)).toBeNull();
      expect(chunk).not.toHaveBeenCalled(); if (getReader) expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(status === 204 ? 0 : 1);
      expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
    });
  }
  it("retains status cancellation work through invalidation until the body ends", async () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope();
    let began!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { began(); return pending; } }), { status: 404 });
    const work = fetchImageFile({ broker, scope, url: "https://example.test/status", declaredBytes: 4, priority: 0, limits: { responseBytes: 10, timeoutMs: 1000 }, fetch: async () => response });
    const rejected = expect(work).rejects.toThrow(); await started; broker.invalidate();
    expect(broker.pools.stats().encoded.reserved).toBe(4);
    finish(); await rejected; expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
  it("preserves a status and cancellation failure without leaking its grant", async () => {
    const broker = createImageSessionBroker(limits), scope = broker.scope(), cleanup = new Error("status body cleanup");
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { throw cleanup; } }), { status: 404 });
    const work = fetchImageFile({ broker, scope, url: "https://example.test/status", declaredBytes: 4, priority: 0, limits: { responseBytes: 10, timeoutMs: 1000 }, fetch: async () => response });
    const error = await work.catch(error => error);
    expect(error).toBeInstanceOf(ImageHttpStatusError); expect(error.status).toBe(404); expect(error.cause).toBe(cleanup);
    expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
});

describe("nonabortable decode lifetime", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
  const declared = { mimeType: "image/png" as const, width: 2, height: 1 };
  it("rejects a wrong-size native bitmap before publishing its header-sized charge", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope(), close = vi.fn();
    await expect(decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: async () => ({ width: 3, height: 1, close }) as ImageBitmap })).rejects.toThrow("Decoded image is 3×1");
    expect(close).toHaveBeenCalledOnce(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("observes mismatched readable header dimensions without starting native decode", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope(), decode = vi.fn();
    const error = await decodeImageFile({ broker, scope, priority: 0, declared: { ...declared, width: 3 }, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode }).catch(error => error);
    expect(error).toBeInstanceOf(ImageDimensionMismatch); expect(imageDimensionMismatch(error)).toMatchObject({ actual: { width: 2, height: 1 }, expected: { width: 3, height: 1 }, observation: "header" });
    expect(decode).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("keeps a decoded native input alive and charged through broker invalidation until every user ends", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope();
    let closes = 0;
    const held = await decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: async () => ({ width: 2, height: 1, close() { closes += 1; expect(broker.pools.stats().decoded.reserved).toBe(8); } }) as ImageBitmap });
    const a = held.retain!(), b = held.retain!();
    broker.invalidate(); held.close();
    expect(closes).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(8);
    expect(() => held.retain!()).toThrow("closing decoded image");
    a(); a(); expect(closes).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(8);
    b(); b(); held.close(); expect(closes).toBe(1); expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
  it("does not release a retained decoded input on session disposal, including a throwing bitmap close", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope();
    let closes = 0;
    const held = await decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: async () => ({ width: 2, height: 1, close() { closes += 1; throw new Error("bitmap disposer"); } }) as ImageBitmap });
    const endNative = held.retain!();
    expect(() => broker.dispose()).not.toThrow(); expect(closes).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(8);
    expect(() => endNative()).toThrow("bitmap disposer");
    endNative(); held.close(); expect(closes).toBe(1); expect(broker.pools.live()).toEqual([]);
  });
  it("retaining and ending native use before owner close does not dispose the live decoded image", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope();
    let closes = 0;
    const held = await decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: async () => ({ width: 2, height: 1, close() { closes += 1; } }) as ImageBitmap });
    const endNative = held.retain!(); endNative(); endNative();
    expect(closes).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(8);
    held.close(); held.close(); expect(closes).toBe(1); expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
  it("holds both input and prospective pixels until a late bitmap closes", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope();
    const input = scope.reserve("encoded", png.length, "decoder input");
    let finish!: (image: ImageBitmap) => void, began!: () => void, closed = 0;
    const started = new Promise<void>(resolve => { began = resolve; });
    const work = decodeImageFile({ broker, scope, priority: 0, declared,
      file: { bytes: png, contentType: declared.mimeType, retain: () => input.retain(), release: () => input.release() },
      decode: () => { began(); return new Promise(resolve => { finish = resolve; }); },
    });
    await started; const rejected = expect(work).rejects.toThrow(); scope.dispose();
    expect(broker.pools.stats().encoded.reserved).toBe(png.length);
    expect(broker.pools.stats().decoded.reserved).toBe(8);
    finish({ width: 2, height: 1, close: () => { closed += 1; } } as unknown as ImageBitmap);
    await rejected; expect(closed).toBe(1); expect(broker.pools.live()).toEqual([]);
  });
  it("does not begin a queued decode after owner cancellation", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), blocker = new AbortController();
    let finish!: () => void; const blocked = broker.decodes.run(0, blocker.signal, () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve(); const scope = broker.scope(); let calls = 0;
    const work = decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: async () => { calls += 1; throw new Error("Must not decode"); } });
    const rejected = expect(work).rejects.toThrow(); scope.dispose(); await rejected; finish(); await blocked;
    expect(calls).toBe(0); expect(broker.pools.live()).toEqual([]);
  });
  it("charges a foreign input without a retain port until its nonabortable decoder returns", async () => {
    const broker = createImageSessionBroker({ ...limits, pools: { ...limits.pools, encoded: 100 } }), scope = broker.scope();
    let finish!: (image: ImageBitmap) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const work = decodeImageFile({ broker, scope, priority: 0, declared, file: { bytes: png, contentType: declared.mimeType, release() {} }, decode: () => { began(); return new Promise(resolve => { finish = resolve; }); } });
    await started; const rejected = expect(work).rejects.toThrow(); scope.dispose();
    expect(broker.pools.stats().encoded.reserved).toBe(png.length); expect(broker.pools.stats().decoded.reserved).toBe(8);
    finish({ width: 2, height: 1, close() {} } as unknown as ImageBitmap); await rejected;
    expect(broker.pools.live()).toEqual([]); broker.dispose();
  });
});
