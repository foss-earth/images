import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, rgba8Bytes, type ImageFile } from "../index.js";
import type { EncodedImageFile, HeldDecodedImage } from "./transport.js";
import type { WholeImagePorts, WholeImageTexture } from "./loadPorts.js";
import { loadWholeImage, type WholeImageLoad } from "./wholeImage.js";

const file: ImageFile = { url: "https://example.invalid/photo.png", mimeType: "image/png", width: 6, height: 3 };
function fixture() {
  const broker = createImageSessionBroker({ pools: { encoded: 10000, decoded: 10000, sourceGpu: 10000, uploadOutstanding: 10000, overlap: 10000 }, requests: 1, decodes: 1 });
  const body: EncodedImageFile = { bytes: new Uint8Array([1]), contentType: "image/png", release: vi.fn() };
  const pixels: HeldDecodedImage = { image: { width: 6, height: 3 } as ImageBitmap, close: vi.fn() };
  const texture: WholeImageTexture = { dispose: vi.fn() };
  const ports: WholeImagePorts<WholeImageTexture> = { broker, scope: broker.scope(), maxTextureSide: 4096, overlap: true,
    obtain: vi.fn(async () => body), decode: vi.fn(async () => pixels), whenReady: async (_value, signal) => signal.throwIfAborted() };
  const load: WholeImageLoad<WholeImageTexture> = { file, encodedBytes: 10, label: "fixture", kind: "rectangle image",
    estimate: () => ({ encoded: 10, decoded: 72, sourceGpu: rgba8Bytes(6, 3), uploadOutstanding: 72 }),
    upload: vi.fn(async () => texture) };
  return { broker, body, pixels, texture, ports, load };
}

describe("whole-image loading", () => {
  it("reads, decodes and uploads one file, holding overlap until the host settles the replacement", async () => {
    const h = fixture(), loaded = await loadWholeImage(h.load, h.ports);
    expect(h.ports.obtain).toHaveBeenCalledWith(file, 10);
    expect(h.ports.decode).toHaveBeenCalledWith(h.body, file);
    expect(h.load.upload).toHaveBeenCalledWith(h.pixels.image, "fixture");
    expect(h.body.release).toHaveBeenCalledOnce(); expect(h.pixels.close).toHaveBeenCalledOnce();
    expect(h.broker.pools.stats().overlap.reserved).toBe(rgba8Bytes(6, 3));
    loaded.settleReplacement(); loaded.settleReplacement();
    expect(h.broker.pools.stats().overlap.reserved).toBe(0);
    loaded.dispose(); loaded.dispose();
    expect(h.texture.dispose).toHaveBeenCalledOnce(); expect(h.broker.pools.live()).toHaveLength(0); h.broker.dispose();
  });
  it("refuses GPU capacity or an estimate before reading anything, and ends the scope", async () => {
    const h = fixture();
    h.broker.setLimits({ pools: { encoded: 10000, decoded: 10000, sourceGpu: 0, uploadOutstanding: 10000, overlap: 0 }, requests: 1, decodes: 1 });
    await expect(loadWholeImage(h.load, h.ports)).rejects.toThrow(/sourceGpu/);
    expect(h.ports.obtain).not.toHaveBeenCalled();
    const g = fixture();
    g.load.estimate = () => { throw new RangeError("too wide"); };
    await expect(loadWholeImage(g.load, g.ports)).rejects.toThrow("too wide");
    expect(g.ports.obtain).not.toHaveBeenCalled(); expect(g.ports.scope.isCurrent()).toBe(false);
    h.broker.dispose(); g.broker.dispose();
  });
  it("disposes an upload that arrives after replacement and names the representation", async () => {
    const h = fixture(); let arrive!: (texture: WholeImageTexture) => void;
    h.load.upload = vi.fn(() => new Promise(resolve => { arrive = resolve; }));
    const pending = loadWholeImage(h.load, h.ports), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(h.load.upload).toHaveBeenCalledOnce());
    h.ports.scope.dispose(); arrive(h.texture); await rejected;
    expect(h.texture.dispose).toHaveBeenCalledOnce(); expect(h.pixels.close).toHaveBeenCalledOnce();
    expect(h.broker.pools.live()).toHaveLength(0); h.broker.dispose();
  });
  it("keeps the native input held until a late upload has settled", async () => {
    const h = fixture(); const release = vi.fn(); let arrive!: (texture: WholeImageTexture) => void;
    h.pixels.retain = vi.fn(() => release);
    h.load.upload = vi.fn(() => new Promise(resolve => { arrive = resolve; }));
    const pending = loadWholeImage(h.load, h.ports);
    await vi.waitFor(() => expect(h.load.upload).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    arrive(h.texture); const loaded = await pending;
    expect(release).toHaveBeenCalledOnce();
    loaded.dispose(); h.broker.dispose();
  });
  it("reports every cleanup failure after a readiness failure", async () => {
    const h = fixture(); h.ports.whenReady = async () => { throw new Error("renderer not ready"); };
    h.pixels.close = vi.fn(() => { throw new Error("pixel cleanup"); });
    const error = await loadWholeImage(h.load, h.ports).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe("Rectangle image loading and cleanup failed.");
    expect((error as AggregateError).errors.map(item => (item as Error).message)).toEqual(["renderer not ready", "pixel cleanup"]);
    expect(h.texture.dispose).toHaveBeenCalledOnce(); expect(h.broker.pools.live()).toHaveLength(0); h.broker.dispose();
  });
});
