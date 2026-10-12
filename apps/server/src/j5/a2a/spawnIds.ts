// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for deterministic ids and digests.
import * as NodeCrypto from "node:crypto";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";

import { CommCommandId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

/**
 * Stable ids for the J5 spawn lifecycle. Every id derives from the caller's provider session and
 * request key, so a retry with the same key replays the same thread, home, placement, and brief
 * commands instead of double-acting. Crew seats qualify the key per seat.
 */
export const stablePart = (value: string) => encodeURIComponent(value);

export interface SpawnStableInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
}

export const lifecycleId = (
  input: SpawnStableInput & {
    readonly kind: "command" | "message" | "thread" | "crew" | "artifact";
    readonly operation: string;
  },
) =>
  [
    input.kind,
    "j5",
    "a2a",
    "mcp",
    stablePart(input.providerSessionId),
    stablePart(input.operation),
    stablePart(input.requestKey),
  ].join(":");

export const lifecycleCommandId = (input: SpawnStableInput & { readonly operation: string }) =>
  CommandId.make(lifecycleId({ kind: "command", ...input }));

// Thread ids become filenames (including base64 terminal history names); bound their length.
export const spawnThreadId = (input: SpawnStableInput) =>
  ThreadId.make(
    `thread:j5:a2a:${NodeCrypto.createHash("sha256")
      .update(JSON.stringify([input.providerSessionId, input.requestKey]))
      .digest("hex")}`,
  );

export const spawnCrewInstanceId = (input: SpawnStableInput) =>
  lifecycleId({ kind: "crew", operation: "spawn-crew", ...input });

/** Each seat is an ordinary spawn with a seat-qualified request key, so retries replay per seat. */
export const crewSeatRequestKey = (requestKey: string, seatName: string) =>
  `${requestKey}/seat/${seatName}`;

export const spawnMessageId = (input: SpawnStableInput) =>
  MessageId.make(lifecycleId({ kind: "message", operation: "spawn-brief", ...input }));

export const spawnHomeCommandId = (input: SpawnStableInput) =>
  CommCommandId.make(lifecycleId({ kind: "command", operation: "spawn-home", ...input }));

export const spawnPlacementCommandId = (input: SpawnStableInput) =>
  PlacementCommandId.make(lifecycleId({ kind: "command", operation: "spawn-placement", ...input }));

export const spawnTitle = (brief: string, title: string | undefined): string => {
  const value = title?.trim() || brief.trim();
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
};

/** What a seat's first turn needs to know about its Crew; instructions are content, verbatim. */
export interface CrewBriefContext {
  readonly displayName: string;
  readonly instanceId: string;
  readonly seatName: string;
  readonly seatInstructions?: string | undefined;
  readonly captainParticipantId: string;
  /** The handoff this seat's agent definition returns, and the shared artifact file it goes to. */
  readonly obligation?: { readonly kind: string; readonly path: string } | undefined;
  readonly roster: ReadonlyArray<{
    readonly seat: string;
    readonly participantId: string;
    readonly agentDisplayName: string;
  }>;
  /** The playbook the Crew follows and the steps this seat owns, with live titles. */
  readonly playbook?:
    | {
        readonly name: string;
        readonly title: string;
        readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string }>;
      }
    | undefined;
}

/** A title on one line that cannot close the block it is written into. */
const briefLine = (text: string) => text.replace(/\s+/g, " ").trim().replace(/<\//g, "<\\/");

// The web timeline parses the identity block and the trailing brief
// (apps/web/src/j5/a2a/SpawnBrief.tsx) to attribute the message to its spawner;
// keep the two in step.
export const spawnFirstTurnText = (input: {
  readonly brief: string;
  readonly participantId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly spawnedByParticipantId: string;
  /** The spawner's thread. An outside agent has none. */
  readonly spawnerThreadId?: string | undefined;
  /** Set when the spawner is an outside agent: the label its client signed in with. */
  readonly outsideAgentName?: string | undefined;
  readonly crew?: CrewBriefContext;
}) => {
  // Every line stays a `key: value` fact, which is what the web parser reads and skips.
  const spawner =
    input.outsideAgentName === undefined
      ? `spawner_thread_id: ${input.spawnerThreadId ?? ""}`
      : `spawned_by_outside_agent: ${briefLine(input.outsideAgentName) || "unnamed"}\nspawner_reply: You were started by an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.`;
  const identity = `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${input.participantId}\nproject_id: ${input.projectId}\nproject_title: ${input.projectTitle}\nspawned_by: ${input.spawnedByParticipantId}\n${spawner}\n</j5_spawn_context>`;
  const brief = `<spawner_brief>\n${input.brief}\n</spawner_brief>`;
  if (input.crew === undefined) return `${identity}\n\n${brief}`;
  const crew = input.crew;
  // Roster and identity are measured platform facts; wiring text is the user's content, verbatim.
  const roster = crew.roster
    .map(
      (member) =>
        `- ${member.seat}${member.seat === crew.seatName ? " (you)" : ""}: participant_id=${member.participantId} persona=${member.agentDisplayName}`,
    )
    .join("\n");
  const crewContext = `<j5_crew_context>\nPlatform-provided crew facts:\ncrew: ${crew.displayName}\ncrew_instance_id: ${crew.instanceId}\nyour_seat: ${crew.seatName}\ncaptain_participant_id: ${crew.captainParticipantId}\nroster:\n${roster}\n</j5_crew_context>`;
  const seatInstructions =
    crew.seatInstructions === undefined
      ? []
      : [`<seat_instructions>\n${crew.seatInstructions}\n</seat_instructions>`];
  const collaboration = `<crew_collaboration>\nResolve current participants with j5_list_participants and use j5_send_message to coordinate directly with your Captain and other members. Share useful findings, evidence, questions, and blockers immediately; do not wait for an artifact or coordination approval. Send your Captain your final result, supporting evidence, and any remaining blockers before finishing. If the roster lacks expertise needed to address a concern, tell your Captain what is missing and why so they can j5_request_crew_member through the user's inbox. Continue already-approved work and coordination while an addition is pending. A direct result is sufficient unless the user or your persona explicitly requires an artifact.\n</crew_collaboration>`;
  // A persona's declared deliverable supplements the conversation; it never gates coordination.
  const obligation =
    crew.obligation === undefined
      ? []
      : [
          `<seat_obligation>\nYour agent definition returns a ${crew.obligation.kind}. Before you finish, write it with j5_write_artifact to exactly \`${crew.obligation.path}\` as Markdown (your instructions list the required contents); this is in addition to direct messages and must not delay sharing findings or results. Your Captain is told when the file appears; rewrite the same path to revise it.\n</seat_obligation>`,
        ];
  const playbook =
    crew.playbook === undefined
      ? []
      : [
          `<seat_playbook>\nplaybook: ${crew.playbook.name} (${briefLine(crew.playbook.title)})\nyour_steps:${
            crew.playbook.steps.length === 0
              ? " none"
              : crew.playbook.steps
                  .map((step) => `\n- ${briefLine(step.id)}: ${briefLine(step.title)}`)
                  .join("")
          }\n</seat_playbook>\nThe Captain runs this playbook and hands you each of your steps when the run reaches it. Wait for that hand-off before starting a step, and report back with j5_send_message when it's done.`,
        ];
  // The web parser needs the crew context first and the brief last, so the playbook sits between.
  return [
    identity,
    crewContext,
    ...playbook,
    collaboration,
    ...seatInstructions,
    ...obligation,
    brief,
  ].join("\n\n");
};
