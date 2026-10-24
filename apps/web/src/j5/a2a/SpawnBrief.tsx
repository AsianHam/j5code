import { presentJ5SpawnBrief } from "@t3tools/client-runtime/j5/user-message";
import { ThreadId } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import type { ChatMessage } from "~/types";

import {
  presentParticipantIdentity,
  type ParticipantIdentityPresentation,
} from "./ParticipantIdentity";

/** A Peer Agent's first message, for the "Spawned by" divider at the top of its thread. */
export function presentSpawnBrief(message: ChatMessage) {
  const brief = presentJ5SpawnBrief(message);
  return brief === null
    ? null
    : {
        spawnedBy: brief.spawnedBy,
        spawnerThreadId:
          brief.spawnerThreadId === null ? null : ThreadId.make(brief.spawnerThreadId),
      };
}

export function participantIdsForSpawnBrief(message: ChatMessage): ReadonlyArray<string> {
  const spawnedBy = presentJ5SpawnBrief(message)?.spawnedBy ?? null;
  return spawnedBy === null ? [] : [spawnedBy];
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
