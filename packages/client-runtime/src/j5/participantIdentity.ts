import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ParticipantIdentitiesResponse } from "@t3tools/contracts/j5";

import { scopeThreadRef } from "../environment/scoped.ts";
import { parseJ5AgentEnvelope, type J5UserMessagePresentation } from "./userMessagePresentation.ts";

export interface ParticipantIdentities {
  readonly labels: ReadonlyMap<string, string>;
  /** Each agent's thread, on whichever server it is: this one or a peer. */
  readonly threads: ReadonlyMap<string, ScopedThreadRef>;
}

/** The identity read's answer for one environment; unknowns deliberately stay absent. */
export function participantIdentitiesFromResponse(
  environmentId: EnvironmentId,
  response: ParticipantIdentitiesResponse,
): ParticipantIdentities {
  const labels = new Map<string, string>();
  const threads = new Map<string, ScopedThreadRef>();
  for (const entry of response.entries) {
    const identity = entry.identity;
    if (identity.kind !== "known") continue;
    labels.set(entry.participantId, identity.displayName);
    if (identity.threadId === undefined) continue;
    const home =
      identity.threadEnvironmentId === undefined
        ? environmentId
        : EnvironmentId.make(identity.threadEnvironmentId);
    threads.set(entry.participantId, scopeThreadRef(home, ThreadId.make(identity.threadId)));
  }
  return { labels, threads };
}

export interface ParticipantIdentityPresentation {
  readonly label: string;
  readonly tooltipParticipantId: string | null;
}

/** Archive established the truthful fallback: names when known, otherwise an explicit unnamed label. */
export function presentParticipantIdentity(input: {
  readonly participantId: string;
  readonly participantLabels: ReadonlyMap<string, string>;
  readonly annotateHumanInbox?: boolean;
}): ParticipantIdentityPresentation {
  const label = input.participantLabels.get(input.participantId);
  if (label === undefined) {
    return { label: "Unnamed participant", tooltipParticipantId: input.participantId };
  }
  return {
    label:
      input.annotateHumanInbox && input.participantId.startsWith("human:")
        ? `${label} (inbox)`
        : label,
    tooltipParticipantId: null,
  };
}

/** A queued delivery's row in "Up next": `From <sender>: <first line>`. Null for anything else. */
export function formatJ5QueuedDelivery(
  text: string,
  participantLabels: ReadonlyMap<string, string>,
): { readonly label: string; readonly tooltipParticipantId: string | null } | null {
  const envelope = parseJ5AgentEnvelope(text);
  if (envelope === null) return null;
  const sender = presentParticipantIdentity({
    participantId: envelope.senderId,
    participantLabels,
  });
  const firstLine = envelope.letter.split("\n")[0]?.trim() ?? "";
  return {
    label: `From ${sender.label}: ${firstLine || "Message content unavailable"}`,
    tooltipParticipantId: sender.tooltipParticipantId,
  };
}

export function participantIdsForJ5Envelope(text: string): ReadonlyArray<string> {
  const envelope = parseJ5AgentEnvelope(text);
  return envelope === null ? [] : [envelope.senderId];
}

/**
 * The thread a message's sender works in, if any: the identity read's answer for a participant,
 * else the thread the message or brief names on this server. Whether the reader can open it is
 * the client's own thread list's to say.
 */
export function j5SenderThreadRef(input: {
  readonly environmentId: EnvironmentId;
  readonly presentation: J5UserMessagePresentation | null;
  readonly messageSenderThreadId: string | undefined;
  readonly participantThreads: ReadonlyMap<string, ScopedThreadRef>;
}): ScopedThreadRef | null {
  const j5 = input.presentation;
  const senderId = j5?.group === "participant" || j5?.group === "other-person" ? j5.senderId : null;
  const localThreadId =
    input.messageSenderThreadId ?? (j5?.group === "participant" ? j5.senderThreadId : null);
  return (
    (senderId === null ? undefined : input.participantThreads.get(senderId)) ??
    (localThreadId ? scopeThreadRef(input.environmentId, ThreadId.make(localThreadId)) : null)
  );
}

/**
 * The name above a message from someone other than the reader: the participant's label, else
 * the sender thread's title, else "Agent"; for another person, the name they sent with. Null for
 * the reader's own message.
 */
export function j5MessageAuthorName(input: {
  readonly presentation: J5UserMessagePresentation | null;
  readonly participantLabels: ReadonlyMap<string, string>;
  readonly senderThreadTitle: string | undefined;
}): string | null {
  const j5 = input.presentation;
  if (j5?.group === "participant") {
    const label = j5.senderId === null ? undefined : input.participantLabels.get(j5.senderId);
    return label || input.senderThreadTitle?.trim() || "Agent";
  }
  if (j5?.group === "other-person") {
    return j5.senderName ?? input.participantLabels.get(j5.senderId) ?? "Someone without a name";
  }
  return null;
}
