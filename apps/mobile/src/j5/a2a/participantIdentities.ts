import { readParticipantIdentities } from "@t3tools/client-runtime/j5/archive-flow";
import type { ParticipantIdentities } from "@t3tools/client-runtime/j5/participant-identity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { j5Environment } from "../state";

export const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threads: new Map() };

/**
 * One identity read for the ids on screen; unknowns stay absent and a failed read names nobody.
 * A read sent before the environment connects fails, so it waits for the connection and runs
 * again on each reconnect.
 */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ParticipantIdentities {
  const idsKey = Array.from(new Set(participantIds)).sort().join("\0");
  // A result answers one environment's ids; another environment's never stands in for it.
  const key = `${environmentId}\n${idsKey}`;
  const connected = useWorkspaceEnvironments().some(
    (environment) =>
      environment.environmentId === environmentId && environment.connectionState === "connected",
  );
  const [result, setResult] = useState({ key: "", identities: NO_IDENTITIES });
  // oxlint-disable-next-line t3code/react-effect-budget -- reads identities from the server for the ids on screen, and drops a stale answer when they change.
  useEffect(() => {
    if (idsKey === "" || !connected) return;
    let active = true;
    void readParticipantIdentities(
      j5Environment,
      appAtomRegistry,
      environmentId,
      idsKey.split("\0"),
    ).then((identities) => {
      if (active) setResult({ key, identities });
    });
    return () => {
      active = false;
    };
  }, [connected, environmentId, idsKey, key]);
  return result.key === key ? result.identities : NO_IDENTITIES;
}
