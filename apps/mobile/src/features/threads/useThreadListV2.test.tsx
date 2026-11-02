import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({
    isListed: () => true,
    unloadedCount: () => 0,
    loading: false,
    failed: false,
  }),
  useOlderSettledShelfGrowth: () => {},
}));

import { makeThreadShellFixture } from "../../test-fixtures";
import { useThreadListV2 } from "./useThreadListV2";

const NOW = "2026-06-02T00:00:00.000Z";
const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW,
};

// Runs under the release React Compiler (vite.config.ts `reactTests`), as the app does.
it("returns a finished thread from Working once its grace ends, with nothing else changing", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const working = makeThreadShellFixture({
      id: ThreadId.make("new-thread"),
      title: "Say hello",
      runtime: running,
    });
    const finished = { ...working, runtime: null };
    function Probe({ threads }: { readonly threads: ReadonlyArray<typeof working> }) {
      const { layout } = useThreadListV2({
        threads,
        pendingTasks: [],
        environmentId: null,
        projectRefs: null,
        searchQuery: "",
        searchMatches: new Map(),
        settlementEnvironmentIds: new Set(),
        snoozeEnvironmentIds: new Set(),
        pinReorderEnvironmentIds: new Set(),
        activeReorderEnvironmentIds: new Set(),
        queuedThreadKeys: new Set(),
        settledLimit: 10,
        now: NOW,
        pendingOrder: null,
        shelfPreferencesLoaded: true,
        workingShelfEnabled: true,
        workingShelfExpanded: false,
        snoozedShelfExpanded: false,
        settledShelfExpanded: false,
        selectedThreadKey: null,
      });
      return <span>{layout.workingCount}</span>;
    }
    const workingCount = () => Number(container.textContent);
    const workingThreads = [working];
    const finishedThreads = [finished];
    act(() => root.render(<Probe threads={workingThreads} />));
    expect(workingCount()).toBe(1);
    // The turn ends: the shelf holds the thread for the grace period.
    act(() => root.render(<Probe threads={finishedThreads} />));
    expect(workingCount()).toBe(1);
    // Only the grace timer fires; the thread list itself does not change again.
    act(() => vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS));
    expect(workingCount()).toBe(0);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
