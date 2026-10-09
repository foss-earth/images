import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker } from "../session.js";
import { createMediaStore } from "../mediaStore.js";
import type { SavedFiles } from "../mediaStore.js";
import { memoryBackend } from "../test/memoryMediaBackend.js";
import { createImageFileService } from "./fileService.js";
import { imageDimensionMismatch, ImageDimensionMismatch } from "../headers.js";
import { ImageDecodeFailure } from "./transport.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const file = { url: "https://example.test/image.png", mimeType: "image/png" as const, width: 2, height: 1 };
const brokerFor = (encoded = 4096, decoded = 4096) => createImageSessionBroker({ pools: { sourceGpu: 4096, encoded, decoded, uploadOutstanding: 4096, overlap: 2048 }, requests: 1, decodes: 1 });
const response = () => new Response(png, { headers: { "content-type": "image/png" } });
const bitmap = () => ({ width: 2, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

describe("bounded persistent image acquisition", () => {
  it("uses each source's explicit priority in the one shared network queue", async () => {
    const broker = brokerFor(), scope = broker.scope(), order: string[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => -1, fetch: async input => {
      const path = String(input); order.push(path);
      if (path.endsWith("block")) await blocked;
      return response();
    }, decode: async () => bitmap() });
    const first = service.obtain({ ...file, url: `${file.url}?block` }, png.length, scope);
    await vi.waitFor(() => expect(order).toHaveLength(1));
    const low = service.obtain({ ...file, url: `${file.url}?low` }, png.length, scope, undefined, 1);
    const high = service.obtain({ ...file, url: `${file.url}?high` }, png.length, scope, undefined, 9);
    unblock(); const bodies = await Promise.all([first, low, high]);
    expect(order.map(path => path.split("?")[1])).toEqual(["block", "high", "low"]);
    for (const body of bodies) body.release(); scope.dispose();
  });
  it("admits actual tiny bodies for six parallel cached faces without full-cap overhead", async () => {
    const memory = memoryBackend(), store = createMediaStore({ open: async () => memory.backend, maxBytes: 8192 });
    const group = { id: "fixture@1/preview", label: "Preview" };
    for (let index = 0; index < 6; index++) store.put(group, `${file.url}?${index}`, png, file.mimeType);
    await store.settled();
    const broker = brokerFor(256), fetch = vi.fn(async () => response());
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch, decode: async () => bitmap(), cache: { files: store.files(group), settled: () => store.settled() } });
    const scope = broker.scope();
    const bodies = await Promise.all(Array.from({ length: 6 }, (_, index) => service.obtain({ ...file, url: `${file.url}?${index}` }, png.length, scope)));
    expect(bodies.every(body => body.fromCache)).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect(broker.pools.stats().encoded.reserved).toBe(6 * png.length);
    scope.dispose(); expect(broker.pools.live()).toEqual([]);
  });
  it("never calls an unbounded custom cache and keeps its bytes intact", async () => {
    const broker = brokerFor(), get = vi.fn(async () => ({ bytes: png, contentType: file.mimeType })), forget = vi.fn();
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => response(), decode: async () => bitmap(), cache: { files: { get, put() {}, forget }, settled: async () => {} } });
    const scope = broker.scope(), body = await service.obtain(file, png.length, scope);
    expect(body.fromCache).toBe(false); expect(get).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve(); scope.dispose();
  });
  it("holds a cancelled nonabortable cache read until its admitted body returns", async () => {
    const broker = brokerFor(), scope = broker.scope(); let finish!: () => void;
    const cache: SavedFiles = { get: vi.fn(), put() {}, forget() {}, async getBounded(_url, admission) {
      expect(admission.admit(png.length)).toBe(true);
      await new Promise<void>(resolve => { finish = resolve; });
      return { bytes: png, contentType: file.mimeType };
    } };
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: vi.fn(), decode: async () => bitmap(), cache: { files: cache, settled: async () => {} } });
    const loading = service.obtain(file, png.length, scope); await Promise.resolve(); await Promise.resolve();
    const rejected = expect(loading).rejects.toThrow(); scope.dispose();
    expect(broker.pools.stats().encoded.reserved).toBe(png.length);
    finish(); await rejected; expect(broker.pools.live()).toEqual([]);
  });
  it("retains both persistence input and snapshot after cancellation until settled", async () => {
    const broker = brokerFor(), scope = broker.scope(); let finish!: () => void;
    const persisted = new Promise<void>(resolve => { finish = resolve; });
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => response(), decode: async () => bitmap(), cache: { files: { get: vi.fn(), put() {}, forget() {} }, settled: () => persisted } });
    await service.obtain(file, png.length, scope); scope.dispose();
    expect(broker.pools.stats().encoded.reserved).toBe(2 * png.length);
    finish(); await persisted; await Promise.resolve(); await Promise.resolve();
    expect(broker.pools.live()).toEqual([]);
  });
  it("keeps valid cached bytes after decoded-capacity refusal but forgets a decoder failure", async () => {
    const forget = vi.fn(), cached: SavedFiles = { get: vi.fn(), put() {}, forget, async getBounded(_url, admission) { return admission.admit(png.length) ? { bytes: png, contentType: file.mimeType } : null; } };
    const broker = brokerFor(4096, 0), scope = broker.scope();
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: vi.fn(), decode: async () => { throw new Error("corrupt decoder input"); }, cache: { files: cached, settled: async () => {} } });
    const body = await service.obtain(file, png.length, scope);
    await expect(service.decode(body, file, scope)).rejects.toThrow("decoded"); expect(forget).not.toHaveBeenCalled();
    broker.setLimits({ pools: { sourceGpu: 4096, encoded: 4096, decoded: 4096, uploadOutstanding: 4096, overlap: 2048 }, requests: 1, decodes: 1 });
    await expect(service.decode(body, file, scope)).rejects.toThrow("corrupt decoder input"); expect(forget).toHaveBeenCalledOnce(); scope.dispose();
  });
});

