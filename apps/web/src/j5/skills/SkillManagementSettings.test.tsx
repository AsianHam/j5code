import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ManagedSkillLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SkillInventoryPanel } from "./SkillManagementSettings";

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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "permission" ? true : state.providers),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { settings: { skillCatalogSource: state.catalogSource } },
  }),
}));
vi.mock("../settingsScopeEnvironment.logic", () => ({
  lockedSettingsScopeProject: () => state.lockedProject,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "first", environmentId: "env", title: "First project", workspaceRoot: "/first" },
    { id: "second", environmentId: "env", title: "Second project", workspaceRoot: "/second" },
    {
      id: "remote",
      environmentId: "other-env",
      title: "Other environment",
      workspaceRoot: "/remote",
    },
  ],
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => "providers", refreshProviders: "refresh" },
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
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.links,
    error: null,
    isPending: false,
    refresh: state.refreshLinks,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (given: string | { readonly name: string }) => {
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
  },
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
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: () => null,
  SettingsSection: ({
    children,
    title,
    headerAction,
  }: {
    children: React.ReactNode;
    title: string;
    headerAction?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
    role,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    status?: React.ReactNode;
    control?: React.ReactNode;
    children?: React.ReactNode;
    role?: string;
  }) => (
    <div role={role}>
      <h3>{title}</h3>
      <p>{description}</p>
      {status}
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../../components/settings/providerDriverMeta", () => ({
  getDriverOption: () => undefined,
  providerClients: new Map(),
}));
vi.mock("../../components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => children,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.notify } }));

vi.mock("../../components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../../components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => children,
  MenuTrigger: ({
    children,
    render: _render,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { render: React.ReactElement }) => (
    <button {...props}>{children}</button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => children,
  MenuSeparator: () => <hr />,
  MenuItem: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const environmentId = EnvironmentId.make("env");
const instanceId = ProviderInstanceId.make("codex-work");
const checkedAt = "2026-09-18T00:00:00Z";
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.restoreAllMocks();
});
async function renderPanel() {
  await act(async () => {
    renderer = create(<SkillInventoryPanel environmentId={environmentId} />);
  });
  return renderer!;
}
async function renderProjectPanel() {
  const panel = await renderPanel();
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  return panel;
}

function renderedText() {
  return JSON.stringify(renderer!.toJSON());
}
function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .filter((text) => text.trim().length > 0)
    .join(" ");
}
function discoveryText() {
  return textContent(renderer!.root.findByProps({ role: "status" }));
}
function inventoryText() {
  return inventoryLists().map(textContent).join(" ");
}
function inventoryStatusLabels() {
  return inventoryItems().flatMap((row) =>
    row.findAllByProps({ role: "img" }).map((node) => node.props["aria-label"]),
  );
}
function inventoryLists() {
  return renderer!.root.findAll((node) => node.type === "div" && node.props.role === "list");
}
function inventoryItems() {
  return renderer!.root.findAll((node) => node.type === "div" && node.props.role === "listitem");
}
async function openDetails() {
  await act(async () => buttonNamed("Details").props.onClick());
  return renderer!.root.findByProps({ role: "dialog" });
}

function refreshButton() {
  return renderer!.root
    .findAllByType("button")
    .find((button) => textContent(button) === "Refresh")!;
}
function categoryButton(origin: string) {
  return renderer!.root
    .findAllByType("button")
    .find((button) => button.props["aria-label"]?.endsWith(`${origin} skills`))!;
}

it("uses the explicit settings project instead of an environment-wide default", async () => {
  state.lockedProject = {
    id: "second",
    environmentId: "env",
    title: "Second project",
    workspaceRoot: "/second",
  };
  await renderPanel();
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, cwd: "/second" },
  });
  expect(renderer!.root.findAllByType("select")).toHaveLength(1);
});

it.each(["ready", "unchecked", "failed"])(
  "exposes empty-provider availability as %s through compact status indicators",
  async (discovery) => {
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
    await renderPanel();
    const row = inventoryItems()[0]!;
    expect(textContent(row)).toContain("codex");
    expect(textContent(row)).toContain("claudeAgent");
    const statuses = row.findAllByProps({ role: "img" }).map((node) => node.props["aria-label"]);
    expect(statuses).toContain("codex: review · Enabled");
    expect(statuses).toContain(
      `claudeAgent: review · ${discovery === "ready" ? "Not detected" : "Unknown"}`,
    );
    expect(textContent(row)).not.toMatch(/Enabled|Disabled|Not detected|Unknown/);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  },
);

