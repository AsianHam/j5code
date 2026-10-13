import {
  ARTIFACT_READ_PATH,
  ArtifactReadRequest,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ArtifactProjectUnavailableError } from "./ArtifactDeletion.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

const decodeReadRequest = Schema.decodeUnknownEffect(ArtifactReadRequest);

const authenticate = Effect.fn("j5.artifacts.authenticate")(function* (
  requiredScope: AuthEnvironmentScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(requiredScope)) {
    return yield* failEnvironmentScopeRequired(requiredScope);
  }
});

const authenticateRead = authenticate(AuthOrchestrationReadScope);

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (cause: unknown) => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "ArtifactOperationError";
  const detail = cause instanceof Error ? cause.message : "Artifact operation failed.";
  const status =
    tag === "ArtifactProjectUnavailableError"
      ? 404
      : tag === "ArtifactWorkspaceError" &&
          (cause as { readonly reason?: string }).reason === "not_found"
        ? 404
        : tag === "ArtifactWorkspaceError"
          ? 409
          : 500;
  return status === 500
    ? Effect.logError("J5 artifact operation failed", { cause }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: tag, message: "Artifact operation failed." },
            { status },
          ),
        ),
      )
    : Effect.succeed(HttpServerResponse.jsonUnsafe({ error: tag, message: detail }, { status }));
};

const requireProject = Effect.fn("j5.artifacts.requireProject")(function* (
  projects: ProjectService.ProjectService["Service"],
  projectId: ProjectId,
) {
  const project = yield* projects.getById(projectId);
  if (Option.isNone(project)) {
    return yield* new ArtifactProjectUnavailableError({ projectId });
  }
});

/**
 * The authenticated read of one artifact from server-owned application storage. It stays an HTTP
 * route because an artifact can be megabytes, which upstream keeps off the RPC socket; listing
 * and deleting are RPCs (`artifactRpc.ts`).
 */
export const artifactHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projects = yield* ProjectService.ProjectService;

    const readRoute = HttpRouter.add(
      "POST",
      ARTIFACT_READ_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.artifacts.read");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeReadRequest(body.success));
        if (Result.isFailure(decoded))
          return requestFailure("A valid projectId and artifact path are required.");
        const input = decoded.success;
        const result = yield* Effect.result(
          requireProject(projects, input.projectId).pipe(
            Effect.flatMap(() =>
              artifacts.read({ projectId: input.projectId, relativePath: input.path }),
            ),
          ),
        );
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe(result.success)
          : yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );

    return readRoute;
  }),
);
