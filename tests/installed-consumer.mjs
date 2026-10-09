import assert from "node:assert/strict";
// The installed harness supplies its physical-path/module-scope guard.
for (const name of ["document", "window", "navigator", "localStorage"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Eager browser access: ${name}`); } });
const { createImageSessionBroker, createImageSourceCache, readImageHeader, ImageDimensionMismatch, imageDimensionMismatch } = await import("@foss-earth/images");
// The retained settings assertion lives in consumer/settings-runtime.mjs so
// optional UI does not weaken the core/browser/codec runtime guard.
const { openIndexedDbBackend, decodeImageFile, createImageFileService, ImageHttpStatusError, readbackDecodedImage, createCanvasRgbaSurface, RgbaSurfaceCreationError } = await import("@foss-earth/images/browser");
assert.equal(await openIndexedDbBackend(), null);
const codecs = await import("@foss-earth/images/node");
const source = { width: 2, height: 1, rgb: new Uint8Array([0, 0, 0, 255, 255, 255]) };
const png = codecs.encodePng(source);
assert.equal(codecs.sniffImage(png), "image/png");
assert.deepEqual(readImageHeader(png), { kind: "image/png", width: 2, height: 1, orientation: null });
const decoded = codecs.dropOpaqueAlpha(codecs.decodePng(png));
assert.deepEqual([...decoded.rgb], [...source.rgb]);
assert.deepEqual([...codecs.toSrgbImage(codecs.resizeArea(codecs.toLinearImage(decoded), 1, 1)).rgb], [188, 188, 188]);
const jpeg = codecs.encodeJpeg({ width: 1, height: 1, rgb: new Uint8Array([230, 50, 25]) }, 90);
assert.equal(codecs.sniffImage(jpeg), "image/jpeg");
assert.equal(codecs.decodeJpeg(jpeg).width, 1);
const decodeBroker = createImageSessionBroker({ pools: { sourceGpu: 16, encoded: 1000, decoded: 16, uploadOutstanding: 16, overlap: 8 }, requests: 1, decodes: 1 });
let bitmapClosed = 0;
const held = await decodeImageFile({ broker: decodeBroker, scope: decodeBroker.scope(), priority: 0, declared: { mimeType: "image/png", width: 2, height: 1 }, file: { bytes: png, contentType: "image/png", release() {} }, decode: async () => ({ width: 2, height: 1, close() { bitmapClosed += 1; } }) });
assert.equal(typeof held.retain, "function"); const nativeInput = held.retain(); decodeBroker.dispose();
assert.equal(bitmapClosed, 0); assert.equal(decodeBroker.pools.stats().decoded.reserved, 8);
nativeInput(); nativeInput(); held.close(); assert.equal(bitmapClosed, 1); assert.deepEqual(decodeBroker.pools.live(), []);
const broker = createImageSessionBroker({ pools: { sourceGpu: 16, encoded: 16, decoded: 16, uploadOutstanding: 16, overlap: 8 }, requests: 1, decodes: 1 });
let loads = 0, disposed = 0;
const cache = createImageSourceCache({ broker, keptGpuBytes: 4, gpuBytes: source => source.bytes });
const first = await cache.acquire("shared", { load: async scope => { loads++; const grant = scope.reserve("sourceGpu", 4, "shared"); return { bytes: 4, settleReplacement() { grant.settle(); }, dispose() { disposed++; grant.release(); } }; } });
const second = await cache.acquire("shared", { load: async () => { throw new Error("Unexpected duplicate source"); } });
assert.equal(first.resource, second.resource); first.release(); second.release(); assert.equal(loads, 1); cache.dispose(); assert.equal(disposed, 1);
broker.scope().reserve("sourceGpu", 12, "first representation");
assert.throws(() => broker.scope().reserve("sourceGpu", 8, "second representation"));
broker.dispose(); assert.equal(broker.pools.live().length, 0);
const rgbaBroker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 1000, decoded: 100, sourceGpu: 100, uploadOutstanding: 100, overlap: 100 } }), rgbaScope = rgbaBroker.scope();
let nativeBitmapCloses = 0, surfaceCloses = 0;
const service = createImageFileService({ broker: rgbaBroker, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }), priority: () => 0, fetch: async () => new Response(png, { headers: { "content-type": "application/octet-stream" } }), decode: async () => ({ width: 2, height: 1, close() { nativeBitmapCloses++; } }) });
await assert.rejects(service.obtainInferred({ url: "https://example.invalid/wrong-size", width: 3, height: 1 }, 0, rgbaScope), error => {
  assert.ok(error instanceof ImageDimensionMismatch); assert.deepEqual(imageDimensionMismatch(error).actual, { width: 2, height: 1 }); assert.deepEqual(error.expected, { width: 3, height: 1 }); return true;
});
const inferred = await service.obtainInferred({ url: "https://example.invalid/no-format", width: 2, height: 1 }, 0, rgbaScope);
assert.equal(inferred.file.mimeType, "image/png"); assert.equal(inferred.body.fromCache, false);
const native = await service.decode(inferred.body, inferred.file, rgbaScope); inferred.body.release();
const pixels = await readbackDecodedImage({ broker: rgbaBroker, scope: rgbaScope, image: native, priority: 0, label: "installed map", createSurface() {
  assert.equal(rgbaBroker.pools.stats().decoded.reserved, 24);
  return { read: () => new Uint8ClampedArray(8), dispose() { surfaceCloses++; } };
} });
assert.equal(surfaceCloses, 1); assert.equal(nativeBitmapCloses, 0); native.close(); assert.equal(nativeBitmapCloses, 1);
const nativePixels = pixels.retain(); rgbaBroker.dispose(); assert.equal(rgbaBroker.pools.stats().decoded.reserved, 8); assert.equal(pixels.data.length, 8);
nativePixels(); nativePixels(); pixels.close(); assert.deepEqual(rgbaBroker.pools.live(), []);
assert.throws(() => pixels.data, /closed/);
const failedBroker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 1000, decoded: 100, sourceGpu: 100, uploadOutstanding: 100, overlap: 100 } });
const failedService = createImageFileService({ broker: failedBroker, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }), priority: () => 0, fetch: async () => new Response(null, { status: 204 }), decode: async () => { throw new Error("Must not decode status."); } });
await assert.rejects(failedService.obtainInferred({ url: "https://example.invalid/missing", width: 2, height: 1 }, 0, failedBroker.scope()), error => error instanceof ImageHttpStatusError && error.status === 204);
failedBroker.dispose(); assert.deepEqual(failedBroker.pools.live(), []);
const canvasPixels = new Uint8ClampedArray(8), borrowedCanvas = { width: 2, height: 1, getContext() { return { drawImage() {}, getImageData() { return { data: canvasPixels }; } }; } };
const realmSurface = createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => borrowedCanvas });
assert.equal(realmSurface.read({ width: 2, height: 1 }), canvasPixels); realmSurface.dispose(); assert.equal(borrowedCanvas.width, 0); assert.equal(borrowedCanvas.height, 0);
// Actual common accounting retains a partially constructed canvas until reset proof.
{
const failedBroker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 1000, decoded: 100, sourceGpu: 100, uploadOutstanding: 100, overlap: 100 } });
const failedScope = failedBroker.scope();
const failedService = createImageFileService({ broker: failedBroker, priority: () => 0, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }), fetch: async () => new Response(png), decode: async () => ({ width: 2, height: 1, close() {} }) });
const failedBody = await failedService.obtainInferred({ url: "https://example.invalid/canvas", width: 2, height: 1 }, 0, failedScope);
const failedImage = await failedService.decode(failedBody.body, failedBody.file, failedScope); failedBody.body.release();
let failedWidth = 2, failedHeight = 1, resetFails = true;
const failedCanvas = {
  get width() { return failedWidth; }, set width(value) { if (value === 0 && resetFails) throw new Error("width reset"); failedWidth = value; },
  get height() { return failedHeight; }, set height(value) { if (value === 0 && resetFails) throw new Error("height reset"); failedHeight = value; },
  getContext: () => null,
};
const failedSurface = await readbackDecodedImage({ broker: failedBroker, scope: failedScope, image: failedImage, priority: 0, label: "installed canvas failure", createSurface: () => createCanvasRgbaSurface({ width: 2, height: 1, createCanvas: () => failedCanvas }) }).catch(error => error);
assert.ok(failedSurface instanceof RgbaSurfaceCreationError);
failedScope.dispose(); failedBroker.dispose(); assert.equal(failedBroker.pools.stats().decoded.reserved, 8);
resetFails = false; failedSurface.retryCleanup(); await failedSurface.retired;
assert.deepEqual(failedBroker.pools.live(), []);
}
console.log("Installed images root/browser/node imports, codec/color round trip, retained decoded/RGBA resources and canvas retirement, inferred headers, typed dimensions, HTTP status and shared broker passed.");
