import type {
  HeldPersonLevel,
  PeopleEntry,
  PeopleLink,
  PersonDevice,
  PersonLevel,
  PersonScope,
  ScopePerson,
  ScopeReach,
} from "@t3tools/contracts/j5";
import { LEVEL_PERMISSIONS, levelReaches } from "@t3tools/contracts/j5";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";

import { lifetimeLeft } from "./shareLink.logic";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const LEVEL_LABELS: Record<PersonLevel, string> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  owner: "Owner",
};
export const levelLabel = (level: PersonLevel) => LEVEL_LABELS[level];

/** The levels offered at a scope: Owner only at server scope (AC8). */
export const levelsAt = (scope: PersonScope): ReadonlyArray<PersonLevel> =>
  scope.kind === "server" ? ["viewer", "collaborator", "owner"] : ["viewer", "collaborator"];

export const sameScope = (left: PersonScope, right: PersonScope) =>
  left.kind === "server"
    ? right.kind === "server"
    : left.kind === "project"
      ? right.kind === "project" && left.projectId === right.projectId
      : right.kind === "thread" && left.threadId === right.threadId;

const RANK: Record<PersonLevel, number> = { owner: 0, collaborator: 1, viewer: 2 };

/**
 * One row of the Share dialog's "Who has it" list. `here` is the level held on the thing being
 * shared itself, which an Owner changes or removes in the dialog; `wider` is the highest level
 * held somewhere that covers it, shown with that place and changed only there (AC36).
 */
export interface AccessRow {
  readonly personId: string | null;
  readonly name: string | null;
  readonly level: PersonLevel;
  readonly here: PersonLevel | null;
  readonly wider: ScopeReach | null;
  readonly firstOwner: boolean;
  readonly you: boolean;
}

const VIA_FOR: Record<PersonScope["kind"], ScopeReach["via"]> = {
  server: "server",
  project: "project",
  thread: "thread",
};

const byStanding = (left: AccessRow, right: AccessRow) =>
  RANK[left.level] - RANK[right.level] || (left.name ?? "").localeCompare(right.name ?? "");

/** Everyone who reaches a thread or project, as the server answers it, Owners first. */
export function accessRowsFromScope(
  people: ReadonlyArray<ScopePerson>,
  scope: PersonScope,
): ReadonlyArray<AccessRow> {
  const via = VIA_FOR[scope.kind];
  return people
    .map((person) => {
      const here = person.via.find((reach) => reach.via === via) ?? null;
      const wider =
        person.via
          .filter((reach) => reach.via !== via)
          .toSorted((left, right) => RANK[left.level] - RANK[right.level])[0] ?? null;
      return {
        personId: person.personId,
        name: person.name,
        level: person.level,
        here: here?.level ?? null,
        wider,
        firstOwner: person.firstOwner,
        you: person.you,
      };
    })
    .toSorted(byStanding);
}

/** Everyone with a level at server scope, from an Owner's list of people, Owners first. */
export function accessRowsForServer(people: ReadonlyArray<PeopleEntry>): ReadonlyArray<AccessRow> {
  return people
    .flatMap((person) => {
      const held = person.levels.find((level) => level.scope.kind === "server");
      return held === undefined
        ? []
        : [
            {
              personId: person.personId,
              name: person.name,
              level: held.level,
              here: held.level,
              wider: null,
              firstOwner: person.firstOwner,
              you: person.you,
            },
          ];
    })
    .toSorted(byStanding);
}

/** "Owner · server", "Viewer · via Live test repo": where a wider level is held. */
export function widerLabel(reach: ScopeReach): string {
  switch (reach.via) {
    case "server":
      return `${levelLabel(reach.level)} · server`;
    case "project":
      return `${levelLabel(reach.level)} · via ${reach.scopeTitle ?? "its project"}`;
    case "ancestor":
      return `${levelLabel(reach.level)} · via ${reach.scopeTitle ?? "the thread above"}`;
    case "thread":
      return levelLabel(reach.level);
  }
}

/**
 * Whether changing someone to `to` gives them writing they did not have, which shows the
 * statement of AC37 before it applies (AC35).
 */
export const raisesToWriting = (from: PersonLevel | null, to: PersonLevel) =>
  levelReaches(to, "collaborator") && !levelReaches(from, to);

/** The statement before someone is given writing (AC37). */
export function writingWarning(name: string | null) {
  const who = name === null || name.trim() === "" ? null : name.trim();
  return {
    lead: `You are inviting ${who ?? "them"} to talk to and control an AI agent on your device.`,
    rest: `Make sure you trust them. Anything the agent can do, ${who ?? "they"} can ask it to do.`,
  };
}

/** What sharing a thing gives away, said every time (AC37). */
export function historyNote(scope: PersonScope): string {
  switch (scope.kind) {
    case "thread":
      return "Sharing a thread shares the agent's whole history, including any agents it spawned.";
    case "project":
      return "Sharing a project shares every thread in it and its artifacts, including any agents they spawned.";
    case "server":
      return "Sharing the server shares every project and thread on it, including any agents they spawned.";
  }
}

