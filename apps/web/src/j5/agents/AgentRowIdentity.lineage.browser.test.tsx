import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  personaShell: null as unknown,
}));

vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => ({ projection: state.projection })) as never,
  useThreadRelationshipShells: (() => []) as never,
  useProjects: (() => []) as never,
  // The lineage row's saved-agent identity reads the child shell.
  useThreadShell: ((ref: { threadId: string } | null) =>
    ref?.threadId === "child-1" ? state.personaShell : null) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => ({ _tag: "Success" })) as never,
}));
vi.mock(import("./AgentHandoffChip"), async (importOriginal) => ({
  ...(await importOriginal()),
  AgentHandoffChip: (() => <a href="/artifacts">Handoff written</a>) as never,
}));

import { render } from "../../../test/render";
import { ThreadRelationshipsPanel } from "../../components/chat/ThreadRelationshipsControl";

// FORK.md, PR #75–#86 table: the saved-agent chip and handoff link sit beside a lineage
// row's button, not inside it.
it("keeps a child's saved-agent identity and handoff link beside the row button", async () => {
  state.personaShell = {
    agentPersonaAssignment: {
      personaId: "critic",
      displayName: "Critic",
      authorityPolicy: "critic-fix",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    },
  };
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null }, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "agent-1",
        driver: "codex",
        providerInstanceId: "codex",
        childThreadId: "child-1",
        title: "Checker",
        prompt: "Check the change",
        model: "gpt-5.4",
        status: "running",
        progress: null,
        result: null,
        startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="/artifacts"]');
  expect(link).not.toBeNull();
  expect(link!.closest("button")).toBeNull();
  const persona = [...screen.container.querySelectorAll("*")].filter(
    (element) => element.childElementCount === 0 && element.textContent === "Critic · Fix",
  );
  expect(persona).toHaveLength(1);
  expect(persona[0]!.closest("button")).toBeNull();
});
