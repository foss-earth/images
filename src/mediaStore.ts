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
  const open = options.open ?? (async () => null);
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
