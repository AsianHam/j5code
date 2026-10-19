import { LEGACY_PLAYBOOK_AUTHOR_INSTRUCTIONS } from "./playbookAuthorLegacy.ts";
import type { AgentPersonaEditInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  AgentPersonaCreateInput,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AgentPersonaCatalogEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlaybookError, type PlaybookProgress } from "@t3tools/contracts/j5";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  expandPlaybookPrompt,
  isPlaybookSlashCommandVisible,
  matchPlaybookSuggestions,
  playbookMenuItems,
  playbookSelectionText,
  presentPlaybook,
  presentPlaybookStages,
  playbookRunSelection,
  playbookStagesView,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
  sortPlaybookRuns,
  playbookWorkspaces,
} from "./playbooks.ts";

const author: OrchestrationV2AgentPersonaCatalogEntry = {
  personaId: "playbook-author",
  displayName: "My customized author",
  description: "Keep my edits",
  definitionVersion: 1,
  defaultAuthorityPolicy: "workspace-write",
  allowedAuthorityPolicies: ["workspace-write"],
  availability: {
    status: "available",
    resolvedRoute: "primary",
    resolvedDriver: ProviderDriverKind.make("codex"),
    resolvedModelSelection: {
      instanceId: ProviderInstanceId.make("remote-codex"),
      model: "my-model",
    },
  },
};
const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("remote-codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-21T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "my-model",
      name: "My model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};
const decodePersonaCreate = Schema.decodeUnknownSync(AgentPersonaCreateInput);

describe("Playbook Author launch", () => {
  const workspace = {
    key: "remote-project",
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("shared-project-id"),
    threadId: null,
    title: "Project",
    workspaceRoot: "/remote/project",
    branch: null,
  };
  const launch = {
    workspace,
    commandId: CommandId.make("create-author"),
    threadId: ThreadId.make("new-author"),
    messageId: MessageId.make("first-message"),
    createdAt: "2026-09-21T00:00:00Z",
    modelSelection: { instanceId: codex.instanceId, model: "my-model" },
  };

  it.each([
    { threadId: null, workspaceRoot: "/remote/project", branch: null },
    {
      threadId: ThreadId.make("source-thread"),
      workspaceRoot: "/remote/feature",
      branch: "feature",
    },
  ])("launches the author in the selected workspace's project", (selection) => {
    const target = playbookAuthorLaunch({
      ...launch,
      workspace: { ...workspace, ...selection },
    });
    expect(target.environmentId).toBe(workspace.environmentId);
    expect(target.input).not.toHaveProperty("projectId");
    expect(target.input).toMatchObject({
      bootstrap: {
        createThread: {
          projectId: workspace.projectId,
          worktreePath: selection.threadId ? selection.workspaceRoot : null,
          branch: selection.branch,
          agentPersona: { personaId: "playbook-author" },
        },
      },
      message: {
        text: expect.stringContaining("across all projects"),
      },
    });
  });
  it("always authors a shared definition through the save tool", () => {
    const target = playbookAuthorLaunch({ ...launch, workspace });
    expect(target.input.message.text).toContain("j5_playbook_save");
    expect(target.input.message.text).not.toContain(".j5/playbooks");
  });
});

describe("saved Playbook Author instructions", () => {
  it.each([true, false])("updates only unchanged stock instructions (stock=%s)", async (stock) => {
    const original = stock
      ? LEGACY_PLAYBOOK_AUTHOR_INSTRUCTIONS
      : `${LEGACY_PLAYBOOK_AUTHOR_INSTRUCTIONS}\nMy custom rule.`;
    let instructions = original;
    const modelRoute = decodePersonaCreate({
      id: "playbook-author",
      displayName: "Author",
      description: "Author",
      instructions: original,
      authorityPolicy: "workspace-write",
      modelRoute: [
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
      ],
    }).modelRoute;
    const edits: AgentPersonaEditInput[] = [];
    const input: Parameters<typeof ensurePlaybookAuthor>[0] = {
      providers: [],
      readCatalog: async () => ({
        personas: [{ ...author, editable: { definitionDigest: "a".repeat(64), modelRoute } }],
      }),
      createPersona: async () => {
        throw new Error("must not recreate saved author");
      },
      readDefinition: async () => ({
        id: "playbook-author",
        version: 1,
        displayName: author.displayName,
        description: author.description,
        instructions,
        authority: { defaultPolicy: "workspace-write", allowedPolicies: ["workspace-write"] },
        modelRoute,
      }),
      editPersona: async (edit) => {
        edits.push(edit);
        instructions = edit.instructions;
      },
    };
    await ensurePlaybookAuthor(input);
    await ensurePlaybookAuthor(input);
    expect(edits).toHaveLength(stock ? 1 : 0);
    if (stock)
      expect(edits[0]).toMatchObject({
        expectedDigest: "a".repeat(64),
        displayName: author.displayName,
        modelRoute,
      });
    else expect(instructions).toBe(original);
  });
});

describe("Playbook Author installation", () => {
  it("creates a valid editable author once and uses the server-resolved provider instance", async () => {
    let installed: OrchestrationV2AgentPersonaCatalogEntry | undefined;
    const definitions: AgentPersonaCreateInput[] = [];
    const input = {
      providers: [codex],
      readCatalog: async () => ({ personas: installed ? [installed] : [] }),
      createPersona: async (definition: AgentPersonaCreateInput) => {
        definitions.push(decodePersonaCreate(definition));
        installed = author;
      },
    };
    expect(await ensurePlaybookAuthor(input)).toEqual({
      instanceId: "remote-codex",
      model: "my-model",
    });
    await ensurePlaybookAuthor(input);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      id: "playbook-author",
      authorityPolicy: "workspace-write",
      modelRoute: [
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
      ],
    });
  });

  it("reuses customized authors without rewriting or needing local provider data", async () => {
    expect(
      await ensurePlaybookAuthor({
        providers: [],
        readCatalog: async () => ({ personas: [author] }),
        createPersona: async () => {
          throw new Error("must not overwrite");
        },
      }),
    ).toEqual({ instanceId: "remote-codex", model: "my-model" });
  });

  it.each(["disabled", "removed", "routes-unavailable", "authority-not-enforceable"] as const)(
    "respects an existing author's %s state",
    async (reason) => {
      await expect(
        ensurePlaybookAuthor({
          providers: [codex],
          readCatalog: async () => ({
            personas: [
              {
                ...author,
                availability: { status: "unavailable", reason },
              },
            ],
          }),
          createPersona: async () => {
            throw new Error("must not replace");
          },
        }),
      ).rejects.toThrow("Settings → Personas");
    },
  );

  it("requires write authority without silently changing a customized author", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({
          personas: [{ ...author, defaultAuthorityPolicy: "read-only" }],
        }),
        createPersona: async () => {
          throw new Error("must not overwrite");
        },
      }),
    ).rejects.toThrow("Workspace write authority");
  });

  it("does not create an unusable author when only Claude is configured", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [{ ...codex, driver: ProviderDriverKind.make("claudeAgent") }],
        readCatalog: async () => ({ personas: [] }),
        createPersona: async () => {
          throw new Error("must not create");
        },
      }),
    ).rejects.toThrow("authenticated Codex provider");
  });

  it("uses an author created concurrently by another client", async () => {
    let installed = false;
    expect(
      await ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({ personas: installed ? [author] : [] }),
        createPersona: async () => {
          installed = true;
          throw new Error("ID already exists");
        },
      }),
    ).toEqual({ instanceId: "remote-codex", model: "my-model" });
  });

  it("surfaces a failed write when no author was installed", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({ personas: [] }),
        createPersona: async () => {
          throw new Error("Read-only connection");
        },
      }),
    ).rejects.toThrow("Read-only connection");
  });
});

