import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { readParticipantIdentities, readParticipantLabels } from "./archiveFlowClient";

export interface ParticipantIdentities {
  readonly labels: ReadonlyMap<string, string>;
  /** Each agent's thread, on whichever server it is: this one or a peer. */
  readonly threads: ReadonlyMap<string, ScopedThreadRef>;
}

const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threads: new Map() };

/**
 * One identity read for every J5 surface; unknowns deliberately stay absent. A read sent before
 * the environment connects fails, so the read waits for the connection and runs again on each
 * reconnect: a page load, a secondary environment, or a server restart.
 */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ParticipantIdentities {
  const idsKey = Array.from(new Set(participantIds)).sort().join("\0");
  // A result answers one environment's ids; another environment's never stands in for it.
  const key = `${environmentId}\n${idsKey}`;
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const [result, setResult] = useState({ key: "", identities: NO_IDENTITIES });
  // oxlint-disable-next-line t3code/react-effect-budget -- reads identities from the server for the ids on screen, and drops a stale answer when they change.
  useEffect(() => {
    if (idsKey === "" || !connected) return;
    const ids = idsKey.split("\0");
    let active = true;
    void readParticipantIdentities(environmentId, ids).then((next) => {
      if (active) setResult({ key, identities: next });
    });
    return () => {
      active = false;
    };
  }, [connected, environmentId, idsKey, key]);
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
  // oxlint-disable-next-line t3code/react-effect-budget -- reads labels from each server for the participants on screen, and drops a stale answer when they change.
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
