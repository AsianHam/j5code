import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../../project/ProjectService.ts";
import { AgentHandoffArtifactDelete } from "../agents/agentHandoffArtifactDelete.ts";
import {
  ArtifactWorkspace,
  type ArtifactWorkspaceError,
  type ArtifactListTooLargeError,
} from "./ArtifactWorkspace.ts";

export class ArtifactProjectUnavailableError extends Schema.TaggedError<ArtifactProjectUnavailableError>()(
  "ArtifactProjectUnavailableError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not available.`;
  }
}

/**
 * The person's permanent artifact deletion. A saved-agent handoff that pointed at a deleted file is
 * marked missing afterwards; that step is best-effort, because the file is already gone and
 * cannot be put back.
 */
export class ArtifactDeletion extends Context.Service<
  ArtifactDeletion,
  {
    readonly delete: (input: {
      readonly projectId: ProjectId;
      readonly path: string;
    }) => Effect.Effect<
      void,
      | ArtifactProjectUnavailableError
      | ArtifactWorkspaceError
      | ProjectService.ProjectOperationError
    >;
    readonly deleteAll: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      void,
      | ArtifactProjectUnavailableError
      | ArtifactWorkspaceError
      | ArtifactListTooLargeError
      | ProjectService.ProjectOperationError
    >;
  }
>()("t3/j5/artifacts/ArtifactDeletion") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const artifacts = yield* ArtifactWorkspace;
  const handoffs = yield* AgentHandoffArtifactDelete;

  const deleteArtifact = Effect.fn("j5.artifacts.deleteFile")(function* ({
    projectId,
    path,
  }: {
    readonly projectId: ProjectId;
    readonly path: string;
  }) {
    const deleted = yield* artifacts.delete({ projectId, relativePath: path });
    yield* handoffs.reconcile({ projectId, path: deleted }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Deleted artifact handoff state could not be reconciled", {
          cause,
          projectId,
          path,
        }),
      ),
    );
  });

  return ArtifactDeletion.of({
    delete: Effect.fn("j5.artifacts.delete")(function* (input) {
      if (Option.isNone(yield* projects.getById(input.projectId))) {
        return yield* new ArtifactProjectUnavailableError({ projectId: input.projectId });
      }
      yield* deleteArtifact(input);
    }),
    deleteAll: Effect.fn("j5.artifacts.deleteAll")(function* ({ projectId }) {
      if (Option.isNone(yield* projects.getById(projectId))) {
        return yield* new ArtifactProjectUnavailableError({ projectId });
      }
      // The browser list is capped; deleting a project must include files beyond that cap.
      const entries = yield* artifacts.list(projectId, { all: true });
      for (const entry of entries) {
        yield* deleteArtifact({ projectId, path: entry.path });
      }
    }),
  });
});

export const layer = Layer.effect(ArtifactDeletion, make);
