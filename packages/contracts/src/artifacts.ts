import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

export const ARTIFACT_READ_PATH = "/api/j5/artifacts/read";

export const ArtifactEntry = Schema.Struct({
  path: Schema.String,
  byteLength: NonNegativeInt,
  modifiedAt: Schema.NullOr(Schema.String),
});
export type ArtifactEntry = typeof ArtifactEntry.Type;

export const ArtifactContent = Schema.Struct({
  path: Schema.String,
  byteLength: NonNegativeInt,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
});
export type ArtifactContent = typeof ArtifactContent.Type;

export const ArtifactReadInput = Schema.Struct({
  path: Schema.String,
});
export type ArtifactReadInput = typeof ArtifactReadInput.Type;

export const ArtifactWriteInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type ArtifactWriteInput = typeof ArtifactWriteInput.Type;

export const ArtifactWriteResult = Schema.Struct({
  artifact: ArtifactEntry,
  logicalPath: Schema.String,
});
export type ArtifactWriteResult = typeof ArtifactWriteResult.Type;

export class ArtifactMcpFailure extends Schema.TaggedError<ArtifactMcpFailure>()(
  "ArtifactMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "invalid_request",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

export const ArtifactListRequest = Schema.Struct({
  projectId: ProjectId,
});
export type ArtifactListRequest = typeof ArtifactListRequest.Type;

export const ArtifactListResponse = Schema.Struct({
  entries: Schema.Array(ArtifactEntry),
});
export type ArtifactListResponse = typeof ArtifactListResponse.Type;

export const ArtifactReadRequest = Schema.Struct({
  projectId: ProjectId,
  path: Schema.String,
});
export type ArtifactReadRequest = typeof ArtifactReadRequest.Type;

export const ArtifactWatchInput = Schema.Struct({
  projectId: ProjectId,
});
export type ArtifactWatchInput = typeof ArtifactWatchInput.Type;

export const ArtifactChangeEvent = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
});
export type ArtifactChangeEvent = typeof ArtifactChangeEvent.Type;

export class ArtifactWatchError extends Schema.TaggedError<ArtifactWatchError>()(
  "ArtifactWatchError",
  {
    projectId: ProjectId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