it("keeps conversation destinations scoped when two environments share IDs", () => {
  const projects = ["alpha", "bravo"].map((name) => ({
    environmentId: EnvironmentId.make(name),
    id: ProjectId.make("same-project"),
    title: "Project",
    workspaceRoot: `/${name}/main`,
  }));
  const threads = projects.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    id: ThreadId.make("same-thread"),
    title: "Task",
    worktreePath: `/${project.environmentId}/feature`,
    branch: "feature",
    deletedAt: null,
  }));
  const workspaces = playbookWorkspaces(projects, [
    ...threads,
    { ...threads[0]!, id: ThreadId.make("deleted"), deletedAt: "2026-09-21T00:00:00Z" },
    { ...threads[0]!, id: ThreadId.make("root"), worktreePath: projects[0]!.workspaceRoot },
    { ...threads[0]!, id: ThreadId.make("unattached"), worktreePath: null },
  ]);
  expect(new Set(workspaces.map(({ key }) => key)).size).toBe(4);
  expect(
    workspaces.map(({ environmentId, threadId, workspaceRoot }) => ({
      environmentId,
      threadId,
      workspaceRoot,
    })),
  ).toEqual([
    { environmentId: "alpha", threadId: null, workspaceRoot: "/alpha/main" },
    { environmentId: "alpha", threadId: "same-thread", workspaceRoot: "/alpha/feature" },
    { environmentId: "bravo", threadId: null, workspaceRoot: "/bravo/main" },
    { environmentId: "bravo", threadId: "same-thread", workspaceRoot: "/bravo/feature" },
  ]);
});