it("does not show session-restart guidance when making a skill available changes nothing", async () => {
  linkableSkill();
  state.create.mockResolvedValue({
    _tag: "Success",
    value: {
      action: "unchanged",
      discovery: "detected",
      message: "Already linked. Nothing changed.",
    },
  });
  await renderPanel();
  await act(async () => buttonNamed("Make available to…").props.onClick());
  await act(async () => buttonNamed("Make available").props.onClick());
  expect(renderedText()).toContain("Nothing changed.");
  expect(renderedText()).not.toContain("Restart agent session");
});

it("shows matching skills while typing and updates rows when discovery changes", async () => {
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
  const panel = await renderPanel();
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  for (const value of ["r", "re", "review"])
    await act(async () => panel.root.findByType("input").props.onChange({ target: { value } }));
  expect(inventoryText()).toContain("review-31");
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [{ name: "review-new", path: "/new/SKILL.md", enabled: true }],
    },
  ];
  await act(async () => panel.update(<SkillInventoryPanel environmentId={environmentId} />));
  expect(inventoryText()).toContain("review-new");
  expect(inventoryText()).not.toContain("review-31");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  state.catalogSource = "/new-catalog";
  await act(async () => panel.update(<SkillInventoryPanel environmentId={environmentId} />));
});

it("starts environment-wide and only requests workspace discovery after a project is selected", async () => {
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
  const panel = await renderPanel();
  expect(panel.root.findAllByType("select")[0]!.props.value).toBe("");
  expect(state.refresh).not.toHaveBeenCalled();
  expect(discoveryText()).toContain("Checked");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  const providerDetails = await openDetails();
  expect(textContent(providerDetails)).toContain("review");
  expect(textContent(providerDetails)).toContain("tools:review");
  expect(textContent(providerDetails)).toContain("/skills/review/SKILL.md");
  expect(textContent(providerDetails)).toContain("/plugins/review/SKILL.md");
  expect(textContent(providerDetails)).toContain("Disabled");
  expect(textContent(providerDetails)).toContain("User only");
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
  expect(discoveryText()).toContain("Not checked");
  expect(discoveryText()).not.toContain("Not detected");
  expect(renderedText()).not.toContain("Other environment");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "second" } }),
  );
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/second" },
  });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(discoveryText()).toContain("Checked");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  expect(state.refresh).toHaveBeenCalledTimes(3);
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
});

it("replaces an existing workspace on manual instance refresh, retains stale rows after failure and recovers", async () => {
  const old = { name: "old-skill", path: "/old/SKILL.md", enabled: true };
  state.providers = [
    {
      ...state.providers[0]!,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [old], slashCommands: [] }],
    },
  ];
  await renderProjectPanel();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(renderedText()).toContain("old-skill");
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
  await act(async () => refreshButton().props.onClick());
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { instanceId } });
  expect(renderedText()).toContain("new-skill");
  expect(renderedText()).not.toContain("old-skill");
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  await act(async () => refreshButton().props.onClick());
  expect(renderedText()).toContain("new-skill");
  expect(discoveryText()).toContain("Refresh failed");
  expect(inventoryStatusLabels()).toContain("codex: new-skill · Unknown · Stale");
  state.refresh.mockImplementation(() =>
    Promise.resolve({ _tag: "Success", value: { providers: state.providers } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(discoveryText()).not.toContain("Refresh failed");
  expect(inventoryStatusLabels()).toContain("codex: new-skill · Enabled");
});

it("clears a transport failure when selecting an unchecked project succeeds later", async () => {
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  const panel = await renderProjectPanel();
  expect(discoveryText()).toContain("Refresh failed");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  state.refresh.mockImplementation(() => {
    state.providers = [
      {
        ...state.providers[0]!,
        workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [], slashCommands: [] }],
      },
    ];
    return Promise.resolve({ _tag: "Success", value: { providers: state.providers } });
  });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  expect(discoveryText()).not.toContain("Refresh failed");
  expect(discoveryText()).toContain("Checked");
});

it("preserves provider-specific metadata when filtering a shared location and labels missing records", async () => {
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
  const panel = await renderProjectPanel();
  expect(inventoryText()).toContain("codex (codex-work)");
  const details = await openDetails();
  expect(textContent(details)).toContain("Not detected");
  expect(textContent(details)).toContain("Not checked");
  expect(textContent(details)).toContain("Refresh failed");
  expect(inventoryStatusLabels().join(" ")).not.toContain("review · Unknown · Stale");
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: secondId } }),
  );
  const selectedDetails = await openDetails();
  expect(textContent(selectedDetails)).toContain("audit");
  expect(textContent(selectedDetails)).toContain("audit@team");
  expect(textContent(selectedDetails)).toContain("Agent only");
  expect(textContent(selectedDetails)).not.toContain("/codex/review/SKILL.md");
  expect(inventoryText()).not.toContain("codex-personal");
});

