import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ARTIFACT_READ_PATH,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  J5_ARTIFACT_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
} from "@t3tools/contracts";
import { J5_CLIENT_READ_WS_METHODS } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServer } from "effect/http";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import * as ArtifactWorkspace from "../artifacts/ArtifactWorkspace.ts";
import * as GuestGate from "./GuestGate.ts";
import * as GuestPairing from "./GuestPairing.ts";
import * as PersonAccess from "./PersonAccess.ts";

/**
 * A project guest and the project's artifacts (Shared server AC9, issue #578), through the real
 * artifact routes, the real artifact folder and the real gate. Only upstream's sign-in is stood
 * in for: which session a request carries is read from a header, the way a credential would be.
 */

const AT = "2026-10-12T00:00:00.000Z";
const GRANTED = ProjectId.make("project:website-redesign");
const OTHER = ProjectId.make("project:billing-migration");
const SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

const session = (id: string, subject: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  method: "browser-session-cookie",
  scopes: SCOPES,
});
const SESSIONS = {
  member: session("session:member", "one-time-token"),
  // Holds a grant on the project as a whole.
  "project-guest": session("session:project-guest", PersonAccess.GUEST_SESSION_SUBJECT),
  // Holds a grant on one thread of the same project, and so none of its artifacts.
  "thread-guest": session("session:thread-guest", PersonAccess.GUEST_SESSION_SUBJECT),
  // Marked as a guest's, with no person recorded.
  stray: session("session:stray", PersonAccess.GUEST_SESSION_SUBJECT),
} as const;
type Who = keyof typeof SESSIONS;

const upstreamAuth = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed(SESSIONS[request.headers["x-test-session"] as Who]),
  authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed(SESSIONS[request.headers["x-test-session"] as Who]),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));

const testLayer = Layer.mergeAll(
  GuestGate.gateEnvironmentAuth(
    upstreamAuth.pipe(Layer.provideMerge(GuestPairing.layer), Layer.provideMerge(database)),
  ),
  ArtifactWorkspace.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-guest-artifacts-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const projects = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" } as never)),
});

