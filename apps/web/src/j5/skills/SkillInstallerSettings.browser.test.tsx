import { EnvironmentId } from "@t3tools/contracts";
import type * as React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  notify: vi.fn(),
  configuredSource: "/catalog/A",
  status: {
    data: null as unknown,
    error: null as string | null,
    isPending: true,
    refresh: (() => undefined) as () => void,
  },
  persistImpl: null as null | ((value: unknown) => Promise<unknown>),
  applyCalls: [] as Array<unknown>,
  updateCalls: [] as Array<unknown>,
  applyImpl: null as null | ((value: unknown) => Promise<unknown>),
  updateImpl: null as null | ((value: unknown) => Promise<unknown>),
  canOperate: true,
}));

// The only atom the panel reads is the apply command's permission.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.canOperate) as never,
}));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "env-1",
        serverConfig: { settings: { skillCatalogSource: state.configuredSource } },
      },
    ],
  })) as never,
  usePrimaryEnvironmentId: (() => "env-1") as never,
}));

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => state.status) as never,
}));

vi.mock(import("../../state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  serverEnvironment: { updateSettings: { description: "updateSettings" } } as never,
}));

vi.mock(import("./skillCatalogAtoms"), async (importOriginal) => ({
  ...(await importOriginal()),
  skillCatalogEnvironment: {
    status: () => Symbol("status"),
    applyGroups: { description: "applyGroups", permissionAtom: () => null },
    updateCatalog: { description: "updateCatalog" },
  } as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: { readonly description: string }) => {
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
  }) as never,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  squashAtomCommandFailure: ((result: unknown) =>
    result instanceof Error ? result : new Error("save failed")) as never,
}));

vi.mock(import("../../commandPaletteBus"), async (importOriginal) => ({
  ...(await importOriginal()),
  openCommandPalette: vi.fn(),
}));

vi.mock(import("../../components/ui/toast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastManager: { add: state.notify } as never,
}));

