import type { MediaStoreBackend, MediaGroupRecord, SavedFile } from "../mediaStore.js";
const SEPARATOR = "\n";
const fileKey = (group: string, url: string): string => `${group}${SEPARATOR}${url}`;
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