/** Both projects with one artifact each, and the two guests with their grants. */
const seeded = Effect.fn("test.seeded")(function* () {
  const access = yield* PersonAccess.PersonAccess;
  const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
  const sql = yield* SqlClient.SqlClient;
  yield* artifacts.exportPlan({ projectId: GRANTED, markdown: "# Redesign plan" });
  yield* artifacts.exportPlan({ projectId: OTHER, markdown: "# Billing plan" });
  const threadId = ThreadId.make("thread:redesign-one");
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${threadId}, ${GRANTED}, 'One', 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, '{}'
    )
  `;
  const projectGuest = yield* access.createGuest({ displayName: "Project guest" });
  yield* access.bindSession({
    sessionId: SESSIONS["project-guest"].sessionId,
    personId: projectGuest.personId,
  });
  yield* access.putGrant({
    personId: projectGuest.personId,
    target: { kind: "project", projectId: GRANTED },
    level: "view",
  });
  const threadGuest = yield* access.createGuest({ displayName: "Thread guest" });
  yield* access.bindSession({
    sessionId: SESSIONS["thread-guest"].sessionId,
    personId: threadGuest.personId,
  });
  // Collaborate, the higher level: a thread grant gives no artifacts at any level.
  yield* access.putGrant({
    personId: threadGuest.personId,
    target: { kind: "thread", threadId },
    level: "collaborate",
  });
  return { projectGuest };
});

it("names the artifact read as the only request a guest may POST", () => {
  assert.deepStrictEqual(GuestGate.guestHttpRule("POST", ARTIFACT_READ_PATH), {
    kind: "projectInBody",
  });
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    assert.deepStrictEqual(
      GuestGate.guestHttpRule(method, ARTIFACT_READ_PATH),
      { kind: "refuse" },
      method,
    );
  }
  for (const path of [
    "/api/j5/artifacts",
    // The list was a route here before it became a request on the socket.
    "/api/j5/artifacts/list",
    "/api/j5/artifacts/delete",
    "/api/j5/artifacts/write",
    `${ARTIFACT_READ_PATH}/`,
    `${ARTIFACT_READ_PATH}/../list`,
    "/api/j5/inbox",
  ]) {
    assert.deepStrictEqual(GuestGate.guestHttpRule("POST", path), { kind: "refuse" }, path);
  }
});

it.layer(testLayer)("a project guest and the project's artifacts", (it) => {
  it.effect("reads the granted project's artifacts over HTTP, and no one else's", () =>
    Effect.gen(function* () {
      const { projectGuest } = yield* seeded();
      const access = yield* PersonAccess.PersonAccess;
      const context = yield* Effect.context<
        EnvironmentAuth.EnvironmentAuth | ArtifactWorkspace.ArtifactWorkspace
      >();
      const { dispose, handler } = HttpRouter.toWebHandler(
        artifactHttpRouteLayer.pipe(
          Layer.provide(projects),
          Layer.provideMerge(Layer.succeedContext(context)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const post = (who: Who, path: string, body: string) =>
        Effect.promise(() =>
          handler(
            new Request(`http://environment.test${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-test-session": who },
              body,
            }),
          ),
        );
      const read = (who: Who, projectId: unknown, path: string) =>
        post(who, ARTIFACT_READ_PATH, JSON.stringify({ projectId, path }));
      const body = (response: Response) => Effect.promise(() => response.json());

      // The route reads the same body the gate did.
      const opened = yield* read("project-guest", GRANTED, "plan.md");
      assert.strictEqual(opened.status, 200);
      assert.strictEqual(
        ((yield* body(opened)) as { content: string }).content,
        "# Redesign plan\n",
      );

      // Another project's artifacts.
      assert.strictEqual((yield* read("project-guest", OTHER, "plan.md")).status, 403);
      // A guest of one thread in the same project, at the higher level.
      assert.strictEqual((yield* read("thread-guest", GRANTED, "plan.md")).status, 403);
      // A guest's session with no person recorded.
      assert.strictEqual((yield* read("stray", GRANTED, "plan.md")).status, 403);
      // A body that names no project, or is not JSON, is refused before the route decodes it.
      for (const raw of ["{}", "[]", "null", '"project:website-redesign"', "not json", ""]) {
        assert.strictEqual((yield* post("project-guest", ARTIFACT_READ_PATH, raw)).status, 403);
      }
      for (const projectId of [null, 7, "", [GRANTED], { id: GRANTED }]) {
        assert.strictEqual((yield* read("project-guest", projectId, "plan.md")).status, 403);
      }

      // A path that leaves the granted project's artifact folder reaches no other file: not the
      // other project's plan beside it, and nothing on the host.
      const otherFolder = ArtifactWorkspace.artifactProjectDirectoryName(OTHER);
      for (const path of [
        `../${otherFolder}/plan.md`,
        `../../${ArtifactWorkspace.ARTIFACT_DIRECTORY_NAME}/${otherFolder}/plan.md`,
        "../../../../../../../../etc/passwd",
        "/etc/passwd",
        "..",
        "plan.md/../../" + otherFolder + "/plan.md",
      ]) {
        const escaped = yield* read("project-guest", GRANTED, path);
        assert.notStrictEqual(escaped.status, 200, path);
        assert.notInclude(JSON.stringify(yield* body(escaped)), "Billing plan", path);
      }

      // A member's connection is not looked up, and reads both.
      assert.strictEqual((yield* read("member", OTHER, "plan.md")).status, 200);

      // Removing the grant ends it for the next request.
      yield* access.removeGrant({
        personId: projectGuest.personId,
        target: { kind: "project", projectId: GRANTED },
      });
      assert.strictEqual((yield* read("project-guest", GRANTED, "plan.md")).status, 403);
    }).pipe(Effect.scoped),
  );
});

