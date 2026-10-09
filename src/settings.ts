/** Common resource controls; the host registers these in its one SettingsRegistry. */
import { MIB, rgba8Bytes } from "./bytes.js";
import type { DerivedDefault, DeviceContext, ParameterSpec, ParameterUnit } from "@foss-earth/ui/settings";

export const IMAGE_RESOURCES_TAB = "scenes";
const SCENES_TAB = IMAGE_RESOURCES_TAB;
const RESOURCES = "src/scenes/panoramaResources.ts";
const PROVISIONAL = "A provisional development value chosen to exercise a bounded path; not measured on a device.";

/** WebGPU's default largest texture side, assumed until the renderer reports its own. */
const DEFAULT_TEXTURE_SIDE = 8192;
/** Room for orb previews: 64 cubes of 256 px faces, 2 MiB each with mips. */
const PREVIEW_ROOM_MIB = 128;
/** Room for preview faces decoding while a whole image arrives: ten 256 px cubes. */
const PREVIEW_DECODE_MIB = 16;

/** Common widest-image cost forecast from the renderer texture limit; no representation is selected. */
export function imageResourceForecast(context: DeviceContext): { width: number; from: string } {
  return context.maxTextureSize
    ? { width: context.maxTextureSize, from: `this renderer's ${context.maxTextureSize} px texture limit` }
    : { width: DEFAULT_TEXTURE_SIDE, from: `${DEFAULT_TEXTURE_SIDE} px, WebGPU's default texture limit, until the renderer reports its own` };
}
/** GPU MiB of that image with its mips. */
const widestGpuMiB = (width: number): number => rgba8Bytes(width, width / 2) / MIB;
/** Decoded MiB of that image: four bytes a pixel. */
const widestDecodedMiB = (width: number): number => (4 * width * (width / 2)) / MIB;

interface Quantity {
  id: string;
  label: string;
  description: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  fallback: number;
  reason: string;
  tab?: string;
  section: string;
  source: string;
  level?: "main" | "all";
  scale?: "linear" | "log2";
  step?: number;
}

function quantity(spec: Quantity): ParameterSpec {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    unit: spec.unit,
    kind: "number",
    bounds: () => ({ min: spec.min, max: spec.max }),
    scale: spec.scale ?? "linear",
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    default: spec.fallback,
    defaultReason: spec.reason,
    home: { tab: spec.tab ?? SCENES_TAB, section: spec.section, level: spec.level ?? "main" },
    appliesLive: true,
    source: spec.source,
  };
}

/** A default no larger than the parameter's bound. */
function capped(value: number, max: number): number { return Math.min(max, Math.ceil(value)); }

export interface ImageResourceSettingsPorts {
  /** Preserve the owner's device-derived kept-source policy, with no tile implementation import. */
  keptGpuDefault(context: DeviceContext): DerivedDefault<number>;
}

