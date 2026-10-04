/**
 * Loads panorama representations within the user's budgets (§4): bounded
 * requests, header-checked decodes and chunked uploads, each reserved
 * before it is spent and released exactly once. Sources are shared and
 * reference counted; unreferenced ones stay for reuse, as many as the kept
 * allowance holds, until a reservation needs their room, least recently used
 * first.
 *
 * Nothing here draws. The GPU side is injected, so the accounting is tested
 * without a device.
 */
import type { CubeFaceName } from "./panoramaMath";
import { CUBE_FACE_NAMES } from "./panoramaMath";
import type { ResolvedAsset, ResolvedRepresentation, ResolvedSheetPlace, ResolvedTiledCube } from "./format";
import {
  MIB,
  createResourcePools,
  representationAroundPx,
  representationGpuBytes,
  representationMaxSide,
  tileAtlasLayout,
  type PoolLimits,
  type PoolName,
  type Reservation,
  type ResourcePools,
  type TileAtlasLayout,
} from "./budget";
import { checkImage, type ImageKind } from "./imageHeaders";
import { mediaGroup, type MediaGroup, type MediaStore, type SavedFiles } from "./mediaStore";

/** A texture on the GPU, as the renderer's uploader makes it, or a tiled cube's atlas. */
export interface GpuSource {
  readonly kind: "cube" | "equirectangular" | "tiles";
  readonly gpuBytes: number;
  dispose(): void;
}

export interface ResourceBackend<Texture extends GpuSource = GpuSource> {
  fetch(url: string, init: RequestInit): Promise<Response>;
  decode(bytes: Uint8Array, mimeType: ImageKind): Promise<ImageBitmap>;
  uploadCube(faces: Readonly<Record<CubeFaceName, ImageBitmap>>, label: string): Promise<Texture>;
  /** A rectangle of a decoded image as an image of its own: a cube's face out of a preview sheet. Left out, sheets are not read. */
  crop?(image: ImageBitmap, x: number, y: number, width: number, height: number): Promise<ImageBitmap>;
  uploadEquirect(image: ImageBitmap, label: string): Promise<Texture>;
  /**
   * A tiled cube's atlas laid out as `layout`, with its scheduler; it fetches
   * its own tiles as it is shown, from `saved` where they were kept before.
   */
  createTiles(representation: ResolvedTiledCube, layout: TileAtlasLayout, label: string, saved: SavedFiles | null): Promise<Texture>;
  /** The device's largest texture side, px. */
  maxTextureSide(): number;
  /** Images kept between visits: read before the network is asked, added to after. Left out, nothing is kept. */
  media?: MediaStore;
}

/** Every value the `scene.panorama.*` loading parameters set. */
export interface ResourceSettings {
  limits: PoolLimits;
  /** One response's bytes: `responseMiB`. */
  responseBytes: number;
  /** Concurrent requests and decodes: `requests`, `decodes`. */
  requests: number;
  decodes: number;
  timeoutMs: number;
  /** The widest immersion image, px around the turn: `immersionWidth`. Infinite at the parameter's largest. */
  immersionWidth: number;
  /** A tiled cube's atlas: `tileMemoryMiB`. */
  tileMemoryBytes: number;
  /** GPU bytes that sources nobody holds may keep for a quick return: `keptGpuMiB`. */
  keptBytes: number;
  /** Whether a cube with a place in a preview sheet loads from the sheet: `previewSheets`. */
  previewSheets: boolean;
}

export interface SourceHandle<Texture extends GpuSource = GpuSource> {
  readonly texture: Texture;
  readonly representation: ResolvedRepresentation;
  readonly key: string;
  /** A tiled cube's preview cube, held with it: what shows where no tile has arrived. */
  readonly fallback?: SourceHandle<Texture>;
  /** Idempotent. The source stays cached until its room is needed. */
  release(): void;
}

export type ResourceLimiter = PoolName | "overlap" | "device" | "immersionWidth" | "response" | "file" | "timeout" | "network";

/** A load refused or failed, naming the limit or cause, for the list's message. */
export class ResourceRefusal extends Error {
  readonly limiter: ResourceLimiter;
  constructor(message: string, limiter: ResourceLimiter) {
    super(message);
    this.name = "ResourceRefusal";
    this.limiter = limiter;
  }
}

