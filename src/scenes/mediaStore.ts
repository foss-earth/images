/**
 * Scene images kept between visits, so no file is downloaded twice
 * (docs/scenes/format.md, "Saved images").
 *
 * The browser's own cache cannot do this where the host gives files a short
 * life: GitHub Pages lets them go stale after ten minutes, and every file then
 * costs a request to find it unchanged. A scene says more than its host does.
 * An asset's `revision` changes whenever its files do, so a file kept under
 * its asset's revision never needs asking for again.
 *
 * Files are kept in IndexedDB in groups, one per representation of an asset
 * revision: an orb's preview cube, a panorama's tiles, a whole image. A group
 * is the unit that is counted, listed and dropped. Past `maxBytes` the groups
 * unused longest go first, whole; a new revision's files join a new group, and
 * the old one goes the same way.
 *
 * Everything here may fail without the scene noticing: with no IndexedDB, a
 * refused write or a full disk, files come from the network as before.
 */

/** One representation of one asset revision: `<asset id>@<revision>/<representation id>`. */
export interface MediaGroup {
  id: string;
  /** For the list of what is kept. */
  label: string;
}

export interface SavedFile {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface MediaGroupRecord {
  id: string;
  label: string;
  bytes: number;
  files: number;
  /** When it was last read or added to, ms since the epoch. */
  used: number;
}

export interface PendingFile {
  key: string;
  group: MediaGroup;
  bytes: Uint8Array;
  contentType: string | null;
}

/** The storage under the store. IndexedDB in the app; a map in tests. */
export interface MediaStoreBackend {
  groups(): Promise<MediaGroupRecord[]>;
  /** Each key's file, or null where there is none. */
  read(keys: readonly string[]): Promise<(SavedFile | null)[]>;
  /** Adds the files that are not there yet and counts them into their groups, all or nothing; resolves with what it added. */
  write(files: readonly PendingFile[], now: number): Promise<{ files: number; bytes: number }>;
  /** Marks groups as used now. */
  touch(ids: readonly string[], now: number): Promise<void>;
  /** Removes groups with every file in them. */
  drop(ids: readonly string[]): Promise<void>;
  /** Removes one file and takes it out of its group's count. */
  remove(key: string, group: string): Promise<void>;
  clear(): Promise<void>;
}

/** What the store may hold: `scene.panorama.savedMiB`. */
export interface MediaStoreLimits {
  maxBytes: number;
}

export interface MediaStoreSnapshot {
  /** Whether files can be kept in this browser session. */
  available: boolean;
  /** Why nothing more is being kept, when something stopped it. */
  problem: string | null;
  bytes: number;
  files: number;
  maxBytes: number;
  groups: MediaGroupRecord[];
  /** This visit: files that came from the store instead of the network, and files added to it. */
  reused: { files: number; bytes: number };
  added: { files: number; bytes: number };
}

/** A group's files, as the loader of one representation uses them. */
export interface SavedFiles {
  get(url: string): Promise<SavedFile | null>;
  put(url: string, bytes: Uint8Array, contentType: string | null): void;
  /** Drops a file that turned out not to be an image, so the next load asks the network. */
  forget(url: string): void;
}

export interface MediaStore {
  get(group: MediaGroup, url: string): Promise<SavedFile | null>;
  put(group: MediaGroup, url: string, bytes: Uint8Array, contentType: string | null): void;
  forget(group: MediaGroup, url: string): void;
  /** One group's files. */
  files(group: MediaGroup): SavedFiles;
  inspect(): Promise<MediaStoreSnapshot>;
  clear(): Promise<void>;
  setLimits(limits: MediaStoreLimits): void;
  /** Resolves once everything asked for so far is written or given up: for tests and for a page about to close. */
  settled(): Promise<void>;
}

/** Separates a group's id from a file's URL in a key; neither contains it. */
const SEPARATOR = "\n";
const fileKey = (group: string, url: string): string => `${group}${SEPARATOR}${url}`;

/** The group of one representation of an asset. */
export function mediaGroup(asset: { id: string; revision: string }, representation: { id: string }): MediaGroup {
  return { id: `${asset.id}@${asset.revision}/${representation.id}`.split(SEPARATOR).join(" "), label: `${asset.id} · ${representation.id}` };
}

// ─── IndexedDB ──────────────────────────────────────────────────────────

const DATABASE = "foss-earth-scene-media-v1";
const FILES = "files";
const GROUPS = "groups";

interface StoredFile {
  bytes: ArrayBuffer;
  type: string | null;
}

/** Runs `work` in one transaction and resolves once it has committed. */
function transact(database: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(stores, mode);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => { /* onabort follows and rejects. */ };
    try {
      work(transaction);
    } catch (error) {
      try { transaction.abort(); } catch { /* Already finished. */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The bytes of a view as an ArrayBuffer of exactly its length. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The store's files in IndexedDB; null where the browser has none or refuses to open it. */
export async function openIndexedDbBackend(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<MediaStoreBackend | null> {
  if (!factory) return null;
  let database: IDBDatabase;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1);
      opening.onupgradeneeded = () => {
        const upgraded = opening.result;
        if (!upgraded.objectStoreNames.contains(FILES)) upgraded.createObjectStore(FILES);
        if (!upgraded.objectStoreNames.contains(GROUPS)) upgraded.createObjectStore(GROUPS, { keyPath: "id" });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB could not be opened"));
      opening.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
    });
  } catch {
    return null;
  }
  // Another tab upgrading the database must not wait on this one.
  database.onversionchange = () => database.close();
  const groupRange = (id: string): IDBKeyRange => IDBKeyRange.bound(fileKey(id, ""), fileKey(id, "￿"));
  return {
    async groups() {
      let records: MediaGroupRecord[] = [];
      await transact(database, [GROUPS], "readonly", transaction => {
        const all = transaction.objectStore(GROUPS).getAll() as IDBRequest<MediaGroupRecord[]>;
        all.onsuccess = () => { records = all.result; };
      });
      return records;
    },
    async read(keys) {
      const found: (SavedFile | null)[] = keys.map(() => null);
      await transact(database, [FILES], "readonly", transaction => {
        const store = transaction.objectStore(FILES);
        keys.forEach((key, index) => {
          const reading = store.get(key) as IDBRequest<StoredFile | undefined>;
          reading.onsuccess = () => {
            const value = reading.result;
            if (value?.bytes instanceof ArrayBuffer) found[index] = { bytes: new Uint8Array(value.bytes), contentType: value.type ?? null };
          };
        });
      });
      return found;
    },
    async write(files, now) {
      const total = { files: 0, bytes: 0 };
      await transact(database, [FILES, GROUPS], "readwrite", transaction => {
        const store = transaction.objectStore(FILES);
        const groups = transaction.objectStore(GROUPS);
        const added = new Map<string, { label: string; bytes: number; files: number }>();
        let remaining = files.length;
        const count = (): void => {
          remaining -= 1;
          if (remaining > 0) return;
          // Every file is checked: count what was added into its group, in the same transaction.
          for (const [id, sum] of added) {
            const reading = groups.get(id) as IDBRequest<MediaGroupRecord | undefined>;
            reading.onsuccess = () => {
              const before = reading.result;
              groups.put({ id, label: sum.label, bytes: (before?.bytes ?? 0) + sum.bytes, files: (before?.files ?? 0) + sum.files, used: now } satisfies MediaGroupRecord);
            };
          }
        };
        for (const file of files) {
          const check = store.getKey(file.key);
          check.onsuccess = () => {
            if (check.result === undefined) {
              store.put({ bytes: exactBuffer(file.bytes), type: file.contentType } satisfies StoredFile, file.key);
              const sum = added.get(file.group.id) ?? { label: file.group.label, bytes: 0, files: 0 };
              sum.bytes += file.bytes.byteLength;
              sum.files += 1;
              added.set(file.group.id, sum);
              total.bytes += file.bytes.byteLength;
              total.files += 1;
            }
            count();
          };
        }
      });
      return total;
    },
    touch(ids, now) {
      return transact(database, [GROUPS], "readwrite", transaction => {
        const groups = transaction.objectStore(GROUPS);
        for (const id of ids) {
          const reading = groups.get(id) as IDBRequest<MediaGroupRecord | undefined>;
          reading.onsuccess = () => { if (reading.result) groups.put({ ...reading.result, used: now }); };
        }
      });
    },
    drop(ids) {
      return transact(database, [FILES, GROUPS], "readwrite", transaction => {
        for (const id of ids) {
          transaction.objectStore(FILES).delete(groupRange(id));
          transaction.objectStore(GROUPS).delete(id);
        }
      });
    },
    remove(key, group) {
      return transact(database, [FILES, GROUPS], "readwrite", transaction => {
        const store = transaction.objectStore(FILES);
        const groups = transaction.objectStore(GROUPS);
        const reading = store.get(key) as IDBRequest<StoredFile | undefined>;
        reading.onsuccess = () => {
          const file = reading.result;
          if (!file) return;
          store.delete(key);
          const record = groups.get(group) as IDBRequest<MediaGroupRecord | undefined>;
          record.onsuccess = () => {
            const before = record.result;
            if (!before) return;
            if (before.files <= 1) groups.delete(group);
            else groups.put({ ...before, bytes: Math.max(0, before.bytes - file.bytes.byteLength), files: before.files - 1 });
          };
        };
      });
    },
    clear() {
      return transact(database, [FILES, GROUPS], "readwrite", transaction => {
        transaction.objectStore(FILES).clear();
        transaction.objectStore(GROUPS).clear();
      });
    },
  };
}

// ─── The store ──────────────────────────────────────────────────────────

/** The browser's word for a full disk or a spent quota. */
function isQuotaError(error: unknown): boolean {
  return error instanceof Error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

export function createMediaStore(options: {
  /** Opens the storage; null where there is none. */
  open?: () => Promise<MediaStoreBackend | null>;
  now?: () => number;
} & Partial<MediaStoreLimits> = {}): MediaStore {
  const open = options.open ?? (() => openIndexedDbBackend());
  const now = options.now ?? Date.now;
  // Until the app gives its limit (the registry holds the default), nothing is added and nothing kept is dropped.
  let limitsKnown = options.maxBytes !== undefined;
  let maxBytes = options.maxBytes ?? 0;
  /** The groups as last read or written here; another tab may have moved on. */
  const groups = new Map<string, MediaGroupRecord>();
  /** Groups read or written this visit: each is marked as used once. */
  const touched = new Set<string>();
  /** Groups too large for the budget by themselves: not written again this visit. */
  const tooLarge = new Set<string>();
  let backend: MediaStoreBackend | null = null;
  let ready: Promise<MediaStoreBackend | null> | undefined;
  let problem: string | null = null;
  let stopped = false;
  const reused = { files: 0, bytes: 0 };
  const added = { files: 0, bytes: 0 };

  let reads: { key: string; group: MediaGroup; resolve(file: SavedFile | null): void }[] = [];
  let reading = false;
  let writes: PendingFile[] = [];
  let touches: string[] = [];
  /** Work on the stored files, one transaction after another. */
  let chain: Promise<void> = Promise.resolve();
  const serialize = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task);
    chain = next.catch(() => { /* A failed step must not stop the ones after it. */ });
    return next;
  };

  function init(): Promise<MediaStoreBackend | null> {
    ready ??= (async () => {
      try {
        backend = await open();
        if (backend) for (const record of await backend.groups()) groups.set(record.id, record);
      } catch {
        backend = null;
      }
      return backend;
    })();
    return ready;
  }

  const total = (): number => { let sum = 0; for (const record of groups.values()) sum += record.bytes; return sum; };
  /** Whether kept files are used at all: a limit of nothing keeps and reads nothing. */
  const using = (): boolean => backend !== null && limitsKnown && maxBytes > 0;
  const keeping = (): boolean => using() && !stopped;

  async function refresh(): Promise<void> {
    if (!backend) return;
    const records = await backend.groups();
    groups.clear();
    for (const record of records) groups.set(record.id, record);
  }

  /** Drops groups, the one unused longest first, while `more` says so; returns the bytes freed. */
  async function dropOldest(more: (keptBytes: number, freedBytes: number) => boolean, spare: ReadonlySet<string> = new Set()): Promise<number> {
    if (!backend) return 0;
    let kept = total();
    let freed = 0;
    const dropped: string[] = [];
    for (const record of [...groups.values()].sort((a, b) => a.used - b.used)) {
      if (!more(kept, freed)) break;
      if (spare.has(record.id)) continue;
      dropped.push(record.id);
      kept -= record.bytes;
      freed += record.bytes;
      // A group over the limit by itself is not worth writing again this visit.
      if (limitsKnown && record.bytes > maxBytes) tooLarge.add(record.id);
    }
    if (dropped.length === 0) return 0;
    await backend.drop(dropped);
    for (const id of dropped) groups.delete(id);
    return freed;
  }

  /** Keeps within the limit. */
  async function prune(): Promise<void> {
    if (!limitsKnown) return;
    await dropOldest(kept => kept > maxBytes);
  }

  function touch(id: string): void {
    if (touched.has(id)) return;
    touched.add(id);
    touches.push(id);
  }

  function pumpReads(): void {
    if (reading || reads.length === 0 || !backend) return;
    reading = true;
    const batch = reads;
    reads = [];
    const store = backend;
    void store.read(batch.map(entry => entry.key)).then(files => {
      batch.forEach((entry, index) => {
        const file = files[index];
        if (file) {
          reused.files += 1;
          reused.bytes += file.bytes.byteLength;
          touch(entry.group.id);
        }
        entry.resolve(file);
      });
    }, () => {
      for (const entry of batch) entry.resolve(null);
    }).finally(() => {
      reading = false;
      if (touches.length > 0) flush();
      pumpReads();
    });
  }

  /** Writes what is waiting, then keeps within the limit. */
  function flush(): void {
    void serialize(async () => {
      if (!backend) return;
      const marking = touches;
      touches = [];
      const batch = writes;
      writes = [];
      if (marking.length > 0) await backend.touch(marking, now()).catch(() => {});
      if (batch.length === 0) return;
      // One file a key: the same file asked for twice arrives twice.
      const unique = [...new Map(batch.map(file => [file.key, file])).values()].filter(file => !tooLarge.has(file.group.id));
      if (unique.length === 0 || !keeping()) return;
      const bytes = unique.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      const writing = new Set(unique.map(file => file.group.id));
      const store = backend;
      let written: { files: number; bytes: number };
      try {
        written = await store.write(unique, now());
      } catch (error) {
        if (!isQuotaError(error)) {
          problem = `The browser refused to keep images: ${error instanceof Error ? error.message : String(error)}`;
          stopped = true;
          return;
        }
        // The disk or the browser's quota is full below the limit: give up as much as is arriving, and try once more.
        try {
          await refresh();
          const freed = await dropOldest((_kept, freedBytes) => freedBytes < bytes, writing);
          if (freed < bytes) throw error;
          written = await store.write(unique, now());
        } catch {
          problem = "The browser has no more room for this site's images, so nothing more is kept this visit.";
          stopped = true;
          return;
        }
      }
      added.files += written.files;
      added.bytes += written.bytes;
      for (const id of writing) touched.add(id);
      await refresh();
      await prune().catch(() => {});
    });
  }

  const store: MediaStore = {
    async get(group, url) {
      await init();
      if (!using() || !groups.has(group.id)) return null;
      return new Promise<SavedFile | null>(resolve => {
        reads.push({ key: fileKey(group.id, url), group, resolve });
        pumpReads();
      });
    },
    put(group, url, bytes, contentType) {
      void init().then(() => {
        if (!keeping() || tooLarge.has(group.id) || bytes.byteLength > maxBytes) return;
        writes.push({ key: fileKey(group.id, url), group, bytes, contentType });
        if (writes.length === 1) flush();
      });
    },
    forget(group, url) {
      void init().then(() => {
        if (!backend) return;
        const removing = backend;
        void serialize(async () => {
          await removing.remove(fileKey(group.id, url), group.id);
          await refresh();
        }).catch(() => {});
      });
    },
    files(group) {
      return {
        get: url => store.get(group, url),
        put: (url, bytes, contentType) => store.put(group, url, bytes, contentType),
        forget: url => store.forget(group, url),
      };
    },
    async inspect() {
      await init();
      if (backend) await serialize(async () => { await refresh(); await prune(); }).catch(() => {});
      const records = [...groups.values()].sort((a, b) => b.used - a.used);
      return {
        available: backend !== null, problem,
        bytes: records.reduce((sum, record) => sum + record.bytes, 0),
        files: records.reduce((sum, record) => sum + record.files, 0),
        maxBytes, groups: records, reused: { ...reused }, added: { ...added },
      };
    },
    async clear() {
      await init();
      if (!backend) return;
      const clearing = backend;
      writes = [];
      await serialize(async () => {
        await clearing.clear();
        groups.clear();
        tooLarge.clear();
        // Kept again from here: a refusal before the clear may not stand after it.
        stopped = false;
        problem = null;
      });
    },
    setLimits(limits) {
      limitsKnown = true;
      maxBytes = Math.max(0, limits.maxBytes);
      tooLarge.clear();
      if (ready) void serialize(async () => { await refresh(); await prune(); }).catch(() => {});
    },
    async settled() {
      await init();
      // Reads and the writes they start are queued as they resolve: wait until nothing is left.
      for (;;) {
        const waiting = chain;
        await waiting;
        await Promise.resolve();
        if (waiting === chain && !reading && reads.length === 0 && writes.length === 0 && touches.length === 0) return;
      }
    },
  };
  return store;
}

/** The app's store: every scene on the page shares it. */
const sceneMedia = createMediaStore();
export const sceneMediaStore: MediaStore = sceneMedia;
export const inspectSceneMedia = sceneMedia.inspect;
export const clearSceneMedia = sceneMedia.clear;
/** Applies `scene.panorama.savedMiB`; the scene loader calls it and follows the parameter. */
export const setSceneMediaLimits = sceneMedia.setLimits;
