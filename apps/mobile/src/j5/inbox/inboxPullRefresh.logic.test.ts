import { describe, expect, it, vi } from "vite-plus/test";

import { createPullRefresh } from "./inboxPullRefresh.logic";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("the Inbox's pull-to-refresh spinner", () => {
  it("shows from the person's pull until every read has settled", async () => {
    const read = deferred();
    const changes: Array<boolean> = [];
    const pull = createPullRefresh({
      read: () => read.promise,
      onChange: (on) => changes.push(on),
    });

    const done = pull();
    expect(changes).toEqual([true]);

    read.resolve();
    await done;
    expect(changes).toEqual([true, false]);
  });

  it("stops when a read fails, so a server that can't answer doesn't leave it spinning", async () => {
    const changes: Array<boolean> = [];
    const pull = createPullRefresh({
      read: () => Promise.reject(new Error("offline")),
      onChange: (on) => changes.push(on),
    });

    await pull();
    expect(changes).toEqual([true, false]);
  });

  it("ignores a second pull while one is running", async () => {
    const reading = deferred();
    const read = vi.fn(() => reading.promise);
    const pull = createPullRefresh({ read, onChange: () => undefined });

    const first = pull();
    void pull();
    expect(read).toHaveBeenCalledTimes(1);

    reading.resolve();
    await first;
    await pull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
