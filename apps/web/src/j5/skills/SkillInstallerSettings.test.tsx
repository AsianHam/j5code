import { EnvironmentId } from "@t3tools/contracts";
import type * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SkillCatalogPanel } from "./SkillInstallerSettings";
import { openCommandPalette } from "../../commandPaletteBus";

const state = vi.hoisted(() => ({
  notify: vi.fn(),
  configuredSource: "/catalog/A",
  status: {
    data: null as unknown,
    error: null as string | null,
    isPending: true,
    refresh: vi.fn(),
  },
  persistImpl: null as null | ((value: unknown) => Promise<unknown>),
  applyCalls: [] as Array<unknown>,
  updateCalls: [] as Array<unknown>,
  applyImpl: null as null | ((value: unknown) => Promise<unknown>),
  updateImpl: null as null | ((value: unknown) => Promise<unknown>),
  canOperate: true,
}));

// The only atom the panel reads is the apply command's permission.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.canOperate }));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env-1",
        serverConfig: { settings: { skillCatalogSource: state.configuredSource } },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "env-1",
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => state.status,
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: { description: "updateSettings" } },
}));

vi.mock("./skillCatalogAtoms", () => ({
  skillCatalogEnvironment: {
    status: () => Symbol("status"),
    applyGroups: { description: "applyGroups", permissionAtom: () => null },
    updateCatalog: { description: "updateCatalog" },
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly description: string }) => {
    if (command.description === "updateSettings") {
      return (value: unknown) =>
        state.persistImpl ? state.persistImpl(value) : Promise.resolve({ _tag: "Success" });
    }
    if (command.description === "applyGroups") {
      return (value: unknown) => {
        state.applyCalls.push(value);
        return state.applyImpl
          ? state.applyImpl(value)
          : Promise.resolve({
              _tag: "Success",
              value: {
                selectedGroups: [],
                installed: 0,
                removed: 0,
                unchanged: 0,
                conflicts: [],
                failed: [],
              },
            });
      };
    }
    return (value: unknown) => {
      state.updateCalls.push(value);
      return state.updateImpl
        ? state.updateImpl(value)
        : Promise.resolve({ _tag: "Success", value: { upstream: "origin/main" } });
    };
  },
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (result: unknown) =>
    result instanceof Error ? result : new Error("save failed"),
}));

vi.mock("../../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
}));

vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => children,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: React.ReactNode;
    headerAction?: React.ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    children,
    control,
  }: {
    children?: React.ReactNode;
    control?: React.ReactNode;
  }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));

vi.mock("../../components/ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      {...props}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.notify } }));

vi.mock("../../components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../../components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? children : null,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../../components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const environmentId = EnvironmentId.make("env-1");

function statusData(source: string) {
  return {
    catalogDir: `/state/${source === "/catalog/A" ? "a" : "b"}`,
    groups: [{ name: "core", description: "", depends: [], skills: [] }],
    selectedGroups: ["core"],
    targets: [],
    git: { upstream: "origin/main", dirty: false },
    warnings: [],
  };
}

function setStatusLoaded(source: string) {
  state.status.data = statusData(source);
  state.status.error = null;
  state.status.isPending = false;
}

async function renderPanel(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<SkillCatalogPanel environmentId={environmentId} />);
  });
  if (state.canOperate) {
    await act(async () =>
      buttonByText(
        renderer!,
        state.configuredSource ? "Change source…" : "Add source…",
      ).props.onClick(),
    );
  }
  return renderer!;
}

async function rerender(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(<SkillCatalogPanel environmentId={environmentId} />);
  });
}

function sourceInput(renderer: ReactTestRenderer) {
  const inputs = renderer.root.findAll(
    (node) => node.type === "input" && typeof node.props.value === "string",
  );
  return inputs[0]!;
}

function buttonByText(renderer: ReactTestRenderer, text: string) {
  const buttons = renderer.root.findAll((node) => node.type === "button");
  const found = buttons.findLast((button) =>
    (Array.isArray(button.props.children)
      ? button.props.children.join("")
      : String(button.props.children ?? "")
    ).includes(text),
  );
  if (!found) throw new Error(`button "${text}" not found`);
  return found;
}

