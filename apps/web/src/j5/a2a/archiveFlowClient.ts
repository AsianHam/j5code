import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { PreArchiveFacts } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type { PreArchiveFacts, PreArchiveLiveCrew as LiveCrew } from "@t3tools/contracts/j5";

/** Unknown participants stay absent, and so does every one when the read fails. */
export async function readParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  const labels = new Map<string, string>();
  if (participantIds.length === 0) return labels;
  const result = await j5Environment.readParticipantIdentities.run(appAtomRegistry, {
    environmentId,
    input: { participantIds },
  });
  if (result._tag === "Failure") return labels;
  for (const entry of result.value.entries)
    if (entry.identity.kind === "known")
      labels.set(entry.participantId, entry.identity.displayName);
  return labels;
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
