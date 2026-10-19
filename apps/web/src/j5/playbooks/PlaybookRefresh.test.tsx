import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PlaybookProgress } from "@t3tools/contracts/j5";
import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PlaybookComposerControl } from "./PlaybookComposerControl";
import { PlaybookRunsSection } from "./PlaybookRunsSection";

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
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => {
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
  },
}));
vi.mock("../state", () => ({
  j5Environment: {
    playbooks: () => "runs",
    playbookRuns: () => "runs",
    playbookChanges: () => "changes",
  },
}));
vi.mock("../../state/shell", () => ({ environmentShell: { stateAtom: () => "shell" } }));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "env",
    label: "Environment",
    connection: { phase: "connected" },
    get serverConfig() {
      return { environment: { capabilities: { j5ProjectLedger: state.supported } } };
    },
  };
  return {
    useEnvironment: () => environment,
    useEnvironments: () => ({ environments: [environment], isReady: true }),
  };
});
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ latestRun: { runId: "same-turn", status: "running" } }),
  useThreadShells: () => [],
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-23T12:00" }));
vi.mock("../../components/Sidebar.logic", () => ({ resolveThreadStatusPill: () => null }));
vi.mock("./PlaybookStepStrip", () => ({ PlaybookStepStrip: () => null }));
vi.mock("../../components/ui/tooltip", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Tooltip: Wrapper, TooltipTrigger: Wrapper, TooltipPopup: Wrapper };
});
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => createElement("button", null, children),
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["thread", "Fleet"] as const)(
  "%s discovers a playbook started in the same running turn, and holds no timer with or without an active run",
  async (surface) => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    await act(async () => {
      renderer = create(
        surface === "thread"
          ? createElement(PlaybookComposerControl, {
              environmentId: EnvironmentId.make("env"),
              threadId: ThreadId.make("thread"),
            })
          : createElement(PlaybookRunsSection),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
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
    await act(async () => {
      state.revision++;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Live demo");
    // An active run is followed by the server's revision, which a file change moves too.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A terminal update arriving during a read must be fetched once that read finishes.
    await act(async () => {
      state.pending = true;
      emit();
    });
    state.serverRuns = [{ ...state.serverRuns[0]!, status: "completed" }];
    await act(async () => {
      state.revision++;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      state.pending = false;
      emit();
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Completed");
    expect(vi.getTimerCount()).toBe(0);

    document.visibilityState = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    state.serverRuns = [
      { ...state.serverRuns[0]!, status: "active", title: "Started while hidden" },
    ];
    await act(async () => {
      state.revision++;
      emit();
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    document.visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Started while hidden");

    await act(async () => {
      state.supported = false;
      emit();
    });
    state.refresh.mockClear();
    await act(async () => {
      state.revision++;
      emit();
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refresh).not.toHaveBeenCalled();
  },
);
