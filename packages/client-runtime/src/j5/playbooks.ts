import {
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_NAME_PATTERN,
  type PlaybookProgress,
} from "@t3tools/contracts/j5";
import type {
  AgentPersonaCreateInput,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2AgentPersonaCatalog,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  PLAYBOOK_MENTION_PREFIX,
  playbookMentionReplacement,
} from "@t3tools/shared/j5/agentMention";
import { defaultAgentPersonaModelRoute } from "./agentPersonas.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/shell.ts";

export const PLAYBOOK_AUTHOR_ID = "playbook-author";
export const PLAYBOOK_AUTHOR_INSTRUCTIONS = `You are Playbook Author. Help the user turn a repeatable task into a small, clear agent-led playbook in this thread's workspace.

1. Start by asking what the playbook should accomplish. Clarify the desired result, inputs, constraints, and evidence of success one focused question at a time. Use details already provided instead of asking again.
2. Inspect existing .j5/playbooks definitions and relevant workspace guidance. Propose the smallest useful sequence of steps, then write or refine the definition once the user's intent is clear. Ask before replacing an unrelated existing definition; preserve stable step IDs when editing.
3. Save .j5/playbooks/<name>.yaml relative to this thread's workspace. The name must be lowercase letters, digits, and hyphens, starting with a letter, such as release-review; put the human-readable name in title. Use YAML 1.2 with title, description, and steps. Each step has a unique stable id, a title, and a non-empty prompt. A step may add persona, the id of the persona that should do it; call j5_list_personas before writing one, and leave it off steps the user doesn't assign. Use 1–${PLAYBOOK_MAX_STEPS} steps, no YAML aliases, and at most ${PLAYBOOK_MAX_BYTES / 1024} KiB. For example:

title: Review a change
description: Inspect a change and report evidence.
steps:
  - id: inspect
    title: Inspect
    prompt: Read the change, check its intended behavior, and record findings with evidence.
  - id: report
    title: Report
    persona: reviewer
    prompt: Summarize findings, checks performed, and remaining uncertainty.

Each prompt tells the same agent what work to do, what evidence to retain, and when to advance.
4. Call j5_playbook_list in this thread after writing. Fix reported issues and repeat until the named definition is listed without an issue. Tell the user about any warnings, such as a persona that is missing or turned off. If the tool is unavailable, state that runtime validation is still unverified.
5. Report the file path, purpose, and steps. Explain that the user can inspect it in Settings → Personas and send /playbook <name> when ready to run it.

Stay within authoring and validation. Start a run only when the user explicitly asks. Make changes needed for the playbook; leave unrelated workspace files alone.`;

/** Install once in the selected environment; subsequent launches retain the user's edits. */
export async function ensurePlaybookAuthor(input: {
  providers: ReadonlyArray<ServerProvider>;
  readCatalog: () => Promise<OrchestrationV2AgentPersonaCatalog>;
  createPersona: (definition: AgentPersonaCreateInput) => Promise<unknown>;
}) {
  const findAuthor = async () =>
    (await input.readCatalog()).personas.find(({ personaId }) => personaId === PLAYBOOK_AUTHOR_ID);
  let persona = await findAuthor();
  if (!persona) {
    // Workspace-writing personas currently require the Codex sandbox policy.
    const modelRoute = defaultAgentPersonaModelRoute(
      input.providers.filter(({ driver }) => driver === "codex"),
    );
    if (!modelRoute)
      throw new Error(
        "Playbook Author needs an authenticated Codex provider with an available model. Configure one in Settings → Providers for this environment.",
      );
    try {
      await input.createPersona({
        id: PLAYBOOK_AUTHOR_ID,
        displayName: "Playbook Author",
        description: "Helps you design, write, and validate agent-led playbooks.",
        instructions: PLAYBOOK_AUTHOR_INSTRUCTIONS,
        authorityPolicy: "workspace-write",
        modelRoute,
      });
    } catch (cause) {
      // Another client can create it between our catalog read and create request.
      persona = await findAuthor();
      if (!persona) throw cause;
    }
    persona ??= await findAuthor();
  }
  if (!persona || persona.availability.status !== "available")
    throw new Error(
      "Playbook Author is unavailable. Enable or restore it and check its model route in Settings → Personas for this environment.",
    );
  if (persona.defaultAuthorityPolicy !== "workspace-write")
    throw new Error(
      "Playbook Author needs Workspace write authority to save YAML. Update it in Settings → Personas for this environment.",
    );
  return persona.availability.resolvedModelSelection;
}

/** Keep the persona and workspace together through the durable launch. */
export function playbookAuthorLaunch(input: {
  workspace: ReturnType<typeof playbookWorkspaces>[number];
  modelSelection: ModelSelection;
  commandId: CommandId;
  threadId: ThreadId;
  messageId: MessageId;
  createdAt: string;
}) {
  const { workspace, modelSelection, commandId, threadId, messageId, createdAt } = input;
  return {
    environmentId: workspace.environmentId,
    input: {
      commandId,
      threadId,
      createdAt,
      message: {
        messageId,
        role: "user",
        text: "Help me create a playbook in this workspace. Start by asking what I want it to accomplish.",
        attachments: [],
      },
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: workspace.projectId,
          title: "Create playbook",
          modelSelection,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: workspace.branch,
          worktreePath: workspace.threadId ? workspace.workspaceRoot : null,
          createdAt,
          agentPersona: { personaId: PLAYBOOK_AUTHOR_ID },
        },
      },
    } satisfies StartThreadTurnInput,
  };
}