function applyButton(renderer: ReactTestRenderer) {
  return buttonByText(renderer, "Apply changes");
}

async function applyChanges(renderer: ReactTestRenderer) {
  await act(async () => applyButton(renderer).props.onClick());
  await act(async () => buttonByText(renderer, "Confirm changes").props.onClick());
}

function updateButton(renderer: ReactTestRenderer) {
  return buttonByText(renderer, "Update catalog");
}

function allParagraphText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => node.type === "p")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    )
    .join("\n");
}

describe("SkillCatalogPanel source identity", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.notify.mockReset();
    state.configuredSource = "/catalog/A";
    state.status.data = null;
    state.status.error = null;
    state.status.isPending = true;
    state.status.refresh = vi.fn();
    state.persistImpl = null;
    state.canOperate = true;
    state.applyImpl = null;
    state.updateImpl = null;
    state.applyCalls = [];
    state.updateCalls = [];
    vi.mocked(openCommandPalette).mockClear();
  });

  const conflicts = ["codex", "claude"].map((provider) => ({
    skill: "explain",
    linkPath: `/${provider}/explain`,
    detail: "Existing link",
    replacement: {
      linkPath: `/${provider}/explain`,
      currentTarget: "/deleted-catalog/skills/explain",
      target: "/state/a/skills/explain",
      identity: `identity-${provider}`,
    },
  }));
  async function renderConflicts() {
    setStatusLoaded("/catalog/A");
    state.applyImpl = async () => ({
      _tag: "Success",
      value: {
        selectedGroups: ["core"],
        installed: 0,
        removed: 0,
        unchanged: 0,
        conflicts,
        failed: [],
      },
    });
    const renderer = await renderPanel();
    await applyChanges(renderer);
    return renderer;
  }
  it("previews both targets and replaces only selected links after confirmation", async () => {
    const renderer = await renderConflicts();
    await act(async () => buttonByText(renderer, "Use this catalog…").props.onClick());
    expect(state.applyCalls).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("/deleted-catalog/skills/explain");
    expect(JSON.stringify(renderer.toJSON())).toContain("/state/a/skills/explain");
    const checkbox = renderer.root.findByProps({ "aria-label": "Replace /claude/explain" });
    await act(async () => checkbox.props.onChange({ target: { checked: false } }));
    state.applyImpl = async () => ({
      _tag: "Success",
      value: {
        selectedGroups: ["core"],
        installed: 1,
        removed: 0,
        unchanged: 0,
        conflicts: [conflicts[1]],
        failed: [],
      },
    });
    await act(async () => buttonByText(renderer, "Replace selected links").props.onClick());
    expect(state.applyCalls[1]).toEqual({
      environmentId,
      input: {
        expectedSource: "/catalog/A",
        groups: ["core"],
        replacements: [conflicts[0]!.replacement],
      },
    });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(allParagraphText(renderer)).toContain("Installed 1 links");
    expect(state.status.refresh).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });
  it("allows canceling and disables replacement when no links are selected", async () => {
    const renderer = await renderConflicts();
    await act(async () => buttonByText(renderer, "Use this catalog…").props.onClick());
    for (const conflict of conflicts) {
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": `Replace ${conflict.linkPath}` })
          .props.onChange({ target: { checked: false } }),
      );
    }
    expect(buttonByText(renderer, "Replace selected links").props.disabled).toBe(true);
    await act(async () => buttonByText(renderer, "Cancel").props.onClick());
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(state.applyCalls).toHaveLength(1);
    await act(async () => renderer.unmount());
  });
  it("dismisses the replacement preview when the environment's source changes", async () => {
    const renderer = await renderConflicts();
    await act(async () => buttonByText(renderer, "Use this catalog…").props.onClick());
    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("/deleted-catalog/skills/explain");
    expect(state.applyCalls).toHaveLength(1);
    await act(async () => renderer.unmount());
  });
  it("requires a new Apply after the group selection changes", async () => {
    const renderer = await renderConflicts();
    await act(async () =>
      renderer.root
        .findAll(
          (node) => node.type === "input" && node.props["aria-label"] === "Install core group",
        )[0]!
        .props.onChange({ target: { checked: false } }),
    );
    expect(buttonByText(renderer, "Use this catalog…").props.disabled).toBe(true);
    expect(state.applyCalls).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it.each(["/catalog/chosen", "https://github.com/example/skills.git"])(
    "keeps the chosen source %s as a draft until saved",
    async (source) => {
      setStatusLoaded("/catalog/A");
      const persist = vi.fn().mockResolvedValue({ _tag: "Success" });
      state.persistImpl = persist;
      const renderer = await renderPanel();

      await act(async () => buttonByText(renderer, "Choose source").props.onClick());
      const picker = vi.mocked(openCommandPalette).mock.calls.at(-1)?.[0]?.sourcePicker;
      expect(picker?.environmentId).toBe(environmentId);
      await act(async () => picker!.onSelect(source));

      expect(sourceInput(renderer).props.value).toBe(source);
      expect(persist).not.toHaveBeenCalled();
      expect(applyButton(renderer).props.disabled).toBe(true);
      expect(updateButton(renderer).props.disabled).toBe(true);
      await act(async () => buttonByText(renderer, "Save source").props.onClick());
      expect(persist).toHaveBeenCalledWith({
        environmentId,
        input: { patch: { skillCatalogSource: source } },
      });
      await act(async () => renderer.unmount());
    },
  );

  it("closes the source editor when acknowledged settings arrive before the save receipt", async () => {
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    let finish!: (result: unknown) => void;
    state.persistImpl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await act(async () =>
      sourceInput(renderer).props.onChange({ target: { value: "/catalog/B" } }),
    );
    await act(async () => buttonByText(renderer, "Save source").props.onClick());
    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    await act(async () => finish({ _tag: "Success" }));
    expect(renderer.root.findAllByProps({ "aria-label": "Catalog source" })).toHaveLength(0);
    expect(applyButton(renderer).props.disabled).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("ignores a picker result after another client changes the catalog source", async () => {
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    await act(async () => buttonByText(renderer, "Choose source").props.onClick());
    const picker = vi.mocked(openCommandPalette).mock.calls.at(-1)?.[0]?.sourcePicker;

    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    await act(async () => picker!.onSelect("/catalog/stale"));

    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(buttonByText(renderer, "Save source").props.disabled).toBe(true);
    await act(async () => renderer.unmount());
  });

  it("keeps apply and update unavailable to a session without the operate scope", async () => {
    state.canOperate = false;
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(applyButton(renderer).props.disabled).toBe(true);
    expect(updateButton(renderer).props.disabled).toBe(true);
    await act(async () => renderer.unmount());
  });

  it("submits the acknowledged source after another client changes A to B", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(sourceInput(renderer).props.value).toBe("/catalog/A");
    expect(applyButton(renderer).props.disabled).toBe(false);

    await applyChanges(renderer);
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client saves B: the input follows acknowledged settings, but
    // actions wait for B's status instead of submitting the cached A.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(applyButton(renderer).props.disabled).toBe(true);

    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    expect(applyButton(renderer).props.disabled).toBe(false);
    await applyChanges(renderer);
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
    await act(async () => renderer.unmount());
  });

  it("applies the groups selected in the settings rows", async () => {
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    const group = renderer.root.findAll(
      (node) => node.type === "input" && node.props["aria-label"] === "Install core group",
    )[0]!;

    await act(async () => group.props.onChange({ target: { checked: false } }));
    await act(async () => applyButton(renderer).props.onClick());
    expect(state.applyCalls).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("Remove groups");
    expect(allParagraphText(renderer)).toContain("No groups selected");
    await act(async () => buttonByText(renderer, "Cancel").props.onClick());
    expect(state.applyCalls).toHaveLength(0);
    await applyChanges(renderer);

    expect(state.applyCalls.at(-1)).toMatchObject({ input: { groups: [] } });
    await act(async () => renderer.unmount());
  });

  it("dismisses a pending apply review when another client changes the catalog", async () => {
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    await act(async () => applyButton(renderer).props.onClick());
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    state.configuredSource = "/catalog/B";
    state.status.isPending = true;
    await rerender(renderer);
    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(state.applyCalls).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it.each(["save", "update", "apply"] as const)(
    "shows progress only for the active %s operation",
    async (operation) => {
      setStatusLoaded("/catalog/A");
      const renderer = await renderPanel();
      let finish!: (result: unknown) => void;
      const pending = () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        });
      if (operation === "save") {
        state.persistImpl = pending;
        await act(async () =>
          sourceInput(renderer).props.onChange({ target: { value: "/catalog/B" } }),
        );
        await act(async () => buttonByText(renderer, "Save source").props.onClick());
      } else if (operation === "update") {
        state.updateImpl = pending;
        await act(async () => updateButton(renderer).props.onClick());
      } else {
        state.applyImpl = pending;
        await applyChanges(renderer);
      }
      const progress = renderer.root
        .findAllByType("button")
        .map((button) => String(button.props.children))
        .filter((label) => ["Saving…", "Updating…", "Applying…"].includes(label));
      expect(progress).toEqual([
        operation === "save" ? "Saving…" : operation === "update" ? "Updating…" : "Applying…",
      ]);
      await act(async () =>
        finish({
          _tag: "Success",
          value:
            operation === "apply"
              ? {
                  selectedGroups: ["core"],
                  installed: 0,
                  removed: 0,
                  unchanged: 0,
                  conflicts: [],
                  failed: [],
                }
              : { upstream: "origin/main" },
        }),
      );
      await act(async () => renderer.unmount());
    },
  );

  it("discards late apply results after the catalog identity changes", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(applyButton(renderer).props.disabled).toBe(false);

    // Start Apply on A and hold its response.
    let resolveApply!: (value: unknown) => void;
    state.applyImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveApply = resolve;
      });
    await applyChanges(renderer);
    await act(async () => {});
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);

    // A's late response must not appear in B's panel.
    await act(async () => {
      resolveApply({
        _tag: "Success",
        value: {
          selectedGroups: ["core"],
          installed: 7,
          removed: 0,
          unchanged: 0,
          conflicts: [],
          failed: [],
        },
      });
    });
    await act(async () => {});
    setStatusLoaded("/catalog/B");
    await rerender(renderer);

    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(allParagraphText(renderer)).not.toContain("Installed 7 links");
    expect(applyButton(renderer).props.disabled).toBe(false);
    await applyChanges(renderer);
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
    await act(async () => renderer.unmount());
  });

  it("discards late update results after the catalog identity changes", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(updateButton(renderer).props.disabled).toBe(false);

    // Start Update on A and hold its response.
    let resolveUpdate!: (value: unknown) => void;
    state.updateImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveUpdate = resolve;
      });
    updateButton(renderer).props.onClick();
    await act(async () => {});
    expect(state.updateCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);

    // A's late response must not appear in B's panel.
    await act(async () => {
      resolveUpdate({ _tag: "Success", value: { upstream: "origin/main" } });
    });
    await act(async () => {});
    setStatusLoaded("/catalog/B");
    await rerender(renderer);

    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(allParagraphText(renderer)).not.toContain("Catalog updated from");
    expect(updateButton(renderer).props.disabled).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("keeps a failed save visible and actions disabled against the old source", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(applyButton(renderer).props.disabled).toBe(false);

    await act(async () => {
      sourceInput(renderer).props.onChange({ target: { value: "/catalog/B" } });
    });
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");

    state.persistImpl = () => Promise.resolve({ _tag: "Failure" });
    await act(async () => {
      await buttonByText(renderer, "Save source").props.onClick();
    });

    // The draft stays visible, Apply stays disabled (not enabled against A),
    // and the error explains the previous source is still active.
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(applyButton(renderer).props.disabled).toBe(true);
    const alerts = renderer.root.findAll((node) => node.type === "p");
    const alertText = alerts
      .map((node) =>
        Array.isArray(node.props.children)
          ? node.props.children.join("")
          : String(node.props.children ?? ""),
      )
      .join("\n");
    expect(alertText).toContain("still active");
    await act(async () => renderer.unmount());
  });
});
