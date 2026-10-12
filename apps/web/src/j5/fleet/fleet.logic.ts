import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { classifyCrewSeat, type CrewSeatState, type CrewSeatThread } from "../crew/crewState";
import type { FleetAgent, FleetCrew, FleetLedgerProject } from "./fleetClient";

/** One rendered row of the Roster tree. Crew members hang under their Captain as one unit. */
export interface FleetRow {
  readonly agent: FleetAgent;
  readonly depth: number;
  /** The Crew this row belongs to when it is a member; the Captain's own row has none. */
  readonly crewInstanceId: string | null;
}

export interface FleetCrewGroup {
  readonly crewInstanceId: string;
  readonly crewName: string;
  /** The playbook the Crew follows, and the step ids each seat owns. */
  readonly playbookName: string | null;
  readonly stepsBySeat: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Seats are nodes too: a helper an agent places under a seat renders beneath that seat. */
  readonly members: ReadonlyArray<FleetNode>;
  /** The Crew's active playbook run, when it follows one. */
  readonly playbookRun: FleetPlaybookRun | null;
}

export type FleetPlaybookRun = NonNullable<FleetCrew["playbookRun"]>;

/**
 * Who holds a Crew's current step. Only `captain` is the Captain; a hand-off still in progress
 * never reads as the Captain's, even when it has no seat yet.
 */
export const playbookRunOwnerLabel = (run: Pick<FleetPlaybookRun, "state" | "seat">) =>
  run.state === "delivered"
    ? (run.seat ?? "Seat")
    : run.state === "captain"
      ? "Captain"
      : run.seat === null
        ? "handing off"
        : `handing off to ${run.seat}`;

/** The DOM id of a live Crew's group on the Fleet page, unique across environments. */
export const fleetCrewAnchorId = (environmentId: string, crewInstanceId: string) =>
  `fleet-crew:${environmentId}:${crewInstanceId}`;

/**
 * "Step N of M: <title> · <who holds it>" for a Crew's header, or "Step <id> · needs attention"
 * when the live playbook can't place the recorded step.
 */
export const playbookRunHeader = (run: FleetPlaybookRun) =>
  run.issue === undefined
    ? `Step ${run.position} of ${run.total}: ${run.stepTitle} · ${playbookRunOwnerLabel(run)}`
    : `Step ${run.stepId} · needs attention`;

/** A tree node: an agent, its non-Crew children, and the Crews it commands as collapsible groups. */
export interface FleetNode {
  readonly row: FleetRow;
  readonly children: ReadonlyArray<FleetNode>;
  readonly crews: ReadonlyArray<FleetCrewGroup>;
}

const byLabel = (left: FleetAgent, right: FleetAgent) =>
  (left.displayName ?? left.participantId).localeCompare(right.displayName ?? right.participantId);

/**
 * Placement tree per project, the unit each machine's ledger answers in: roots are agents whose parent is null or not in the
 * project; Crew members are pulled out of the plain child list and grouped under their
 * Captain by Crew. A seat on the roster that is not placed yet (or never created: the read
 * carries it with no thread) still hangs under its Captain, so a Crew's group always counts
 * every seat. Agents that sit in a Crew but whose Captain is gone still render at the root.
 */
export function buildFleetTree(ledgerProject: FleetLedgerProject): ReadonlyArray<FleetNode> {
  const byId = new Map(ledgerProject.agents.map((agent) => [agent.participantId, agent]));
  const crewById = new Map(ledgerProject.crews.map((crew) => [crew.crewInstanceId, crew]));
  const children = new Map<string | null, Array<FleetAgent>>();
  for (const agent of ledgerProject.agents) {
    const placed = agent.placementParentId ?? agent.crew?.captainParticipantId ?? null;
    const parent = placed !== null && byId.has(placed) ? placed : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(agent);
    children.set(parent, siblings);
  }
  const visited = new Set<string>();
  const build = (agent: FleetAgent, depth: number): FleetNode => {
    visited.add(agent.participantId);
    const own = (children.get(agent.participantId) ?? [])
      .filter((child) => !visited.has(child.participantId))
      .toSorted(byLabel);
    const crewGroups = new Map<string, { name: string; members: Array<FleetNode> }>();
    const plain: Array<FleetNode> = [];
    for (const child of own) {
      if (child.crew !== null && child.crew.captainParticipantId === agent.participantId) {
        const group = crewGroups.get(child.crew.crewInstanceId) ?? {
          name: child.crew.crewName,
          members: [],
        };
        const seat = build(child, depth + 2);
        group.members.push({
          ...seat,
          row: { ...seat.row, crewInstanceId: child.crew.crewInstanceId },
        });
        crewGroups.set(child.crew.crewInstanceId, group);
      } else {
        plain.push(build(child, depth + 1));
      }
    }
    return {
      row: { agent, depth, crewInstanceId: null },
      children: plain,
      crews: [...crewGroups.entries()].map(([crewInstanceId, group]) => {
        const crew = crewById.get(crewInstanceId);
        return {
          crewInstanceId,
          crewName: group.name,
          playbookName: crew?.playbook?.name ?? null,
          stepsBySeat: new Map(
            (crew?.roster ?? []).flatMap((seat) =>
              seat.steps === undefined ? [] : [[seat.seat, seat.steps] as const],
            ),
          ),
          members: group.members,
          playbookRun: crew?.playbookRun ?? null,
        };
      }),
    };
  };
  const roots = (children.get(null) ?? [])
    .toSorted(byLabel)
    .filter((agent) => !visited.has(agent.participantId))
    .map((agent) => build(agent, 0));
  // A corrupt placement cycle has no root; surface its agents rather than losing them.
  for (const agent of [...ledgerProject.agents].toSorted(byLabel)) {
    if (!visited.has(agent.participantId)) roots.push(build(agent, 0));
  }
  return roots;
}

