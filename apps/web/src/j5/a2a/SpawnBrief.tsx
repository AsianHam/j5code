import { ThreadId } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import type { ResolvedUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatMessage } from "~/types";

import {
  presentParticipantIdentity,
  type ParticipantIdentityPresentation,
} from "./ParticipantIdentity";

/**
 * `j5_spawn_agent` starts a Peer Agent's thread with one user-role message whose
 * id is `message:j5:a2a:mcp:<session>:spawn-brief:<request key>` (server
 * `spawnMessageId`). The id shape is the only gate; envelope-looking text alone
 * is never a spawn brief.
 */
const SPAWN_BRIEF_MESSAGE_ID_PATTERN = /^message:j5:a2a:mcp:[^:]+:spawn-brief:/;

const CONTEXT_OPEN = "<j5_spawn_context>\n";
const CONTEXT_CLOSE = "\n</j5_spawn_context>\n\n";
const BRIEF_ONLY_PATTERN = /^<spawner_brief>\n([\s\S]*)\n<\/spawner_brief>$/;
/** Crew seats: the crew block first, the wrapped brief last, platform prose in between. */
const CREW_SEAT_PATTERN =
  /^<j5_crew_context>\n[\s\S]*\n\n<spawner_brief>\n[\s\S]*\n<\/spawner_brief>$/;

export interface SpawnBriefPresentation {
  /**
   * What the spawner told the agent, without the platform identity block. For
   * a plain Peer Agent this is the bare brief. Crew seats also receive crew
   * facts, collaboration rules, and seat instructions between the identity
   * block and the brief; those stay verbatim here until they get their own UI.
   */
  readonly brief: string;
  readonly participantId: string;
  /** Null on briefs written before the server recorded the spawner. */
  readonly spawnedBy: string | null;
  readonly spawnerThreadId: ThreadId | null;
}

export function isSpawnBriefMessage(message: ChatMessage): boolean {
  return message.role === "user" && SPAWN_BRIEF_MESSAGE_ID_PATTERN.test(String(message.id));
}

/**
 * Strictly recognizes the identity block the server's `spawnFirstTurnText`
 * puts first, and unwraps the brief when it is all that follows. A changed
 * template returns null so the message falls back to the plain user row rather
 * than hiding text the agent actually received.
 */
export function presentSpawnBrief(message: ChatMessage): SpawnBriefPresentation | null {
  if (!isSpawnBriefMessage(message)) return null;
  const text = message.text;
  if (!text.startsWith(CONTEXT_OPEN)) return null;
  const closeIndex = text.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length);
  if (closeIndex < 0) return null;

  const facts = new Map<string, string>();
  for (const line of text.slice(CONTEXT_OPEN.length, closeIndex).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) facts.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const participantId = facts.get("participant_id");
  // Briefs stored before Squadrons were retired name a Squadron where newer ones name a project.
  const projectId = facts.get("project_id") ?? facts.get("squadron_id");
  const projectTitle = facts.get("project_title") ?? facts.get("squadron_name");
  if (!participantId || !projectId || !projectTitle) return null;
  const spawnerThreadId = facts.get("spawner_thread_id");
  const remainder = text.slice(closeIndex + CONTEXT_CLOSE.length);
  const bareBrief = BRIEF_ONLY_PATTERN.exec(remainder)?.[1];
  if (bareBrief === undefined && !CREW_SEAT_PATTERN.test(remainder)) return null;

  return {
    brief: bareBrief ?? remainder,
    participantId,
    spawnedBy: facts.get("spawned_by") ?? null,
    spawnerThreadId: spawnerThreadId ? ThreadId.make(spawnerThreadId) : null,
  };
}

export function participantIdsForSpawnBrief(message: ChatMessage): ReadonlyArray<string> {
  const spawnedBy = presentSpawnBrief(message)?.spawnedBy ?? null;
  return spawnedBy === null ? [] : [spawnedBy];
}

/**
 * A brief is literal authored text. The composer never attaches context
 * records to it, so the user row must not upgrade legacy trailing blocks
 * (`<terminal_context>`, `<element_context>`, preview annotations) out of it:
 * a brief that quotes one of those tags would otherwise lose its tail.
 */
export function resolvedSpawnBriefContext(brief: string): ResolvedUserMessageContext {
  return { text: brief, records: [], recordsById: new Map() };
}

/**
 * The spawner's name when known; otherwise the honest unnamed label with the id as a tooltip. An
 * outside agent (`outside:<session id>`, an MCP client signed in from outside the app) is marked
 * as one, since its label alone reads like an agent in this app and it has no thread to open.
 */
export function presentSpawnerIdentity(input: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}): ParticipantIdentityPresentation {
  if (input.spawnedBy === null) return { label: "another agent", tooltipParticipantId: null };
  const identity = presentParticipantIdentity({
    participantId: input.spawnedBy,
    participantLabels: input.participantLabels,
  });
  if (!input.spawnedBy.startsWith("outside:")) return identity;
  return identity.tooltipParticipantId === null
    ? { label: `${identity.label} (outside agent)`, tooltipParticipantId: null }
    : { label: "an outside agent", tooltipParticipantId: input.spawnedBy };
}

export function SpawnerIdentity(props: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}) {
  const identity = presentSpawnerIdentity(props);
  return identity.tooltipParticipantId === null ? (
    <>{identity.label}</>
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span />}>{identity.label}</TooltipTrigger>
      <TooltipPopup>{identity.tooltipParticipantId}</TooltipPopup>
    </Tooltip>
  );
}

/** Replaces upstream's "Sent by another agent" line above a spawn brief bubble. */
export function SpawnBriefAttribution(props: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}) {
  return (
    <p
      className="me-1 text-2xs text-muted-foreground/70"
      data-user-message-attribution="spawn-brief"
    >
      Brief from <SpawnerIdentity {...props} />
    </p>
  );
}