it("shows empty supported providers, retains cached skills, and keeps them selectable and refreshable", async () => {
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
  const panel = await renderProjectPanel();
  expect(discoveryText()).toContain("Codex");
  expect(discoveryText()).toContain("OpenCode");
  expect(discoveryText()).toContain("Claude");
  expect(discoveryText()).not.toContain("Antigravity");
  expect(inventoryStatusLabels()).toContain("OpenCode: deploy · Unknown · Stale");
  expect(textContent(panel.root.findAllByType("select")[1]!)).toContain("Claude");
  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "review" } }),
  );
  expect(discoveryText()).toContain("Codex");
  expect(discoveryText()).toContain("OpenCode");
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: claudeId } }),
  );
  expect(inventoryItems()).toHaveLength(0);
  expect(discoveryText()).toContain("Claude");
  expect(discoveryText()).toContain("Checked");
  expect(renderedText()).toContain("No skills reported for this selection");
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: "" } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId: claudeId } });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  expect(inventoryText()).toContain("Claude");
  expect(discoveryText()).toContain("OpenCode");
  expect(inventoryText()).toContain("Codex");
  expect(inventoryStatusLabels()).toContain("Codex: review · Not detected");
});

it("groups skills in origin order, collapses categories independently, and reveals search matches", async () => {
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
  const panel = await renderProjectPanel();
  const listNames = () => inventoryLists().map((list) => list.props["aria-label"]);
  expect(listNames()).toEqual([
    "Plugin skill inventory",
    "Catalog skill inventory",
    "Project skill inventory",
    "Personal skill inventory",
    "Built-in skill inventory",
    "Other skill inventory",
  ]);
  expect(
    textContent(
      panel.root.findAllByType("h2").find((heading) => textContent(heading) === "Plugin (2)")!,
    ),
  ).toBe("Plugin (2)");

  await act(async () => categoryButton("Plugin").props.onClick({}));
  // The node renderer has no DOM for Base UI to finish panel transitions.
  // Observe expanded state for toggles, and rendered contents for filtering.
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(true);
  await act(async () => categoryButton("Catalog").props.onClick({}));
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(false);
  await act(async () => categoryButton("Plugin").props.onClick({}));
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(false);
  await act(async () => categoryButton("Plugin").props.onClick({}));

  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "review" } }),
  );
  expect(listNames()).toEqual(["Plugin skill inventory"]);
  expect(panel.root.findAllByType("h2").map(textContent)).toContain("Plugin (1)");
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
  expect(inventoryText()).not.toContain("build");
  expect(categoryButton("Catalog")).toBeUndefined();
  await act(async () => categoryButton("Plugin").props.onClick({}));
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "no matching skill" } }),
  );
  expect(categoryButton("Plugin")).toBeUndefined();
  expect(renderedText()).toContain("No skills reported for this selection");
});

it("keeps collapsed categories across filters and refresh, and resets them on remount", async () => {
  const first = state.providers[0]!;
  const otherId = ProviderInstanceId.make("other");
  const skill = { name: "review", path: "/review/SKILL.md", pluginId: "tools", enabled: true };
  state.providers = [
    { ...first, skills: [skill] },
    { ...first, instanceId: otherId },
  ];
  const panel = await renderPanel();
  await act(async () => categoryButton("Plugin").props.onClick({}));
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: otherId } }),
  );
  expect(categoryButton("Plugin")).toBeUndefined();
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: instanceId } }),
  );
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  expect(inventoryText()).not.toContain("review");

  await act(async () => {
    panel.update(<SkillInventoryPanel key="remounted" environmentId={environmentId} />);
  });
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
});

