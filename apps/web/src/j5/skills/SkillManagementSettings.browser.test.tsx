import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ManagedSkillLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Dialog and menu layers need the app styles, or Base UI's unstyled backdrop covers their contents.
import "~/index.css";

const state = vi.hoisted(() => ({
  notify: vi.fn(),
  providers: [] as ReadonlyArray<ServerProvider>,
  refresh: vi.fn(),
  preview: vi.fn(),
  inspect: vi.fn(),
  deletePreview: vi.fn(),
  delete: vi.fn(),
  unlink: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  refreshLinks: vi.fn(),
  links: [] as ReadonlyArray<ManagedSkillLink>,
  catalogSource: "/catalog",
  lockedProject: null as null | {
    id: string;
    environmentId: string;
    title: string;
    workspaceRoot: string;
  },
}));
// A command's permission atom is the string "permission"; every session here may operate.
vi.mock(import("@effect/atom-react"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useAtomValue: ((atom: unknown) =>
      atom === "permission"
        ? true
        : atom === "providers"
          ? state.providers
          : original.useAtomValue(atom as never)) as never,
  };
});
vi.mock(import("../../state/server"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      providersValueAtom: (() => "providers") as never,
    },
  };
});
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({
    connection: { phase: "connected" },
    serverConfig: { settings: { skillCatalogSource: state.catalogSource } },
  })) as never,
}));
vi.mock(import("../settingsScopeEnvironment.logic"), async (importOriginal) => ({
  ...(await importOriginal()),
  lockedSettingsScopeProject: (() => state.lockedProject) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: (() => [
    { id: "first", environmentId: "env", title: "First project", workspaceRoot: "/first" },
    { id: "second", environmentId: "env", title: "Second project", workspaceRoot: "/second" },
    {
      id: "remote",
      environmentId: "other-env",
      title: "Other environment",
      workspaceRoot: "/remote",
    },
  ]) as never,
}));
vi.mock("./skillLinkAtoms", () => ({
  skillLinkEnvironment: {
    list: () => "links",
    preview: "preview",
    inspect: "inspect",
    deletePreview: "deletePreview",
    delete: "delete",
    unlink: "unlink",
    create: { name: "create", permissionAtom: () => "permission" },
    remove: { name: "remove", permissionAtom: () => "permission" },
  },
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: state.links,
    error: null,
    isPending: false,
    refresh: state.refreshLinks,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((given: string | { readonly name: string }) => {
    const command = typeof given === "string" ? given : given.name;
    return command === "deletePreview"
      ? state.deletePreview
      : command === "delete"
        ? state.delete
        : command === "inspect"
          ? state.inspect
          : command === "unlink"
            ? state.unlink
            : command === "preview"
              ? state.preview
              : command === "create"
                ? state.create
                : command === "remove"
                  ? state.remove
                  : state.refresh;
  }) as never,
}));
vi.mock(import("../../components/ui/toast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastManager: { add: state.notify } as never,
}));

import { act, render } from "../../../test/render";
import { SkillInventoryPanel } from "./SkillManagementSettings";

const environmentId = EnvironmentId.make("env");
const instanceId = ProviderInstanceId.make("codex-work");
const checkedAt = "2026-09-18T00:00:00Z";
let container: HTMLElement;

// Browser tests take no lifecycle hooks; each test resets the shared mocks first.
function setup() {
  state.notify.mockReset();
  state.catalogSource = "/catalog";
  state.lockedProject = null;
  state.links = [];
  state.inspect.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  state.unlink.mockReset();
  state.deletePreview.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { expectedPath: "/home/.claude/skills/review", expectedIdentity: "identity" },
  });
  state.delete.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      action: "removed",
      discovery: "not-detected",
      message: "Skill permanently deleted.",
    },
  });
  state.refreshLinks.mockReset();
  state.preview.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      sourcePath: "/shared/review",
      destinationPath: "/home/.claude/skills/review",
      skillName: "review",
      status: "available",
      sharedWith: [],
      warnings: ["Running sessions may need refreshing."],
    },
  });
  state.create.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      action: "created",
      discovery: "failed",
      message: "Link created. Discovery refresh failed.",
    },
  });
  state.remove.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      action: "removed",
      discovery: "not-detected",
      message: "Link removed. The source is unchanged.",
    },
  });
  state.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
    },
  ];
  state.refresh
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ _tag: "Success", value: { providers: state.providers } }),
    );
}

