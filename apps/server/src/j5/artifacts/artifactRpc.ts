import {
  ArtifactWatchError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  J5_ARTIFACT_WS_METHODS,
  type ArtifactDeleteRequest,
  type ArtifactListRequest,
  type ArtifactWatchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ProjectService from "../../project/ProjectService.ts";
import { failAsJ5ActionError } from "../rpcActionError.ts";
import { ArtifactProjectUnavailableError, type ArtifactDeletion } from "./ArtifactDeletion.ts";
import type { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

const METHODS = J5_ARTIFACT_WS_METHODS;

/** Spread into upstream's scope table beside the persona scopes; every J5 RPC names its scope here. */
export const ARTIFACT_RPC_SCOPES = {
  [METHODS.subscribeArtifactChanges]: AuthOrchestrationReadScope,
  [METHODS.listArtifacts]: AuthOrchestrationReadScope,
  [METHODS.deleteArtifact]: AuthOrchestrationOperateScope,
} as const;

/**
 * The artifact change stream: a first event on subscribe so the client knows the watch is live,
 * then one event per debounced filesystem change with a monotonic revision; the list that
 * stream refreshes; and the permanent delete. Reading one artifact is an HTTP route
 * (`ArtifactHttp.ts`). The handlers are built here and served beside the persona RPCs (`wsRpc.ts`).
 */
export function makeArtifactRpcHandlers(input: {
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getById">;
  readonly artifacts: Pick<ArtifactWorkspace["Service"], "watch" | "list">;
  readonly deletion: ArtifactDeletion["Service"];
}) {
  return {
    [METHODS.listArtifacts]: (request: ArtifactListRequest) =>
      input.projects.getById(request.projectId).pipe(
        Effect.filterOrFail(
          Option.isSome,
          () => new ArtifactProjectUnavailableError({ projectId: request.projectId }),
        ),
        Effect.andThen(input.artifacts.list(request.projectId)),
        Effect.map((entries) => ({ entries })),
        Effect.catch(
          failAsJ5ActionError({
            refusals: ["ArtifactProjectUnavailableError", "ArtifactWorkspaceError"],
            failed: "Artifact operation failed.",
          }),
        ),
      ),
    [METHODS.deleteArtifact]: (request: ArtifactDeleteRequest) =>
      input.deletion.delete(request).pipe(
        Effect.as({ deleted: true as const }),
        Effect.catch(
          failAsJ5ActionError({
            refusals: ["ArtifactProjectUnavailableError", "ArtifactWorkspaceError"],
            failed: "Artifact operation failed.",
          }),
        ),
      ),
    [METHODS.subscribeArtifactChanges]: (request: ArtifactWatchInput) =>
      Stream.unwrap(
        input.projects.getById(request.projectId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ArtifactWatchError({
                    projectId: request.projectId,
                    detail: `Project ${request.projectId} is not available.`,
                  }),
                ),
              onSome: () =>
                Effect.succeed(
                  Stream.merge(
                    Stream.make({ projectId: request.projectId, revision: 0 }),
                    input.artifacts.watch(request.projectId).pipe(
                      Stream.mapError(
                        (cause) =>
                          new ArtifactWatchError({
                            projectId: request.projectId,
                            detail: cause.message,
                          }),
                      ),
                      Stream.mapAccum(
                        () => 0,
                        (revision) => {
                          const nextRevision = revision + 1;
                          return [
                            nextRevision,
                            [{ projectId: request.projectId, revision: nextRevision }],
                          ] as const;
                        },
                      ),
                    ),
                  ),
                ),
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ArtifactWatchError({ projectId: request.projectId, detail: cause.message }),
          ),
        ),
      ),
  };
}
