import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createImageSessionBroker, ResourceCapacityError } from "../index.js";
import { createImageFileService, readbackDecodedImage, createCanvasRgbaSurface, RgbaSurfaceCreationError, type RgbaReadbackSurface } from "./index.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const declared = { url: "https://example.test/map", mimeType: "image/png" as const, width: 2, height: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function fixture(decoded = 100, closeInput?: () => void) {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 1000, decoded, sourceGpu: 100, uploadOutstanding: 100, overlap: 100 } });
  const scope = broker.scope(), inputEvents: number[] = [];
  const image = { width: 2, height: 1, close() { inputEvents.push(broker.pools.stats().decoded.reserved); closeInput?.(); } } as ImageBitmap;
  const service = createImageFileService({ broker, fetch: async () => new Response(png, { headers: { "content-type": "image/png" } }), decode: async () => image, priority: () => 0, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }) });
  const body = await service.obtain(declared, png.length, scope), held = await service.decode(body, declared, scope); body.release();
  return { broker, scope, held, image, inputEvents };
}

describe("bounded RGBA readback through actual shared common resources", () => {
  it("pre-admits bitmap/canvas/output once and transfers an independently retained output", async () => {
    const f = await fixture();
    let disposed = 0;
    const pixels = await readbackDecodedImage({ ...f, image: f.held, priority: 2, label: "map", createSurface(width, height) {
      expect([width, height]).toEqual([2, 1]); expect(f.broker.pools.stats().decoded.reserved).toBe(24);
      return { read(image) { expect(image).toBe(f.image); return new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]); }, dispose() { disposed += 1; expect(f.broker.pools.stats().decoded.reserved).toBe(24); } };
    } });
    expect(disposed).toBe(1); expect(f.inputEvents).toEqual([]); expect(f.broker.pools.stats().decoded.reserved).toBe(16);
    f.held.close(); expect(f.inputEvents).toEqual([16]); expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    const endPixels = pixels.retain(); f.scope.dispose();
    expect(pixels.data[0]).toBe(1); expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    expect(() => pixels.retain()).toThrow("closing"); endPixels(); endPixels(); pixels.close();
    expect(() => pixels.data).toThrow("closed"); expect(f.broker.pools.live()).toEqual([]); f.broker.dispose();
  });
  it("refuses canvas+output capacity before allocating a surface and leaves the borrowed bitmap live", async () => {
    const f = await fixture(16), createSurface = vi.fn();
    await expect(readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "limited", createSurface })).rejects.toBeInstanceOf(ResourceCapacityError);
    expect(createSurface).not.toHaveBeenCalled(); expect(f.inputEvents).toEqual([]); expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    f.scope.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  for (const end of ["scope", "invalidate", "dispose"] as const) for (const completion of ["resolve", "reject"] as const) {
    it(`${end} keeps all native charges through readback ${completion} and disposes the surface before input`, async () => {
      const f = await fixture(), native = deferred<Uint8ClampedArray>(), started = deferred<void>();
      let disposed = 0;
      const work = readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "pending", createSurface: () => ({ read() { started.resolve(); return native.promise; }, dispose() { disposed += 1; expect(f.broker.pools.stats().decoded.reserved).toBe(24); } }) });
      const rejected = expect(work).rejects.toThrow(); await started.promise;
      if (end === "scope") f.scope.dispose(); else if (end === "invalidate") f.broker.invalidate(); else f.broker.dispose();
      expect(disposed).toBe(0); expect(f.inputEvents).toEqual([]); expect(f.broker.pools.stats().decoded.reserved).toBe(24);
      if (completion === "resolve") native.resolve(new Uint8ClampedArray(8)); else native.reject(new Error("native read failed"));
      await rejected; expect(disposed).toBe(1); expect(f.inputEvents).toEqual([8]); expect(f.broker.pools.live()).toEqual([]);
      f.scope.dispose(); f.broker.dispose(); expect(disposed).toBe(1); expect(f.inputEvents).toHaveLength(1);
    });
  }
  it("aggregates native, surface and bitmap failures while releasing every charge", async () => {
    const f = await fixture(100, () => { throw new Error("bitmap cleanup"); }), native = deferred<Uint8ClampedArray>(), started = deferred<void>();
    const work = readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "throwing", createSurface: () => ({ retired: Promise.resolve(), read() { started.resolve(); return native.promise; }, dispose() { throw new Error("surface cleanup"); } }) });
    const result = work.catch(error => error); await started.promise; f.broker.dispose(); native.reject(new Error("native read failed"));
    const error = await result; expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((failure: Error) => failure.message)).toEqual(["native read failed", "surface cleanup", "bitmap cleanup"]);
    expect(f.inputEvents).toEqual([8]); expect(f.broker.pools.live()).toEqual([]); f.held.close(); f.broker.dispose();
  });
  it("does not start queued readback after cancellation", async () => {
    const f = await fixture(), blocker = new AbortController(), pending = deferred<void>(), began = deferred<void>();
    const blocked = f.broker.decodes.run(0, blocker.signal, () => { began.resolve(); return pending.promise; }); await began.promise;
    const createSurface = vi.fn();
    const work = readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "queued", createSurface }); const rejected = expect(work).rejects.toThrow();
    f.scope.dispose(); await rejected; expect(createSurface).not.toHaveBeenCalled(); expect(f.broker.pools.live()).toEqual([]);
    pending.resolve(); await blocked; f.broker.dispose();
  });
  it("rejects publication when surface cleanup invalidates the shared broker", async () => {
    const f = await fixture();
    await expect(readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "surface observer", createSurface: () => ({ read: () => new Uint8ClampedArray(8), dispose() { f.broker.invalidate(); } }) })).rejects.toThrow();
    expect(f.inputEvents).toEqual([8]); expect(f.broker.pools.live()).toEqual([]); f.broker.dispose();
  });
  it("rejects publication when final native input closure ends the operation", async () => {
    let endOperation = () => {};
    const f = await fixture(100, () => endOperation()), native = deferred<Uint8ClampedArray>(), started = deferred<void>(); endOperation = () => f.scope.dispose();
    const work = readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "input observer", createSurface: () => ({ read() { started.resolve(); return native.promise; }, dispose() {} }) });
    const rejected = expect(work).rejects.toThrow(); await started.promise; f.held.close(); native.resolve(new Uint8ClampedArray(8)); await rejected;
    expect(f.inputEvents).toHaveLength(1); expect(f.broker.pools.live()).toEqual([]); f.broker.dispose();
  });
  it("rejects an uncharged larger backing buffer and releases all output room", async () => {
    const f = await fixture();
    await expect(readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "alias", createSurface: () => ({ read: () => new Uint8ClampedArray(new ArrayBuffer(16), 0, 8), dispose() {} }) })).rejects.toThrow("admitted independent");
    expect(f.inputEvents).toEqual([]); expect(f.broker.pools.stats().decoded.reserved).toBe(8); f.scope.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  it("accepts an exact output from the supplied foreign realm", async () => {
    const f = await fixture(), data = runInNewContext("new Uint8ClampedArray([1,2,3,255,4,5,6,255])") as Uint8ClampedArray;
    expect(data instanceof Uint8ClampedArray).toBe(false);
    const held = await readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "foreign realm", createSurface: () => ({ read: () => data, dispose() {} }) });
    expect(held.data).toBe(data); expect([...held.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]); held.close(); f.scope.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  it("requires the actual native-input hold rather than claiming legacy lifetime safety", async () => {
    const f = await fixture(), createSurface = vi.fn();
    await expect(readbackDecodedImage({ ...f, image: { image: f.image, close() {} }, priority: 0, label: "legacy", createSurface })).rejects.toThrow("reliable");
    expect(createSurface).not.toHaveBeenCalled(); expect(f.broker.pools.stats().decoded.reserved).toBe(8); f.scope.dispose(); f.broker.dispose();
  });
  it("keeps failed canvas backing storage charged after scope/broker disposal until a real reset retires it", async () => {
    const f = await fixture();
    let width = 2, height = 1, failReset = true;
    const canvas = {
      get width() { return width; }, set width(value: number) { if (value === 0 && failReset) throw new Error("width reset"); width = value; },
      get height() { return height; }, set height(value: number) { if (value === 0 && failReset) throw new Error("height reset"); height = value; },
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8) }) }),
    } as unknown as HTMLCanvasElement;
    let surface!: RgbaReadbackSurface;
    await expect(readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "quarantined canvas",
      createSurface: () => (surface = createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas })),
    })).rejects.toThrow();
    f.scope.dispose(); f.broker.dispose();
    expect([width, height]).toEqual([2, 1]);
    expect(f.inputEvents).toHaveLength(1);
    expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    failReset = false; surface.dispose(); await surface.retired;
    expect([width, height]).toEqual([0, 0]);
    expect(f.broker.pools.live()).toEqual([]);
  });
  it("preserves retirement and retry cleanup when canvas allocation fails before returning a surface", async () => {
    const f = await fixture();
    let width = 2, height = 1, failReset = true;
    const canvas = {
      get width() { return width; }, set width(value: number) { if (value === 0 && failReset) throw new Error("width reset"); width = value; },
      get height() { return height; }, set height(value: number) { if (value === 0 && failReset) throw new Error("height reset"); height = value; },
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const error = await readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "allocation",
      createSurface: () => createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas }),
    }).catch(error => error);
    expect(error).toBeInstanceOf(RgbaSurfaceCreationError);
    f.scope.dispose(); f.broker.dispose();
    expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    failReset = false; error.retryCleanup(); await error.retired;
    expect(f.broker.pools.live()).toEqual([]);
  });
  it("accepts a proven zero canvas dimension after the other reset throws", async () => {
    const f = await fixture();
    let height = 1;
    const canvas = {
      get width() { return 2; }, set width(value: number) { if (value === 0) throw new Error("width reset"); },
      get height() { return height; }, set height(value: number) { height = value; },
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8) }) }),
    } as unknown as HTMLCanvasElement;
    await expect(readbackDecodedImage({ ...f, image: f.held, priority: 0, label: "zero height",
      createSurface: () => createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas }),
    })).rejects.toThrow("width reset");
    expect(height).toBe(0);
    expect(f.broker.pools.stats().decoded.reserved).toBe(8);
    f.scope.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
});

