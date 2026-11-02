import { readParticipantIdentities } from "@t3tools/client-runtime/j5/archive-flow";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { j5Environment } from "../state";

export interface ScopedParticipantRef {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
  readonly connected: boolean;
}

/**
 * Names for senders spread across servers, as web's merged inbox reads them: each connected
 * server names its own senders once, so saved items shown while offline pick up names on
 * reconnect. Earlier names stay shown while a changed set reloads.
 */
export function useScopedParticipantLabels(
  refs: ReadonlyArray<ScopedParticipantRef>,
): ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>> {
  const key = Array.from(
    new Set(
      refs
        .filter((ref) => ref.connected)
        .map((ref) => JSON.stringify([ref.environmentId, ref.participantId])),
    ),
  )
    .sort()
    .join("\n");
  const [labels, setLabels] = useState<ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>>(
    () => new Map(),
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- reads names from each server for the senders on screen, and drops a stale answer when they change.
  useEffect(() => {
    const byEnvironment = new Map<EnvironmentId, Array<string>>();
    for (const entry of key === "" ? [] : key.split("\n")) {
      const [environmentId, participantId] = JSON.parse(entry) as [EnvironmentId, string];
      byEnvironment.set(environmentId, [
        ...(byEnvironment.get(environmentId) ?? []),
        participantId,
      ]);
    }
    let active = true;
    void Promise.all(
      Array.from(byEnvironment, async ([environmentId, ids]) => {
        const identities = await readParticipantIdentities(
          j5Environment,
          appAtomRegistry,
          environmentId,
          ids,
        );
        return [environmentId, identities.labels] as const;
      }),
    ).then((entries) => {
      if (active) setLabels((current) => new Map([...current, ...entries]));
    });
    return () => {
      active = false;
    };
  }, [key]);
  return labels;
}