/** A Crew paired with the project it belonged to, for lists that span projects. */
export interface FleetProjectCrew<S extends FleetLedgerProject = FleetLedgerProject> {
  readonly project: S;
  readonly crew: FleetCrew;
}

/**
 * Retired Crews across every project, newest retirement first, each paired with its project so
 * the row can name it. Their roster snapshot stays readable so whoever proposes a successor can
 * start from the brief and the approved seats (Crews AC20).
 */
export const retiredCrews = <S extends FleetLedgerProject>(
  projects: ReadonlyArray<S>,
): ReadonlyArray<FleetProjectCrew<S>> =>
  projects
    .flatMap((ledgerProject) =>
      ledgerProject.crews
        .filter((crew) => crew.archivedAt !== null)
        .map((crew) => ({ project: ledgerProject, crew })),
    )
    .toSorted((left, right) =>
      (right.crew.archivedAt ?? "").localeCompare(left.crew.archivedAt ?? ""),
    );

/** A placement-tree root paired with the project it belongs to, for tables that span projects. */
export interface FleetSectionRow<S extends FleetLedgerProject = FleetLedgerProject> {
  readonly project: S;
  readonly node: FleetNode;
}

/** The Active and Settled sections of the Fleet page; retired Crews are listed by `retiredCrews`. */
export interface FleetSections<S extends FleetLedgerProject = FleetLedgerProject> {
  readonly active: ReadonlyArray<FleetSectionRow<S>>;
  readonly settled: ReadonlyArray<FleetSectionRow<S>>;
  /** Every agent row in Settled, seats included, for the expander's label. */
  readonly settledAgentCount: number;
  /** Every agent that is a row in either section, for the page subtitle. */
  readonly agentCount: number;
}

/** The client's thread shell for a thread on an environment; `undefined` when the client holds none. */
export type FleetShellLookup = (
  environmentId: EnvironmentId,
  threadId: string,
) => CrewSeatThread | undefined;

/** Every agent in a subtree: the node itself, its plain children, and every Crew seat beneath it. */
export function* fleetNodeAgents(node: FleetNode): Generator<FleetAgent> {
  yield node.row.agent;
  for (const crew of node.crews) for (const member of crew.members) yield* fleetNodeAgents(member);
  for (const child of node.children) yield* fleetNodeAgents(child);
}

/**
 * A subtree is settled only when every agent in it, Crew seats included, reads as settled from
 * upstream's settle mechanic on its thread shell (`settledAt` / `settledOverride`, the facts
 * `classifyCrewSeat` reads). One running, failed, needs-you, idle, or unknown agent anywhere
 * beneath the root keeps the whole subtree in Active: a settled Captain whose seats still work is
 * not done, and an agent the client cannot see is not assumed done. Idle is not settled; nothing
 * is inferred from silence.
 */
export const isSettledFleetNode = (
  node: FleetNode,
  classify: (agent: FleetAgent) => CrewSeatState,
): boolean => {
  for (const agent of fleetNodeAgents(node)) if (classify(agent) !== "settled") return false;
  return true;
};

/**
 * The Active and Settled sections across every project. The roster read already leaves out
 * retired agents (fleet-page AC11), and the client's thread shells never hold archived threads,
 * so the child of a retired agent roots through `buildFleetTree` and nothing here filters. Roots
 * keep the order `buildFleetTree` gives them, project by project, so nothing is reordered by
 * activity (AC9); a root and its whole subtree land in one section together, placed by
 * `isSettledFleetNode`.
 */
export function partitionFleet<
  S extends FleetLedgerProject & { readonly environmentId: EnvironmentId },
