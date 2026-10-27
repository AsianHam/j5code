import { assert, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  J5_AGENT_PERSONA_WS_METHODS,
  J5_ARTIFACT_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
  LEVEL_PERMISSIONS,
} from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as AccessGate from "./AccessGate.ts";
import { PAIRED_AS_SOMEONE_ELSE, PairingIntents } from "./PairingIntents.ts";
import * as PersonAccess from "./PersonAccess.ts";
import {
  PROJECT,
  OTHER_PROJECT,
  accessLayer,
  device,
  person,
  placed,
  thread,
} from "./test-support/accessHarness.ts";

it("names the few routes a narrowed connection keeps permissions on", () => {
  assert.deepStrictEqual(AccessGate.accessHttpRule("GET", "/ws"), { kind: "open" });
  assert.strictEqual(
    AccessGate.accessHttpRule("GET", "/api/orchestration/threads/t1").kind,
    "thread",
  );
  assert.strictEqual(
    AccessGate.accessHttpRule("GET", "/api/orchestration/threads/t1/bounded").kind,
    "thread",
  );
  for (const [method, path] of [
    ["GET", "/api/orchestration/shell"],
    ["GET", "/api/projects"],
    ["GET", "/api/auth/pairing-links"],
    ["GET", "/api/orchestration/threads/t1/anything-else"],
    ["POST", "/api/orchestration/threads/t1"],
    ["POST", "/ws"],
  ] as const) {
    assert.strictEqual(AccessGate.accessHttpRule(method, path).kind, "refuse", path);
  }
});

/** A session as upstream signs one in, carried by a header the stub reads. */
type Signed = EnvironmentAuth.AuthenticatedSession;
const signedIn = new Map<string, Signed>();

