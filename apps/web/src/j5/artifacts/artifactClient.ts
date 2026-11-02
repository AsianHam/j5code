import * as Shared from "@t3tools/client-runtime/j5/artifacts";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { j5Environment } from "../state";

export async function listArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<ReadonlyArray<ArtifactEntry>> {
  const result = await j5Environment.listArtifacts.run(appAtomRegistry, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value.entries;
}

export const readArtifact = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}): Promise<ArtifactContent> =>
  runtime.runPromise(Shared.readArtifact(readPreparedConnection(input.environmentId), input));

/** Permanently delete one artifact on the environment that holds the project. */
export async function deleteArtifact(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}): Promise<void> {
  const result = await j5Environment.deleteArtifact.run(appAtomRegistry, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId, path: input.path },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}

/** Permanently delete all artifacts on the environment that holds the project. */
export async function deleteAllArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<void> {
  const result = await j5Environment.deleteAllArtifacts.run(appAtomRegistry, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}
