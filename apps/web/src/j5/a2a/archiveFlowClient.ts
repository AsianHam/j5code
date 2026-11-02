import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Shared from "@t3tools/client-runtime/j5/archive-flow";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type {
  ArchivePreflight,
  LiveCrew,
  PreArchiveFacts,
} from "@t3tools/client-runtime/j5/archive-flow";

export const readParticipantIdentities = (
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) =>
  Shared.readParticipantIdentities(j5Environment, appAtomRegistry, environmentId, participantIds);

export async function readParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  return (await readParticipantIdentities(environmentId, participantIds)).labels;
}

export const readArchivePreflight = (threadRef: ScopedThreadRef) =>
  Shared.readArchivePreflight(j5Environment, appAtomRegistry, threadRef);