// The real settings rows read the primary environment's settings store.
vi.mock(import("../../components/settings/settingsLayout"), async (importOriginal) => ({
  ...(await importOriginal()),
  SettingsPageContainer: (({ children }: { children: React.ReactNode }) => children) as never,
  SettingsSection: (({
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
  )) as never,
  SettingsRow: (({
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
  )) as never,
}));

// A modal dialog's backdrop covers the panel behind it, so the review dialogs render
// inline here, and only while open.
vi.mock(import("../../components/ui/dialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  Dialog: (({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? children : null) as never,
  DialogPopup: (({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  )) as never,
  DialogDescription: (({ children }: { children: React.ReactNode }) => <p>{children}</p>) as never,
  DialogFooter: (({ children }: { children: React.ReactNode }) => <div>{children}</div>) as never,
  DialogHeader: (({ children }: { children: React.ReactNode }) => <div>{children}</div>) as never,
  DialogPanel: (({ children }: { children: React.ReactNode }) => <div>{children}</div>) as never,
  DialogTitle: (({ children }: { children: React.ReactNode }) => <h2>{children}</h2>) as never,
}));

import { act, render, type Screen } from "../../../test/render";
import { openCommandPalette } from "../../commandPaletteBus";
import { SkillCatalogPanel } from "./SkillInstallerSettings";

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

const panel = () => <SkillCatalogPanel environmentId={environmentId} />;

/** The last match, so a dialog's Cancel wins over the source editor's. */
const button = (name: string) => page.getByRole("button", { name }).last();
const sourceInput = () => page.getByRole("textbox", { name: "Catalog source" });
const applyButton = () => button("Apply changes");
const updateButton = () => button("Update catalog");
const groupCheckbox = () => page.getByRole("checkbox", { name: "Install core group" });
const dialogs = () => document.querySelectorAll('[role="dialog"]');

async function renderPanel(): Promise<Screen> {
  const screen = await render(panel());
  if (state.canOperate) {
    await button(state.configuredSource ? "Change source…" : "Add source…").click();
  }
  return screen;
}

async function applyChanges() {
  await applyButton().click();
  await button("Confirm changes").click();
}

/** Resolves a held command result and lets the panel settle on it. */
async function settle(finish: (result: unknown) => void, result: unknown) {
  await act(async () => finish(result));
}

describe("SkillCatalogPanel source identity", () => {
  function resetState() {
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
  }

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
    const screen = await renderPanel();
    await applyChanges();
    await expect.element(button("Use this catalog…")).toBeEnabled();
    return screen;
  }

  it("previews both targets and replaces only selected links after confirmation", async () => {
    resetState();
    await using _screen = await renderConflicts();
    await button("Use this catalog…").click();
    expect(state.applyCalls).toHaveLength(1);
    await expect
      .element(page.getByText("Current target: /deleted-catalog/skills/explain").first())
      .toBeVisible();
    await expect
      .element(page.getByText("New target: /state/a/skills/explain").first())
      .toBeVisible();
    await page.getByRole("checkbox", { name: "Replace /claude/explain" }).click();
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
    await button("Replace selected links").click();
    await expect.element(page.getByText("Installed 1 links", { exact: false })).toBeVisible();
    expect(state.applyCalls[1]).toEqual({
      environmentId,
      input: {
        expectedSource: "/catalog/A",
        groups: ["core"],
        replacements: [conflicts[0]!.replacement],
      },
    });
    expect(dialogs()).toHaveLength(0);
    expect(state.status.refresh).toHaveBeenCalledTimes(2);
  });

  it("allows canceling and disables replacement when no links are selected", async () => {
    resetState();
    await using _screen = await renderConflicts();
    await button("Use this catalog…").click();
    await page.getByRole("checkbox", { name: "Replace /codex/explain" }).click();
    await page.getByRole("checkbox", { name: "Replace /claude/explain" }).click();
    await expect.element(button("Replace selected links")).toBeDisabled();
    await button("Cancel").click();
    expect(dialogs()).toHaveLength(0);
    expect(state.applyCalls).toHaveLength(1);
  });

  it("dismisses the replacement preview when the environment's source changes", async () => {
    resetState();
    await using screen = await renderConflicts();
    await button("Use this catalog…").click();
    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("/deleted-catalog/skills/explain");
    expect(state.applyCalls).toHaveLength(1);
  });

  it("requires a new Apply after the group selection changes", async () => {
    resetState();
    await using _screen = await renderConflicts();
    await groupCheckbox().click();
    await expect.element(button("Use this catalog…")).toBeDisabled();
    expect(state.applyCalls).toHaveLength(1);
  });

  it.each(["/catalog/chosen", "https://github.com/example/skills.git"])(
    "keeps the chosen source %s as a draft until saved",
    async (source) => {
      resetState();
      setStatusLoaded("/catalog/A");
      const persist = vi.fn().mockResolvedValue({ _tag: "Success" });
      state.persistImpl = persist;
      await using _screen = await renderPanel();

      await button("Choose source").click();
      const picker = vi.mocked(openCommandPalette).mock.calls.at(-1)?.[0]?.sourcePicker;
      expect(picker?.environmentId).toBe(environmentId);
      await act(() => picker!.onSelect(source));

      await expect.element(sourceInput()).toHaveValue(source);
      expect(persist).not.toHaveBeenCalled();
      await expect.element(applyButton()).toBeDisabled();
      await expect.element(updateButton()).toBeDisabled();
      await button("Save source").click();
      expect(persist).toHaveBeenCalledWith({
        environmentId,
        input: { patch: { skillCatalogSource: source } },
      });
    },
  );

  it("closes the source editor when acknowledged settings arrive before the save receipt", async () => {
    resetState();
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    let finish!: (result: unknown) => void;
    state.persistImpl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await sourceInput().fill("/catalog/B");
    await button("Save source").click();
    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());
    await settle(finish, { _tag: "Success" });
    await expect.element(sourceInput()).not.toBeInTheDocument();
    await expect.element(applyButton()).toBeEnabled();
  });

  it("ignores a picker result after another client changes the catalog source", async () => {
    resetState();
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    await button("Choose source").click();
    const picker = vi.mocked(openCommandPalette).mock.calls.at(-1)?.[0]?.sourcePicker;

    state.configuredSource = "/catalog/B";
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());
    await act(() => picker!.onSelect("/catalog/stale"));

    await expect.element(sourceInput()).toHaveValue("/catalog/B");
    await expect.element(button("Save source")).toBeDisabled();
  });

  it("keeps apply and update unavailable to a session without the operate scope", async () => {
    resetState();
    state.canOperate = false;
    setStatusLoaded("/catalog/A");
    await using _screen = await renderPanel();
    await expect.element(applyButton()).toBeDisabled();
    await expect.element(updateButton()).toBeDisabled();
  });

  it("submits the acknowledged source after another client changes A to B", async () => {
    resetState();
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    await expect.element(sourceInput()).toHaveValue("/catalog/A");
    await expect.element(applyButton()).toBeEnabled();

    await applyChanges();
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client saves B: the input follows acknowledged settings, but
    // actions wait for B's status instead of submitting the cached A.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await screen.rerender(panel());
    await expect.element(sourceInput()).toHaveValue("/catalog/B");
    await expect.element(applyButton()).toBeDisabled();

    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());
    await expect.element(applyButton()).toBeEnabled();
    await applyChanges();
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
  });

  it("applies the groups selected in the settings rows", async () => {
    resetState();
    setStatusLoaded("/catalog/A");
    await using _screen = await renderPanel();

    await groupCheckbox().click();
    await applyButton().click();
    expect(state.applyCalls).toHaveLength(0);
    await expect.element(page.getByText("Remove groups").first()).toBeVisible();
    await expect.element(page.getByText("No groups selected", { exact: false })).toBeVisible();
    await button("Cancel").click();
    expect(state.applyCalls).toHaveLength(0);
    await applyChanges();

    expect(state.applyCalls.at(-1)).toMatchObject({ input: { groups: [] } });
  });

  it("dismisses a pending apply review when another client changes the catalog", async () => {
    resetState();
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    await applyButton().click();
    expect(dialogs()).toHaveLength(1);
    state.configuredSource = "/catalog/B";
    state.status.isPending = true;
    await screen.rerender(panel());
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());
    expect(dialogs()).toHaveLength(0);
    expect(state.applyCalls).toHaveLength(0);
  });

  it.each(["save", "update", "apply"] as const)(
    "shows progress only for the active %s operation",
    async (operation) => {
      resetState();
      setStatusLoaded("/catalog/A");
      await using screen = await renderPanel();
      let finish!: (result: unknown) => void;
      const pending = () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        });
      if (operation === "save") {
        state.persistImpl = pending;
        await sourceInput().fill("/catalog/B");
        await button("Save source").click();
      } else if (operation === "update") {
        state.updateImpl = pending;
        await updateButton().click();
      } else {
        state.applyImpl = pending;
        await applyChanges();
      }
      const progress = [...screen.container.querySelectorAll("button")]
        .map((found) => found.textContent?.trim() ?? "")
        .filter((label) => ["Saving…", "Updating…", "Applying…"].includes(label));
      expect(progress).toEqual([
        operation === "save" ? "Saving…" : operation === "update" ? "Updating…" : "Applying…",
      ]);
      await settle(finish, {
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
      });
    },
  );

  it("discards late apply results after the catalog identity changes", async () => {
    resetState();
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    await expect.element(applyButton()).toBeEnabled();

    // Start Apply on A and hold its response.
    let resolveApply!: (value: unknown) => void;
    state.applyImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveApply = resolve;
      });
    await applyChanges();
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await screen.rerender(panel());

    // A's late response must not appear in B's panel.
    await settle(resolveApply, {
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
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());

    await expect.element(sourceInput()).toHaveValue("/catalog/B");
    expect(document.body.textContent).not.toContain("Installed 7 links");
    await expect.element(applyButton()).toBeEnabled();
    await applyChanges();
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
  });

  it("discards late update results after the catalog identity changes", async () => {
    resetState();
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    await using screen = await renderPanel();
    await expect.element(updateButton()).toBeEnabled();

    // Start Update on A and hold its response.
    let resolveUpdate!: (value: unknown) => void;
    state.updateImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveUpdate = resolve;
      });
    await updateButton().click();
    expect(state.updateCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await screen.rerender(panel());

    // A's late response must not appear in B's panel.
    await settle(resolveUpdate, { _tag: "Success", value: { upstream: "origin/main" } });
    setStatusLoaded("/catalog/B");
    await screen.rerender(panel());

    await expect.element(sourceInput()).toHaveValue("/catalog/B");
    expect(document.body.textContent).not.toContain("Catalog updated from");
    await expect.element(updateButton()).toBeEnabled();
  });

  it("keeps a failed save visible and actions disabled against the old source", async () => {
    resetState();
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    await using _screen = await renderPanel();
    await expect.element(applyButton()).toBeEnabled();

    await sourceInput().fill("/catalog/B");
    await expect.element(sourceInput()).toHaveValue("/catalog/B");

    state.persistImpl = () => Promise.resolve({ _tag: "Failure" });
    await button("Save source").click();

    // The draft stays visible, Apply stays disabled (not enabled against A),
    // and the error explains the previous source is still active.
    await expect.element(page.getByText("still active", { exact: false })).toBeVisible();
    await expect.element(sourceInput()).toHaveValue("/catalog/B");
    await expect.element(applyButton()).toBeDisabled();
  });
});
