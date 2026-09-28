/**
 * Loads panorama representations within the user's budgets (§4): bounded
 * requests, header-checked decodes and chunked uploads, each reserved
 * before it is spent and released exactly once. Sources are shared and
 * reference counted; unreferenced ones stay for reuse until a reservation
 * needs their room, least recently used first.
 *
 * Nothing here draws. The GPU side is injected, so the accounting is tested
 * without a device.
 */
import type { CubeFaceName } from "./panoramaMath";
import { CUBE_FACE_NAMES } from "./panoramaMath";
import type { ResolvedAsset, ResolvedRepresentation } from "./format";
import {
  MIB,
  createResourcePools,
  representationAroundPx,
  representationGpuBytes,
  representationMaxSide,
  type PoolLimits,
  type PoolName,
  type Reservation,
  type ResourcePools,
} from "./budget";
import { checkImage, type ImageKind } from "./imageHeaders";

/** A texture on the GPU, as the renderer's uploader makes it. */
export interface GpuSource {
  readonly kind: "cube" | "equirectangular";
  readonly gpuBytes: number;
  dispose(): void;
}

export interface ResourceBackend<Texture extends GpuSource = GpuSource> {
  fetch(url: string, init: RequestInit): Promise<Response>;
  decode(bytes: Uint8Array, mimeType: ImageKind): Promise<ImageBitmap>;
  uploadCube(faces: Readonly<Record<CubeFaceName, ImageBitmap>>, label: string): Promise<Texture>;
  uploadEquirect(image: ImageBitmap, label: string): Promise<Texture>;
  /** The device's largest texture side, px. */
  maxTextureSide(): number;
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
}

export interface SourceHandle<Texture extends GpuSource = GpuSource> {
  readonly texture: Texture;
  readonly representation: ResolvedRepresentation;
  readonly key: string;
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
  transferredBytes: number;
}

interface Entry<Texture extends GpuSource> {
  key: string;
  representation: ResolvedRepresentation;
  refs: number;
  waiting: number;
  lastUsed: number;
  controller: AbortController;
  promise: Promise<Texture>;
  texture: Texture | null;
  gpu: Reservation | null;
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
      await new Promise<void>((resolve, reject) => {
        const entry = { priority, start: resolve, signal };
        queue.push(entry);
        signal.addEventListener("abort", () => {
          const index = queue.indexOf(entry);
          if (index >= 0) { queue.splice(index, 1); reject(signal.reason); }
        }, { once: true });
        pump();
      });
      try { return await work(); } finally { active -= 1; pump(); }
    },
    stats: () => ({ active, queued: queue.length }),
    pump,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Cancelled.", "AbortError");
}

export function sourceKey(asset: ResolvedAsset, representation: ResolvedRepresentation, generation: number): string {
  const urls = representation.projection === "cube" ? CUBE_FACE_NAMES.map(face => representation.faces[face]).join(" ") : representation.url;
  return `${asset.id}@${asset.revision}/${representation.id}#${generation} ${urls}`;
}

export function createPanoramaResources<Texture extends GpuSource>(backend: ResourceBackend<Texture>, initial: ResourceSettings) {
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

  /** Frees unreferenced sources, least recently used first, until `bytes` fits. */
  function makeRoom(pool: PoolName, bytes: number, overlap: boolean): void {
    if (pool !== "sourceGpu") return;
    const idle = [...entries.values()].filter(entry => entry.refs === 0 && entry.waiting === 0 && entry.texture).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (pools.fits(pool, bytes, { overlap })) return;
      evict(entry);
    }
  }

  function evict(entry: Entry<Texture>): void {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
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

  async function fetchFile(url: string, declaredBytes: number, grow: (bytes: number) => boolean, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string | null }> {
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

  async function load(asset: ResolvedAsset, representation: ResolvedRepresentation, entry: Entry<Texture>, priority: number, overlap: boolean): Promise<Texture> {
    const signal = entry.controller.signal;
    const label = `${asset.id}/${representation.id}`;
    const side = representationMaxSide(representation);
    if (side > backend.maxTextureSide()) throw new ResourceRefusal(`${label} is ${side} px on a side; this device allows ${backend.maxTextureSide()}`, "device");
    if (representation.role === "immersion" && representationAroundPx(representation) > settings.immersionWidth) {
      throw new ResourceRefusal(`${label} is ${representationAroundPx(representation)} px around, over the ${Math.round(settings.immersionWidth)} px image detail (scene.panorama.immersionWidth)`, "immersionWidth");
    }
    entry.gpu = reserve("sourceGpu", representationGpuBytes(representation), label, overlap);
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
    try {
      const bodies = await Promise.all(files.map(file => requests.run(priority, signal, () => fetchFile(file.url, declaredEach, grow, signal))));
      if (signal.aborted) throw abortError(signal);
      files.forEach((file, index) => {
        const problem = checkImage(bodies[index].bytes, { mimeType: representation.mimeType, width: file.width, height: file.height }, bodies[index].contentType);
        if (problem) throw new ResourceRefusal(`${file.url} ${problem}`, "file");
      });
      // Header-checked sizes, not declarations, decide the decode reservation.
      for (const file of files) decodedReservations.push(reserve("decoded", 4 * file.width * file.height, `${label} ${file.name} decoded`));
      for (let index = 0; index < files.length; index++) {
        const bitmap = await decodes.run(priority, signal, () => backend.decode(bodies[index].bytes, representation.mimeType));
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

  return {
    /**
     * A shared source for `representation`, loaded if needed. `overlap`
     * counts it against the replacement allowance while an outgoing source
     * is still shown. Rejects with a ResourceRefusal naming the limit.
     */
    acquire(asset: ResolvedAsset, representation: ResolvedRepresentation, options: { signal?: AbortSignal; priority?: number; overlap?: boolean } = {}): Promise<SourceHandle<Texture>> {
      if (disposed) return Promise.reject(new DOMException("The scene's resources are disposed.", "AbortError"));
      const key = sourceKey(asset, representation, generation);
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry<Texture> = {
          key, representation, refs: 0, waiting: 0, lastUsed: ++tick, controller: new AbortController(),
          promise: null as unknown as Promise<Texture>, texture: null, gpu: null,
        };
        created.promise = load(asset, representation, created, options.priority ?? 0, options.overlap === true).then(texture => {
          if (entries.get(key) !== created) { texture.dispose(); throw new DOMException("Released while loading.", "AbortError"); }
          created.texture = texture;
          created.gpu?.settle();
          return texture;
        }, error => {
          if (entries.get(key) === created) entries.delete(key);
          created.gpu?.release();
          created.gpu = null;
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
          // No one else wants an unfinished load: stop it.
          if (current.waiting === 0 && current.refs === 0 && !current.texture) evict(current);
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
    },
    /** Whether a representation's GPU bytes would fit now, evicting only idle sources. */
    wouldFit(representation: ResolvedRepresentation, overlap = false): boolean {
      const bytes = representationGpuBytes(representation);
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
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries.values()]) evict(entry);
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
  };
}
