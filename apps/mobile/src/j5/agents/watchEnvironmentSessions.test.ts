import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const sessions = vi.hoisted(() => ({
  generation: null as unknown as import("effect/reactivity").Atom.Writable<number>,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  sessions.generation = Atom.make(1).pipe(Atom.keepAlive);
  return { environmentCatalog: { sessionGenerationAtom: () => sessions.generation } };
});

import { appAtomRegistry } from "../../state/atom-registry";
import { watchEnvironmentSessions } from "./watchEnvironmentSessions";

const environmentId = EnvironmentId.make("environment-1");

describe("watchEnvironmentSessions", () => {
  it("waits through a stale connected state until a new session is up", async () => {
    appAtomRegistry.set(sessions.generation, 1);
    const watch = watchEnvironmentSessions(environmentId);
    let settled: boolean | null = null;
    const waiting = watch.waitForNewSession().then((value) => {
      settled = value;
    });
    // The resume cleared the old session but no new one has counted yet.
    await Promise.resolve();
    expect(settled).toBeNull();
    appAtomRegistry.set(sessions.generation, 2);
    await waiting;
    expect(settled).toBe(true);
    watch.dispose();
  });

  it("resolves at once when a new session came up before the wait began", async () => {
    appAtomRegistry.set(sessions.generation, 3);
    const watch = watchEnvironmentSessions(environmentId);
    appAtomRegistry.set(sessions.generation, 4);
    await expect(watch.waitForNewSession()).resolves.toBe(true);
    watch.dispose();
  });

  it("gives up after the bounded wait when no new session comes", async () => {
    vi.useFakeTimers();
    try {
      appAtomRegistry.set(sessions.generation, 5);
      const watch = watchEnvironmentSessions(environmentId);
      const waiting = watch.waitForNewSession();
      vi.advanceTimersByTime(15_000);
      await expect(waiting).resolves.toBe(false);
      watch.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
