import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { createScopedThreadReadStore } from "./scopedThreadReadStore.ts";

const alpha = EnvironmentId.make("alpha");
const bravo = EnvironmentId.make("bravo");
const prepared = (environmentId: EnvironmentId): PreparedConnection => ({
  environmentId,
  label: environmentId,
  httpBaseUrl: `https://${environmentId}.test`,
  socketUrl: `wss://${environmentId}.test/ws`,
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: environmentId,
    httpBaseUrl: `https://${environmentId}.test`,
    wsBaseUrl: `wss://${environmentId}.test`,
  }),
});

function waitForChange(
  store: { readonly subscribe: (listener: () => void) => () => void },
  ready: () => boolean,
) {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (ready()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

it("keeps a negative answer loaded, re-reads only named rows, and keeps the snapshot when nothing changed", async () => {
  const one = ThreadId.make("thread:one");
  const two = ThreadId.make("thread:two");
  const load = vi.fn(async (_: EnvironmentId, ids: ReadonlyArray<ThreadId>) =>
    // Only `one` sits in a Crew; `two` is answered with nothing, which is an answer too.
    ids.includes(one) ? [{ threadId: one, value: "seat" }] : [],
  );
  const store = createScopedThreadReadStore<string, { threadId: ThreadId; value: string }>({
    load,
    replace: (current, environmentId, requested, entries) => {
      const next = new Map(current);
      for (const id of requested) next.delete(scopedThreadKey(scopeThreadRef(environmentId, id)));
      for (const entry of entries)
        next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.value);
      return next;
    },
  });
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([scopeThreadRef(alpha, one), scopeThreadRef(alpha, two)]);
  await waitForChange(store, () => store.getSnapshot().size === 1);
  expect(load.mock.calls).toHaveLength(1);
  const first = store.getSnapshot();
  // The requested set reorders and shrinks; the negative for `two` is not fetched again.
  store.request([scopeThreadRef(alpha, two), scopeThreadRef(alpha, one)]);
  store.request([scopeThreadRef(alpha, two)]);
  expect(load.mock.calls).toHaveLength(1);
  // The poll names the involved row only; the read carries just that id and, being unchanged,
  // leaves the same snapshot in place so no subscriber re-renders.
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.refreshRows([scopeThreadRef(alpha, one), scopeThreadRef(bravo, one)]);
  await waitForChange(store, () => notified > 0);
  expect(load.mock.calls).toHaveLength(2);
  expect(load.mock.calls[1]?.[1]).toEqual([one]);
  expect(store.getSnapshot()).toBe(first);
  // A row nobody asked for is not read on the poll's say-so.
  store.refreshRows([scopeThreadRef(alpha, ThreadId.make("thread:unrequested"))]);
  expect(load.mock.calls).toHaveLength(2);
});

it("re-reads the rows still holding a value on a held refresh, so an ended relation clears", async () => {
  const one = ThreadId.make("thread:one");
  const two = ThreadId.make("thread:two");
  let crews: ReadonlyArray<ThreadId> = [one];
  const load = vi.fn(async (_: EnvironmentId, ids: ReadonlyArray<ThreadId>) =>
    ids.filter((id) => crews.includes(id)).map((id) => ({ threadId: id, value: "seat" })),
  );
  const store = createScopedThreadReadStore<string, { threadId: ThreadId; value: string }>({
    load,
    replace: (current, environmentId, requested, entries) => {
      const next = new Map(current);
      for (const id of requested) next.delete(scopedThreadKey(scopeThreadRef(environmentId, id)));
      for (const entry of entries)
        next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.value);
      return next;
    },
  });
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([scopeThreadRef(alpha, one), scopeThreadRef(alpha, two)]);
  await waitForChange(store, () => store.getSnapshot().size === 1);
  // The Crew retires elsewhere: the live roster names nobody, yet `one` still shows its chip. The
  // held refresh re-reads it, and only it, and the chip clears.
  crews = [];
  let reads = 0;
  store.subscribe(() => {
    reads += 1;
  });
  store.refreshRows([], { held: true });
  await waitForChange(store, () => reads > 0);
  expect(load.mock.calls).toHaveLength(2);
  expect(load.mock.calls[1]?.[1]).toEqual([one]);
  expect(store.getSnapshot().size).toBe(0);
  // Nothing holds a value now, so a held refresh with no named rows reads nothing at all.
  store.refreshRows([], { held: true });
  expect(load.mock.calls).toHaveLength(2);
});
