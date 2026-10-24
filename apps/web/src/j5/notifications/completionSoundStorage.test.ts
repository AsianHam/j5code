import { afterEach, expect, it, vi } from "vite-plus/test";

// Exercise the storage adapter's transaction boundary, including persistence across module reloads.
function indexedDbFixture() {
  const records = new Map<IDBValidKey, unknown>();
  const database = {
    createObjectStore: vi.fn(),
    transaction: vi.fn(() => {
      const transaction = new EventTarget();
      const request = { result: undefined as unknown };
      const store = {
        get(key: IDBValidKey) {
          request.result = structuredClone(records.get(key));
          return request;
        },
        put(value: unknown, key: IDBValidKey) {
          records.set(key, structuredClone(value));
          return request;
        },
        delete(key: IDBValidKey) {
          records.delete(key);
          return request;
        },
      };
      Object.assign(transaction, { objectStore: () => store });
      queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
      return transaction;
    }),
  };
  return {
    records,
    open: vi.fn(() => {
      const request = Object.assign(new EventTarget(), { result: database });
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
      return request;
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());

it("writes bytes to the local store, reloads them and durably removes them on reset", async () => {
  const fixture = indexedDbFixture();
  vi.stubGlobal("indexedDB", fixture);
  vi.resetModules();
  const first = (await import("./completionSoundStorage")).completionSoundStorage;
  const sound = { name: "done.mp3", bytes: new Uint8Array([73, 68, 51]).buffer, duration: 1 };
  await first.write(sound);
  expect(fixture.records.get("completion")).toEqual(sound);
  vi.resetModules();
  const reloaded = (await import("./completionSoundStorage")).completionSoundStorage;
  const saved = await reloaded.read();
  expect(saved).toEqual(sound);
  expect(saved?.bytes).not.toBe(sound.bytes);
  await reloaded.write(null);
  vi.resetModules();
  expect(await (await import("./completionSoundStorage")).completionSoundStorage.read()).toBeNull();
  expect(fixture.open).toHaveBeenCalledWith("j5code:completion-sound", 1);
});

it("reports damaged saved records for settings to show an error", async () => {
  const fixture = indexedDbFixture();
  fixture.records.set("completion", { name: "lost bytes" });
  vi.stubGlobal("indexedDB", fixture);
  vi.resetModules();
  await expect(
    (await import("./completionSoundStorage")).completionSoundStorage.read(),
  ).rejects.toThrow("invalid");
});
