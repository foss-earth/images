import { describe, expect, it, vi } from "vitest";
import { openIndexedDbBackend } from "./indexedDb.js";
import { indexedDbReadFixture } from "../test/indexedDbReadFixture.js";

const group = { id: "fixture@1/preview", label: "Preview", bytes: 1000, files: 1, used: 0 };
const key = `${group.id}\nhttps://example.test/image.png`;
describe("admission before IndexedDB body materialization", () => {
  it("waits for every admitted nonabortable materialization before rejecting a batch", async () => {
    const first = new Blob([new Uint8Array([1])]), second = new Blob([new Uint8Array([2])]);
    const error = new Error("first storage read failed"); let finish!: () => void;
    vi.spyOn(first, "arrayBuffer").mockRejectedValue(error);
    vi.spyOn(second, "arrayBuffer").mockImplementation(() => new Promise<ArrayBuffer>(resolve => { finish = () => resolve(new Uint8Array([2]).buffer); }));
    const fixture = indexedDbReadFixture({ group, blobs: new Map([[key, first], [`${key}2`, second]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    let ended = false;
    const read = backend.readBounded!([key, `${key}2`].map(key => ({ key, group: group.id, admission: { maxBytes: 10, admit: () => true } })));
    const failed = expect(read.finally(() => { ended = true; })).rejects.toBe(error);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); expect(ended).toBe(false);
    finish(); await failed; expect(ended).toBe(true);
  });
  it("refuses an oversized Blob without materializing its bytes", async () => {
    const blob = new Blob([new Uint8Array(1000)]), materialize = vi.spyOn(blob, "arrayBuffer");
    const fixture = indexedDbReadFixture({ group, blobs: new Map([[key, blob]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    const admit = vi.fn(() => true);
    expect(await backend.readBounded!([{ key, group: group.id, admission: { maxBytes: 64, admit } }])).toEqual([null]);
    expect(admit).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled();
    expect(fixture.calls.openedVersion).toBe(2); expect(fixture.names.has("files")).toBe(true);
  });
  it("admits exact Blob size before materializing the same immutable snapshot", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]), order: string[] = [];
    const read = blob.arrayBuffer.bind(blob); vi.spyOn(blob, "arrayBuffer").mockImplementation(() => { order.push("materialize"); return read(); });
    const fixture = indexedDbReadFixture({ group, blobs: new Map([[key, blob]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    const [file] = await backend.readBounded!([{ key, group: group.id, admission: { maxBytes: 64, admit(bytes) { order.push(`admit ${bytes}`); return true; } } }]);
    expect(order).toEqual(["admit 3", "materialize"]); expect([...file!.bytes]).toEqual([1, 2, 3]);
    expect(fixture.calls.legacyClones).toBe(0);
  });
  it("does not clone v1 arrays when their trusted aggregate bound does not fit", async () => {
    const fixture = indexedDbReadFixture({ group, legacy: new Map([[key, new Uint8Array(1000).buffer]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    expect(await backend.readBounded!([{ key, group: group.id, admission: { maxBytes: 64, admit: () => true } }])).toEqual([null]);
    expect(fixture.calls.legacyClones).toBe(0);
  });
  it("retains v1 cache compatibility only after its transaction group bound is admitted", async () => {
    const fixture = indexedDbReadFixture({ group, legacy: new Map([[key, new Uint8Array([1, 2, 3]).buffer]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    const admission = vi.fn((bytes: number) => bytes === group.bytes);
    const [file] = await backend.readBounded!([{ key, group: group.id, admission: { maxBytes: 2000, admit: admission } }]);
    expect(admission).toHaveBeenCalledWith(1000); expect([...file!.bytes]).toEqual([1, 2, 3]); expect(fixture.calls.legacyClones).toBe(1);
  });
  it("writes new immutable Blob rows and atomically updates metadata without duplicating a v1 row", async () => {
    const fixture = indexedDbReadFixture({ group, legacy: new Map([[key, new Uint8Array([1, 2, 3]).buffer]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!, bytes = new Uint8Array([4, 5]);
    expect(await backend.write([{ key, group, bytes, contentType: "image/png" }, { key: `${key}2`, group, bytes, contentType: "image/png" }], 7)).toEqual({ files: 1, bytes: 2 });
    bytes[0] = 9;
    expect(fixture.blobs.has(key)).toBe(false); expect(fixture.legacy.has(key)).toBe(true);
    expect(fixture.groups.get(group.id)).toMatchObject({ bytes: 1002, files: 2, used: 7 });
    expect([...new Uint8Array(await fixture.blobs.get(`${key}2`)!.arrayBuffer())]).toEqual([4, 5]);
    expect(fixture.calls.legacyClones).toBe(0);
  });
  it("removes a safely observed v1 file without cloning it a second time", async () => {
    const fixture = indexedDbReadFixture({ group: { ...group, files: 2 }, legacy: new Map([[key, new Uint8Array([1, 2, 3]).buffer]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    await backend.readBounded!([{ key, group: group.id, admission: { maxBytes: 2000, admit: () => true } }]);
    await backend.remove(key, group.id);
    expect(fixture.calls.legacyClones).toBe(1); expect(fixture.legacy.has(key)).toBe(false);
    expect(fixture.groups.get(group.id)).toMatchObject({ files: 1, bytes: 997 });
  });
  it("keeps conservative accounting for an unobserved v1 removal without unsafe body reads", async () => {
    const fixture = indexedDbReadFixture({ group, legacy: new Map([[key, new Uint8Array(1000).buffer]]) });
    const backend = (await openIndexedDbBackend(fixture.factory))!;
    await backend.remove(key, group.id);
    expect(fixture.calls.legacyClones).toBe(0); expect(fixture.legacy.has(key)).toBe(false);
    expect(fixture.groups.get(group.id)).toEqual(group);
  });
});