export interface ResourceStats {
  pools: ReturnType<ResourcePools["stats"]>;
  cachedSources: number;
  referencedSources: number;
  activeRequests: number;
  queuedRequests: number;
  activeDecodes: number;
  queuedDecodes: number;
  largestResponseBytes: number;
  rejectedResponses: number;
  /** Bytes that arrived from the network. */
  transferredBytes: number;
  /** Files, and their bytes, that came from the images kept between visits instead. */
  reusedFiles: number;
  reusedBytes: number;
  /** Cubes whose faces came out of a preview sheet, not their own six files. */
  cubesFromSheets: number;
  /** Sources nobody holds that stay on the GPU for a quick return, and their bytes. */
  keptSources: number;
  keptBytes: number;
}

/** Download bytes for one representation; cube faces share one total. */
export interface ResourceProgress {
  id: string;
  assetId: string;
  representation: ResolvedRepresentation;
  receivedBytes: number;
  totalBytes: number;
  state: "loading" | "ready" | "failed" | "cancelled";
}

interface Entry<Texture extends GpuSource> {
  key: string;
  asset: ResolvedAsset;
  representation: ResolvedRepresentation;
  refs: number;
  waiting: number;
  lastUsed: number;
  controller: AbortController;
  promise: Promise<Texture>;
  texture: Texture | null;
  gpu: Reservation | null;
  receivedBytes: number;
  progressState: ResourceProgress["state"];
}

/** A counting semaphore that lets higher priorities through first. */
function createLimiter(limit: () => number) {
  let active = 0;
  const queue: { priority: number; start: () => void; signal: AbortSignal }[] = [];
  const pump = (): void => {
    while (active < limit() && queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const next = queue.shift()!;
      if (next.signal.aborted) continue;
      active += 1;
      next.start();
    }
  };
  return {
    async run<T>(priority: number, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      if (signal.aborted) throw abortError(signal);
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = queue.indexOf(entry);
          if (index >= 0) { queue.splice(index, 1); reject(signal.reason); }
        };
        const entry = { priority, start: () => { signal.removeEventListener("abort", onAbort); resolve(); }, signal };
        queue.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
        pump();
      });
      try {
        if (signal.aborted) throw abortError(signal);
        return await work();
      } finally { active -= 1; pump(); }
    },
    stats: () => ({ active, queued: queue.length }),
    pump,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Cancelled.", "AbortError");
}

/** `tileSlots` tells two atlases of one tiled cube apart: another tile memory makes another source. */
export function sourceKey(asset: ResolvedAsset, representation: ResolvedRepresentation, generation: number, tileSlots = 0): string {
  const urls = representation.projection === "cube" ? CUBE_FACE_NAMES.map(face => representation.faces[face]).join(" ")
    : representation.projection === "tiled-cube" ? `${representation.url} ${tileSlots} slots` : representation.url;
  return `${asset.id}@${asset.revision}/${representation.id}#${generation} ${urls}`;
}

