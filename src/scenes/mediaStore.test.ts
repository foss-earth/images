import { describe, expect, it } from "vitest";
import { createMediaStore, mediaGroup } from "./mediaStore";
import { memoryBackend } from "../test/memoryMediaBackend";

const bytes = (length: number, fill = 7): Uint8Array => new Uint8Array(length).fill(fill);
const MIB = 1024 * 1024;
const northrop = mediaGroup({ id: "northrop-mall", revision: "ac69" }, { id: "eac-tiles" });
const bookstore = mediaGroup({ id: "bookstore", revision: "1f02" }, { id: "eac-tiles" });
const previews = mediaGroup({ id: "northrop-mall", revision: "ac69" }, { id: "preview-64" });

describe("the scene media store", () => {
  it("names a group by asset, revision and representation", () => {
    expect(northrop).toEqual({ id: "northrop-mall@ac69/eac-tiles", label: "northrop-mall · eac-tiles" });
    expect(mediaGroup({ id: "a", revision: "2" }, { id: "eac-tiles" }).id).not.toBe(mediaGroup({ id: "a", revision: "1" }, { id: "eac-tiles" }).id);
  });

  it("returns what was kept, on a later visit too, and counts it", async () => {
    const memory = memoryBackend();
    const first = createMediaStore({ open: async () => memory.backend, maxBytes: MIB, now: () => 1000 });
    expect(await first.get(northrop, "https://x/px/0/0/0.jpg")).toBeNull();
    first.put(northrop, "https://x/px/0/0/0.jpg", bytes(300), "image/jpeg");
    first.put(northrop, "https://x/px/1/0/0.jpg", bytes(200, 9), "image/jpeg");
    await first.settled();
    expect((await first.inspect())).toMatchObject({ available: true, files: 2, bytes: 500, added: { files: 2, bytes: 500 }, reused: { files: 0, bytes: 0 } });

    // A new visit: a new store on the same storage.
    const second = createMediaStore({ open: async () => memory.backend, maxBytes: MIB, now: () => 2000 });
    const saved = await second.get(northrop, "https://x/px/1/0/0.jpg");
    expect(saved?.contentType).toBe("image/jpeg");
    expect([...saved!.bytes]).toEqual([...bytes(200, 9)]);
    expect(await second.get(northrop, "https://x/px/2/0/0.jpg")).toBeNull();
    await second.settled();
    const snapshot = await second.inspect();
    expect(snapshot.reused).toEqual({ files: 1, bytes: 200 });
    // Reading it marked the group as used on this visit.
    expect(snapshot.groups[0]).toMatchObject({ id: northrop.id, used: 2000, files: 2 });
  });

  it("does not ask the storage about a group it holds nothing of", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: MIB });
    for (let index = 0; index < 20; index++) expect(await store.get(northrop, `https://x/${index}.jpg`)).toBeNull();
    expect(memory.calls.read).toBe(0);
  });

  it("keeps another revision of an asset apart", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: MIB });
    store.put(northrop, "https://x/tile.jpg", bytes(10, 1), "image/jpeg");
    await store.settled();
    const newer = mediaGroup({ id: "northrop-mall", revision: "next" }, { id: "eac-tiles" });
    expect(await store.get(newer, "https://x/tile.jpg")).toBeNull();
    expect((await store.get(northrop, "https://x/tile.jpg"))?.bytes[0]).toBe(1);
  });

  it("counts a file once, however often it is put", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: MIB });
    store.put(northrop, "https://x/a.jpg", bytes(100), null);
    store.put(northrop, "https://x/a.jpg", bytes(100), null);
    await store.settled();
    store.put(northrop, "https://x/a.jpg", bytes(100), null);
    await store.settled();
    expect(await store.inspect()).toMatchObject({ files: 1, bytes: 100, added: { files: 1, bytes: 100 } });
  });

  it("drops the group unused longest, whole, when the limit is passed", async () => {
    const memory = memoryBackend();
    let time = 0;
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: 1000, now: () => time });
    time = 1; store.put(previews, "https://x/p.jpg", bytes(100), null);
    await store.settled();
    time = 2; store.put(northrop, "https://x/n1.jpg", bytes(400), null);
    store.put(northrop, "https://x/n2.jpg", bytes(100), null);
    await store.settled();
    // The previews are read again later, as every visit does, so the tiles are now the oldest.
    time = 3;
    const laterVisit = createMediaStore({ open: async () => memory.backend, maxBytes: 1000, now: () => time });
    expect(await laterVisit.get(previews, "https://x/p.jpg")).not.toBeNull();
    await laterVisit.settled();
    time = 4; laterVisit.put(bookstore, "https://x/b.jpg", bytes(450), null);
    await laterVisit.settled();
    const snapshot = await laterVisit.inspect();
    expect(snapshot.groups.map(group => group.id).sort()).toEqual([bookstore.id, previews.id].sort());
    expect(snapshot.bytes).toBe(550);
    expect([...memory.files.keys()].some(key => key.startsWith(northrop.id))).toBe(false);
  });

  it("stops writing a group that is over the limit by itself", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: 250 });
    store.put(northrop, "https://x/1.jpg", bytes(200), null);
    await store.settled();
    store.put(northrop, "https://x/2.jpg", bytes(200), null);
    await store.settled();
    expect(await store.inspect()).toMatchObject({ files: 0, bytes: 0 });
    const writes = memory.calls.write;
    store.put(northrop, "https://x/3.jpg", bytes(200), null);
    await store.settled();
    expect(memory.calls.write).toBe(writes);
    // A file larger than the whole limit is never written.
    store.put(bookstore, "https://x/huge.jpg", bytes(300), null);
    await store.settled();
    expect(memory.calls.write).toBe(writes);
  });

  it("keeps and reads nothing at a limit of nothing, and shrinks to a lowered limit", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: 1000 });
    store.put(northrop, "https://x/1.jpg", bytes(300), null);
    store.put(bookstore, "https://x/2.jpg", bytes(300), null);
    await store.settled();
    store.setLimits({ maxBytes: 400 });
    await store.settled();
    expect((await store.inspect()).bytes).toBe(300);
    store.setLimits({ maxBytes: 0 });
    await store.settled();
    expect(await store.inspect()).toMatchObject({ bytes: 0, files: 0, maxBytes: 0 });
    store.put(northrop, "https://x/1.jpg", bytes(10), null);
    await store.settled();
    expect(await store.get(northrop, "https://x/1.jpg")).toBeNull();
    expect(memory.files.size).toBe(0);
  });

  it("adds nothing before it is given its limit", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend });
    store.put(northrop, "https://x/1.jpg", bytes(10), null);
    await store.settled();
    expect(memory.files.size).toBe(0);
    store.setLimits({ maxBytes: 1000 });
    store.put(northrop, "https://x/1.jpg", bytes(10), null);
    await store.settled();
    expect(memory.files.size).toBe(1);
  });

  it("makes room when the browser's own quota is full, and gives up without stopping the scene when it cannot", async () => {
    const memory = memoryBackend({ quotaBytes: 500 });
    let time = 0;
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: 10_000, now: () => time });
    time = 1; store.put(northrop, "https://x/n.jpg", bytes(400), null);
    await store.settled();
    time = 2; store.put(bookstore, "https://x/b.jpg", bytes(300), null);
    await store.settled();
    let snapshot = await store.inspect();
    expect(snapshot.groups.map(group => group.id)).toEqual([bookstore.id]);
    expect(snapshot.problem).toBeNull();
    // Nothing else can be given up for a file that does not fit the quota at all.
    time = 3; store.put(bookstore, "https://x/b2.jpg", bytes(400), null);
    await store.settled();
    snapshot = await store.inspect();
    expect(snapshot.problem).toMatch(/no more room/);
    expect(snapshot.bytes).toBe(300);
    // What is kept is still read.
    expect(await store.get(bookstore, "https://x/b.jpg")).not.toBeNull();
    // Clearing starts again.
    await store.clear();
    store.put(northrop, "https://x/n.jpg", bytes(100), null);
    await store.settled();
    expect(await store.inspect()).toMatchObject({ problem: null, bytes: 100 });
  });

  it("forgets one file and leaves the rest of its group", async () => {
    const memory = memoryBackend();
    const store = createMediaStore({ open: async () => memory.backend, maxBytes: MIB });
    const files = store.files(northrop);
    files.put("https://x/1.jpg", bytes(100), null);
    files.put("https://x/2.jpg", bytes(50), null);
    await store.settled();
    files.forget("https://x/1.jpg");
    await store.settled();
    expect(await files.get("https://x/1.jpg")).toBeNull();
    expect(await files.get("https://x/2.jpg")).not.toBeNull();
    expect(await store.inspect()).toMatchObject({ files: 1, bytes: 50 });
  });

  it("answers as an empty store where the browser has no storage", async () => {
    const store = createMediaStore({ open: async () => null, maxBytes: MIB });
    store.put(northrop, "https://x/1.jpg", bytes(10), null);
    await store.settled();
    expect(await store.get(northrop, "https://x/1.jpg")).toBeNull();
    expect(await store.inspect()).toMatchObject({ available: false, files: 0, bytes: 0 });
    await store.clear();
    const failing = createMediaStore({ open: async () => { throw new Error("denied"); }, maxBytes: MIB });
    expect(await failing.get(northrop, "https://x/1.jpg")).toBeNull();
    expect((await failing.inspect()).available).toBe(false);
  });
});