describe("observed dimensions without representation missing policy", () => {
  it.each(["strict", "inferred"] as const)("reports actual and expected fetched header dimensions through %s acquisition", async mode => {
    const broker = brokerFor(), scope = broker.scope(), decode = vi.fn(async () => bitmap());
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => response(), decode });
    const expected = { ...file, width: 3 };
    const error = await (mode === "strict" ? service.obtain(expected, 0, scope) : service.obtainInferred(expected, 0, scope)).catch(error => error);
    expect(error).toBeInstanceOf(ImageDimensionMismatch);
    expect(imageDimensionMismatch(error)).toMatchObject({ actual: { width: 2, height: 1 }, expected: { width: 3, height: 1 }, observation: "header" });
    expect(decode).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("retains existing forget/refetch fallback for a mismatched cached header", async () => {
    const bad = png.slice(); bad[19] = 3;
    const broker = brokerFor(), scope = broker.scope(), forget = vi.fn(), fetch = vi.fn(async () => response());
    const cached: SavedFiles = { get: vi.fn(), put() {}, forget, async getBounded(_url, admission) { return admission.admit(bad.length) ? { bytes: bad, contentType: file.mimeType } : null; } };
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch, decode: async () => bitmap(), cache: { files: cached, settled: async () => {} } });
    const body = await service.obtain(file, 0, scope);
    expect(body.fromCache).toBe(false); expect(forget).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    body.release(); await Promise.resolve(); await Promise.resolve(); scope.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
  it("reports a final fetched mismatch after cached fallback and releases both acquisitions", async () => {
    const bad = png.slice(); bad[19] = 3;
    const broker = brokerFor(), scope = broker.scope(), forget = vi.fn(), fetch = vi.fn(async () => new Response(bad, { headers: { "content-type": file.mimeType } }));
    const cached: SavedFiles = { get: vi.fn(), put() {}, forget, async getBounded(_url, admission) { return admission.admit(bad.length) ? { bytes: bad, contentType: file.mimeType } : null; } };
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch, decode: async () => bitmap(), cache: { files: cached, settled: async () => {} } });
    const error = await service.obtainInferred(file, 0, scope).catch(error => error);
    expect(imageDimensionMismatch(error)).toMatchObject({ actual: { width: 3, height: 1 }, expected: { width: 2, height: 1 }, observation: "header" });
    expect(forget).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it.each([false, true])("keeps native mismatch a cache-forgetting decode failure, including throwing close=%s", async throwing => {
    const broker = brokerFor(), scope = broker.scope(), forget = vi.fn(), close = vi.fn(() => { if (throwing) throw new Error("native close"); });
    const cached: SavedFiles = { get: vi.fn(), put() {}, forget, async getBounded(_url, admission) { return admission.admit(png.length) ? { bytes: png, contentType: file.mimeType } : null; } };
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: vi.fn(), decode: async () => ({ width: 3, height: 1, close }) as unknown as ImageBitmap, cache: { files: cached, settled: async () => {} } });
    const body = await service.obtain(file, 0, scope);
    const error = await service.decode(body, file, scope).catch(error => error);
    expect(error).toBeInstanceOf(ImageDecodeFailure);
    expect(imageDimensionMismatch(error)).toMatchObject({ actual: { width: 3, height: 1 }, expected: { width: 2, height: 1 }, observation: "decoded" });
    if (throwing) expect(error.cause).toBeInstanceOf(AggregateError);
    expect(close).toHaveBeenCalledOnce(); expect(forget).toHaveBeenCalledOnce();
    body.release(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("does not infer dimensions from arbitrary decode failure messages", async () => {
    const broker = brokerFor(), scope = broker.scope();
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => response(), decode: async () => { throw new Error("Decoded image is 3×1, declared 2×1."); } });
    const body = await service.obtain(file, 0, scope), error = await service.decode(body, file, scope).catch(error => error);
    expect(error).toBeInstanceOf(ImageDecodeFailure); expect(imageDimensionMismatch(error)).toBeNull(); body.release(); scope.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
});

describe("header-inferred MIME through the same common file service", () => {
  it("infers bytes at a misleading URL and shares strict cached acquisition without another transport", async () => {
    const memory = memoryBackend(), store = createMediaStore({ open: async () => memory.backend, maxBytes: 8192 }), group = { id: "map-fixture@1", label: "Map" };
    const broker = brokerFor(), scope = broker.scope(), fetch = vi.fn(async () => new Response(png, { headers: { "content-type": "application/octet-stream" } }));
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch, decode: async () => bitmap(), cache: { files: store.files(group), settled: () => store.settled() } });
    const requested = { url: "https://example.test/not-really.jpeg", width: 2, height: 1 };
    const obtained = await service.obtainInferred(requested, 0, scope);
    expect(obtained.file).toEqual({ ...requested, mimeType: "image/png" }); expect(obtained.header).toEqual({ kind: "image/png", width: 2, height: 1, orientation: null });
    expect(obtained.body.fromCache).toBe(false); await store.settled(); obtained.body.release();
    const strict = await service.obtain(obtained.file, 0, scope);
    expect(strict.fromCache).toBe(true); expect(fetch).toHaveBeenCalledOnce();
    const inferred = await service.obtainInferred(requested, 0, scope);
    expect(inferred.body.fromCache).toBe(true); expect(inferred.file.mimeType).toBe("image/png");
    strict.release(); inferred.body.release(); scope.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
  it("preserves strict declarations and rejects conflicting inferred dimensions/MIME before decode", async () => {
    const broker = brokerFor(), scope = broker.scope(), decode = vi.fn(async () => bitmap());
    let contentType = "image/png";
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => new Response(png, { headers: { "content-type": contentType } }), decode });
    await expect(service.obtain({ ...file, mimeType: "image/jpeg" }, 0, scope)).rejects.toThrow("declared image/jpeg");
    await expect(service.obtainInferred({ url: file.url, width: 3, height: 1 }, 0, scope)).rejects.toThrow("declared 3×1");
    contentType = "image/jpeg";
    await expect(service.obtainInferred({ url: file.url, width: 2, height: 1 }, 0, scope)).rejects.toThrow("served as image/jpeg");
    expect(decode).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("requires reviewed dimensions before contacting a source", async () => {
    const broker = brokerFor(), scope = broker.scope(), fetch = vi.fn();
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch, decode: async () => bitmap() });
    for (const width of [0, -1, 1.5, Infinity]) await expect(service.obtainInferred({ url: file.url, width, height: 1 }, 0, scope)).rejects.toThrow("reviewed");
    expect(fetch).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
  it("keeps the existing orientation validation when MIME is inferred", async () => {
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const oriented = new Uint8Array([...png, 0, 0, 0, tiff.length, 0x65, 0x58, 0x49, 0x66, ...tiff, 0, 0, 0, 0]);
    const broker = brokerFor(), scope = broker.scope(), decode = vi.fn(async () => bitmap());
    const service = createImageFileService({ broker, limits: () => ({ responseBytes: 256, timeoutMs: 1000 }), priority: () => 0, fetch: async () => new Response(oriented, { headers: { "content-type": "image/png" } }), decode });
    await expect(service.obtainInferred({ url: file.url, width: 2, height: 1 }, 0, scope)).rejects.toThrow("EXIF orientation 6");
    expect(decode).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); scope.dispose(); broker.dispose();
  });
});
