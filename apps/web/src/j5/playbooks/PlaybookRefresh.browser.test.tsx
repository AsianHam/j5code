import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PlaybookProgress } from "@t3tools/contracts/j5";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  revision: 0,
  version: 0,
  pending: false,
  supported: true,
  visibleRuns: [] as PlaybookProgress[],
  serverRuns: [] as PlaybookProgress[],
  listeners: new Set<() => void>(),
  refresh: vi.fn(),
}));
const emit = () => {
  state.version++;
  state.listeners.forEach((listener) => listener());
};
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: string | null) => {
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.version,
    );
    return {
      data:
        atom === "runs"
          ? { runs: state.visibleRuns, total: state.visibleRuns.length }
          : atom === "changes"
            ? state.revision
            : null,
      error: null,
      isPending: atom === "runs" && state.pending,
      refresh: state.refresh,
    };
  }) as never,
}));
vi.mock(import("../state"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    j5Environment: {
      ...original.j5Environment,
      playbooks: (() => "runs") as never,
      playbookRuns: (() => "runs") as never,
      playbookChanges: (() => "changes") as never,
    },
  };
});
vi.mock(import("../../state/environments"), async (importOriginal) => {
  const environment = {
    environmentId: "env",
    label: "Environment",
    connection: { phase: "connected" },
    get serverConfig() {
      return { environment: { capabilities: { j5ProjectLedger: state.supported } } };
    },
  };
  return {
    ...(await importOriginal()),
    useEnvironment: (() => environment) as never,
    useEnvironments: (() => ({ environments: [environment], isReady: true })) as never,
  };
});
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadShell: (() => ({ latestRun: { runId: "same-turn", status: "running" } })) as never,
  useThreadShells: (() => []) as never,
}));
vi.mock(import("../../hooks/useNowMinute"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNowMinute: () => "2026-09-23T12:00",
}));
vi.mock(import("./PlaybookStepStrip"), async (importOriginal) => ({
  ...(await importOriginal()),
  PlaybookStepStrip: () => null,
}));
import { act, fakeTimers, render } from "../../../test/render";
import { PlaybookComposerControl } from "./PlaybookComposerControl";
import { PlaybookRunsSection } from "./PlaybookRunsSection";

// The test page is always visible, so the test overrides the document's own getter.
function stubVisibility(): Disposable & { set: (state: DocumentVisibilityState) => void } {
  let current: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => current,
  });
  return {
    set: (next) => {
      current = next;
    },
    [Symbol.dispose]: () => void Reflect.deleteProperty(document, "visibilityState"),
  };
}

function setup() {
  Object.assign(state, {
    revision: 0,
    version: 0,
    pending: false,
    supported: true,
    visibleRuns: [],
    serverRuns: [],
  });
  state.refresh.mockReset().mockImplementation(() => {
    state.visibleRuns = [...state.serverRuns];
    emit();
  });
}

it.each(["thread", "Fleet"] as const)(
  "%s discovers a playbook started in the same running turn, and holds no timer with or without an active run",
  async (surface) => {
    setup();
    using _timers = fakeTimers();
    using visibility = stubVisibility();
    await using screen = await render(
      surface === "thread" ? (
        <PlaybookComposerControl
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("thread")}
        />
      ) : (
        <PlaybookRunsSection />
      ),
    );
    vi.advanceTimersByTime(60_000);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    state.serverRuns = [
      {
        runId: "playbook",
        ownerThreadId: ThreadId.make("thread"),
        definitionPath: "/workspace/.j5/playbooks/demo.yaml",
        currentStepId: "first",
        status: "active",
        createdAt: "2026-09-23T12:00:00Z",
        updatedAt: "2026-09-23T12:00:00Z",
        title: "Live demo",
        description: "",
        steps: [{ id: "first", title: "First" }],
        position: 1,
        total: 1,
        issue: null,
      },
    ];
    await act(() => {
      state.revision++;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain("Live demo");
    // An active run is followed by the server's revision, which a file change moves too.
    vi.advanceTimersByTime(60_000);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A terminal update arriving during a read must be fetched once that read finishes.
    await act(() => {
      state.pending = true;
      emit();
    });
    state.serverRuns = [{ ...state.serverRuns[0]!, status: "completed" }];
    await act(() => {
      state.revision++;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(() => {
      state.pending = false;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    // No timer count here: the Fleet card's real UI components schedule their own once the run
    // completes. The refresh never holds one, which the counts above already show.
    expect(screen.container.textContent).toContain("Completed");

    visibility.set("hidden");
    await act(() => void document.dispatchEvent(new Event("visibilitychange")));
    state.serverRuns = [
      { ...state.serverRuns[0]!, status: "active", title: "Started while hidden" },
    ];
    await act(() => {
      state.revision++;
      emit();
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    visibility.set("visible");
    await act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.container.textContent).toContain("Started while hidden");

    await act(() => {
      state.supported = false;
      emit();
    });
    state.refresh.mockClear();
    await act(() => {
      state.revision++;
      emit();
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refresh).not.toHaveBeenCalled();
  },
);