export function createPanoramaResources<Texture extends GpuSource>(backend: ResourceBackend<Texture>, initial: ResourceSettings, onProgress?: (progress: ResourceProgress) => void) {
  let settings = initial;
  const pools = createResourcePools(settings.limits);
  const entries = new Map<string, Entry<Texture>>();
  const requests = createLimiter(() => settings.requests);
  const decodes = createLimiter(() => settings.decodes);
  let generation = 0;
  let tick = 0;
  let disposed = false;
  let largestResponseBytes = 0;
  let rejectedResponses = 0;
  let transferredBytes = 0;
  let reusedFiles = 0;
  let reusedBytes = 0;
  let cubesFromSheets = 0;

  /** Loaded sources nobody holds, least recently used first. */
  const idleSources = (): Entry<Texture>[] => [...entries.values()].filter(entry => entry.refs === 0 && entry.waiting === 0 && entry.texture).sort((a, b) => a.lastUsed - b.lastUsed);

  /** Frees unreferenced sources, least recently used first, until `bytes` fits. */
  function makeRoom(pool: PoolName, bytes: number, overlap: boolean): void {
    if (pool !== "sourceGpu") return;
    for (const entry of idleSources()) {
      if (pools.fits(pool, bytes, { overlap })) return;
      evict(entry);
    }
  }

  /** Frees unreferenced sources, least recently used first, until what they keep is within `keptBytes`. */
  function trimKept(): void {
    const idle = idleSources();
    let kept = idle.reduce((sum, entry) => sum + (entry.gpu?.bytes ?? 0), 0);
    for (const entry of idle) {
      if (kept <= settings.keptBytes) return;
      kept -= entry.gpu?.bytes ?? 0;
      evict(entry);
    }
  }

  function evict(entry: Entry<Texture>): void {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (!entry.texture) publish(entry, entry.asset, "cancelled");
    entry.controller.abort(new DOMException("Evicted.", "AbortError"));
    entry.texture?.dispose();
    entry.texture = null;
    entry.gpu?.release();
    entry.gpu = null;
  }

  function gpuRoom(): number {
    const idle = [...entries.values()].filter(entry => entry.refs === 0 && entry.waiting === 0 && entry.gpu).reduce((sum, entry) => sum + (entry.gpu?.bytes ?? 0), 0);
    return pools.limits().sourceGpu - pools.stats().sourceGpu.reserved + idle;
  }

  function reserve(pool: PoolName, bytes: number, label: string, overlap = false): Reservation {
    let result = pools.reserve(pool, bytes, label, { overlap });
    if (!result.ok) {
      makeRoom(pool, bytes, overlap);
      result = pools.reserve(pool, bytes, label, { overlap });
    }
    if (!result.ok) throw new ResourceRefusal(result.reason, result.pool);
    return result.reservation;
  }

  async function fetchFile(url: string, declaredBytes: number, grow: (bytes: number) => boolean, signal: AbortSignal, receivedChunk: (bytes: number) => void): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const timeout = AbortSignal.timeout(settings.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await backend.fetch(url, { credentials: "omit", mode: "cors", signal: combined });
    } catch (error) {
      if (timeout.aborted) throw new ResourceRefusal(`${url} did not arrive within ${Math.round(settings.timeoutMs / 1000)} s (scene.panorama.requestTimeout)`, "timeout");
      if (signal.aborted) throw abortError(signal);
      throw new ResourceRefusal(`${url} could not be fetched: ${error instanceof Error ? error.message : String(error)}`, "network");
    }
    if (!response.ok) throw new ResourceRefusal(`${url} answered ${response.status}`, "network");
    const announced = Number(response.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > settings.responseBytes) {
      rejectedResponses += 1;
      void response.body?.cancel();
      throw new ResourceRefusal(`${url} is ${announced} bytes, over the ${settings.responseBytes}-byte response limit (scene.panorama.responseMiB)`, "response");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ResourceRefusal(`${url} has no body`, "network");
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        transferredBytes += value.byteLength;
        receivedChunk(value.byteLength);
        if (received > settings.responseBytes) {
          rejectedResponses += 1;
          throw new ResourceRefusal(`${url} passed the ${settings.responseBytes}-byte response limit while arriving (scene.panorama.responseMiB)`, "response");
        }
        // Past the declared size, the encoded reservation grows or the read stops.
        if (received > declaredBytes && !grow(Math.min(value.byteLength, received - declaredBytes))) {
          rejectedResponses += 1;
          throw new ResourceRefusal(`${url} is larger than declared and passed the encoded-bytes limit (scene.panorama.encodedMiB)`, "encoded");
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      if (timeout.aborted) throw new ResourceRefusal(`${url} did not finish within ${Math.round(settings.timeoutMs / 1000)} s (scene.panorama.requestTimeout)`, "timeout");
      if (signal.aborted) throw abortError(signal);
      throw error;
    }
    largestResponseBytes = Math.max(largestResponseBytes, received);
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return { bytes, contentType: response.headers.get("content-type") };
  }

  // ─── Preview sheets ─────────────────────────────────────────────────
  /** A sheet decoding or decoded, shared by every cube loading from it and closed when the last lets go. */
  interface SheetUse {
    key: string;
    users: number;
    controller: AbortController;
    image: Promise<ImageBitmap>;
    bitmap: ImageBitmap | null;
    decoded: Reservation | null;
  }
  const sheetUses = new Map<string, SheetUse>();
  /** Sheets that failed: their cubes load from their own files for the rest of the visit. */
  const failedSheets = new Set<string>();
  const sheetKey = (sheet: ResolvedSheetPlace): string => `${sheet.id}@${sheet.revision} ${sheet.url}`;
  const sheetGroup = (sheet: ResolvedSheetPlace): MediaGroup => ({ id: `sheet ${sheet.id}@${sheet.revision}`, label: `${sheet.id} · preview sheet` });

  function closeSheet(use: SheetUse): void {
    if (sheetUses.get(use.key) === use) sheetUses.delete(use.key);
    use.controller.abort(new DOMException("No orb is waiting for the sheet.", "AbortError"));
    use.bitmap?.close();
    use.bitmap = null;
    use.decoded?.release();
    use.decoded = null;
  }

  async function loadSheet(sheet: ResolvedSheetPlace, use: SheetUse, priority: number): Promise<ImageBitmap> {
    const signal = use.controller.signal;
    const saved = backend.media?.files(sheetGroup(sheet)) ?? null;
    const encoded = reserve("encoded", sheet.encodedBytes, `${sheet.id} encoded`);
    let extra = 0;
    const grow = (bytes: number): boolean => {
      if (!encoded.resize(sheet.encodedBytes + extra + bytes)) return false;
      extra += bytes;
      return true;
    };
    const headerProblem = (body: { bytes: Uint8Array; contentType: string | null }): string | null =>
      checkImage(body.bytes, { mimeType: sheet.mimeType, width: sheet.width, height: sheet.height }, body.contentType);
    try {
      let body = saved ? await saved.get(sheet.url) : null;
      if (signal.aborted) throw abortError(signal);
      if (body && headerProblem(body)) { saved!.forget(sheet.url); body = null; }
      const kept = body !== null;
      if (body) {
        if (body.bytes.byteLength > sheet.encodedBytes && !grow(body.bytes.byteLength - sheet.encodedBytes)) throw new ResourceRefusal(`${sheet.url} is larger than declared and passed the encoded-bytes limit (scene.panorama.encodedMiB)`, "encoded");
        reusedFiles += 1;
        reusedBytes += body.bytes.byteLength;
      } else {
        body = await requests.run(priority, signal, () => fetchFile(sheet.url, sheet.encodedBytes, grow, signal, () => {}));
        const problem = headerProblem(body);
        if (problem) throw new ResourceRefusal(`${sheet.url} ${problem}`, "file");
        saved?.put(sheet.url, body.bytes, body.contentType);
      }
      // Held decoded for as long as cubes are cut from it.
      use.decoded = reserve("decoded", 4 * sheet.width * sheet.height, `${sheet.id} decoded`);
      const bytes = body.bytes;
      const bitmap = await decodes.run(priority, signal, () => backend.decode(bytes, sheet.mimeType)).catch(error => {
        if (kept && !signal.aborted) saved!.forget(sheet.url);
        throw error;
      });
      if (signal.aborted) {
        bitmap.close();
        throw abortError(signal);
      }
      return bitmap;
    } finally {
      encoded.release();
    }
  }

  /** The sheet's decoded image for one cube, which lets go of it when it has its faces. */
  function holdSheet(sheet: ResolvedSheetPlace, priority: number): { image: Promise<ImageBitmap>; release(): void } {
    const key = sheetKey(sheet);
    let use = sheetUses.get(key);
    if (!use) {
      const created: SheetUse = { key, users: 0, controller: new AbortController(), image: null as unknown as Promise<ImageBitmap>, bitmap: null, decoded: null };
      created.image = loadSheet(sheet, created, priority).then(bitmap => {
        created.bitmap = bitmap;
        return bitmap;
      }, error => {
        const cancelled = created.controller.signal.aborted;
        created.decoded?.release();
        created.decoded = null;
        if (sheetUses.get(key) === created) sheetUses.delete(key);
        // One failure is enough: the cubes have their own files.
        if (!cancelled) failedSheets.add(key);
        throw error;
      });
      created.image.catch(() => {});
      sheetUses.set(key, created);
      use = created;
    }
    use.users += 1;
    const held = use;
    let released = false;
    return {
      image: held.image,
      release() {
        if (released) return;
        released = true;
        held.users -= 1;
        if (held.users === 0) closeSheet(held);
      },
    };
  }

  /** A cube from its place in a sheet: six rectangles of the one decoded image, uploaded as its face files would be. */
  async function cubeFromSheet(asset: ResolvedAsset, representation: Extract<ResolvedRepresentation, { projection: "cube" }>, entry: Entry<Texture>, priority: number): Promise<Texture> {
    const signal = entry.controller.signal;
    const place = representation.sheet!;
    const size = representation.faceSize;
    const use = holdSheet(place, priority);
    const faces: ImageBitmap[] = [];
    const reservations: Reservation[] = [];
    try {
      const image = await use.image;
      if (signal.aborted) throw abortError(signal);
      for (const face of CUBE_FACE_NAMES) reservations.push(reserve("decoded", 4 * size * size, `${asset.id}/${representation.id} ${face} decoded`));
      for (let index = 0; index < CUBE_FACE_NAMES.length; index++) {
        faces.push(await backend.crop!(image, place.x + index * size, place.y, size, size));
        if (signal.aborted) throw abortError(signal);
      }
      entry.receivedBytes = representation.encodedBytes;
      publish(entry, asset, "loading");
      const texture = await backend.uploadCube(Object.fromEntries(CUBE_FACE_NAMES.map((face, index) => [face, faces[index]])) as Record<CubeFaceName, ImageBitmap>, `${asset.id}/${representation.id}`);
      if (signal.aborted) {
        texture.dispose();
        throw abortError(signal);
      }
      cubesFromSheets += 1;
      return texture;
    } finally {
      use.release();
      for (const face of faces) face.close();
      for (const reservation of reservations) reservation.release();
    }
  }

  /** A tiled cube's atlas, within the device's texture side; null when not one tile fits. */
  const layoutOf = (representation: ResolvedTiledCube): TileAtlasLayout | null => tileAtlasLayout(representation, settings.tileMemoryBytes, backend.maxTextureSide());
  const gpuBytesOf = (representation: ResolvedRepresentation): number => representationGpuBytes(representation, settings.tileMemoryBytes, backend.maxTextureSide());

  async function load(asset: ResolvedAsset, representation: ResolvedRepresentation, entry: Entry<Texture>, priority: number, overlap: boolean): Promise<Texture> {
    const signal = entry.controller.signal;
    const label = `${asset.id}/${representation.id}`;
    if (representation.projection === "tiled-cube") {
      // Only the atlas is made here; the tiles come as the view asks for them, a frame at a time.
      const layout = layoutOf(representation);
      if (!layout) throw new ResourceRefusal(`${label}: not one ${representationMaxSide(representation)} px tile fits the tile memory (scene.panorama.tileMemoryMiB) within this device's ${backend.maxTextureSide()} px textures`, "device");
      entry.gpu = reserve("sourceGpu", layout.gpuBytes, label, overlap);
      return backend.createTiles(representation, layout, label, backend.media?.files(mediaGroup(asset, representation)) ?? null);
    }
    const side = representationMaxSide(representation);
    if (side > backend.maxTextureSide()) throw new ResourceRefusal(`${label} is ${side} px on a side; this device allows ${backend.maxTextureSide()}`, "device");
    if (representation.role === "immersion" && representationAroundPx(representation) > settings.immersionWidth) {
      throw new ResourceRefusal(`${label} is ${representationAroundPx(representation)} px around, over the ${Math.round(settings.immersionWidth)} px image detail (scene.panorama.immersionWidth)`, "immersionWidth");
    }
    entry.gpu = reserve("sourceGpu", representationGpuBytes(representation), label, overlap);
    if (representation.projection === "cube" && representation.sheet && settings.previewSheets && backend.crop && !failedSheets.has(sheetKey(representation.sheet))) {
      // One image for many cubes. If it fails, this cube's own files are still there, as for a loader that knows no sheets.
      const sheetKeyNow = sheetKey(representation.sheet);
      try {
        return await cubeFromSheet(asset, representation, entry, priority);
      } catch (error) {
        if (signal.aborted) throw error;
        failedSheets.add(sheetKeyNow);
      }
    }
    const files: { name: CubeFaceName | "image"; url: string; width: number; height: number }[] = representation.projection === "cube"
      ? CUBE_FACE_NAMES.map(face => ({ name: face, url: representation.faces[face], width: representation.faceSize, height: representation.faceSize }))
      : [{ name: "image", url: representation.url, width: representation.width, height: representation.height }];
    const declaredEach = Math.ceil(representation.encodedBytes / files.length);
    const encoded = reserve("encoded", representation.encodedBytes, `${label} encoded`);
    // Files larger than their share of the declared bytes grow the one encoded reservation.
    let extra = 0;
    const grow = (bytes: number): boolean => {
      if (!encoded.resize(representation.encodedBytes + extra + bytes)) return false;
      extra += bytes;
      return true;
    };
    const decodedReservations: Reservation[] = [];
    const bitmaps: ImageBitmap[] = [];
    const saved = backend.media?.files(mediaGroup(asset, representation)) ?? null;
    /** Files that came from the saved images: forgotten if they turn out not to decode. */
    const fromSaved = new Set<string>();
    const received = (bytes: number): void => {
      entry.receivedBytes += bytes;
      publish(entry, asset, "loading");
    };
    type File = (typeof files)[number];
    const headerProblem = (file: File, body: { bytes: Uint8Array; contentType: string | null }): string | null =>
      checkImage(body.bytes, { mimeType: representation.mimeType, width: file.width, height: file.height }, body.contentType);
    /** A file's bytes, header-checked: the copy kept from an earlier visit, or the network's, which is then kept. */
    const obtain = async (file: File): Promise<{ bytes: Uint8Array; contentType: string | null }> => {
      const kept = saved ? await saved.get(file.url) : null;
      if (signal.aborted) throw abortError(signal);
      if (kept && headerProblem(file, kept)) saved!.forget(file.url);
      else if (kept) {
        // Held in memory until it is decoded, like a response: past its declared share, the encoded reservation grows.
        if (kept.bytes.byteLength > declaredEach && !grow(kept.bytes.byteLength - declaredEach)) {
          throw new ResourceRefusal(`${file.url} is larger than declared and passed the encoded-bytes limit (scene.panorama.encodedMiB)`, "encoded");
        }
        fromSaved.add(file.url);
        reusedFiles += 1;
        reusedBytes += kept.bytes.byteLength;
        received(kept.bytes.byteLength);
        return kept;
      }
      const body = await requests.run(priority, signal, () => fetchFile(file.url, declaredEach, grow, signal, received));
      const problem = headerProblem(file, body);
      if (problem) throw new ResourceRefusal(`${file.url} ${problem}`, "file");
      saved?.put(file.url, body.bytes, body.contentType);
      return body;
    };
    try {
      const downloads = files.map(obtain);
      const bodies = await Promise.all(downloads).catch(async error => {
        // Stop the other faces before releasing the shared encoded reservation.
        entry.controller.abort(error);
        await Promise.allSettled(downloads);
        throw error;
      });
      if (signal.aborted) throw abortError(signal);
      // Header-checked sizes, not declarations, decide the decode reservation.
      for (const file of files) decodedReservations.push(reserve("decoded", 4 * file.width * file.height, `${label} ${file.name} decoded`));
      for (let index = 0; index < files.length; index++) {
        const bitmap = await decodes.run(priority, signal, () => backend.decode(bodies[index].bytes, representation.mimeType)).catch(error => {
          // A kept file the browser cannot decode is damaged: the next load asks the network for it.
          if (fromSaved.has(files[index].url) && !signal.aborted) saved!.forget(files[index].url);
          throw error;
        });
        bitmaps.push(bitmap);
        if (signal.aborted) throw abortError(signal);
      }
      encoded.release();
      const texture = representation.projection === "cube"
        ? await backend.uploadCube(Object.fromEntries(CUBE_FACE_NAMES.map((face, index) => [face, bitmaps[index]])) as Record<CubeFaceName, ImageBitmap>, label)
        : await backend.uploadEquirect(bitmaps[0], label);
      if (signal.aborted) {
        texture.dispose();
        throw abortError(signal);
      }
      return texture;
    } finally {
      encoded.release();
      for (const bitmap of bitmaps) bitmap.close();
      for (const reservation of decodedReservations) reservation.release();
    }
  }

  function publish(entry: Entry<Texture>, asset: ResolvedAsset, state: ResourceProgress["state"]): void {
    if (entry.progressState !== "loading") return;
    entry.progressState = state;
    onProgress?.({
      id: entry.key, assetId: asset.id, representation: entry.representation,
      receivedBytes: entry.receivedBytes, totalBytes: entry.representation.encodedBytes, state,
    });
  }

  /** A shared source for a cube or an image, loaded if needed. */
  function acquireSource(asset: ResolvedAsset, representation: ResolvedRepresentation, options: { signal?: AbortSignal; priority?: number; overlap?: boolean }): Promise<SourceHandle<Texture>> {
    const key = sourceKey(asset, representation, generation, representation.projection === "tiled-cube" ? layoutOf(representation)?.slots ?? 0 : 0);
    let entry = entries.get(key);
    if (!entry) {
      const created: Entry<Texture> = {
        key, asset, representation, refs: 0, waiting: 0, lastUsed: ++tick, controller: new AbortController(),
        promise: null as unknown as Promise<Texture>, texture: null, gpu: null, receivedBytes: 0, progressState: "loading",
      };
      publish(created, asset, "loading");
      created.promise = load(asset, representation, created, options.priority ?? 0, options.overlap === true).then(texture => {
        if (entries.get(key) !== created) { texture.dispose(); throw new DOMException("Released while loading.", "AbortError"); }
        created.texture = texture;
        created.gpu?.settle();
        publish(created, asset, "ready");
        return texture;
      }, error => {
        if (entries.get(key) === created) entries.delete(key);
        created.gpu?.release();
        created.gpu = null;
        publish(created, asset, error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed");
        throw error;
      });
      created.promise.catch(() => {});
      entries.set(key, created);
      entry = created;
    }
    const current = entry;
    current.waiting += 1;
    return new Promise<SourceHandle<Texture>>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        current.waiting -= 1;
        // No one else wants an unfinished load: stop it. A finished one is kept, within its allowance.
        if (current.waiting === 0 && current.refs === 0) {
          if (!current.texture) evict(current);
          else trimKept();
        }
        reject(abortError(options.signal!));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      current.promise.then(texture => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        current.waiting -= 1;
        current.refs += 1;
        current.lastUsed = ++tick;
        let released = false;
        resolve({
          texture, representation, key,
          release() {
            if (released) return;
            released = true;
            current.refs -= 1;
            current.lastUsed = ++tick;
            // Nobody shows it now: it stays on the GPU only within what may be kept.
            if (current.refs === 0) trimKept();
          },
        });
      }, error => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        current.waiting -= 1;
        reject(error);
      });
    });
  }

  /**
   * A tiled cube's atlas, held with the preview cube it shows over: the
   * preview is acquired too, normally already on the GPU, so the handle draws
   * at once. Released together.
   */
  async function acquireTiled(asset: ResolvedAsset, representation: ResolvedTiledCube, options: { signal?: AbortSignal; priority?: number; overlap?: boolean; fallback?: ResolvedRepresentation }): Promise<SourceHandle<Texture>> {
    const preview = options.fallback ?? asset.representations.find(entry => entry.role === "preview" && entry.projection === "cube");
    if (!preview || preview.projection !== "cube") throw new ResourceRefusal(`${asset.id}/${representation.id} needs a preview cube to show over`, "file");
    const [tiles, fallback] = await Promise.allSettled([acquireSource(asset, representation, options), acquireSource(asset, preview, { ...options, overlap: false })]);
    if (tiles.status === "rejected" || fallback.status === "rejected") {
      if (tiles.status === "fulfilled") tiles.value.release();
      if (fallback.status === "fulfilled") fallback.value.release();
      throw tiles.status === "rejected" ? tiles.reason : (fallback as PromiseRejectedResult).reason;
    }
    const held = tiles.value;
    return {
      texture: held.texture, representation, key: held.key, fallback: fallback.value,
      release() {
        held.release();
        fallback.value.release();
      },
    };
  }

  return {
    /**
     * A shared source for `representation`, loaded if needed. `overlap`
     * counts it against the replacement allowance while an outgoing source
     * is still shown. Rejects with a ResourceRefusal naming the limit.
     */
    acquire(asset: ResolvedAsset, representation: ResolvedRepresentation, options: { signal?: AbortSignal; priority?: number; overlap?: boolean; fallback?: ResolvedRepresentation } = {}): Promise<SourceHandle<Texture>> {
      if (disposed) return Promise.reject(new DOMException("The scene's resources are disposed.", "AbortError"));
      if (representation.projection === "tiled-cube") return acquireTiled(asset, representation, options);
      return acquireSource(asset, representation, options);
    },
    /** Whether a representation's GPU bytes would fit now, evicting only idle sources. */
    wouldFit(representation: ResolvedRepresentation, overlap = false): boolean {
      const bytes = gpuBytesOf(representation);
      if (pools.fits("sourceGpu", bytes, { overlap })) return true;
      return gpuRoom() >= bytes;
    },
    /** GPU bytes a new source could have: what is free, and what idle sources would give up. */
    gpuRoom,
    setSettings(next: ResourceSettings): void {
      settings = next;
      const over = pools.setLimits(next.limits);
      // Lowering a budget evicts what is idle; what is in use stays until released.
      if (over.includes("sourceGpu")) makeRoom("sourceGpu", 0, false);
      trimKept();
      requests.pump();
      decodes.pump();
    },
    /** After a device loss: every GPU source is gone, and loads in flight are abandoned. */
    invalidateDevice(): void {
      generation += 1;
      for (const entry of [...entries.values()]) evict(entry);
    },
    stats(): ResourceStats {
      const values = [...entries.values()];
      const kept = idleSources();
      return {
        pools: pools.stats(),
        cachedSources: values.filter(entry => entry.texture).length,
        referencedSources: values.filter(entry => entry.refs > 0).length,
        activeRequests: requests.stats().active,
        queuedRequests: requests.stats().queued,
        activeDecodes: decodes.stats().active,
        queuedDecodes: decodes.stats().queued,
        largestResponseBytes,
        rejectedResponses,
        transferredBytes,
        reusedFiles,
        reusedBytes,
        cubesFromSheets,
        keptSources: kept.length,
        keptBytes: kept.reduce((sum, entry) => sum + (entry.gpu?.bytes ?? 0), 0),
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries.values()]) evict(entry);
      for (const use of [...sheetUses.values()]) closeSheet(use);
    },
  };
}

