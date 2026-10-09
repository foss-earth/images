import { describe, expect, it, vi } from "vitest";
import type { DeviceContext } from "@foss-earth/ui/settings";
import { createImageResourceParameters, imageResourceForecast, IMAGE_RESOURCE_SECTION_TITLES } from "./settings.js";
import { MIB, rgba8Bytes } from "./bytes.js";

const context = (maxTextureSize: number | null): DeviceContext => ({ rendererMode: null, maxTextureSize, devicePixelRatio: 1, hardwareConcurrency: null, deviceMemoryGiB: null, touch: false, frameTimeMs: null, refreshIntervalMs: null, rendererDevicePixels: null });

describe("common image resource parameters", () => {
  it("preserves device-derived image budgets and their original reasons", () => {
    const specs = createImageResourceParameters({ keptGpuDefault: () => ({ value: 76, derivedFrom: "host owner atlas policy" }) });
    for (const side of [null, 8192, 16384, 32768]) {
      const device = context(side), width = side ?? 8192;
      const number = (id: string): number => { const value = specs.find(spec => spec.id === `scene.panorama.${id}`)!.default; return (typeof value === "function" ? value(device).value : value) as number; };
      expect(number("sourceGpuMiB")).toBe(Math.min(4096, Math.ceil(128 + 2 * rgba8Bytes(width, width / 2) / MIB)));
      expect(number("overlapMiB")).toBe(Math.min(4096, Math.ceil(rgba8Bytes(width, width / 2) / MIB)));
      expect(number("decodedMiB")).toBe(Math.min(2048, Math.ceil(4 * width * (width / 2) / MIB + 16)));
      expect(number("keptGpuMiB")).toBe(76);
    }
    expect(imageResourceForecast(context(null))).toEqual({ width: 8192, from: "8192 px, WebGPU's default texture limit, until the renderer reports its own" });
    expect(specs.find(spec => spec.id === "scene.panorama.requests")!.description).toContain("Files already saved are read from the disk and do not count");
  });
  it("injects kept-source policy and omits preview, tiled, viewer and scene-only controls", () => {
    const keptGpuDefault = vi.fn(() => ({ value: 0, derivedFrom: "host supplied" }));
    const specs = createImageResourceParameters({ keptGpuDefault });
    expect(keptGpuDefault).not.toHaveBeenCalled();
    const ids = specs.map(spec => spec.id.split(".").at(-1));
    expect(ids).toEqual(["sourceGpuMiB", "keptGpuMiB", "overlapMiB", "decodedMiB", "encodedMiB", "responseMiB", "requests", "decodes", "uploadMiBPerFrame", "uploadOutstandingMiB", "requestTimeout", "prefetchCount", "prefetchMiB", "savedMiB"]);
    for (const spec of specs) {
      expect(spec.home.tab).toBe("scenes"); expect(["loading", "saved"]).toContain(spec.home.section);
      expect(spec.appliesLive).toBe(true); expect(spec.defaultReason.length).toBeGreaterThan(0);
    }
    expect(specs.at(-1)).toMatchObject({ id: "scene.panorama.savedMiB", default: 256, unit: "MiB", home: { tab: "scenes", section: "saved" } });
    expect(IMAGE_RESOURCE_SECTION_TITLES).toEqual([["scenes", "loading", "Loading and memory"], ["scenes", "saved", "Saved images"]]);
  });
});