it.each([
  ["playbook", true, true],
  ["playbook", false, false],
  ["model", false, true],
  ["plan", false, true],
  ["default", false, true],
])("offers /%s at message start=%s: %s", (command, atMessageStart, expected) => {
  expect(isPlaybookSlashCommandVisible(command, atMessageStart)).toBe(expected);
});

describe("playbook composer expansion", () => {
  it.each([
    ["/playbook release", "Start playbook release"],
    ["  /playbook release.yaml  ", "Start playbook release"],
    ["/playbook Release-Review.", "Start playbook release-review"],
    ["/playbook", "List available playbooks and help me choose one to start."],
    ["/playbook ", "List available playbooks and help me choose one to start."],
    ["/playbook release, then make a crew", "Start playbook release.\n\nthen make a crew"],
    ["/playbook release\nDo something else", "Start playbook release.\n\nDo something else"],
    [
      "/playbook\nWhich one fits this bug?",
      "List available playbooks and help me choose one to start.\n\nWhich one fits this bug?",
    ],
    ['/playbook "Release Plan"', '/playbook "Release Plan"'],
    ["/playbook release_notes", "/playbook release_notes"],
    ["Explain /playbook release", "Explain /playbook release"],
    ["/playbooks release", "/playbooks release"],
    ["/plan", "/plan"],
    ["", ""],
  ])("expands a message that starts with /playbook: %s", (text, expected) => {
    expect(expandPlaybookPrompt(text)).toBe(expected);
  });
});

const run: PlaybookProgress = {
  runId: "run-a",
  ownerThreadId: ThreadId.make("thread-a"),
  definitionPath: "/workspace/.j5/playbooks/demo.yaml",
  currentStepId: "build",
  status: "active",
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-21T10:00:00Z",
  title: "Demo",
  description: "Do the work",
  steps: [
    { id: "research", title: "Research" },
    { id: "build", title: "Build" },
    { id: "review", title: "Review" },
  ],
  position: 2,
  total: 3,
  issue: null,
};
it("presents the current phase without inventing success for earlier steps", () => {
  const display = presentPlaybook(run);
  expect(display.position).toBe("Step 2 of 3");
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ label }) => label)).toEqual(["Earlier", "Current", "Later"]);
  expect(presentPlaybook({ ...run, status: "cancelled" })).toMatchObject({
    status: "Cancelled",
    steps: [{ label: "Earlier" }, { label: "Last position" }, { label: "Later" }],
  });
});
it("preserves the phase identity when live steps are reordered", () => {
  const display = presentPlaybook({
    ...run,
    steps: [run.steps[1]!, run.steps[2]!, run.steps[0]!],
    position: 1,
  });
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ current }) => current)).toEqual([true, false, false]);
});

it.each(["completed", "cancelled"] as const)(
  "marks the last position without an active or successful step in a %s run",
  (status) => {
    const display = presentPlaybook({ ...run, status, currentStepId: "research", position: 1 });
    expect(display.steps.map(({ state }) => state)).toEqual(["last", "later", "later"]);
    expect(display.steps.some(({ current }) => current)).toBe(false);
    expect(display.steps[0]?.label).toBe("Last position");
  },
);