export type PanoramaResources<Texture extends GpuSource = GpuSource> = ReturnType<typeof createPanoramaResources<Texture>>;

/**
 * The loading parameters as the resource manager takes them. `immersionWidth`
 * is the image detail, infinite at its largest, where only the device's
 * texture limit applies.
 */
export function resourceSettingsFrom(read: (id: string) => unknown, immersionWidth: number): ResourceSettings {
  const number = (id: string): number => {
    const value = read(id);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    limits: {
      sourceGpu: number("scene.panorama.sourceGpuMiB") * MIB,
      overlap: number("scene.panorama.overlapMiB") * MIB,
      decoded: number("scene.panorama.decodedMiB") * MIB,
      encoded: number("scene.panorama.encodedMiB") * MIB,
      uploadOutstanding: number("scene.panorama.uploadOutstandingMiB") * MIB,
    },
    responseBytes: number("scene.panorama.responseMiB") * MIB,
    requests: Math.max(1, Math.round(number("scene.panorama.requests"))),
    decodes: Math.max(1, Math.round(number("scene.panorama.decodes"))),
    timeoutMs: number("scene.panorama.requestTimeout") * 1000,
    immersionWidth,
    tileMemoryBytes: number("scene.panorama.tileMemoryMiB") * MIB,
    keptBytes: number("scene.panorama.keptGpuMiB") * MIB,
    previewSheets: read("scene.panorama.previewSheets") !== false,
  };
}
