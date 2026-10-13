import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  ArtifactChangeEvent,
  ArtifactListRequest,
  ArtifactListResponse,
  ArtifactWatchError,
  ArtifactWatchInput,
} from "../artifacts.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProjectId } from "../baseSchemas.ts";
import { J5ActionError } from "./actionError.ts";

export const ArtifactDeleteRequest = Schema.Struct({
  projectId: ProjectId,
  path: Schema.String,
});
export type ArtifactDeleteRequest = typeof ArtifactDeleteRequest.Type;

export const ArtifactDeleteResponse = Schema.Struct({
  deleted: Schema.Literal(true),
});
export type ArtifactDeleteResponse = typeof ArtifactDeleteResponse.Type;

/**
 * The J5 artifact WebSocket surface: the stream that tells a client a project's artifacts
 * directory changed, the list, and the permanent delete. Reading one artifact stays an HTTP route
 * (`ARTIFACT_READ_PATH`): its content can be megabytes, which upstream keeps off the socket. Lives in its own group, merged into the upstream group in one place, so
 * upstream's method table and RPC list stay untouched.
 */
export const J5_ARTIFACT_WS_METHODS = {
  subscribeArtifactChanges: "j5.artifacts.subscribeChanges",
  listArtifacts: "j5.artifacts.list",
  deleteArtifact: "j5.artifacts.delete",
} as const;

export const WsJ5SubscribeArtifactChangesRpc = Rpc.make(
  J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges,
  {
    payload: ArtifactWatchInput,
    success: ArtifactChangeEvent,
    error: Schema.Union([ArtifactWatchError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const J5ArtifactRpcGroup = RpcGroup.make(
  WsJ5SubscribeArtifactChangesRpc,
  Rpc.make(J5_ARTIFACT_WS_METHODS.listArtifacts, {
    payload: ArtifactListRequest,
    success: ArtifactListResponse,
    error: Schema.Union([J5ActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_ARTIFACT_WS_METHODS.deleteArtifact, {
    payload: ArtifactDeleteRequest,
    success: ArtifactDeleteResponse,
    error: Schema.Union([J5ActionError, EnvironmentAuthorizationError]),
  }),
);
