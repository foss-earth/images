import type { MediaGroupRecord } from "../mediaStore.js";

/** Transaction snapshot fixture; counts legacy clones and supports immutable Blob rows. */
export function indexedDbReadFixture(options: {
  group: MediaGroupRecord;
  legacy?: ReadonlyMap<string, ArrayBuffer>;
  blobs?: ReadonlyMap<string, Blob>;
}) {
  const names = new Set(["files", "groups"]), calls = { legacyClones: 0, openedVersion: 0, blobReads: 0 };
  const legacy = new Map(options.legacy ?? []), blobs = new Map(options.blobs ?? []), groups = new Map([[options.group.id, { ...options.group }]]);
  const database = {
    objectStoreNames: { contains: (name: string) => names.has(name) },
    createObjectStore(name: string) { names.add(name); }, close() {},
    transaction(_stores: string[], mode: IDBTransactionMode) {
      let pending = 0, aborted = false, completeQueued = false;
      const readLegacy = new Map(legacy), readBlobs = new Map(blobs), readGroups = new Map([...groups].map(([id, value]) => [id, { ...value }]));
      const request = <T>(work: () => T): { result?: T; onsuccess?: () => void } => {
        pending += 1;
        const result: { result?: T; onsuccess?: () => void } = {};
        queueMicrotask(() => {
          if (aborted) return;
          result.result = work(); result.onsuccess?.(); pending -= 1;
          if (pending === 0 && !completeQueued) { completeQueued = true; queueMicrotask(() => { if (!aborted && pending === 0) transaction.oncomplete?.(); }); }
        });
        return result;
      };
      const transaction: { oncomplete?: () => void; onabort?: () => void; error: Error | null; abort(): void; objectStore(name: string): unknown } = {
        error: null,
        abort() { aborted = true; transaction.onabort?.(); },
        objectStore(name) {
          return {
            get(key: string) { return request(() => {
              if (name === "groups") return (mode === "readonly" ? readGroups : groups).get(key);
              if (name === "files-v2") { calls.blobReads += 1; const bytes = (mode === "readonly" ? readBlobs : blobs).get(key); return bytes ? { bytes, type: "image/png" } : undefined; }
              const bytes = (mode === "readonly" ? readLegacy : legacy).get(key); if (bytes) calls.legacyClones += 1;
              return bytes ? { bytes: bytes.slice(0), type: "image/png" } : undefined;
            }); },
            getKey(key: string) { return request(() => (name === "files" ? legacy.has(key) : blobs.has(key)) ? key : undefined); },
            put(value: unknown, key?: string) { return request(() => { if (name === "groups") { const record = value as MediaGroupRecord; groups.set(record.id, { ...record }); } else blobs.set(key!, (value as { bytes: Blob }).bytes); }); },
            delete(key: string) { return request(() => { if (name === "groups") groups.delete(key); else if (name === "files") legacy.delete(key); else blobs.delete(key); }); },
          };
        },
      };
      return transaction;
    },
  };
  const factory = { open(_name: string, version: number) {
    calls.openedVersion = version;
    const request: { result: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: database };
    queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } } as unknown as IDBFactory;
  return { factory, calls, names, legacy, blobs, groups };
}