describe("explicit realm canvas readback", () => {
  it("clears a created canvas if the supplied realm cannot obtain a 2D context", () => {
    const canvas = { width: 2, height: 1, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas })).toThrow("2D canvas");
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
  it("uses only the supplied canvas and preserves draw/read options without copying pixels", () => {
    const data = new Uint8ClampedArray(8), drawImage = vi.fn(), getImageData = vi.fn(() => ({ data })), getContext = vi.fn(() => ({ drawImage, getImageData }));
    const canvas = { width: 2, height: 1, getContext } as unknown as HTMLCanvasElement;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, get() { throw new Error("ambient document"); } });
    try {
      const surface = createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas }), image = { width: 2, height: 1 } as ImageBitmap;
      expect(surface.read(image)).toBe(data); expect(drawImage).toHaveBeenCalledWith(image, 0, 0); expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
      expect(getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true }); surface.dispose(); surface.dispose(); expect([canvas.width, canvas.height]).toEqual([0, 0]);
    } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
  });
  it("attempts both canvas resets even when one cleanup setter throws", () => {
    let height = 1;
    const canvas = { get width() { return 2; }, set width(value: number) { if (value === 0) throw new Error("width cleanup"); }, get height() { return height; }, set height(value: number) { height = value; }, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8) }) }) } as unknown as HTMLCanvasElement;
    const surface: RgbaReadbackSurface = createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => canvas });
    expect(() => surface.dispose()).toThrow("width cleanup"); expect(height).toBe(0); expect(() => surface.dispose()).not.toThrow();
  });
});