/** Existing IDs, reasons, bounds and homes. No registration or device probing. */
export function createImageResourceParameters(ports: ImageResourceSettingsPorts): readonly ParameterSpec[] {
const LOADING: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.sourceGpuMiB", label: "Panorama GPU memory",
    description: "GPU memory for panorama images and their mips: the orbs' previews, the image on screen and a sharper one replacing it.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 1, max: 4096 }), step: 0.25, scale: "log2",
    default: context => {
      const { width, from } = imageResourceForecast(context);
      return { value: capped(PREVIEW_ROOM_MIB + 2 * widestGpuMiB(width), 4096), derivedFrom: `${PREVIEW_ROOM_MIB} MiB of previews and two ${width} px images with mips, for ${from}` };
    },
    defaultReason: `Room for the orbs' previews (${PREVIEW_ROOM_MIB} MiB: 64 cubes of 256 px faces) and two of the widest images the renderer can hold, the one on screen and a sharper one replacing it, so no panorama stays below the largest image it offers.`,
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  {
    id: "scene.panorama.keptGpuMiB", label: "Kept on the GPU when not shown",
    description: "GPU memory that panorama images no longer on screen may keep, so that going back to them shows them at once: the tiles of a panorama you left, a preview an orb no longer shows. Past this, the ones unused longest are given up first. Their files stay in the saved images, so going back reads them from the disk, not the network. 0 keeps only what is on screen. Part of the panorama GPU memory.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 0, max: 4096 }), step: 0.25, scale: "linear",
    default: ports.keptGpuDefault,
    defaultReason: "Where the tile memory holds every tile of a panorama, the tiles of the one you left, so going back to it is immediate. Where it holds less, nothing: the GPU holds only what you look at, and going back reads the tiles from the saved images, which took 0.4 to 0.8 s a view on the UMN tour's build (docs/proposals/panorama-scenes.md, \"Loading once\").",
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  {
    id: "scene.panorama.overlapMiB", label: "Replacement overlap",
    description: "How much of the panorama GPU memory an incoming image may hold while the outgoing one is still shown. Part of that memory, never extra.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 0, max: 4096 }), step: 1, scale: "linear",
    default: context => {
      const { width, from } = imageResourceForecast(context);
      return { value: capped(widestGpuMiB(width), 4096), derivedFrom: `one ${width} px image with mips, for ${from}` };
    },
    defaultReason: "One of the widest images the renderer can hold, with mips: the largest sharper image that can replace the one on screen.",
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  {
    id: "scene.panorama.decodedMiB", label: "Decoded images",
    description: "Memory for images decoded and waiting to be copied to the GPU, reserved from each image's header before it is decoded.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 1, max: 2048 }), step: 0.25, scale: "log2",
    default: context => {
      const { width, from } = imageResourceForecast(context);
      return { value: capped(widestDecodedMiB(width) + PREVIEW_DECODE_MIB, 2048), derivedFrom: `one ${width} × ${width / 2} image and ${PREVIEW_DECODE_MIB} MiB of preview faces, for ${from}` };
    },
    defaultReason: `One decoded image as wide as the renderer can hold, four bytes a pixel, and ${PREVIEW_DECODE_MIB} MiB for preview faces decoding while it arrives.`,
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  quantity({
    id: "scene.panorama.encodedMiB", label: "Downloaded images", unit: "MiB", min: 1, max: 512, fallback: 32, scale: "log2", step: 0.25, section: "loading",
    description: "Downloaded image files held or arriving before they are decoded.", reason: "Bounds response storage. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.responseMiB", label: "Largest image file", unit: "MiB", min: 0.25, max: 256, fallback: 16, scale: "log2", step: 0.25, section: "loading", level: "all",
    description: "A single image file larger than this is stopped while it downloads. Never more than Downloaded images.",
    reason: "Catches an oversized response early. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.requests", label: "Image requests at once", unit: "count", min: 1, max: 32, fallback: 16, step: 1, section: "loading",
    description: "Preview and whole-image downloads in flight at the same time; tiles have their own count. An orb's preview is six small files, which wait on the connection's round trips, not on its bandwidth, so more at once shows a scene's orbs sooner. Files already saved are read from the disk and do not count.",
    reason: "Sixteen showed every orb of a 60-panorama tour in 3 s on its HTTP/2 host, where four took 6 to 19 s (docs/proposals/panorama-scenes.md, \"Loading once\"). Over HTTP/1.1 the browser sends six at once whatever this says.", source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.decodes", label: "Image decodes at once", unit: "count", min: 1, max: 8, fallback: 1, step: 1, section: "loading", level: "all",
    description: "Images the browser decodes at the same time.", reason: "One prevents decode bursts. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.uploadMiBPerFrame", label: "Upload per frame", unit: "MiB", min: 0.25, max: 64, fallback: 4, scale: "log2", step: 0.25, section: "loading",
    description: "Image data copied to the GPU in one frame; a larger image is copied in rows over several frames.",
    reason: "Bounds upload work per frame; it is not a timing guarantee. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.uploadOutstandingMiB", label: "Uploads in flight", unit: "MiB", min: 0.25, max: 256, fallback: 16, scale: "log2", step: 0.25, section: "loading", level: "all",
    description: "Image data submitted to the GPU and not yet confirmed complete.", reason: "Bounds outstanding staging. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.requestTimeout", label: "Image request timeout", unit: "s", min: 1, max: 120, fallback: 30, step: 1, section: "loading", level: "all",
    description: "An image download that takes longer is stopped and reported; retrying is by hand.", reason: "Recovers from a hanging load.", source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.prefetchCount", label: "Linked panoramas loaded ahead", unit: "count", min: 0, max: 8, fallback: 0, step: 1, section: "loading",
    description: "How many panoramas linked from the one you are in may be loaded before you follow a link. Both this and the size below must allow it.",
    reason: "None: no speculative transfer unless you ask for it.", source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.prefetchMiB", label: "Loaded ahead, most", unit: "MiB", min: 0, max: 128, fallback: 0, step: 0.25, section: "loading",
    description: "Downloaded bytes spent on linked panoramas before you follow a link, per panorama you are in.",
    reason: "None: no speculative transfer unless you ask for it.", source: RESOURCES,
  }),
];

/** One panorama's tiles as the tools prepare them, MiB: 510 tiles, 6.5 KB each at the finest level. */
const TILED_PANORAMA_MIB = 3.3;
/** The saved images' default limit, MiB. */
const SAVED_MIB = 256;

/**
 * Scenes → Saved images: what is kept on disk between visits
 * (src/scenes/mediaStore.ts), so that no file is downloaded twice.
 */
const SAVED: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.savedMiB", label: "Saved images", unit: "MiB", min: 0, max: 4096, fallback: SAVED_MIB, step: 1, section: "saved",
    description: "Disk space for the scene images the app keeps between visits: orb previews, tiles and whole images. Each file is kept under its image's revision, so it is downloaded once; a reload, a later visit and a look back at part of a 360 image read it from the disk. Past this, the images unused longest go first, whole. 0 keeps nothing.",
    reason: `Room for the tiles of about ${Math.floor(SAVED_MIB / TILED_PANORAMA_MIB)} panoramas looked all around, ${TILED_PANORAMA_MIB} MiB each as the tools prepare them, with every orb's previews; only what was looked at is kept.`,
    source: "src/scenes/mediaStore.ts",
  }),
];

  return [...LOADING, ...SAVED];
}

export const IMAGE_RESOURCE_SECTION_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  [IMAGE_RESOURCES_TAB, "loading", "Loading and memory"],
  [IMAGE_RESOURCES_TAB, "saved", "Saved images"],
];
