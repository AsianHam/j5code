import * as Shared from "@t3tools/client-runtime/j5/artifacts";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
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
  runtime.runPromise(
    Shared.readArtifact(
      Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      ),
      input,
    ),
  );