function buttonNamed(name: string) {
  return renderer!.root.findAllByType("button").find((button) => textContent(button) === name)!;
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
it("offers only Codex and Claude instances in the inventory filter and link destination picker", async () => {
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
  const panel = await renderPanel();
  const options = (select: ReactTestInstance) =>
    select.findAllByType("option").map((option) => option.props.value);
  expect(options(panel.root.findAllByType("select")[1]!)).toEqual([
    "",
    "codex-work",
    "claude-work",
    "codex-home",
  ]);
  await act(async () => buttonNamed("Make available to…").props.onClick());
  const destination = panel.root.findByProps({ role: "dialog" }).findAllByType("select")[0]!;
  expect(options(destination)).toEqual(["codex-work", "claude-work", "codex-home"]);
  await act(async () => destination.props.onChange({ target: { value: "codex-home" } }));
  expect(state.preview.mock.lastCall![0].input.targetInstanceId).toBe("codex-home");
});
it("previews an environment-scoped destination before linking and separates creation from discovery", async () => {
  linkableSkill();
  await renderPanel();
  await act(async () => buttonNamed("Make available to…").props.onClick());
  expect(state.preview).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      source: { instanceId, path: "/shared/review/SKILL.md", name: "review" },
      targetInstanceId: "claude-work",
      scope: "user",
    },
  });
  expect(renderedText()).toContain("/home/.claude/skills/review");
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Make available").props.onClick());
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
  expect(renderedText()).toContain("Link created. Discovery refresh failed.");
  expect(renderedText()).toContain("Restart agent session");
  expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(state.refreshLinks).toHaveBeenCalledOnce();
});
it("defaults project skills to the selected project and discards a stale preview when scope changes", async () => {
  linkableSkill("project");
  await renderProjectPanel();
  await act(async () => buttonNamed("Make available to…").props.onClick());
  expect(state.preview.mock.calls[0]![0].input.scope).toBe("project");
  let resolve!: (value: unknown) => void;
  state.preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const dialog = renderer!.root.findByProps({ role: "dialog" });
  await act(async () =>
    dialog.findAllByType("select")[1]!.props.onChange({ target: { value: "user" } }),
  );
  expect(buttonNamed("Make available").props.disabled).toBe(true);
  expect(renderedText()).not.toContain("/home/.claude/skills/review");
  await act(async () =>
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
  expect(buttonNamed("Make available").props.disabled).toBe(true);
  expect(state.create).not.toHaveBeenCalled();
});
it("keeps plugin rows read-only and broken managed links removable", async () => {
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
  await renderPanel();
  expect(buttonNamed("Make available to…")).toBeUndefined();
  expect(buttonNamed("Remove provider link…")).toBeUndefined();
  expect(renderedText()).not.toContain("Link unavailable");
  expect(renderedText()).toContain("Broken link");
  await act(async () => buttonNamed("Remove provider link").props.onClick());
  expect(state.remove).toHaveBeenCalledWith({ environmentId, input: { id: "owned-link" } });
  expect(renderedText()).toContain("Link removed. The source is unchanged.");
  expect(renderedText()).toContain("Restart agent session");
});

it("explains an outdated server and keeps linking disabled when the preview RPC is unknown", async () => {
  linkableSkill();
  state.preview.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: j5.skills.links.preview"),
  });
  await renderPanel();
  await act(async () => buttonNamed("Make available to…").props.onClick());
  expect(renderedText()).toContain("Update and restart the app or server hosting this environment");
  expect(renderedText()).not.toContain("Close and reopen");
  expect(buttonNamed("Make available").props.disabled).toBe(true);
  expect(state.create).not.toHaveBeenCalled();
});

