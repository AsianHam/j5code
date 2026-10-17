import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readParticipantIdentities, readParticipantLabels } from "./archiveFlowClient";

export interface ParticipantIdentities {
  readonly labels: ReadonlyMap<string, string>;
  /** Each agent's thread, on whichever server it is: this one or a peer. */
  readonly threads: ReadonlyMap<string, ScopedThreadRef>;
}

const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threads: new Map() };

/** One identity read for every J5 surface; unknowns deliberately stay absent. */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ParticipantIdentities {
  const idsKey = Array.from(new Set(participantIds)).sort().join("\0");
  // A result answers one environment's ids; another environment's never stands in for it.
  const key = `${environmentId}\n${idsKey}`;
  const [result, setResult] = useState({ key: "", identities: NO_IDENTITIES });
  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split("\0");
    if (ids.length === 0) {
      setResult({ key, identities: NO_IDENTITIES });
      return;
    }
    let active = true;
    void readParticipantIdentities(environmentId, ids).then((next) => {
      if (active) setResult({ key, identities: next });
    });
    return () => {
      active = false;
    };
  }, [environmentId, idsKey, key]);
  return result.key === key ? result.identities : NO_IDENTITIES;
}

export function useParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  return useParticipantIdentities(environmentId, participantIds).labels;
}

export interface ScopedParticipantRef {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
  readonly connected: boolean;
}

/**
 * Labels for participants spread across environments, such as a merged inbox. Each environment
 * resolves its own participants once it is connected, so saved items shown while offline pick up
 * names on reconnect. Previous labels stay visible while a changed set reloads.
 */
export function useScopedParticipantLabels(refs: ReadonlyArray<ScopedParticipantRef>) {
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
      Array.from(
        byEnvironment,
        async ([environmentId, ids]) =>
          [environmentId, await readParticipantLabels(environmentId, ids)] as const,
      ),
    ).then((entries) => {
      if (active) setLabels((current) => new Map([...current, ...entries]));
    });
    return () => {
      active = false;
    };
  }, [key]);
  return labels;
}