async function renderPanel() {
  const screen = await render(<SkillInventoryPanel environmentId={environmentId} />);
  container = screen.container;
  return screen;
}
async function renderProjectPanel() {
  const screen = await renderPanel();
  await choose("Skill inventory project", "First project");
  return screen;
}

const PROJECT = "Skill inventory project";
const PROVIDER = "Skill inventory provider";

async function choose(select: string, option: string) {
  await page.getByRole("combobox", { name: select, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
}
async function optionsOf(select: string) {
  await page.getByRole("combobox", { name: select, exact: true }).click();
  await expect.element(page.getByRole("listbox")).toBeVisible();
  const options = page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  return options;
}
async function search(value: string) {
  await page.getByRole("textbox", { name: "Search skill inventory", exact: true }).fill(value);
}
function button(name: string) {
  return page.getByRole("button", { name, exact: true });
}
function rowMenu(skill = "review") {
  return page.getByRole("button", { name: `More actions for ${skill}`, exact: true });
}
async function rowAction(name: string, skill = "review") {
  await rowMenu(skill).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function rowActions(skill = "review") {
  await rowMenu(skill).click();
  await expect.element(page.getByRole("menu")).toBeVisible();
  const items = page
    .getByRole("menuitem")
    .elements()
    .map((item) => item.textContent);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  return items;
}
async function openDetails() {
  const firstRow = inventoryItems()[0]!;
  await page
    .elementLocator(firstRow)
    .getByRole("button", { name: /^More actions for / })
    .click();
  await page.getByRole("menuitem", { name: "Details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  const text = dialog.element().textContent ?? "";
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  return text;
}

function renderedText() {
  return document.body.textContent ?? "";
}
function discoveryText() {
  return container.querySelector('div[role="status"]')!.textContent ?? "";
}
function inventoryLists() {
  return [...container.querySelectorAll('div[role="list"]')];
}
function inventoryItems() {
  return [...container.querySelectorAll('div[role="listitem"]')];
}
function inventoryText() {
  return inventoryLists()
    .map((list) => list.textContent)
    .join(" ");
}
function statusLabels(row: Element) {
  return [...row.querySelectorAll('[role="img"]')].map((node) => node.getAttribute("aria-label"));
}
function inventoryStatusLabels() {
  return inventoryItems().flatMap(statusLabels);
}
function headings() {
  return [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
}
function categoryButton(origin: string) {
  return page.getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${origin} skills$`) });
}

function linkableSkill(scope = "user") {
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [{ name: "review", path: "/shared/review/SKILL.md", scope, enabled: true }],
    },
    {
      ...state.providers[0]!,
      instanceId: ProviderInstanceId.make("claude-work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      skills: [],
    },
  ];
}
function existingLinks() {
  return ["codex-work", "claude-work"].map((id) => ({
    label: `${id} · User`,
    request: {
      targetInstanceId: ProviderInstanceId.make(id),
      scope: "user" as const,
      expectedSourcePath: "/shared/review",
      expectedDestinationPath: `/home/${id}/skills/review`,
      expectedIdentity: `identity-${id}`,
    },
  }));
}

it("uses the explicit settings project instead of an environment-wide default", async () => {
  setup();
  state.lockedProject = {
    id: "second",
    environmentId: "env",
    title: "Second project",
    workspaceRoot: "/second",
  };
  await using _screen = await renderPanel();
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, cwd: "/second" },
  });
  expect(page.getByRole("combobox", { name: PROJECT }).query()).toBeNull();
  expect(page.getByRole("combobox").elements()).toHaveLength(1);
});

it.each(["ready", "unchecked", "failed"])(
  "exposes empty-provider availability as %s through compact status indicators",
  async (discovery) => {
    setup();
    linkableSkill();
    const claude = state.providers[1]!;
    state.providers = [
      state.providers[0]!,
      {
        ...claude,
        // An instance that is off is hidden when empty, so "unchecked" is one
        // that is on but has not reported ready yet.
        status: discovery === "failed" ? "error" : discovery === "unchecked" ? "warning" : "ready",
      },
    ];
    await using _screen = await renderPanel();
    const row = inventoryItems()[0]!;
    expect(row.textContent).toContain("codex");
    expect(row.textContent).toContain("claudeAgent");
    const statuses = statusLabels(row);
    expect(statuses).toContain("codex: review · Enabled");
    expect(statuses).toContain(
      `claudeAgent: review · ${discovery === "ready" ? "Not detected" : "Unknown"}`,
    );
    expect(row.textContent).not.toMatch(/Enabled|Disabled|Not detected|Unknown/);
    expect(page.getByRole("dialog").query()).toBeNull();
  },
);

it("does not show session-restart guidance when making a skill available changes nothing", async () => {
  setup();
  linkableSkill();
  state.create.mockResolvedValue({
    _tag: "Success",
    value: {
      action: "unchanged",
      discovery: "detected",
      message: "Already linked. Nothing changed.",
    },
  });
  await using _screen = await renderPanel();
  await rowAction("Make available to…");
  await expect.element(button("Make available")).toBeEnabled();
  await button("Make available").click();
  await expect.poll(renderedText).toContain("Nothing changed.");
  expect(renderedText()).not.toContain("Restart agent session");
});

it("shows matching skills while typing and updates rows when discovery changes", async () => {
  setup();
  state.providers = [
    {
      ...state.providers[0]!,
      skills: Array.from({ length: 32 }, (_, index) => ({
        name: `review-${index}`,
        path: `/catalog/skills/review-${index}/SKILL.md`,
        enabled: true,
      })),
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [], slashCommands: [] }],
    },
  ];
  await using panel = await renderPanel();
  await search("r");
  await search("re");
  await search("review");
  expect(inventoryText()).toContain("review-31");
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [{ name: "review-new", path: "/new/SKILL.md", enabled: true }],
    },
  ];
  await panel.rerender(<SkillInventoryPanel environmentId={environmentId} />);
  expect(inventoryText()).toContain("review-new");
  expect(inventoryText()).not.toContain("review-31");
});

it("starts environment-wide and only requests workspace discovery after a project is selected", async () => {
  setup();
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [
        {
          name: "review",
          path: "/skills/review/SKILL.md",
          linkTarget: "/shared/review/SKILL.md",
          enabled: true,
        },
        {
          name: "tools:review",
          path: "/plugins/review/SKILL.md",
          linkTarget: "/shared/review/SKILL.md",
          pluginId: "tools@team",
          enabled: false,
          userInvocationOnly: true,
        },
      ],
    },
  ];
  await using _screen = await renderPanel();
  await expect
    .element(page.getByRole("combobox", { name: PROJECT }))
    .toHaveTextContent("Environment only");
  expect(state.refresh).not.toHaveBeenCalled();
  expect(discoveryText()).toContain("Checked");
  await choose(PROJECT, "First project");
  const providerDetails = await openDetails();
  expect(providerDetails).toContain("review");
  expect(providerDetails).toContain("tools:review");
  expect(providerDetails).toContain("/skills/review/SKILL.md");
  expect(providerDetails).toContain("/plugins/review/SKILL.md");
  expect(providerDetails).toContain("Disabled");
  expect(providerDetails).toContain("User only");
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
  expect(discoveryText()).toContain("Not checked");
  expect(discoveryText()).not.toContain("Not detected");
  expect(await optionsOf(PROJECT)).not.toContain("Other environment");
  await choose(PROJECT, "Second project");
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/second" },
  });
  await choose(PROJECT, "Environment only");
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(discoveryText()).toContain("Checked");
  await choose(PROJECT, "First project");
  expect(state.refresh).toHaveBeenCalledTimes(3);
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
});

it("replaces an existing workspace on manual instance refresh, retains stale rows after failure and recovers", async () => {
  setup();
  const old = { name: "old-skill", path: "/old/SKILL.md", enabled: true };
  state.providers = [
    {
      ...state.providers[0]!,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [old], slashCommands: [] }],
    },
  ];
  await using _screen = await renderProjectPanel();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(inventoryText()).toContain("old-skill");
  state.refresh.mockImplementation(() => {
    state.providers = [
      {
        ...state.providers[0]!,
        workspaceSnapshots: [
          {
            cwd: "/first",
            checkedAt,
            skills: [{ ...old, name: "new-skill", path: "/new/SKILL.md" }],
            slashCommands: [],
          },
        ],
      },
    ];
    return Promise.resolve({ _tag: "Success", value: { providers: state.providers } });
  });
  await button("Refresh").click();
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { instanceId } });
  await expect.poll(inventoryText).toContain("new-skill");
  expect(inventoryText()).not.toContain("old-skill");
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  await expect.element(button("Refresh")).toBeEnabled();
  await button("Refresh").click();
  await expect.poll(discoveryText).toContain("Refresh failed");
  expect(inventoryText()).toContain("new-skill");
  expect(inventoryStatusLabels()).toContain("codex: new-skill · Unknown · Stale");
  state.refresh.mockImplementation(() =>
    Promise.resolve({ _tag: "Success", value: { providers: state.providers } }),
  );
  await expect.element(button("Refresh")).toBeEnabled();
  await button("Refresh").click();
  await expect.poll(discoveryText).not.toContain("Refresh failed");
  expect(inventoryStatusLabels()).toContain("codex: new-skill · Enabled");
});

it("clears a transport failure when selecting an unchecked project succeeds later", async () => {
  setup();
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  await using _screen = await renderProjectPanel();
  await expect.poll(discoveryText).toContain("Refresh failed");
  await choose(PROJECT, "Environment only");
  state.refresh.mockImplementation(() => {
    state.providers = [
      {
        ...state.providers[0]!,
        workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [], slashCommands: [] }],
      },
    ];
    return Promise.resolve({ _tag: "Success", value: { providers: state.providers } });
  });
  await choose(PROJECT, "First project");
  await expect.poll(discoveryText).toContain("Checked");
  expect(discoveryText()).not.toContain("Refresh failed");
});

it("preserves provider-specific metadata when filtering a shared location and labels missing records", async () => {
  setup();
  const first = state.providers[0]!;
  const skill = {
    name: "review",
    path: "/codex/review/SKILL.md",
    linkTarget: "/shared/review/SKILL.md",
    enabled: true,
  };
  const otherSkill = { name: "deploy", path: "/deploy/SKILL.md", enabled: true };
  const secondId = ProviderInstanceId.make("codex-personal");
  state.providers = [
    {
      ...first,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [skill] }],
    },
    {
      ...first,
      instanceId: secondId,
      workspaceSnapshots: [
        {
          cwd: "/first",
          checkedAt,
          slashCommands: [],
          skills: [
            {
              ...skill,
              name: "audit",
              path: "/personal/audit/SKILL.md",
              pluginId: "audit@team",
              userInvocable: false,
            },
          ],
        },
      ],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("empty"),
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [otherSkill] }],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("unchecked"),
      enabled: false,
      skills: [otherSkill],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("failed"),
      status: "error",
      workspaceSnapshots: [
        {
          cwd: "/first",
          checkedAt,
          slashCommands: [],
          skills: [otherSkill],
          refreshError: "Failed",
        },
      ],
    },
  ];
  await using _screen = await renderProjectPanel();
  expect(inventoryText()).toContain("codex (codex-work)");
  const details = await openDetails();
  expect(details).toContain("Not detected");
  expect(details).toContain("Not checked");
  expect(details).toContain("Refresh failed");
  expect(inventoryStatusLabels().join(" ")).not.toContain("review · Unknown · Stale");
  await choose(PROVIDER, "codex (codex-personal)");
  const selectedDetails = await openDetails();
  expect(selectedDetails).toContain("audit");
  expect(selectedDetails).toContain("audit@team");
  expect(selectedDetails).toContain("Agent only");
  expect(selectedDetails).not.toContain("/codex/review/SKILL.md");
  expect(inventoryText()).not.toContain("codex-personal");
});

it("shows empty supported providers, retains cached skills, and keeps them selectable and refreshable", async () => {
  setup();
  const first = state.providers[0]!;
  const claudeId = ProviderInstanceId.make("claudeAgent");
  const skill = { name: "review", path: "/review/SKILL.md", enabled: true };
  state.providers = [
    {
      ...first,
      displayName: "Codex",
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [skill] }],
    },
    {
      ...first,
      instanceId: claudeId,
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      skills: [skill],
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [] }],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: false,
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
      displayName: "OpenCode",
      enabled: false,
      skills: [{ ...skill, name: "deploy", path: "/deploy/SKILL.md" }],
    },
  ];
  await using _screen = await renderProjectPanel();
  expect(discoveryText()).toContain("Codex");
  expect(discoveryText()).toContain("OpenCode");
  expect(discoveryText()).toContain("Claude");
  expect(discoveryText()).not.toContain("Antigravity");
  expect(inventoryStatusLabels()).toContain("OpenCode: deploy · Unknown · Stale");
  expect(await optionsOf(PROVIDER)).toContain("Claude");
  await search("review");
  expect(discoveryText()).toContain("Codex");
  expect(discoveryText()).toContain("OpenCode");
  await choose(PROVIDER, "Claude");
  expect(inventoryItems()).toHaveLength(0);
  expect(discoveryText()).toContain("Claude");
  expect(discoveryText()).toContain("Checked");
  expect(renderedText()).toContain("No skills reported for this selection");
  await choose(PROVIDER, "All providers");
  await button("Refresh").click();
  expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId: claudeId } });
  await expect.element(button("Refresh")).toBeEnabled();
  await choose(PROJECT, "Environment only");
  expect(inventoryText()).toContain("Claude");
  expect(discoveryText()).toContain("OpenCode");
  expect(inventoryText()).toContain("Codex");
  expect(inventoryStatusLabels()).toContain("Codex: review · Not detected");
});

it("groups skills in origin order, collapses categories independently, and reveals search matches", async () => {
  setup();
  const skills = [
    { name: "review", path: "/plugins/review/SKILL.md", pluginId: "tools" },
    { name: "build", path: "/plugins/build/SKILL.md", pluginId: "tools" },
    { name: "catalog-skill", path: "/catalog/skills/catalog-skill/SKILL.md" },
    { name: "project-skill", path: "/first/skills/project-skill/SKILL.md" },
    { name: "personal-skill", path: "/skills/personal-skill/SKILL.md", scope: "user" },
    { name: "builtin-skill", path: "/skills/builtin-skill/SKILL.md", scope: "system" },
    { name: "other-skill", path: "/skills/other-skill/SKILL.md" },
  ].map((skill) => ({ ...skill, enabled: true }));
  state.providers = [
    {
      ...state.providers[0]!,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills, slashCommands: [] }],
    },
  ];
  await using _screen = await renderProjectPanel();
  const listNames = () => inventoryLists().map((list) => list.getAttribute("aria-label"));
  expect(listNames()).toEqual([
    "Plugin skill inventory",
    "Catalog skill inventory",
    "Project skill inventory",
    "Personal skill inventory",
    "Built-in skill inventory",
    "Other skill inventory",
  ]);
  expect(headings()).toContain("Plugin (2)");

  await categoryButton("Plugin").click();
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "false");
  await expect.element(categoryButton("Catalog")).toHaveAttribute("aria-expanded", "true");
  await categoryButton("Catalog").click();
  await expect.element(categoryButton("Catalog")).toHaveAttribute("aria-expanded", "false");
  await categoryButton("Plugin").click();
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "true");
  expect(inventoryText()).toContain("review");
  await expect.element(categoryButton("Catalog")).toHaveAttribute("aria-expanded", "false");
  await categoryButton("Plugin").click();

  await search("review");
  await expect.poll(listNames).toEqual(["Plugin skill inventory"]);
  expect(headings()).toContain("Plugin (1)");
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "true");
  expect(inventoryText()).toContain("review");
  expect(inventoryText()).not.toContain("build");
  expect(categoryButton("Catalog").query()).toBeNull();
  await categoryButton("Plugin").click();
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "false");
  await search("no matching skill");
  expect(categoryButton("Plugin").query()).toBeNull();
  expect(renderedText()).toContain("No skills reported for this selection");
});

it("keeps collapsed categories across filters and refresh, and resets them on remount", async () => {
  setup();
  const first = state.providers[0]!;
  const skill = { name: "review", path: "/review/SKILL.md", pluginId: "tools", enabled: true };
  state.providers = [
    { ...first, skills: [skill] },
    { ...first, instanceId: ProviderInstanceId.make("other") },
  ];
  await using panel = await renderPanel();
  await categoryButton("Plugin").click();
  await choose(PROVIDER, "codex (other)");
  expect(categoryButton("Plugin").query()).toBeNull();
  await choose(PROVIDER, "codex (codex-work)");
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "false");
  await button("Refresh").click();
  await expect.element(button("Refresh")).toBeEnabled();
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(inventoryText).not.toContain("review");

  await panel.rerender(<SkillInventoryPanel key="remounted" environmentId={environmentId} />);
  await expect.element(categoryButton("Plugin")).toHaveAttribute("aria-expanded", "true");
  expect(inventoryText()).toContain("review");
});

it("offers only Codex and Claude instances in the inventory filter and link destination picker", async () => {
  setup();
  linkableSkill();
  state.providers = [
    ...state.providers,
    { ...state.providers[0]!, instanceId: ProviderInstanceId.make("codex-home"), skills: [] },
    ...["cursor", "grok", "opencode", "antigravity"].map((driver) => ({
      ...state.providers[0]!,
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      skills: [],
    })),
  ];
  await using _screen = await renderPanel();
  expect(await optionsOf(PROVIDER)).toEqual([
    "All providers",
    "codex (codex-work)",
    "claudeAgent",
    "codex (codex-home)",
  ]);
  await rowAction("Make available to…");
  expect(await optionsOf("Link destination provider")).toEqual([
    "codex-work (codex-work)",
    "claude-work (claude-work)",
    "codex-home (codex-home)",
  ]);
  await choose("Link destination provider", "codex-home (codex-home)");
  expect(state.preview.mock.lastCall![0].input.targetInstanceId).toBe("codex-home");
});

it("previews an environment-scoped destination before linking and separates creation from discovery", async () => {
  setup();
  linkableSkill();
  await using _screen = await renderPanel();
  await rowAction("Make available to…");
  expect(state.preview).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      source: { instanceId, path: "/shared/review/SKILL.md", name: "review" },
      targetInstanceId: "claude-work",
      scope: "user",
    },
  });
  await expect.poll(renderedText).toContain("/home/.claude/skills/review");
  expect(state.create).not.toHaveBeenCalled();
  await button("Make available").click();
  await expect.poll(renderedText).toContain("Link created. Discovery refresh failed.");
  expect(state.create).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...state.preview.mock.calls[0]![0].input,
      expectedSourcePath: "/shared/review",
      expectedDestinationPath: "/home/.claude/skills/review",
    },
  });
  expect(state.notify).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("Restart agent session") }),
  );
  expect(renderedText()).toContain("Restart agent session");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.refreshLinks).toHaveBeenCalledOnce();
});

it("defaults project skills to the selected project and discards a stale preview when scope changes", async () => {
  setup();
  linkableSkill("project");
  await using _screen = await renderProjectPanel();
  await rowAction("Make available to…");
  expect(state.preview.mock.calls[0]![0].input.scope).toBe("project");
  await expect.poll(renderedText).toContain("/home/.claude/skills/review");
  let resolve!: (value: unknown) => void;
  state.preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await choose("Link scope", "User");
  await expect.element(button("Make available")).toBeDisabled();
  expect(renderedText()).not.toContain("/home/.claude/skills/review");
  await act(() =>
    resolve({
      _tag: "Success",
      value: {
        sourcePath: "/shared/review",
        destinationPath: "/new-destination",
        skillName: "review",
        sharedWith: [],
        warnings: [],
        status: "conflict",
        conflict: "Existing directory. Nothing will be overwritten.",
      },
    }),
  );
  expect(renderedText()).toContain("Nothing will be overwritten");
  await expect.element(button("Make available")).toBeDisabled();
  expect(state.create).not.toHaveBeenCalled();
});

it("keeps plugin rows read-only and broken managed links removable", async () => {
  setup();
  linkableSkill("plugin");
  state.links = [
    {
      id: "owned-link",
      skillName: "review",
      sourcePath: "/gone/review",
      destinationPath: "/home/.claude/skills/review",
      targetInstanceId: ProviderInstanceId.make("claude-work"),
      scope: "user",
      status: "broken",
    },
  ];
  await using _screen = await renderPanel();
  const actions = await rowActions();
  expect(actions).not.toContain("Make available to…");
  expect(actions).not.toContain("Remove provider link…");
  expect(renderedText()).not.toContain("Link unavailable");
  expect(renderedText()).toContain("Broken link");
  await rowAction("Remove provider link", "review link");
  expect(state.remove).toHaveBeenCalledWith({ environmentId, input: { id: "owned-link" } });
  await expect.poll(renderedText).toContain("Link removed. The source is unchanged.");
  expect(renderedText()).toContain("Restart agent session");
});

it("explains an outdated server and keeps linking disabled when the preview RPC is unknown", async () => {
  setup();
  linkableSkill();
  state.preview.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: j5.skills.links.preview"),
  });
  await using _screen = await renderPanel();
  await rowAction("Make available to…");
  await expect
    .poll(renderedText)
    .toContain("Update and restart the app or server hosting this environment");
  expect(renderedText()).not.toContain("Close and reopen");
  await expect.element(button("Make available")).toBeDisabled();
  expect(state.create).not.toHaveBeenCalled();
});

it("lets changed links be forgotten and removes only their managed record", async () => {
  setup();
  state.links = [
    {
      id: "changed-link",
      skillName: "review",
      sourcePath: "/source/review",
      destinationPath: "/home/.claude/skills/review",
      targetInstanceId: instanceId,
      scope: "user",
      status: "changed",
    },
  ];
  state.remove.mockImplementation(() => {
    state.links = [];
    return Promise.resolve({
      _tag: "Success",
      value: {
        action: "forgotten",
        discovery: "not-checked",
        message: "Record forgotten. The destination and source were left unchanged.",
      },
    });
  });
  await using _screen = await renderPanel();
  expect(await rowActions("review link")).toEqual(["Forget record"]);
  await rowAction("Forget record", "review link");
  expect(state.remove).toHaveBeenCalledWith({
    environmentId,
    input: { id: "changed-link", forget: true },
  });
  await expect.poll(renderedText).toContain("The destination and source were left unchanged");
  expect(renderedText()).toContain("No managed links yet");
});

it("loads existing links only on demand after remount and unlinks one provider without removing the other", async () => {
  setup();
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  await using panel = await renderPanel();
  expect(state.inspect).not.toHaveBeenCalled();
  await panel.rerender(<SkillInventoryPanel key="restarted" environmentId={environmentId} />);
  expect(state.inspect).not.toHaveBeenCalled();
  await rowAction("Remove provider link…");
  await expect.poll(renderedText).toContain(options[1]!.request.expectedDestinationPath);
  expect(state.inspect).toHaveBeenCalledOnce();
  expect(state.preview).not.toHaveBeenCalled();
  state.unlink.mockResolvedValue({
    _tag: "Success",
    value: {
      removedPaths: [options[0]!.request.expectedDestinationPath],
      failed: [],
      refreshFailed: false,
    },
  });
  await button(`Remove provider link ${options[0]!.label}`).click();
  await expect.poll(renderedText).toContain("1 link removed. Source files stay in place.");
  expect(state.unlink).toHaveBeenCalledWith({
    environmentId,
    input: { links: [options[0]!.request] },
  });
  expect(renderedText()).not.toContain(options[0]!.request.expectedDestinationPath);
  expect(renderedText()).toContain(options[1]!.request.expectedDestinationPath);
  expect(button("Remove all shown links").query()).toBeNull();
  expect(state.inspect).toHaveBeenCalledOnce();
});

it("unlinks both providers in one request and keeps failed links available to retry", async () => {
  setup();
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  await using _screen = await renderPanel();
  await rowAction("Remove provider link…");
  state.unlink.mockResolvedValue({
    _tag: "Success",
    value: {
      removedPaths: [options[0]!.request.expectedDestinationPath],
      failed: [
        {
          path: options[1]!.request.expectedDestinationPath,
          message: "Link changed since preview",
        },
      ],
      refreshFailed: true,
    },
  });
  await button("Remove all shown links").click();
  await expect.poll(renderedText).toContain("Link changed since preview");
  expect(state.unlink).toHaveBeenCalledOnce();
  expect(state.unlink).toHaveBeenCalledWith({
    environmentId,
    input: { links: options.map((option) => option.request) },
  });
  expect(renderedText()).toContain("Discovery refresh failed");
  expect(renderedText()).toContain(options[1]!.request.expectedDestinationPath);
  await expect.element(button(`Remove provider link ${options[1]!.label}`)).toBeEnabled();
  expect(state.refreshLinks).toHaveBeenCalledOnce();
});

it("shows inspection errors without leaving an endless loading state", async () => {
  setup();
  linkableSkill();
  state.inspect.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: j5.skills.links.inspect"),
  });
  await using _screen = await renderPanel();
  await rowAction("Remove provider link…");
  await expect.poll(renderedText).toContain("Update and restart");
  expect(renderedText()).not.toContain("Checking existing links");
  expect(state.unlink).not.toHaveBeenCalled();
});

it("keeps built-in skill rows read-only while showing their metadata and provider status", async () => {
  setup();
  linkableSkill("system");
  await using _screen = await renderPanel();
  const table = container.querySelector('[aria-label="Built-in skill inventory"]')!;
  expect(table.textContent).toContain("review");
  expect(table.textContent).toContain("codex");
  expect(await rowActions()).toEqual(["Details"]);
  expect(await openDetails()).toContain("Enabled");
  expect(table.textContent).not.toContain("Link unavailable");
  expect(state.preview).not.toHaveBeenCalled();
  expect(state.inspect).not.toHaveBeenCalled();
});

it("warns with the exact folder, allows cancellation, and deletes only after explicit confirmation", async () => {
  setup();
  linkableSkill();
  await using _screen = await renderPanel();
  expect(state.deletePreview).not.toHaveBeenCalled();
  await rowAction("Delete source folder…");
  await expect.poll(renderedText).toContain("/home/.claude/skills/review");
  expect(renderedText()).toContain(
    "permanently deletes this skill folder and every file inside it",
  );
  expect(renderedText()).toContain("This cannot be undone");
  expect(state.delete).not.toHaveBeenCalled();
  await button("Cancel").click();
  await expect.element(button("Permanently delete source folder")).not.toBeInTheDocument();
  expect(state.delete).not.toHaveBeenCalled();
  await page.getByRole("dialog").getByRole("button", { name: "Delete source folder…" }).click();
  await button("Permanently delete source folder").click();
  await expect.poll(renderedText).toContain("Skill permanently deleted.");
  expect(state.delete).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...state.deletePreview.mock.calls[1]![0].input,
      expectedPath: "/home/.claude/skills/review",
      expectedIdentity: "identity",
    },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("requires unlinking existing links before offering deletion from the direct action", async () => {
  setup();
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  await using _screen = await renderPanel();
  await rowAction("Delete source folder…");
  await expect.element(button("Remove all shown links")).toBeVisible();
  expect(renderedText()).toContain("Remove existing provider links before deleting");
  expect(button("Permanently delete source folder").query()).toBeNull();
  expect(state.deletePreview).not.toHaveBeenCalled();
  expect(state.delete).not.toHaveBeenCalled();
});

it("keeps deletion unavailable after preview failure", async () => {
  setup();
  linkableSkill();
  state.deletePreview.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Only an original skill folder can be deleted. Use Unlink for links."),
  });
  await using _screen = await renderPanel();
  await rowAction("Delete source folder…");
  await expect.poll(renderedText).toContain("Use Unlink for links");
  expect(button("Permanently delete source folder").query()).toBeNull();
  expect(state.delete).not.toHaveBeenCalled();
});
