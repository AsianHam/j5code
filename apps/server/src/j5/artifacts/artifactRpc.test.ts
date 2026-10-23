import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  J5_ARTIFACT_WS_METHODS,
  ProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { makeArtifactRpcHandlers } from "./artifactRpc.ts";
import { ArtifactListTooLargeError } from "./ArtifactWorkspace.ts";

const projectId = ProjectId.make("project:artifacts-rpc");
const missingProjectId = ProjectId.make("project:artifacts-rpc-missing");

it("requires read scope to list artifacts", () => {
  assert.equal(
    requiredScopeForRpcMethod(J5_ARTIFACT_WS_METHODS.listArtifacts),
    AuthOrchestrationReadScope,
  );
});

it("requires operate scope to delete all artifacts", () => {
  assert.equal(
    requiredScopeForRpcMethod(J5_ARTIFACT_WS_METHODS.deleteAllArtifacts),
    AuthOrchestrationOperateScope,
  );
});

it.effect("lists a project's artifacts, and refuses a project that is not available", () =>
  Effect.gen(function* () {
    const listed: Array<ProjectId> = [];
    const handlers = makeArtifactRpcHandlers({
      projects: {
        getById: (id) =>
          Effect.succeed(
            id === missingProjectId
              ? Option.none()
              : Option.some({ workspaceRoot: "/workspace" } as never),
          ),
      },
      artifacts: {
        watch: () => Effect.die("unused") as never,
        list: (requestedProjectId) =>
          Effect.sync(() => {
            listed.push(requestedProjectId);
            return [{ path: "plan.md", byteLength: 7, modifiedAt: null }];
          }),
      },
      deletion: { delete: () => Effect.die("unused"), deleteAll: () => Effect.die("unused") },
    });
    const list = handlers[J5_ARTIFACT_WS_METHODS.listArtifacts];

    assert.deepStrictEqual(yield* list({ projectId }), {
      entries: [{ path: "plan.md", byteLength: 7, modifiedAt: null }],
    });
    const refusal = yield* list({ projectId: missingProjectId }).pipe(Effect.flip);
    assert.deepStrictEqual(
      { code: refusal.code, message: refusal.message },
      {
        code: "ArtifactProjectUnavailableError",
        message: `Project ${missingProjectId} is not available.`,
      },
    );
    // Storage is never read for a project the server does not have.
    assert.deepStrictEqual(listed, [projectId]);
  }),
);

it.effect("preserves a stable size-limit refusal code for project cleanup", () =>
  Effect.gen(function* () {
    const handlers = makeArtifactRpcHandlers({
      projects: { getById: () => Effect.succeed(Option.some({ id: projectId } as never)) },
      artifacts: {
        watch: () => Effect.die("unused") as never,
        list: () => Effect.fail(new ArtifactListTooLargeError({ maximumFiles: 500 })),
      },
      deletion: { delete: () => Effect.die("unused"), deleteAll: () => Effect.die("unused") },
    });
    const error = yield* handlers[J5_ARTIFACT_WS_METHODS.listArtifacts]({ projectId }).pipe(
      Effect.flip,
    );
    assert.deepStrictEqual(
      { code: error.code, message: error.message },
      {
        code: "ArtifactListTooLargeError",
        message: "The artifacts directory is too large to browse (maximum 500 files).",
      },
    );
  }),
);
