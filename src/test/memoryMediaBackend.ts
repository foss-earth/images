import type { MediaGroupRecord, MediaStoreBackend, SavedFile } from "../scenes/mediaStore";

/** The storage as a map, with a quota in bytes and a count of what each call did. */
export function memoryBackend(options: { quotaBytes?: number } = {}) {
  const files = new Map<string, { group: string; file: SavedFile }>();
  const groups = new Map<string, MediaGroupRecord>();
  const calls = { read: 0, write: 0, touch: 0, drop: 0 };
  const stored = (): number => [...files.values()].reduce((sum, entry) => sum + entry.file.bytes.byteLength, 0);
  const backend: MediaStoreBackend = {
    groups: async () => [...groups.values()].map(record => ({ ...record })),
    async read(keys) {
      calls.read += 1;
      return keys.map(key => files.get(key)?.file ?? null);
    },
    async write(pending, now) {
      calls.write += 1;
      const fresh = pending.filter(file => !files.has(file.key));
      const bytes = fresh.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      if (options.quotaBytes !== undefined && stored() + bytes > options.quotaBytes) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      for (const file of fresh) {
        files.set(file.key, { group: file.group.id, file: { bytes: file.bytes.slice(), contentType: file.contentType } });
        const record = groups.get(file.group.id) ?? { id: file.group.id, label: file.group.label, bytes: 0, files: 0, used: now };
        groups.set(file.group.id, { ...record, bytes: record.bytes + file.bytes.byteLength, files: record.files + 1, used: now });
      }
      return { files: fresh.length, bytes };
    },
    async touch(ids, now) {
      calls.touch += 1;
      for (const id of ids) { const record = groups.get(id); if (record) groups.set(id, { ...record, used: now }); }
    },
    async drop(ids) {
      calls.drop += 1;
      for (const id of ids) {
        groups.delete(id);
        for (const [key, entry] of files) if (entry.group === id) files.delete(key);
      }
    },
    async remove(key, group) {
      const entry = files.get(key);
      if (!entry) return;
      files.delete(key);
      const record = groups.get(group);
      if (!record) return;
      if (record.files <= 1) groups.delete(group);
      else groups.set(group, { ...record, bytes: record.bytes - entry.file.bytes.byteLength, files: record.files - 1 });
    },
    async clear() {
      files.clear();
      groups.clear();
    },
  };
  return { backend, files, groups, calls };
}
