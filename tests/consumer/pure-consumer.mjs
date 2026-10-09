import assert from "node:assert/strict";
for (const name of ["document", "window", "navigator", "localStorage", "indexedDB", "Worker", "OffscreenCanvas", "createImageBitmap", "GPU", "GPUDevice"]) {
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Eager browser/device access: ${name}`); } });
}
const entry = process.argv[2];
if (entry === "root") {
  const images = await import("@foss-earth/images");
  assert.equal(typeof images.createImageSessionBroker, "function");
  assert.equal(typeof images.imageDimensionMismatch, "function");
  assert.equal(images.readImageHeader(new Uint8Array([1, 2, 3])), null);
} else if (entry === "browser") {
  const browser = await import("@foss-earth/images/browser");
  for (const name of ["createImageFileService", "fetchImageFile", "decodeImageFile", "readbackDecodedImage", "createCanvasRgbaSurface", "openIndexedDbBackend"]) assert.equal(typeof browser[name], "function");
} else if (entry === "shaders") {
  const shaders = await import("@foss-earth/images/shaders");
  for (const name of ["SRGB_ENCODE_WGSL", "SRGB_ENCODE_GLSL", "SRGB_DECODE_GLSL"]) assert.match(shaders[name], /panoramaSrgb/);
} else assert.fail("Unknown pure entry fixture.");
console.log(`Installed pure ${entry} imports without DOM, codec/UI/feature peers or device initialization.`);
