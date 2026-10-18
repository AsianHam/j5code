import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../j5/agents/useAgentMentionPicker", () => ({
  useAgentMentionPicker: () => ({ items: [], isPending: false, error: null }),
}));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("../../j5/state", () => ({ j5Environment: { playbookLibrary: vi.fn() } }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  readComposerDraftSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => refreshProviders,
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  it("hides playbooks after earlier text while retaining local commands", () => {
    const items = buildComposerSlashCommandItems({
      query: "",
      atMessageStart: false,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: null,
    });
    expect(items.map((item) => item.label)).toEqual(["/model", "/plan", "/default"]);
  });

  it("inserts the registered playbook name", () => {
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/playbook deb",
        trigger: { rangeStart: 0, rangeEnd: 13 },
        item: {
          id: "playbook:debugging",
          type: "playbook",
          name: "debugging",
          label: "Debug",
          description: "",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/playbook debugging ", cursor: 20, interactionMode: null });
  });
  it("inserts a mentioned playbook name mid-message", () => {
    const draftMessage = "Please run @playbook:deb";
    expect(
      resolveComposerCommandSelection({
        draftMessage,
        trigger: { rangeStart: 11, rangeEnd: 24 },
        item: {
          id: "playbook:debugging",
          type: "playbook",
          name: "debugging",
          label: "debugging",
          description: "",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "Please run @playbook:debugging ", cursor: 31, interactionMode: null });
  });
  it("keeps the playbook command active to search names", () => {
    const item = buildComposerSlashCommandItems({
      query: "playbook",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      selectedProviderStatus: null,
    })[0];
    if (!item) throw new Error("Expected playbook command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/playbook",
        trigger: { rangeStart: 0, rangeEnd: 9 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({
      text: "/playbook ",
      cursor: 10,
      interactionMode: null,
    });
  });
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items.map((item) => item.type)).toEqual(["slash-command", "provider-slash-command"]);
      const item = items.find((item) => item.type === "provider-slash-command");
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("workspace command discovery retry", () => {
  let root: Root;
  const environmentId = EnvironmentId.make("test-environment");
  const instanceId = ProviderInstanceId.make("claude");
  const provider = {
    instanceId,
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: [
      {
        cwd: "/project-a",
        checkedAt: "2026-01-01T00:00:00.000Z",
        slashCommandsPending: true,
        slashCommands: [{ name: "compact" }],
        skills: [],
      },
    ],
  } satisfies ServerProvider;

  function Probe({ cwd, status = provider }: { cwd: string; status?: ServerProvider }) {
    useComposerCommandMenu({
      draftMessage: "/project",
      ownerKey: null,
      environmentId,
      projectId: null,
      projectCwd: cwd,
      selectedProviderStatus: status,
      hasThread: false,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    refreshProviders.mockReset();
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries partial commands after the cooldown without editing the draft", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: [{ ...provider.workspaceSnapshots[0], slashCommandsPending: false }],
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [provider] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-a" },
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it.each(["pi", "acpRegistry"])(
    "does not poll a healthy %s workspace without discovery",
    async (driver) => {
      const unsupported = {
        ...provider,
        driver: ProviderDriverKind.make(driver),
        workspaceSnapshots: [],
      };
      refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [unsupported] } });
      await act(async () => {
        root.render(createElement(Probe, { cwd: "/project-a", status: unsupported }));
      });
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("arms the remaining cooldown when a concurrent scan publishes partial commands", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [missing] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: provider }));
    });
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("does not retry when a concurrent scan publishes a complete workspace", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [missing] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: recovered }));
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a rejected refresh while published discovery remains pending", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockRejectedValueOnce(new Error("Connection lost"));
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("cancels the old workspace retry and does not duplicate an in-flight request", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    refreshProviders.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-b" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-b" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry when the composer unmounts", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(async () => {
      root.unmount();
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