it("shows available steps without guessing progress when the live definition loses the current step", () => {
  const display = presentPlaybook({ ...run, currentStepId: "removed", position: null });
  expect(display.position).toBe("Step unavailable");
  expect(display.currentTitle).toBe("removed");
  expect(display.steps.every((step) => step.state === "available" && !step.current)).toBe(true);
  expect(presentPlaybook({ ...run, steps: [], position: null, total: 0 }).steps).toEqual([]);
});

it("moves positional highlighting back without treating later steps as completed", () => {
  const display = presentPlaybook({ ...run, currentStepId: "research", position: 1 });
  expect(display.steps.map(({ state }) => state)).toEqual(["current", "later", "later"]);
});

it("retains all 100 step names and identifies the current position by stable ID", () => {
  const steps = Array.from({ length: 100 }, (_, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
  }));
  const display = presentPlaybook({
    ...run,
    steps,
    total: 100,
    position: 50,
    currentStepId: "step-50",
  });
  expect(display.position).toBe("Step 50 of 100");
  expect(display.steps.map(({ id, title }) => ({ id, title }))).toEqual(steps);
  expect(display.steps.filter(({ current }) => current).map(({ id }) => id)).toEqual(["step-50"]);
  expect(display.steps[48]?.state).toBe("earlier");
  expect(display.steps[50]?.state).toBe("later");
});

it("prioritizes active issues, then active runs and recency, without changing the fetched page", () => {
  const issue = new PlaybookError({
    code: "step_missing",
    message: "Step removed",
    availableStepIds: [],
  });
  const runs = Object.freeze([
    { ...run, runId: "completed", status: "completed" as const, updatedAt: "2026-09-21T14:00:00Z" },
    { ...run, runId: "older-active" },
    {
      ...run,
      runId: "cancelled-issue",
      status: "cancelled" as const,
      issue,
      updatedAt: "2026-09-21T15:00:00Z",
    },
    { ...run, runId: "active-issue", issue },
    { ...run, runId: "recent-active", updatedAt: "2026-09-21T11:00:00Z" },
    { ...run, runId: "tied-active", updatedAt: "2026-09-21T11:00:00Z" },
  ]);
  const original = [...runs];
  expect(sortPlaybookRuns(runs).map(({ runId }) => runId)).toEqual([
    "active-issue",
    "recent-active",
    "tied-active",
    "older-active",
    "cancelled-issue",
    "completed",
  ]);
  expect(runs).toEqual(original);
  expect(sortPlaybookRuns([])).toEqual([]);
});

it("ranks playbook suggestions by exact name, then prefix, then name or title match", () => {
  const issue = new PlaybookError({
    code: "step_missing",
    message: "Broken",
    availableStepIds: [],
  });
  const playbooks = [
    { name: "code-review", title: "Code review", issue: null },
    { name: "triage", title: "Review inbox", issue: null },
    { name: "review-plan", title: "Plan", issue: null },
    { name: "review", title: "Review", issue: null },
    { name: "review-broken", title: "Broken", issue },
  ];
  expect(matchPlaybookSuggestions(playbooks, " Review ").map(({ name }) => name)).toEqual([
    "review",
    "review-plan",
    "code-review",
    "triage",
  ]);
  expect(matchPlaybookSuggestions(playbooks, "").map(({ name }) => name)).toEqual([
    "code-review",
    "triage",
    "review-plan",
    "review",
  ]);
});