>(projects: ReadonlyArray<S>, shellFor: FleetShellLookup): FleetSections<S> {
  const active: Array<FleetSectionRow<S>> = [];
  const settled: Array<FleetSectionRow<S>> = [];
  let settledAgentCount = 0;
  let agentCount = 0;
  for (const ledgerProject of projects) {
    const classify = (agent: FleetAgent) =>
      classifyCrewSeat(
        agent.threadId === null ? undefined : shellFor(ledgerProject.environmentId, agent.threadId),
      );
    agentCount += ledgerProject.agents.length;
    for (const node of buildFleetTree(ledgerProject)) {
      if (isSettledFleetNode(node, classify)) {
        settled.push({ project: ledgerProject, node });
        settledAgentCount += [...fleetNodeAgents(node)].length;
      } else {
        active.push({ project: ledgerProject, node });
      }
    }
  }
  return { active, settled, settledAgentCount, agentCount };
}

/** The slice of a logical project the Fleet page orders and counts by. */
export interface FleetProject {
  readonly projectKey: string;
  readonly displayName: string;
}

/** The label a root row sorts under: its project, by the server's title while the client's is unresolved. */
const fleetRowLabel = <S extends FleetLedgerProject>(
  row: FleetSectionRow<S>,
  project: FleetProject | undefined,
) => project?.displayName ?? row.project.title;

/**
 * Orders a section's roots by upstream's logical project, so the copies of one project on two
 * machines sit together although each machine's ledger answered for its own rows. Within a
 * project the roots keep the order `buildFleetTree` gave them (AC9: nothing reorders by
 * activity). A root whose project cannot be resolved sorts by the title the read carries instead.
 */
export function orderFleetRowsByProject<S extends FleetLedgerProject>(
  rows: ReadonlyArray<FleetSectionRow<S>>,
  projectOf: (ledgerProject: S) => FleetProject | undefined,
): ReadonlyArray<FleetSectionRow<S>> {
  return rows
    .map((row, index) => ({ row, index, project: projectOf(row.project) }))
    .toSorted(
      (left, right) =>
        fleetRowLabel(left.row, left.project).localeCompare(
          fleetRowLabel(right.row, right.project),
          undefined,
          { sensitivity: "base", numeric: true },
        ) ||
        (left.project?.projectKey ?? "").localeCompare(right.project?.projectKey ?? "") ||
        left.index - right.index,
    )
    .map(({ row }) => row);
}

/** How many projects the listed roots span; an unresolved root counts by its own project id. */
export function countFleetProjects<
  S extends FleetLedgerProject & { readonly environmentId: string },
>(
  rows: ReadonlyArray<FleetSectionRow<S>>,
  projectOf: (ledgerProject: S) => FleetProject | undefined,
) {
  return new Set(
    rows.map(
      (row) =>
        projectOf(row.project)?.projectKey ??
        `unresolved:${row.project.environmentId}:${row.project.id}`,
    ),
  ).size;
}

/** Roster alert badge: measured "needs a human" facts only, so nothing here is guessed. */
export const countFleetAlerts = (projects: ReadonlyArray<FleetLedgerProject>) =>
  projects.reduce(
    (count, ledgerProject) =>
      count + ledgerProject.agents.filter((agent) => agent.openAsks > 0).length,
    0,
  );

/**
 * Origin copy for the Roster row; unknown renders as `?` rather than a plausible guess. An
 * outside agent that started the agent is named by the label it signed in with, and by its id
 * when it registered none: it has no thread, so the row is the only place it is named.
 */
export const originLabel = (agent: Pick<FleetAgent, "origin" | "outsideSpawner">) =>
  agent.outsideSpawner !== undefined
    ? `${agent.outsideSpawner.name ?? agent.outsideSpawner.participantId} (outside agent)`
    : agent.origin === "human"
      ? "Human-created"
      : agent.origin === "agent"
        ? "Agent-spawned"
        : "?";

/**
 * The sidebar rows the roster says are involved in a Crew or a spawn: every seat, every Captain
 * a seat names, and every agent with a placed child. The Fleet poll re-reads Crew chips and
 * children for these rows (and for the rows still showing one; see refreshCrewMembershipRows)
 * and no others, so that read's cost follows involvement, not the thread list. A Captain that
 * gained a Crew on another device is named here on the next poll. The live read carries no
 * retired Crew, so a Captain whose last Crew retired is not named here; its chip clears because
 * the row still holds one.
 */
export function fleetInvolvedThreadRefs(
  projects: ReadonlyArray<FleetLedgerProject & { readonly environmentId: EnvironmentId }>,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  for (const ledgerProject of projects) {
    const byId = new Map(ledgerProject.agents.map((agent) => [agent.participantId, agent]));
    const involve = (participantId: string) => {
      const threadId = byId.get(participantId)?.threadId ?? null;
      if (threadId === null) return;
      const ref = scopeThreadRef(ledgerProject.environmentId, ThreadId.make(threadId));
      refs.set(`${ref.environmentId}\u0000${ref.threadId}`, ref);
    };
    for (const agent of ledgerProject.agents) {
      if (agent.crew !== null) {
        involve(agent.participantId);
        involve(agent.crew.captainParticipantId);
      }
      if (agent.placementParentId !== null) involve(agent.placementParentId);
    }
  }
  return [...refs.values()];
}
