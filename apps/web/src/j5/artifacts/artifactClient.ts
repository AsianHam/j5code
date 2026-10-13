import { executeJ5Request } from "@t3tools/client-runtime/j5/http";
import {
  ARTIFACT_READ_PATH,
  ArtifactContent,
  type ArtifactContent as ArtifactContentValue,
  type ArtifactEntry,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { j5Environment } from "../state";

export class ArtifactHttpError extends Schema.TaggedError<ArtifactHttpError>()(
  "ArtifactHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

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

/**
 * One artifact's content can be megabytes, so it stays an HTTP read while the list is an RPC. It
 * goes through the shared J5 request helper, which resolves the credential at request time
 * (cookie, static bearer, or relay access token with a fresh DPoP proof) and refreshes a rejected
 * relay token once. A hand-rolled bearer/DPoP branch here signed with whatever token the prepared
 * connection held at page load, so on T3 Connect the change stream kept flowing while every read
 * returned 401 once that token expired.
 */
const readArtifactEffect = Effect.fn("j5.artifacts.client.read")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}) {
  const prepared = readPreparedConnection(input.environmentId);
  if (prepared === null) {
    return yield* new ArtifactHttpError({
      status: 0,
      detail: "The project environment is not connected.",
    });
  }
  const request = yield* HttpClientRequest.post(ARTIFACT_READ_PATH).pipe(
    HttpClientRequest.bodyJson({ projectId: input.projectId, path: input.path }),
  );
  const response = yield* executeJ5Request(prepared, request, REQUEST_TIMEOUT_MS).pipe(
    Effect.mapError((error) =>
      error._tag === "J5HttpError"
        ? new ArtifactHttpError({ status: error.status, detail: error.detail })
        : new ArtifactHttpError({ status: 0, detail: String(error) }),
    ),
  );
  return yield* HttpClientResponse.schemaBodyJson(ArtifactContent)(response);
});

export const readArtifact = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}): Promise<ArtifactContentValue> => runtime.runPromise(readArtifactEffect(input));

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