const upstreamAuth = Layer.succeed(
  EnvironmentAuth.EnvironmentAuth,
  // The gate decorates these and passes the rest through untouched.
  {
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(signedIn.get(request.headers["x-test-session"] ?? "")!),
    authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(signedIn.get(request.headers["x-test-session"] ?? "")!),
    createBrowserSession: () => Effect.succeed({ paired: true }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"],
);

const testLayer = AccessGate.layerGatedEnvironmentAuth.pipe(
  Layer.provideMerge(upstreamAuth),
  Layer.provideMerge(accessLayer),
);

/** A device of a new person holding the levels given, signed in with its level's permissions. */
const signed = Effect.fn("test.signed")(function* (
  name: string,
  levels: Parameters<typeof person>[1],
  scopes: ReadonlyArray<AuthEnvironmentScope> = LEVEL_PERMISSIONS.collaborator,
) {
  const created = yield* person(name, levels);
  const issued = yield* device(created.personId, scopes);
  const session: Signed = {
    sessionId: issued.sessionId,
    subject: "one-time-token",
    method: "browser-session-cookie",
    scopes,
  };
  signedIn.set(name, session);
  return { person: created, session, token: issued.token };
});

const scopesFor = Effect.fn("test.scopesFor")(function* (who: string, method: string, url: string) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const request = {
    method,
    url,
    headers: { "x-test-session": who },
  } as unknown as HttpServerRequest.HttpServerRequest;
  return (yield* auth.authenticateHttpRequest(request)).scopes;
});

/** Runs one request through a connection's authorization and reports whether its handler ran. */
const call = Effect.fn("test.call")(function* (
  who: Signed,
  method: string,
  payload: unknown,
  handler: Effect.Effect<string> = Effect.succeed("ran"),
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(AccessGate.layerRpcAuthorization(who, RpcAuthorization.layer(who.scopes))),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome = yield* authorize(
    handler as unknown as Handler,
    { rpc: { _tag: method }, payload } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
  );
  return String(outcome);
});

it.layer(testLayer)("access gate", (it) => {
  it.effect("allows artifact cleanup only within a project Collaborator's scope", () =>
    Effect.gen(function* () {
      const { session, person: builder } = yield* signed("Artifact builder", [
        { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
      ]);
      for (const method of [
        J5_ARTIFACT_WS_METHODS.deleteArtifact,
        J5_ARTIFACT_WS_METHODS.deleteAllArtifacts,
      ]) {
        assert.strictEqual(
          yield* call(session, method, { projectId: PROJECT, path: "plan.md" }),
          "ran",
        );
        assert.match(
          yield* call(session, method, { projectId: OTHER_PROJECT, path: "plan.md" }),
          /^refused/,
        );
      }
      const { session: viewer } = yield* signed(
        "Artifact reader",
        [{ scope: { kind: "project", projectId: PROJECT }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.match(
        yield* call(viewer, J5_ARTIFACT_WS_METHODS.deleteAllArtifacts, { projectId: PROJECT }),
        /^refused/,
      );
      const access = yield* PersonAccess.PersonAccess;
      yield* access.removeLevel({
        personId: builder.personId,
        scope: { kind: "project", projectId: PROJECT },
      });
      assert.match(
        yield* call(session, J5_ARTIFACT_WS_METHODS.deleteAllArtifacts, { projectId: PROJECT }),
        /^refused/,
      );
    }),
  );

  it.effect("leaves a session that writes to the whole server alone", () =>
    Effect.gen(function* () {
      const { session } = yield* signed("Wide", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      for (const url of ["/ws", "/api/projects", "/api/orchestration/threads/thread:any"]) {
        assert.deepStrictEqual(yield* scopesFor("Wide", "GET", url), session.scopes, url);
      }
      assert.strictEqual(yield* call(session, WS_METHODS.projectsReadFile, {}), "ran");
      assert.strictEqual(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), "ran");
    }),
  );

  it.effect(
    "gives a narrowed person their thread's loads and the socket, and follows a change at once",
    () =>
      Effect.gen(function* () {
        const people = yield* PersonAccess.PersonAccess;
        const mine = yield* thread("thread:http-mine");
        yield* thread("thread:http-other");
        const { person: viewer, session } = yield* signed(
          "Thread viewer",
          [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
          LEVEL_PERMISSIONS.viewer,
        );
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", "/ws"), session.scopes);
        const own = "/api/orchestration/threads/thread%3Ahttp-mine";
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", own), session.scopes);
        for (const url of [
          "/api/orchestration/threads/thread%3Ahttp-other",
          "/api/orchestration/shell",
          "/api/projects",
        ]) {
          assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", url), [], url);
        }
        yield* people.removeLevel({
          personId: viewer.personId,
          scope: { kind: "thread", threadId: mine },
        });
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", own), []);
      }),
  );

  it.effect("holds a Viewer to reading their scope and refuses them every folder", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:rpc-viewer");
      const other = yield* thread("thread:rpc-viewer-other");
      const { session } = yield* signed(
        "Reader",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
        WS_METHODS.previewList,
      ]) {
        assert.strictEqual(yield* call(session, method, { threadId: mine }), "ran", method);
        assert.match(yield* call(session, method, { threadId: other }), /^refused/, method);
      }
      for (const method of [
        WS_METHODS.previewOpen,
        WS_METHODS.terminalOpen,
        WS_METHODS.projectsReadFile,
        WS_METHODS.projectsListIgnoredFiles,
        WS_METHODS.filesystemBrowse,
        WS_METHODS.vcsPull,
        J5_CLIENT_READ_WS_METHODS.readFleet,
        ORCHESTRATION_V2_WS_METHODS.searchThreads,
      ]) {
        assert.match(yield* call(session, method, { threadId: mine }), /^refused/, method);
      }
    }),
  );

  it.effect("lets a narrowed Collaborator open any folder and write only within their scope", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:rpc-collaborator");
      const other = yield* thread("thread:rpc-collaborator-other");
      const { session } = yield* signed("Builder", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      for (const method of [
        WS_METHODS.projectsReadFile,
        WS_METHODS.projectsListIgnoredFiles,
        WS_METHODS.vcsPull,
        WS_METHODS.filesystemBrowse,
      ]) {
        assert.strictEqual(yield* call(session, method, { cwd: "/anywhere" }), "ran", method);
      }
      // Pull request lists are the server's, and checking an Expo account needs settings.
      for (const method of [
        WS_METHODS.pullRequestsFilterOptions,
        WS_METHODS.pullRequestsChangeBreakdown,
        WS_METHODS.deviceEasAccount,
      ]) {
        assert.match(yield* call(session, method, { threadId: mine }), /^refused/, method);
      }
      assert.strictEqual(yield* call(session, WS_METHODS.terminalOpen, { threadId: mine }), "ran");
      assert.match(yield* call(session, WS_METHODS.terminalOpen, { threadId: other }), /^refused/);
      // The server's own surfaces are not theirs.
      assert.match(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), /^refused/);
      // Upstream's own check still runs: a Collaborator holds no access management.
      assert.match(yield* call(session, WS_METHODS.subscribeAuthAccess, {}), /^refused/);
    }),
  );

  it.effect("gives a server-scope Viewer the server's surfaces to read and no folders", () =>
    Effect.gen(function* () {
      const anywhere = yield* thread("thread:rpc-server-viewer");
      const { session } = yield* signed(
        "Auditor",
        [{ scope: { kind: "server" }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.strictEqual(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), "ran");
      assert.strictEqual(
        yield* call(session, ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: anywhere }),
        "ran",
      );
      assert.match(yield* call(session, WS_METHODS.projectsReadFile, {}), /^refused/);
    }),
  );

  it.effect("lets a device no one claimed do no more than connect and say whose it is", () =>
    Effect.gen(function* () {
      const anywhere = yield* thread("thread:rpc-unknown");
      const issued = yield* device(null, LEVEL_PERMISSIONS.owner, { subject: "one-time-token" });
      const session: Signed = {
        sessionId: issued.sessionId,
        subject: "one-time-token",
        method: "browser-session-cookie",
        scopes: LEVEL_PERMISSIONS.owner,
      };
      for (const method of [
        WS_METHODS.serverGetConfig,
        J5_ACCESS_WS_METHODS.getConnectionAccess,
        J5_ACCESS_WS_METHODS.listClaimablePeople,
        J5_ACCESS_WS_METHODS.claimDevice,
      ]) {
        assert.strictEqual(yield* call(session, method, {}), "ran", method);
      }
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        WS_METHODS.projectsReadFile,
        J5_ACCESS_WS_METHODS.leave,
      ]) {
        assert.match(yield* call(session, method, { threadId: anywhere }), /^refused/, method);
      }
    }),
  );

  it.effect("tells a narrowed person an agent's name only when they reach its thread", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:identity-mine");
      yield* thread("thread:identity-other");
      const { session } = yield* signed(
        "Name reader",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      const known = (id: string) => ({
        participantId: `agent:j5:a2a:thread:${id}`,
        identity: { kind: "known", displayName: `Title of ${id}`, threadId: id },
      });
      const authorize = yield* RpcScopeAuthorization.pipe(
        Effect.provide(
          AccessGate.layerRpcAuthorization(session, RpcAuthorization.layer(session.scopes)),
        ),
      );
      type Handler = Parameters<typeof authorize>[0];
      const answer = yield* authorize(
        Effect.succeed({
          entries: [known("thread:identity-mine"), known("thread:identity-other")],
        }) as unknown as Handler,
        {
          rpc: { _tag: J5_CLIENT_READ_WS_METHODS.readParticipantIdentities },
          payload: { participantIds: [] },
        } as unknown as Parameters<typeof authorize>[1],
      );
      assert.deepStrictEqual((answer as unknown as { entries: unknown }).entries, [
        known("thread:identity-mine"),
        {
          participantId: "agent:j5:a2a:thread:thread:identity-other",
          identity: { kind: "unknown" },
        },
      ]);
    }),
  );

  /** The names a connection is told, given the names the identity read answered. */
  const toldNames = Effect.fn("test.toldNames")(function* (
    session: Signed,
    named: ReadonlyArray<readonly [string, string]>,
  ) {
    const authorize = yield* RpcScopeAuthorization.pipe(
      Effect.provide(
        AccessGate.layerRpcAuthorization(session, RpcAuthorization.layer(session.scopes)),
      ),
    );
    type Handler = Parameters<typeof authorize>[0];
    const answer = yield* authorize(
      Effect.succeed({
        entries: named.map(([participantId, displayName]) => ({
          participantId,
          identity: { kind: "known", displayName },
        })),
      }) as unknown as Handler,
      {
        rpc: { _tag: J5_CLIENT_READ_WS_METHODS.readParticipantIdentities },
        payload: { participantIds: [] },
      } as unknown as Parameters<typeof authorize>[1],
    );
    const entries = (
      answer as unknown as {
        readonly entries: ReadonlyArray<{
          readonly identity: { readonly kind: string; readonly displayName?: string };
        }>;
      }
    ).entries;
    return entries.map((entry) => entry.identity.displayName ?? null);
  });

  it.effect("tells a narrowed person only the names on who reaches what they read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mine = yield* thread("thread:names-mine");
      const below = yield* thread("thread:names-below", OTHER_PROJECT, {
        parent: mine,
        relationship: "subagent",
      });
      const other = yield* thread("thread:names-other");
      yield* placed(mine, null);
      const sameThread = yield* person("Priya Names", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      const sameProject = yield* person("Ines Names", [
        { scope: { kind: "project", projectId: PROJECT }, level: "viewer" },
      ]);
      const server = yield* person("Omar Names", [{ scope: { kind: "server" }, level: "viewer" }]);
      const underneath = yield* person("Bea Names", [
        { scope: { kind: "thread", threadId: below }, level: "viewer" },
      ]);
      const elsewhere = yield* person("Sam Names", [
        { scope: { kind: "thread", threadId: other }, level: "collaborator" },
      ]);
      const otherProject = yield* person("Tove Names", [
        { scope: { kind: "project", projectId: OTHER_PROJECT }, level: "collaborator" },
      ]);
      const unshared = yield* person("Uma Names", [
        {
          scope: { kind: "project", projectId: ProjectId.make("project:names-unshared") },
          level: "collaborator",
        },
      ]);
      const stranger = yield* person("Quinn Names");
      // An agent the reader reads asking someone does not put them on its thread's list.
      yield* sql`
        INSERT INTO j5_a2a_exchange (
          project_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
          opened_seq, closed_seq, created_at, updated_at
        ) VALUES (
          ${PROJECT}, 'exchange:names-asked', ${`agent:j5:a2a:thread:${mine}`},
          ${stranger.personId}, 'open', 'Which vendor?', 'soon', 1, NULL,
          '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'
        )
      `;
      const { session, person: reader } = yield* signed(
        "Roster name reader",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.deepStrictEqual(
        yield* toldNames(session, [
          [reader.personId, "Roster name reader"],
          [sameThread.personId, "Priya Names"],
          [sameProject.personId, "Ines Names"],
          [server.personId, "Omar Names"],
          [underneath.personId, "Bea Names"],
          // Her project holds the thread beneath theirs, so she reaches it too.
          [otherProject.personId, "Tove Names"],
          [elsewhere.personId, "Sam Names"],
          [unshared.personId, "Uma Names"],
          [stranger.personId, "Quinn Names"],
        ]),
        [
          "Roster name reader",
          "Priya Names",
          "Ines Names",
          "Omar Names",
          "Bea Names",
          "Tove Names",
          null,
          null,
          null,
        ],
      );
      // Reaching a project, they are told who reaches a thread in it, and no one outside it.
      const { session: projectReader } = yield* signed(
        "Names project reader",
        [{ scope: { kind: "project", projectId: OTHER_PROJECT }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.deepStrictEqual(
        yield* toldNames(projectReader, [
          [underneath.personId, "Bea Names"],
          [otherProject.personId, "Tove Names"],
          [server.personId, "Omar Names"],
          // A thread's level reaches the threads beneath it, wherever they live.
          [sameThread.personId, "Priya Names"],
          [sameProject.personId, "Ines Names"],
          [elsewhere.personId, "Sam Names"],
        ]),
        ["Bea Names", "Tove Names", "Omar Names", "Priya Names", null, null],
      );
    }),
  );

  it.effect("stops telling a narrowed person a name once its person no longer reaches it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const access = yield* PersonAccess.PersonAccess;
      const mine = yield* thread("thread:names-revoked");
      yield* placed(mine, null);
      const revoked = yield* person("Priya Revoked", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      const removed = yield* person("Sam Removed", [
        { scope: { kind: "thread", threadId: mine }, level: "viewer" },
      ]);
      yield* sql`
        INSERT INTO j5_a2a_exchange (
          project_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
          opened_seq, closed_seq, created_at, updated_at
        ) VALUES (
          ${PROJECT}, 'exchange:names-revoked', ${`agent:j5:a2a:thread:${mine}`},
          ${revoked.personId}, 'open', 'Which vendor?', 'soon', 1, NULL,
          '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'
        )
      `;
      const { session } = yield* signed(
        "Revocation reader",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.deepStrictEqual(
        yield* toldNames(session, [
          [revoked.personId, "Priya Revoked"],
          [removed.personId, "Sam Removed"],
        ]),
        ["Priya Revoked", "Sam Removed"],
      );

      yield* access.removeLevel({
        personId: revoked.personId,
        scope: { kind: "thread", threadId: mine },
      });
      yield* access.removePerson(removed.personId);
      yield* access.setName({ personId: revoked.personId, displayName: "Priya Renamed" });
      assert.deepStrictEqual(
        yield* toldNames(session, [
          [revoked.personId, "Priya Renamed"],
          [removed.personId, "Sam Removed"],
        ]),
        [null, null],
      );
    }),
  );

  it.effect("lets a Viewer read only the resource an app in their thread was published with", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mine = yield* thread("thread:mcp-app");
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'item:weather', ${mine}, 1, 'dynamic_tool', 'completed', '2026-10-18T00:00:00.000Z',
          ${JSON.stringify({
            type: "dynamic_tool",
            toolName: "weather.get_weather",
            output: {
              t3McpApp: {
                attachmentId: "thread-1-abc-html",
                server: "weather",
                tool: "get_weather",
                resourceUri: "ui://weather/dashboard",
              },
            },
          })}
        )
      `;
      const { session } = yield* signed(
        "App watcher",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      const read = (uri: string) =>
        call(session, WS_METHODS.mcpAppsReadResource, {
          threadId: mine,
          itemId: "item:weather",
          uri,
        });
      assert.strictEqual(yield* read("ui://weather/dashboard"), "ran");
      assert.match(yield* read("ui://weather/secrets"), /^refused/);
    }),
  );

  it.effect("lets a Collaborator change only the scheduled tasks bound where they write", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mine = yield* thread("thread:scheduled-mine");
      const other = yield* thread("thread:scheduled-other");
      const task = (id: string, threadId: string) => sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, last_run_status, run_count
        ) VALUES (
          ${id}, 'Nightly', 'Run it', 1, '{}', ${PROJECT}, ${threadId}, '{}', '{}',
          'full-access', 'default', 'user', 'web', '2026-10-18T00:00:00.000Z',
          '2026-10-18T00:00:00.000Z', 'never', 0
        )
      `;
      yield* task("task:mine", mine);
      yield* task("task:other", other);
      const { session } = yield* signed("Task keeper", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      assert.strictEqual(
        yield* call(session, WS_METHODS.scheduledTasksRunNow, { id: "task:mine" }),
        "ran",
      );
      assert.match(
        yield* call(session, WS_METHODS.scheduledTasksRunNow, { id: "task:other" }),
        /^refused/,
      );
      // Moving its own task onto a thread it does not write to is refused too.
      assert.match(
        yield* call(session, WS_METHODS.scheduledTasksUpsert, {
          id: "task:mine",
          projectId: PROJECT,
          threadId: other,
        }),
        /^refused/,
      );
      assert.strictEqual(
        yield* call(session, WS_METHODS.scheduledTasksUpsert, {
          projectId: PROJECT,
          threadId: mine,
        }),
        "ran",
      );
      // A task addressed by the command that made it is the same task.
      yield* task("scheduled-task:command-other", other);
      assert.match(
        yield* call(session, WS_METHODS.scheduledTasksUpsert, {
          commandId: "command-other",
          projectId: PROJECT,
          threadId: mine,
        }),
        /^refused/,
      );
    }),
  );

  it.effect(
    "lets anyone who writes somewhere use the Playbook library, and only Owners change it",
    () =>
      Effect.gen(function* () {
        const mine = yield* thread("thread:playbook-runs");
        const playbook = { name: "release" };
        const changes = [
          [J5_PLAYBOOK_WS_METHODS.savePlaybook, { ...playbook, yaml: "title: Release" }],
          [J5_PLAYBOOK_WS_METHODS.renamePlaybook, { ...playbook, title: "Ship" }],
          [J5_PLAYBOOK_WS_METHODS.deletePlaybook, playbook],
          [J5_PLAYBOOK_WS_METHODS.setFolders, { folders: [] }],
          [J5_PLAYBOOK_WS_METHODS.readSources, {}],
        ] as const;

        const { session: writer } = yield* signed("Playbook writer", [
          { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
        ]);
        for (const [method, payload] of [
          [J5_PLAYBOOK_WS_METHODS.readLibrary, {}],
          [J5_PLAYBOOK_WS_METHODS.exportPlaybook, playbook],
          [J5_PLAYBOOK_WS_METHODS.subscribeChanges, {}],
          [J5_PLAYBOOK_WS_METHODS.listThreadRuns, { threadId: mine }],
        ] as const) {
          assert.strictEqual(yield* call(writer, method, payload), "ran", method);
        }
        // Every run on the server is the server's to show.
        assert.match(yield* call(writer, J5_PLAYBOOK_WS_METHODS.listRuns, {}), /^refused/);
        for (const [method, payload] of changes) {
          assert.match(yield* call(writer, method, payload), /^refused/, method);
        }

        const { session: watcher } = yield* signed(
          "Playbook watcher",
          [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
          LEVEL_PERMISSIONS.viewer,
        );
        assert.strictEqual(
          yield* call(watcher, J5_PLAYBOOK_WS_METHODS.listThreadRuns, { threadId: mine }),
          "ran",
        );
        for (const method of [
          J5_PLAYBOOK_WS_METHODS.readLibrary,
          J5_PLAYBOOK_WS_METHODS.subscribeChanges,
        ]) {
          assert.match(yield* call(watcher, method, {}), /^refused/, method);
        }

        // A Collaborator at server scope is held to upstream's checks alone, which an Owner's
        // permission settles.
        const { session: wide } = yield* signed("Server collaborator", [
          { scope: { kind: "server" }, level: "collaborator" },
        ]);
        assert.strictEqual(yield* call(wide, J5_PLAYBOOK_WS_METHODS.listRuns, {}), "ran");
        for (const [method, payload] of changes) {
          assert.match(yield* call(wide, method, payload), /^refused/, method);
        }
        const { session: owner } = yield* signed(
          "Playbook owner",
          [{ scope: { kind: "server" }, level: "owner" }],
          LEVEL_PERMISSIONS.owner,
        );
        for (const [method, payload] of changes) {
          assert.strictEqual(yield* call(owner, method, payload), "ran", method);
        }
      }),
  );

  it.effect("leaves changing Personas to Owners, a server-scope Collaborator included", () =>
    Effect.gen(function* () {
      const { session: wide } = yield* signed("Persona collaborator", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      const { session: owner } = yield* signed(
        "Persona owner",
        [{ scope: { kind: "server" }, level: "owner" }],
        LEVEL_PERMISSIONS.owner,
      );
      for (const method of [
        J5_AGENT_PERSONA_WS_METHODS.createAgentPersona,
        J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas,
        J5_AGENT_PERSONA_WS_METHODS.readAgentPersonaImportFiles,
        J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled,
      ]) {
        assert.match(yield* call(wide, method, {}), /^refused/, method);
        assert.strictEqual(yield* call(owner, method, {}), "ran", method);
      }
      assert.strictEqual(
        yield* call(wide, J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog, {}),
        "ran",
      );
    }),
  );

  it.effect("ends a feed already open when the person loses what it shows", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const mine = yield* thread("thread:rpc-feed");
      const { person: viewer, session } = yield* signed(
        "Watcher",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      // The feed is open, its first check passed, before the level goes.
      const open = yield* Deferred.make<void>();
      const feed = yield* Effect.forkChild(
        call(
          session,
          ORCHESTRATION_V2_WS_METHODS.subscribeThread,
          { threadId: mine },
          Deferred.succeed(open, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(open);
      yield* people.removeLevel({
        personId: viewer.personId,
        scope: { kind: "thread", threadId: mine },
      });
      assert.match(yield* Fiber.join(feed), /^refused/);
    }),
  );

  it.effect("refuses a browser paired as one person a link made for another", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const intents = yield* PairingIntents;
      const marco = yield* person("Marco");
      const { person: priya, token } = yield* signed("Priya B", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      for (const [credential, personId] of [
        ["for-marco", marco.personId],
        ["for-priya", priya.personId],
      ] as const) {
        yield* intents.record({
          pairingLinkId: credential,
          credential,
          personId,
          linkId: null,
          ceiling: null,
        });
      }
      const metadata = { deviceType: "desktop" } as const;
      const refused = yield* auth
        .createBrowserSession("for-marco", metadata, token)
        .pipe(Effect.flip);
      assert.strictEqual(
        "diagnostic" in refused ? refused.diagnostic : null,
        PAIRED_AS_SOMEONE_ELSE,
      );
      // The link is still Marco's to use.
      assert.isNotNull(yield* intents.intentOf("for-marco"));
      // Her own link, or a browser with no session, pairs as upstream has it.
      yield* auth.createBrowserSession("for-priya", metadata, token);
      yield* auth.createBrowserSession("for-marco", metadata, undefined);
    }),
  );
});