/** Whether a link is still in force: it can be copied again or revoked (AC41). */
export const linkInForce = (link: PeopleLink, nowMs: number) =>
  link.expiresAt.epochMilliseconds > nowMs;

/** "Anyone with the link · Viewer · 6 days left · 2 joined", or "link unused · 2 days left". */
export function linkMeta(link: PeopleLink, nowMs: number): string {
  const left = lifetimeLeft(link.expiresAt.epochMilliseconds, nowMs);
  const time = left === null ? "expired" : `${left} left`;
  if (link.use === "one") return `link unused · ${time}`;
  return [
    "Anyone with the link",
    link.level === null ? null : levelLabel(link.level),
    time,
    `${link.joined} joined`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** The person someone typed, when the name is exactly one already on the server (AC44's rule). */
export function personNamed(people: ReadonlyArray<PeopleEntry>, typed: string): PeopleEntry | null {
  const key = nameKey(typed);
  if (key === "") return null;
  return people.find((person) => person.name !== null && nameKey(person.name) === key) ?? null;
}

/** The people whose name holds what was typed, offered as the Owner types. */
export function peopleMatching(
  people: ReadonlyArray<PeopleEntry>,
  typed: string,
): ReadonlyArray<PeopleEntry> {
  const key = nameKey(typed);
  if (key === "") return [];
  return people.filter((person) => person.name !== null && nameKey(person.name).includes(key));
}

// Names are compared without case and surrounding or repeated whitespace (AC44).
const nameKey = (name: string) => name.trim().replace(/\s+/gu, " ").toLowerCase();

export function filterPeople(
  people: ReadonlyArray<PeopleEntry>,
  query: string,
): ReadonlyArray<PeopleEntry> {
  const key = nameKey(query);
  if (key === "") return people;
  return people.filter(
    (person) =>
      nameKey(person.name ?? "Someone without a name yet").includes(key) ||
      person.personId.toLowerCase().includes(key),
  );
}

/** One part of a person's summary: a level and where it is held. */
export type SummaryPart =
  | { readonly kind: "server"; readonly level: PersonLevel }
  | { readonly kind: "project"; readonly level: PersonLevel; readonly projectId: string }
  | { readonly kind: "threads"; readonly level: PersonLevel; readonly count: number };

/**
 * What a person holds, highest first, for the line under their name: "Owner · whole server",
 * "Collaborator · [icon] Live test repo · Viewer · 1 thread". Threads at one level are counted.
 */
export function summaryParts(levels: ReadonlyArray<HeldPersonLevel>): ReadonlyArray<SummaryPart> {
  const parts: SummaryPart[] = [];
  for (const level of ["owner", "collaborator", "viewer"] as const) {
    const held = levels.filter((entry) => entry.level === level);
    if (held.some((entry) => entry.scope.kind === "server")) parts.push({ kind: "server", level });
    for (const entry of held) {
      if (entry.scope.kind === "project") {
        parts.push({ kind: "project", level, projectId: entry.scope.projectId });
      }
    }
    const threads = held.filter((entry) => entry.scope.kind === "thread").length;
    if (threads > 0) parts.push({ kind: "threads", level, count: threads });
  }
  return parts;
}

export const devicesLabel = (devices: number) =>
  devices === 0 ? "no devices" : count(devices, "device", "devices");

export const threadsLabel = (threads: number) => count(threads, "thread", "threads");

/** "Desktop · Linux · Chrome", from what the device said of itself when it paired. */
export function deviceLabel(device: PersonDevice): string {
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- session metadata a device gave of itself, not an RPC client
  const { deviceType, os, browser } = device.client;
  const parts = [
    deviceType === "unknown" ? null : `${deviceType[0]?.toUpperCase()}${deviceType.slice(1)}`,
    os ?? null,
    browser ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? "Unknown device" : parts.join(" · ");
}

/**
 * The permissions a device was paired with in Connections or by `--scope`, by upstream's own
 * labels; `null` for a device paired with none, or with every permission, which holds nothing
 * back. A device keeps only these, whatever its person's level (AC18), so one frozen narrow can be
 * found here and paired again.
 */
export function deviceCeiling(device: Pick<PersonDevice, "ceiling">): ReadonlyArray<string> | null {
  const { ceiling } = device;
  if (ceiling === null || LEVEL_PERMISSIONS.owner.every((scope) => ceiling.includes(scope))) {
    return null;
  }
  return ceiling.map(
    (scope) => AUTH_SCOPE_OPTIONS.find((option) => option.scope === scope)?.title ?? scope,
  );
}

/** What an Owner is told before a person is removed altogether (AC49). */
export function removePersonWarning(name: string | null): string {
  return `Remove ${name ?? "this person"}? Everything they reach is taken away, every device paired as them is signed out at once and their unused links stop working. Their messages stay under their name.`;
}

/** What an Owner is told before one level is removed. */
export function removeLevelWarning(name: string | null, title: string): string {
  return `Take ${title} away from ${name ?? "this person"}? It leaves their list unless something wider still covers it.`;
}

/** What a person is told before leaving a scope they hold (AC48). */
export function leaveWording(scope: PersonScope, title: string) {
  return {
    title: `Leave ${title}?`,
    description:
      scope.kind === "thread"
        ? "It disappears from your list. To get it back, ask an Owner to share it again."
        : scope.kind === "project"
          ? "Every thread in it disappears from your list. To get them back, ask an Owner to share it again."
          : "Everything on this server that you reach through it disappears from your list. To get it back, ask an Owner to share it again.",
  };
}

/**
 * What one row of "Who has it" says (AC26, AC36): the level the person reaches the thing with and,
 * when it comes from a wider scope, that scope; and whether a level held on the thing itself is
 * shown beside it, as its own control. A level held here that a wider one outranks is still the
 * one an Owner changes here, so it is labelled as this thing's.
 */
export function accessRowView(row: AccessRow): {
  readonly effective: string;
  /** The level held on the thing itself, when there is one. */
  readonly here: PersonLevel | null;
  /** Whether that level is not the one the person reaches the thing with. */
  readonly hereIsOutranked: boolean;
} {
  const widerWins =
    row.wider !== null && (row.here === null || RANK[row.wider.level] < RANK[row.here]);
  return {
    effective: widerWins && row.wider !== null ? widerLabel(row.wider) : levelLabel(row.level),
    here: row.here,
    hereIsOutranked: widerWins && row.here !== null,
  };
}

/**
 * Where each link in force on a thing is listed (AC41): a further-device link under the person
 * it is for, when they are in the list, and every other link after the list, an unused link for
 * one person named by the name it offers.
 */
export function placeLinks(input: {
  readonly links: ReadonlyArray<PeopleLink>;
  readonly scope: PersonScope;
  readonly listed: ReadonlySet<string>;
  readonly nowMs: number;
}): {
  readonly underPerson: ReadonlyMap<string, ReadonlyArray<PeopleLink>>;
  readonly after: ReadonlyArray<PeopleLink>;
} {
  const underPerson = new Map<string, PeopleLink[]>();
  const after: PeopleLink[] = [];
  for (const link of input.links) {
    if (!linkInForce(link, input.nowMs)) continue;
    if (link.kind === "device") {
      if (link.personId === null || !input.listed.has(link.personId)) continue;
      underPerson.set(link.personId, [...(underPerson.get(link.personId) ?? []), link]);
      continue;
    }
    if (link.scope === null || !sameScope(link.scope, input.scope)) continue;
    if (link.personId !== null && input.listed.has(link.personId)) {
      underPerson.set(link.personId, [...(underPerson.get(link.personId) ?? []), link]);
    } else after.push(link);
  }
  return { underPerson, after };
}

/**
 * The projects whose people someone who manages no access is shown on People (AC26): each listed
 * project they hold a level on, and every listed project when they hold the server, in the
 * server's order. A thread's people are shown on the thread.
 */
export function rosterProjectIds(
  levels: ReadonlyArray<HeldPersonLevel>,
  listedProjectIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (levels.some((held) => held.scope.kind === "server")) return listedProjectIds;
  const held = new Set<string>(
    levels.flatMap((level) => (level.scope.kind === "project" ? [level.scope.projectId] : [])),
  );
  return listedProjectIds.filter((projectId) => held.has(projectId));
}

/**
 * Whether People has a server to show, or why not. A client lists no server for a moment while
 * it starts, and again while a renewed session reloads it, so an empty list means "starting"
 * unless the client has no server of its own at all (the desktop app with its local server off)
 * and the list has been read.
 */
export function peopleServerState(input: {
  readonly catalogReady: boolean;
  readonly listed: number;
  readonly hasOwnServer: boolean;
}): "ready" | "starting" | "none" {
  if (input.listed > 0) return "ready";
  return input.catalogReady && !input.hasOwnServer ? "none" : "starting";
}

/**
 * Where an Owner can widen a person at their highest level: the server, then each listed project
 * not yet reached at it, in server order. `null` when they hold nothing, already hold the server at
 * that level, or are an Owner (server scope only). Narrower levels stay for the Owner to remove.
 */
export function widenTargets(
  levels: ReadonlyArray<HeldPersonLevel>,
  listedProjectIds: ReadonlyArray<string>,
): { readonly level: PersonLevel; readonly projectIds: ReadonlyArray<string> } | null {
  const level = levels
    .map((held) => held.level)
    .toSorted((left, right) => RANK[left] - RANK[right])[0];
  if (level === undefined) return null;
  const reachedAt = (scope: (held: HeldPersonLevel) => boolean) =>
    levels.some((held) => scope(held) && levelReaches(held.level, level));
  if (reachedAt((held) => held.scope.kind === "server")) return null;
  const projectIds = listedProjectIds.filter(
    (projectId) =>
      !reachedAt((held) => held.scope.kind === "project" && held.scope.projectId === projectId),
  );
  return { level, projectIds };
}
