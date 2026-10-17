import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { PreArchiveFacts } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type { PreArchiveFacts, PreArchiveLiveCrew as LiveCrew } from "@t3tools/contracts/j5";

/** Unknown participants stay absent, and so does every one when the read fails. */
export async function readParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  const labels = new Map<string, string>();
  const threads = new Map<string, ScopedThreadRef>();
  if (participantIds.length === 0) return { labels, threads };
  const result = await j5Environment.readParticipantIdentities.run(appAtomRegistry, {
    environmentId,
    input: { participantIds },
  });
  if (result._tag === "Failure") return { labels, threads };
  for (const entry of result.value.entries) {
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

export async function readParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  return (await readParticipantIdentities(environmentId, participantIds)).labels;
}

export interface ArchivePreflight {
  readonly facts: PreArchiveFacts | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}

/** Facts remain useful without identity labels; literal participant ids are the honest fallback. */
export async function readArchivePreflight(threadRef: ScopedThreadRef): Promise<ArchivePreflight> {
  const result = await j5Environment.readPreArchiveFacts.run(appAtomRegistry, {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  const facts = result.value;
  if (facts.state !== "registered") return { facts, participantLabels: new Map() };
  const ids = Array.from(
    new Set([
      ...facts.openExchanges.map((exchange) => exchange.counterpartyId),
      ...(facts.placementSubtree.state === "known" ? facts.placementSubtree.participantIds : []),
      ...(facts.liveCrews ?? []).flatMap((crew) => crew.seats.map((seat) => seat.participantId)),
    ]),
  );
  return { facts, participantLabels: await readParticipantLabels(threadRef.environmentId, ids) };
}