it("lets changed links be forgotten and removes only their managed record", async () => {
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
  await renderPanel();
  expect(buttonNamed("Remove provider link")).toBeUndefined();
  expect(buttonNamed("Forget record").props.disabled).toBe(false);
  await act(async () => buttonNamed("Forget record").props.onClick());
  expect(state.remove).toHaveBeenCalledWith({
    environmentId,
    input: { id: "changed-link", forget: true },
  });
  expect(renderedText()).toContain("The destination and source were left unchanged");
  expect(renderedText()).toContain("No managed links yet");
});

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
it("loads existing links only on demand after remount and unlinks one provider without removing the other", async () => {
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  const panel = await renderPanel();
  expect(state.inspect).not.toHaveBeenCalled();
  await act(async () =>
    panel.update(<SkillInventoryPanel key="restarted" environmentId={environmentId} />),
  );
  expect(state.inspect).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Remove provider link…").props.onClick());
  expect(state.inspect).toHaveBeenCalledOnce();
  expect(state.preview).not.toHaveBeenCalled();
  expect(renderedText()).toContain(options[1]!.request.expectedDestinationPath);
  state.unlink.mockResolvedValue({
    _tag: "Success",
    value: {
      removedPaths: [options[0]!.request.expectedDestinationPath],
      failed: [],
      refreshFailed: false,
    },
  });
  await act(async () => buttonNamed("Remove provider link").props.onClick());
  expect(state.unlink).toHaveBeenCalledWith({
    environmentId,
    input: { links: [options[0]!.request] },
  });
  expect(renderedText()).not.toContain(options[0]!.request.expectedDestinationPath);
  expect(renderedText()).toContain(options[1]!.request.expectedDestinationPath);
  expect(renderedText()).toContain("1 link removed. Source files stay in place.");
  expect(buttonNamed("Remove all shown links")).toBeUndefined();
  expect(state.inspect).toHaveBeenCalledOnce();
});
it("unlinks both providers in one request and keeps failed links available to retry", async () => {
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  await renderPanel();
  await act(async () => buttonNamed("Remove provider link…").props.onClick());
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
  await act(async () => buttonNamed("Remove all shown links").props.onClick());
  expect(state.unlink).toHaveBeenCalledOnce();
  expect(state.unlink).toHaveBeenCalledWith({
    environmentId,
    input: { links: options.map((option) => option.request) },
  });
  expect(renderedText()).toContain("Link changed since preview");
  expect(renderedText()).toContain("Discovery refresh failed");
  expect(renderedText()).toContain(options[1]!.request.expectedDestinationPath);
  expect(buttonNamed("Remove provider link").props.disabled).toBe(false);
  expect(state.refreshLinks).toHaveBeenCalledOnce();
});
it("shows inspection errors without leaving an endless loading state", async () => {
  linkableSkill();
  state.inspect.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: j5.skills.links.inspect"),
  });
  await renderPanel();
  await act(async () => buttonNamed("Remove provider link…").props.onClick());
  expect(renderedText()).toContain("Update and restart");
  expect(renderedText()).not.toContain("Checking existing links");
  expect(state.unlink).not.toHaveBeenCalled();
});

it("keeps built-in skill rows read-only while showing their metadata and provider status", async () => {
  linkableSkill("system");
  await renderPanel();
  const table = renderer!.root.findByProps({ "aria-label": "Built-in skill inventory" });
  expect(textContent(table)).toContain("review");
  expect(textContent(table)).toContain("codex");
  expect(buttonNamed("Make available to…")).toBeUndefined();
  expect(buttonNamed("Remove provider link…")).toBeUndefined();
  expect(buttonNamed("Delete source folder…")).toBeUndefined();
  expect(textContent(await openDetails())).toContain("Enabled");
  expect(textContent(table)).not.toContain("Link unavailable");
  expect(state.preview).not.toHaveBeenCalled();
  expect(state.inspect).not.toHaveBeenCalled();
});

it("warns with the exact folder, allows cancellation, and deletes only after explicit confirmation", async () => {
  linkableSkill();
  await renderPanel();
  expect(state.deletePreview).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Delete source folder…").props.onClick());
  expect(renderedText()).toContain("/home/.claude/skills/review");
  expect(renderedText()).toContain(
    "permanently deletes this skill folder and every file inside it",
  );
  expect(renderedText()).toContain("This cannot be undone");
  expect(state.delete).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Cancel").props.onClick());
  expect(buttonNamed("Permanently delete source folder")).toBeUndefined();
  expect(state.delete).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root
      .findByProps({ role: "dialog" })
      .findAllByType("button")
      .find((button) => textContent(button) === "Delete source folder…")!
      .props.onClick(),
  );
  await act(async () => buttonNamed("Permanently delete source folder").props.onClick());
  expect(state.delete).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...state.deletePreview.mock.calls[1]![0].input,
      expectedPath: "/home/.claude/skills/review",
      expectedIdentity: "identity",
    },
  });
  expect(renderedText()).toContain("Skill permanently deleted.");
  expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});
it("requires unlinking existing links before offering deletion from the direct action", async () => {
  linkableSkill();
  const options = existingLinks();
  state.inspect.mockResolvedValue({ _tag: "Success", value: options });
  await renderPanel();
  await act(async () => buttonNamed("Delete source folder…").props.onClick());
  expect(renderedText()).toContain("Remove existing provider links before deleting");
  expect(buttonNamed("Remove all shown links")).toBeDefined();
  expect(buttonNamed("Permanently delete source folder")).toBeUndefined();
  expect(state.deletePreview).not.toHaveBeenCalled();
  expect(state.delete).not.toHaveBeenCalled();
});

it("keeps deletion unavailable after preview failure", async () => {
  linkableSkill();
  state.deletePreview.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Only an original skill folder can be deleted. Use Unlink for links."),
  });
  await renderPanel();
  await act(async () => buttonNamed("Delete source folder…").props.onClick());
  expect(renderedText()).toContain("Use Unlink for links");
  expect(buttonNamed("Permanently delete source folder")).toBeUndefined();
  expect(state.delete).not.toHaveBeenCalled();
});