export function playbookWorkspaces(
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">
  >,
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "id" | "projectId" | "title" | "worktreePath" | "branch" | "deletedAt"
    >
  >,
) {
  return projects.flatMap((project) => [
    {
      key: `${project.environmentId}:project:${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      threadId: null,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      branch: null,
    },
    ...threads
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id &&
          thread.worktreePath !== null &&
          thread.worktreePath !== project.workspaceRoot,
      )
      .map((thread) => ({
        key: `${project.environmentId}:thread:${thread.id}`,
        environmentId: project.environmentId,
        projectId: project.id,
        threadId: thread.id,
        title: `${project.title} / ${thread.title}`,
        workspaceRoot: thread.worktreePath!,
        branch: thread.branch,
      })),
  ]);
}

type PlaybookWorkspaceInputs = {
  projects: Parameters<typeof playbookWorkspaces>[0];
  threads: Parameters<typeof playbookWorkspaces>[1];
};

/** Ignore shell activity unless a workspace's identity or location changes. */
export function samePlaybookWorkspaceInputs(
  a: PlaybookWorkspaceInputs,
  b: PlaybookWorkspaceInputs,
) {
  return (
    a.projects.length === b.projects.length &&
    a.threads.length === b.threads.length &&
    a.projects.every((project, index) => {
      const previous = b.projects[index];
      return (
        project.environmentId === previous?.environmentId &&
        project.id === previous.id &&
        project.title === previous.title &&
        project.workspaceRoot === previous.workspaceRoot
      );
    }) &&
    a.threads.every((thread, index) => {
      const previous = b.threads[index];
      return (
        thread.environmentId === previous?.environmentId &&
        thread.id === previous.id &&
        thread.projectId === previous.projectId &&
        thread.title === previous.title &&
        thread.worktreePath === previous.worktreePath &&
        thread.branch === previous.branch &&
        thread.deletedAt === previous.deletedAt
      );
    })
  );
}

/**
 * A composer text expansion for a message that starts with `/playbook`. The name is the next
 * word, lowercased, without trailing punctuation or `.yaml`, so "/playbook release, then make a
 * crew" names `release`; any text after it is kept as a separate paragraph. A word that isn't a
 * valid playbook name leaves the message unchanged. The ordinary agent-message path performs
 * the work.
 */
export function expandPlaybookPrompt(text: string): string {
  const command = /^\s*\/playbook(?!\S)[ \t]*/i.exec(text)?.[0];
  if (command === undefined) return text;
  const args = text.slice(command.length);
  const word = /^\S*/.exec(args)?.[0] ?? "";
  const name = word
    .replace(/[,.;:!?)]+$/, "")
    .replace(/\.ya?ml$/i, "")
    .toLowerCase();
  if (word && !PLAYBOOK_NAME_PATTERN.test(name)) return text;
  const request = word
    ? `Start playbook ${name}`
    : "List available playbooks and help me choose one to start.";
  const rest = args.slice(word.length).trim();
  return rest ? `${request.replace(/\.?$/, ".")}\n\n${rest}` : request;
}

/** Offer the playbook command only where its name picker can open. */
export function isPlaybookSlashCommandVisible(command: string, atMessageStart: boolean) {
  return command !== "playbook" || atMessageStart;
}

/** `/playbook <query>` suggestions: exact name, then name prefix, then name or title substring. */
export function matchPlaybookSuggestions(
  playbooks: ReadonlyArray<PlaybookSuggestionInput>,
  query: string,
) {
  const needle = query.trim().toLowerCase();
  const rank = ({ name, title }: { name: string; title: string }) => {
    const lower = name.toLowerCase();
    if (lower === needle) return 0;
    if (lower.startsWith(needle)) return 1;
    return lower.includes(needle) || title.toLowerCase().includes(needle) ? 2 : null;
  };
  return playbooks
    .flatMap((playbook) => {
      const order = playbook.issue ? null : rank(playbook);
      return order === null ? [] : [{ playbook, order }];
    })
    .sort((a, b) => a.order - b.order)
    .map(({ playbook }) => ({
      id: `playbook:${playbook.name}`,
      type: "playbook" as const,
      name: playbook.name,
      label: playbook.name,
      description: playbook.title,
    }));
}

type PlaybookSuggestionInput = { name: string; title: string; issue: { message: string } | null };
type PlaybookTriggerRange = { rangeStart: number; rangeEnd: number };

/** `@playbook:` and `/playbook` share one trigger kind; the text at `rangeStart` tells them apart. */
export const isPlaybookMention = (text: string, trigger: PlaybookTriggerRange) =>
  text.startsWith(PLAYBOOK_MENTION_PREFIX, trigger.rangeStart);

/**
 * Picker rows for the shared playbook trigger. `/playbook` lists only valid playbooks. The
 * `@playbook:` form also lists invalid ones after the valid ones, with the error as description,
 * except a file whose name isn't a valid playbook name.
 */
export function playbookMenuItems(
  playbooks: ReadonlyArray<PlaybookSuggestionInput>,
  trigger: PlaybookTriggerRange & { query: string },
  text: string,
) {
  if (!isPlaybookMention(text, trigger)) return matchPlaybookSuggestions(playbooks, trigger.query);
  // A file whose name isn't a valid playbook name can't be mentioned, so it isn't offered.
  const mentionable = playbooks.filter(({ name }) => PLAYBOOK_NAME_PATTERN.test(name));
  // Rank invalid entries the same way by matching them as if valid, then show their error.
  const errors = new Map(
    mentionable.flatMap(({ name, issue }) => (issue ? [[name, issue.message] as const] : [])),
  );
  const invalid = matchPlaybookSuggestions(
    mentionable.flatMap((playbook) => (playbook.issue ? [{ ...playbook, issue: null }] : [])),
    trigger.query,
  ).map((item) => ({ ...item, description: errors.get(item.name) ?? "" }));
  return [...matchPlaybookSuggestions(mentionable, trigger.query), ...invalid];
}

/** The text that replaces the trigger range when a playbook row is picked. */
export function playbookSelectionText(text: string, trigger: PlaybookTriggerRange, name: string) {
  return isPlaybookMention(text, trigger) ? playbookMentionReplacement(name) : `/playbook ${name} `;
}

export function presentPlaybook(run: PlaybookProgress) {
  const current = run.steps.find((step) => step.id === run.currentStepId);
  return {
    status:
      run.status === "active"
        ? run.issue
          ? "Needs attention"
          : "In progress"
        : run.status === "completed"
          ? "Completed"
          : "Cancelled",
    position: run.position === null ? "Step unavailable" : `Step ${run.position} of ${run.total}`,
    currentTitle: current?.title ?? run.currentStepId,
    steps: run.steps.map((step, index) => {
      const state =
        step.id === run.currentStepId
          ? run.status === "active"
            ? "current"
            : "last"
          : run.position === null
            ? "available"
            : index + 1 < run.position
              ? "earlier"
              : "later";
      return {
        ...step,
        state,
        current: state === "current",
        label: {
          current: "Current",
          last: "Last position",
          available: "Available",
          earlier: "Earlier",
          later: "Later",
        }[state],
      } as const;
    }),
  };
}

/** Task-style stage progress follows the live order; backtracking reopens following stages. */
export function presentPlaybookStages(run: PlaybookProgress) {
  const display = presentPlaybook(run);
  const steps = display.steps.map((step) => {
    const status =
      run.status === "completed" || step.state === "earlier"
        ? "completed"
        : step.current
          ? "inProgress"
          : "pending";
    return {
      ...step,
      status,
      label: { completed: "Completed", inProgress: "Running", pending: "Pending" }[status],
    } as const;
  });
  return {
    ...display,
    steps,
    completedSteps: steps.filter((step) => step.status === "completed").length,
  };
}

/**
 * The progress bar's expanded state and picked run, by `environmentId:threadId`. The composer
 * unmounts the bar while a question or approval is pending; this lets it come back as it was.
 */
export interface PlaybookStagesView {
  readonly expanded: boolean;
  /** An earlier run the person picked; `null` follows the latest run. */
  readonly selectedRunId: string | null;
}

const playbookStagesViews = new Map<string, PlaybookStagesView>();

export function playbookStagesView(key: string): PlaybookStagesView {
  return playbookStagesViews.get(key) ?? { expanded: false, selectedRunId: null };
}

export function rememberPlaybookStagesView(key: string, view: PlaybookStagesView) {
  playbookStagesViews.set(key, view);
}

/** The run the bar shows: the picked one while it is still listed, otherwise the latest. */
export function selectedPlaybookRun<Run extends { readonly runId: string }>(
  runs: ReadonlyArray<Run>,
  selectedRunId: string | null,
): Run | undefined {
  return runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
}

/** Picking the latest run clears the choice, so the bar follows the next run that starts. */
export function playbookRunSelection(
  runs: ReadonlyArray<{ readonly runId: string }>,
  runId: string,
): string | null {
  return runId === runs[0]?.runId ? null : runId;
}

/** Prioritize active runs with issues within a fetched page without mutating the query's runs. */
export function sortPlaybookRuns(runs: ReadonlyArray<PlaybookProgress>) {
  return [...runs].sort(
    (a, b) =>
      Number(b.status === "active" && !!b.issue) - Number(a.status === "active" && !!a.issue) ||
      Number(b.status === "active") - Number(a.status === "active") ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

/** A step's list label, with its persona when it names one: "1. Plan · planner". */
export function playbookStepLabel(step: { title: string; persona?: string }, index: number) {
  return `${index + 1}. ${step.title}${step.persona ? ` · ${step.persona}` : ""}`;
}