describe("playbook mention picker", () => {
  const broken = new PlaybookError({
    code: "step_missing",
    message: "Step report is missing a prompt.",
    availableStepIds: [],
  });
  const badName = new PlaybookError({
    code: "invalid_name",
    message: "Rename Release Plan.yaml to release-plan.yaml.",
    availableStepIds: [],
  });
  const playbooks = [
    { name: "release-broken", title: "Broken release", issue: broken },
    { name: "Release Plan", title: "Release Plan", issue: badName },
    { name: "code-release", title: "Code release", issue: null },
    { name: "release", title: "Release", issue: null },
  ];
  const mention = (text: string) => ({
    kind: "slash-playbook",
    query: text.slice(text.lastIndexOf(":") + 1),
    rangeStart: text.lastIndexOf("@"),
    rangeEnd: text.length,
  });

  it("lists valid playbooks first, then invalid ones with their error, but no misnamed file", () => {
    const text = "Use @playbook:rel";
    expect(
      playbookMenuItems(playbooks, mention(text), text).map(({ name, description }) => ({
        name,
        description,
      })),
    ).toEqual([
      { name: "release", description: "Release" },
      { name: "code-release", description: "Code release" },
      { name: "release-broken", description: "Step report is missing a prompt." },
    ]);
  });

  it("matches the raw token, so punctuation typed after a name matches no row", () => {
    const text = "@playbook:release,";
    expect(playbookMenuItems(playbooks, mention(text), text)).toEqual([]);
  });

  it("keeps /playbook suggestions to valid playbooks", () => {
    const text = "/playbook rel";
    const trigger = { kind: "slash-playbook", query: "rel", rangeStart: 0, rangeEnd: text.length };
    expect(playbookMenuItems(playbooks, trigger, text)).toEqual(
      matchPlaybookSuggestions(playbooks, "rel"),
    );
  });

  it("inserts the form that was typed", () => {
    const command = "/playbook rel";
    expect(playbookSelectionText(command, { rangeStart: 0, rangeEnd: 13 }, "release")).toBe(
      "/playbook release ",
    );
    const text = "Use @playbook:rel";
    expect(playbookSelectionText(text, mention(text), "release")).toBe("@playbook:release ");
  });

  it("gives a bare @playbook: rows to complete, so Enter picks one instead of sending", () => {
    const text = "Use @playbook:";
    const rows = playbookMenuItems(playbooks, mention(text), text);
    expect(rows.map(({ name }) => name)).toEqual(["code-release", "release", "release-broken"]);
    expect(playbookSelectionText(text, mention(text), rows[0]!.name)).toBe(
      "@playbook:code-release ",
    );
  });
});

it("checks earlier composer stages and reopens stages when going back", () => {
  const middle = presentPlaybookStages(run);
  expect(middle.completedSteps).toBe(1);
  expect(middle.steps.map(({ status }) => status)).toEqual(["completed", "inProgress", "pending"]);
  const beginning = presentPlaybookStages({ ...run, position: 1, currentStepId: "research" });
  expect(beginning.completedSteps).toBe(0);
  expect(beginning.steps.map(({ status }) => status)).toEqual(["inProgress", "pending", "pending"]);
});

it("checks every composer stage when the playbook completes, even when ended early", () => {
  const completed = presentPlaybookStages({ ...run, status: "completed" });
  expect(completed.completedSteps).toBe(3);
  expect(completed.steps.every((step) => step.status === "completed")).toBe(true);
  expect(completed.steps.some((step) => step.current)).toBe(false);
  const cancelled = presentPlaybookStages({ ...run, status: "cancelled" });
  expect(cancelled.completedSteps).toBe(1);
  expect(cancelled.steps.map(({ status }) => status)).toEqual(["completed", "pending", "pending"]);
});

it("leaves stages unchecked when the current position is unavailable", () => {
  const unavailable = presentPlaybookStages({ ...run, position: null, currentStepId: "removed" });
  expect(unavailable.completedSteps).toBe(0);
  expect(unavailable.steps.every((step) => step.status === "pending")).toBe(true);
});

it("follows new runs again once the latest run is picked from history", () => {
  const first = { runId: "run-1" };
  const second = { runId: "run-2" };
  const third = { runId: "run-3" };
  const picked = playbookRunSelection([second, first], first.runId);
  expect(selectedPlaybookRun([second, first], picked)).toBe(first);
  const latest = playbookRunSelection([second, first], second.runId);
  expect(latest).toBeNull();
  expect(selectedPlaybookRun([third, second, first], latest)).toBe(third);
});

it("falls back to the latest run when the picked run is no longer listed", () => {
  expect(selectedPlaybookRun([{ runId: "run-3" }], "run-1")).toEqual({ runId: "run-3" });
});

it("keeps a thread's stage view while the bar is away for a question", () => {
  expect(playbookStagesView("env:thread-a")).toEqual({ expanded: false, selectedRunId: null });
  rememberPlaybookStagesView("env:thread-a", { expanded: true, selectedRunId: "run-1" });
  expect(playbookStagesView("env:thread-a")).toEqual({ expanded: true, selectedRunId: "run-1" });
  expect(playbookStagesView("env:thread-b")).toEqual({ expanded: false, selectedRunId: null });
});
