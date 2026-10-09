import type { MediaStoreBackend, MediaGroupRecord, SavedFile, BoundedFileRead } from "../mediaStore.js";
const SEPARATOR = "\n";
const fileKey = (group: string, url: string): string => `${group}${SEPARATOR}${url}`;
const DATABASE = "foss-earth-scene-media-v1";
const FILES = "files";
const BLOB_FILES = "files-v2";
const GROUPS = "groups";

interface StoredFile {
  bytes: ArrayBuffer;
  type: string | null;
}
interface StoredBlobFile { bytes: Blob; type: string | null }

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

/** The store's files in IndexedDB; null where the browser has none or refuses to open it. */
export async function openIndexedDbBackend(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<MediaStoreBackend | null> {
  if (!factory) return null;
  let database: IDBDatabase;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 2);
      opening.onupgradeneeded = () => {
        const upgraded = opening.result;
        if (!upgraded.objectStoreNames.contains(FILES)) upgraded.createObjectStore(FILES);
        if (!upgraded.objectStoreNames.contains(BLOB_FILES)) upgraded.createObjectStore(BLOB_FILES);
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
  // Version 2 never replaces a v1 row: its safely observed length remains
  // valid until deletion. Removal need not clone its ArrayBuffer again.
  const legacyBytes = new Map<string, number>();
  const readBounded = async (requests: readonly BoundedFileRead[]): Promise<(SavedFile | null)[]> => {
    const found: (SavedFile | null)[] = requests.map(() => null);
    const snapshots: { index: number; file: StoredBlobFile }[] = [];
    await transact(database, [BLOB_FILES, FILES, GROUPS], "readonly", transaction => {
      const blobs = transaction.objectStore(BLOB_FILES), legacy = transaction.objectStore(FILES), groups = transaction.objectStore(GROUPS);
      requests.forEach(({ key, group, admission }, index) => {
        const reading = blobs.get(key) as IDBRequest<StoredBlobFile | undefined>;
        reading.onsuccess = () => {
          try {
            const file = reading.result;
            if (file?.bytes instanceof Blob) {
              // A Blob clone preserves immutable storage. Admit its exact size
              // before arrayBuffer() materializes any body bytes.
              if (file.bytes.size <= admission.maxBytes && admission.admit(file.bytes.size)) snapshots.push({ index, file });
              return;
            }
            // Legacy rows remain intact. Their transaction-consistent group
            // total is the trusted upper bound before get() clones an array.
            const bound = groups.get(group) as IDBRequest<MediaGroupRecord | undefined>;
            bound.onsuccess = () => {
              try {
                const upper = bound.result?.bytes;
                if (upper === undefined || !Number.isSafeInteger(upper) || upper < 0 || upper > admission.maxBytes || !admission.admit(upper)) return;
                const old = legacy.get(key) as IDBRequest<StoredFile | undefined>;
                old.onsuccess = () => { const file = old.result; if (file?.bytes instanceof ArrayBuffer && file.bytes.byteLength <= upper) { legacyBytes.set(key, file.bytes.byteLength); found[index] = { bytes: new Uint8Array(file.bytes), contentType: file.type ?? null }; } };
              } catch { transaction.abort(); }
            };
          } catch { transaction.abort(); }
        };
      });
    });
    // A rejected Blob read cannot cancel another active read. Complete every
    // materialization before callers release the batch's admitted byte holds.
    const results = await Promise.allSettled(snapshots.map(async ({ index, file }) => { const bytes = await file.bytes.arrayBuffer(); found[index] = { bytes: new Uint8Array(bytes), contentType: file.type ?? null }; }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return found;
  };
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
      // Compatibility API is unbounded; common browser loads use readBounded.
      return readBounded(keys.map(key => ({ key, group: key.split(SEPARATOR)[0], admission: { maxBytes: Number.POSITIVE_INFINITY, admit: () => true } })));
    },
    readBounded,
    async write(files, now) {
      const total = { files: 0, bytes: 0 };
      await transact(database, [BLOB_FILES, FILES, GROUPS], "readwrite", transaction => {
        const store = transaction.objectStore(BLOB_FILES), legacy = transaction.objectStore(FILES);
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
          const check = store.getKey(file.key), old = legacy.getKey(file.key);
          let answered = 0;
          const writeIfAbsent = (): void => {
            answered += 1; if (answered < 2) return;
            if (check.result === undefined && old.result === undefined) {
              // One native byte snapshot. The service charges this copy and
              // retains its original input view until persistence settles.
              store.put({ bytes: new Blob([file.bytes as BlobPart]), type: file.contentType } satisfies StoredBlobFile, file.key);
              const sum = added.get(file.group.id) ?? { label: file.group.label, bytes: 0, files: 0 };
              sum.bytes += file.bytes.byteLength;
              sum.files += 1;
              added.set(file.group.id, sum);
              total.bytes += file.bytes.byteLength;
              total.files += 1;
            }
            count();
          };
          check.onsuccess = old.onsuccess = () => { try { writeIfAbsent(); } catch { transaction.abort(); } };
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
      for (const key of legacyBytes.keys()) if (ids.includes(key.split(SEPARATOR)[0])) legacyBytes.delete(key);
      return transact(database, [BLOB_FILES, FILES, GROUPS], "readwrite", transaction => {
        for (const id of ids) {
          transaction.objectStore(FILES).delete(groupRange(id));
          transaction.objectStore(BLOB_FILES).delete(groupRange(id));
          transaction.objectStore(GROUPS).delete(id);
        }
      });
    },
    remove(key, group) {
      return transact(database, [BLOB_FILES, FILES, GROUPS], "readwrite", transaction => {
        const store = transaction.objectStore(BLOB_FILES), legacy = transaction.objectStore(FILES);
        const groups = transaction.objectStore(GROUPS);
        const reading = store.get(key) as IDBRequest<StoredBlobFile | undefined>, old = legacy.getKey(key);
        let answered = 0;
        const remove = (): void => {
          answered += 1; if (answered < 2) return;
          const file = reading.result;
          if (!file && old.result === undefined) return;
          const byteLength = file?.bytes instanceof Blob ? file.bytes.size : legacyBytes.get(key);
          store.delete(key);
          legacy.delete(key);
          legacyBytes.delete(key);
          // An unobserved legacy row has no safe exact size. Preserve its
          // conservative group bound/count until whole-group eviction.
          if (byteLength === undefined) return;
          const record = groups.get(group) as IDBRequest<MediaGroupRecord | undefined>;
          record.onsuccess = () => {
            const before = record.result;
            if (!before) return;
            if (before.files <= 1) groups.delete(group);
            else groups.put({ ...before, bytes: Math.max(0, before.bytes - byteLength), files: before.files - 1 });
          };
        };
        reading.onsuccess = old.onsuccess = () => { try { remove(); } catch { transaction.abort(); } };
      });
    },
    clear() {
      legacyBytes.clear();
      return transact(database, [BLOB_FILES, FILES, GROUPS], "readwrite", transaction => {
        transaction.objectStore(FILES).clear();
        transaction.objectStore(BLOB_FILES).clear();
        transaction.objectStore(GROUPS).clear();
      });
    },
  };
}