/** Runs one request through a connection's authorization, as the RPC server does. */
const authorized = Effect.fn("test.authorized")(function* (
  who: Who,
  method: string,
  payload: unknown,
  handler: Effect.Effect<string> = Effect.succeed("ran"),
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(
      GuestGate.layerRpcAuthorization(SESSIONS[who], RpcAuthorization.layer(SESSIONS[who].scopes)),
    ),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome = yield* authorize(
    handler as unknown as Handler,
    {
      rpc: { _tag: method },
      payload,
    } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
    Effect.scoped,
  );
  return String(outcome);
});

it.layer(testLayer)("a project guest and the artifact requests on the socket", (it) => {
  it.effect(
    "lists and is told of changes to the granted project's artifacts only, and deletes none",
    () =>
      Effect.gen(function* () {
        const { projectGuest } = yield* seeded();
        const access = yield* PersonAccess.PersonAccess;
        const watch = J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges;
        const remove = J5_ARTIFACT_WS_METHODS.deleteArtifact;

        for (const method of [J5_ARTIFACT_WS_METHODS.listArtifacts, watch]) {
          assert.strictEqual(
            yield* authorized("project-guest", method, { projectId: GRANTED }),
            "ran",
            method,
          );
          for (const [who, payload] of [
            ["project-guest", { projectId: OTHER }],
            ["project-guest", {}],
            ["project-guest", { projectId: "" }],
            ["project-guest", { projectId: 7 }],
            ["project-guest", { projectId: [GRANTED] }],
            // The project is named where a thread would be.
            ["project-guest", { threadId: GRANTED }],
            // A guest of one thread in the same project, at the higher level.
            ["thread-guest", { projectId: GRANTED }],
            ["stray", { projectId: GRANTED }],
          ] as const) {
            assert.match(
              yield* authorized(who, method, payload),
              /^refused: /,
              `${method} ${JSON.stringify(payload)}`,
            );
          }
          assert.strictEqual(yield* authorized("member", method, { projectId: OTHER }), "ran");
        }
        // Deleting is not listed for a guest, whatever it holds on the project.
        for (const who of ["project-guest", "thread-guest", "stray"] as const) {
          assert.match(
            yield* authorized(who, remove, { projectId: GRANTED, path: "plan.md" }),
            /^refused: /,
            who,
          );
        }
        assert.strictEqual(
          yield* authorized("member", remove, { projectId: OTHER, path: "plan.md" }),
          "ran",
        );

        // An open change feed ends when the grant on its project is removed.
        const open = yield* authorized(
          "project-guest",
          watch,
          { projectId: GRANTED },
          Effect.never,
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* access.removeGrant({
          personId: projectGuest.personId,
          target: { kind: "project", projectId: GRANTED },
        });
        assert.strictEqual(
          yield* Fiber.join(open),
          "refused: This is not shared with you on this server.",
        );
        // And the list is refused from the next request.
        assert.match(
          yield* authorized("project-guest", J5_ARTIFACT_WS_METHODS.listArtifacts, {
            projectId: GRANTED,
          }),
          /^refused: /,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("is refused every J5 client read and the stream that says they changed", () =>
    Effect.gen(function* () {
      // Whatever a guest holds: none of these is listed, so each is refused by default.
      for (const method of Object.values(J5_CLIENT_READ_WS_METHODS)) {
        assert.isUndefined((GuestGate.GUEST_RPC_RULES as Record<string, unknown>)[method], method);
        for (const who of ["project-guest", "thread-guest", "stray"] as const) {
          assert.match(
            yield* authorized(who, method, { projectId: GRANTED }),
            /^refused: /,
            `${who} ${method}`,
          );
        }
      }
    }).pipe(Effect.scoped),
  );
});
