import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServer } from "effect/http";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as AccessGate from "./AccessGate.ts";
import { accessLayer } from "./test-support/accessHarness.ts";
import {
  GUEST_PROJECT_ICON_ROUTE_PREFIX,
  guestIconPath,
  guestProjectIconRouteLayer,
} from "./GuestProjectIcons.ts";
import * as PersonAccess from "./PersonAccess.ts";

/**
 * A guest and a project's favicon, through the real gate, upstream's real favicon resolution and
 * asset serving, real files and a real database. Only upstream's sign-in is stood in for.
 */

const AT = "2026-10-12T00:00:00.000Z";
const SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
const session = (id: string, subject: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  method: "browser-session-cookie",
  scopes: SCOPES,
});
const MEMBER = session("session:member", "administrative-bootstrap");
const GUEST = session("session:guest", "one-time-token");
const STRAY = session("session:stray", "one-time-token");

const upstreamAuth = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (_request: HttpServerRequest.HttpServerRequest) => Effect.succeed(GUEST),
  authenticateWebSocketUpgrade: (_request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed(GUEST),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-guest-project-icons-",
});

const testLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
  ProjectStore.layer,
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
).pipe(
  Layer.provideMerge(
    AccessGate.layerGatedEnvironmentAuth.pipe(
      Layer.provideMerge(upstreamAuth),
      Layer.provideMerge(accessLayer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A project in its own folder on the host, with the favicon file it is given, if any. */
const project = Effect.fn("test.project")(function* (
  name: string,
  favicon?: { readonly file: string; readonly bytes: string | Uint8Array },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `host-secret-${name}-` });
  if (favicon !== undefined) {
    const target = path.join(root, favicon.file);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* typeof favicon.bytes === "string"
      ? fileSystem.writeFileString(target, favicon.bytes)
      : fileSystem.writeFile(target, favicon.bytes);
  }
  const id = ProjectId.make(`project:${name}`);
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, default_thread_env_mode,
      auto_pull, favicon_path, project_icon_json, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (${id}, ${name}, ${root}, NULL, 'local', 1, NULL, NULL, '[]', ${AT}, ${AT}, NULL)
  `;
  return { id, root };
});

const thread = Effect.fn("test.thread")(function* (id: string, projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, '{}'
    )
  `;
  return ThreadId.make(id);
});

type Answer =
  | { readonly kind: "upstream" }
  | { readonly kind: "refused" }
  | { readonly kind: "link"; readonly relativeUrl: string; readonly expiresAt: number };

/** One favicon request through a connection's authorization, as the RPC server runs it. */
const ask = Effect.fn("test.ask")(function* (
  who: EnvironmentAuth.AuthenticatedSession,
  resource: unknown,
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(AccessGate.layerRpcAuthorization(who, RpcAuthorization.layer(who.scopes))),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome: unknown = yield* authorize(
    // Upstream's own handler, which would answer with a link that names the host's folder.
    Effect.succeed({ kind: "upstream" }) as unknown as Handler,
    {
      rpc: { _tag: WS_METHODS.assetsCreateUrl },
      payload: { resource },
    } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: () => Effect.succeed({ kind: "refused" }),
    }),
    Effect.scoped,
  );
  return (
    typeof outcome === "object" && outcome !== null && "relativeUrl" in outcome
      ? { kind: "link", ...outcome }
      : outcome
  ) as Answer;
});

const icon = (projectId: ProjectId) => ({
  _tag: "project-favicon",
  // What a guest's reduced project carries: a placeholder folder and the project's id.
  cwd: "/",
  path: guestIconPath(projectId),
});

/** J5's icon route as a browser's `<img>` reaches it: no cookie, no header, only the link. */
const iconRoute = Effect.fn("test.iconRoute")(function* () {
  // The route runs on the test's own services, its clock among them.
  const context = yield* Effect.context<never>();
  const { dispose, handler } = HttpRouter.toWebHandler(
    guestProjectIconRouteLayer.pipe(
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  return (relativeUrl: string) =>
    Effect.promise(async () => {
      const response = await handler(new Request(`http://environment.test${relativeUrl}`));
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    });
});

/** The guest of these tests: a grant on one thread of one project, and on a second project. */
const seeded = Effect.fn("test.seeded")(function* (tag: string) {
  const access = yield* PersonAccess.PersonAccess;
  const byThread = yield* project(`${tag}-by-thread`, { file: "favicon.svg", bytes: SVG });
  const byGrant = yield* project(`${tag}-by-grant`, { file: "public/favicon.png", bytes: PNG });
  const bare = yield* project(`${tag}-bare`);
  const hidden = yield* project(`${tag}-hidden`, {
    file: "favicon.svg",
    bytes: "<svg>hidden</svg>",
  });
  const guest = yield* access.createPerson({ displayName: `Contractor ${tag}` });
  const who = session(`session:guest-${tag}`, "one-time-token");
  yield* access.bindSession({ sessionId: who.sessionId, personId: guest.personId, ceiling: null });
  const threadId = yield* thread(`thread:${tag}-in-by-thread`, byThread.id);
  yield* thread(`thread:${tag}-in-hidden`, hidden.id);
  yield* access.setLevel({
    personId: guest.personId,
    scope: { kind: "thread", threadId },
    level: "viewer",
  });
  for (const projectId of [byGrant.id, bare.id]) {
    yield* access.setLevel({
      personId: guest.personId,
      scope: { kind: "project", projectId },
      level: "viewer",
    });
  }
  return { byThread, byGrant, bare, hidden, guest, threadId, who };
});

const linkOf = (answer: Answer) => {
  assert.strictEqual(answer.kind, "link");
  return answer as Extract<Answer, { kind: "link" }>;
};

it("names a project by id where upstream's client carries a favicon's path", () => {
  const id = ProjectId.make("project:fixture:a b/c%3A1");
  assert.match(guestIconPath(id), /^j5-shared-project\/[^/]+\.png$/);
});

it.layer(testLayer)("a guest and a project's favicon", (it) => {
  it.effect(
    "is given the favicon of a project in its sidebar, by a link that names no folder",
    () =>
      Effect.gen(function* () {
        const { byThread, byGrant, bare, who } = yield* seeded("given");
        const fetch = yield* iconRoute();

        // A project the guest reaches through one thread: an SVG favicon.
        const svg = linkOf(yield* ask(who, icon(byThread.id)));
        assert.match(
          svg.relativeUrl,
          /^\/api\/j5\/sharing\/project-icon\/[^/]+\/icon-[0-9a-f]{32}\.svg$/,
        );
        const served = yield* fetch(svg.relativeUrl);
        assert.strictEqual(served.status, 200);
        assert.strictEqual(new TextDecoder().decode(served.bytes), SVG);
        // Upstream's own protections for an asset it serves: no sniffing, and an SVG sandboxed.
        assert.strictEqual(served.headers["x-content-type-options"], "nosniff");
        assert.match(served.headers["content-type"] ?? "", /^image\/svg\+xml/);
        assert.match(served.headers["content-security-policy"] ?? "", /sandbox/);

        // A project the guest holds a grant on: a PNG favicon in a subfolder.
        const png = linkOf(yield* ask(who, icon(byGrant.id)));
        assert.match(png.relativeUrl, /\.png$/);
        const pngServed = yield* fetch(png.relativeUrl);
        assert.strictEqual(pngServed.status, 200);
        assert.deepStrictEqual([...pngServed.bytes], [...PNG]);
        assert.match(pngServed.headers["content-type"] ?? "", /^image\/png/);
        assert.strictEqual(pngServed.headers["x-content-type-options"], "nosniff");

        // Nothing the guest was handed names a folder or a file on the host.
        for (const link of [svg, png]) {
          const [, token] = link.relativeUrl
            .slice(GUEST_PROJECT_ICON_ROUTE_PREFIX.length)
            .split("/");
          const claims = JSON.parse(Buffer.from(token!.split(".")[0]!, "base64url").toString());
          assert.deepStrictEqual(Object.keys(claims).toSorted(), [
            "expiresAt",
            "projectId",
            "version",
          ]);
          const everything = JSON.stringify([link, claims]);
          for (const secret of ["host-secret", byThread.root, byGrant.root, "favicon", "public"]) {
            assert.notInclude(everything, secret);
          }
        }

        // A project with no favicon gets upstream's own "none" marker, which upstream's client
        // reads as "draw the default" and never fetches. Asking again gives the same, not an error.
        for (let asked = 0; asked < 2; asked += 1) {
          const none = linkOf(yield* ask(who, icon(bare.id)));
          assert.isTrue(none.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`));
          assert.strictEqual((yield* fetch(none.relativeUrl)).status, 404);
        }

        // A member's connection is upstream's own handler, whatever the request carries.
        assert.deepStrictEqual(yield* ask(MEMBER, icon(byThread.id)), { kind: "upstream" });
        assert.deepStrictEqual(
          yield* ask(MEMBER, { _tag: "project-favicon", cwd: byThread.root }),
          { kind: "upstream" },
        );
      }).pipe(Effect.scoped),
  );

  it.effect("is refused every project that is not in its sidebar, however it is named", () =>
    Effect.gen(function* () {
      const { byThread, hidden, guest, threadId, who } = yield* seeded("refused");
      const access = yield* PersonAccess.PersonAccess;
      const refused = { kind: "refused" };
      for (const resource of [
        // A project with a thread the guest cannot see, by id and by its real folder.
        icon(hidden.id),
        { _tag: "project-favicon", cwd: hidden.root },
        { _tag: "project-favicon", cwd: hidden.root, path: "favicon.svg" },
        // The guest's own project by its real folder: a guest names a project by id only.
        { _tag: "project-favicon", cwd: byThread.root },
        { _tag: "project-favicon", cwd: byThread.root, path: "favicon.svg" },
        icon(ProjectId.make("project:made-up")),
        { _tag: "project-favicon", cwd: "/", path: "j5-shared-project/.png" },
        { _tag: "project-favicon", cwd: "/", path: "j5-shared-project/%E0%A4%A.png" },
        { _tag: "project-favicon", cwd: "/", path: `../${guestIconPath(byThread.id)}` },
        { _tag: "project-favicon", cwd: "/", path: ["j5-shared-project/x.png"] },
        { _tag: "project-favicon", cwd: "/" },
      ]) {
        assert.deepStrictEqual(yield* ask(who, resource), refused, JSON.stringify(resource));
      }
      // A guest's session with no person recorded holds no sidebar.
      assert.deepStrictEqual(yield* ask(STRAY, icon(byThread.id)), refused);
      // And it ends with the grant.
      assert.strictEqual((yield* ask(who, icon(byThread.id))).kind, "link");
      yield* access.removeLevel({
        personId: guest.personId,
        scope: { kind: "thread", threadId },
      });
      assert.deepStrictEqual(yield* ask(who, icon(byThread.id)), refused);
    }).pipe(Effect.scoped),
  );

  it.effect("a link opens its own project's favicon and nothing else", () =>
    Effect.gen(function* () {
      const { byThread, byGrant, hidden, who } = yield* seeded("link");
      const fetch = yield* iconRoute();
      const mine = linkOf(yield* ask(who, icon(byThread.id)));
      const other = linkOf(yield* ask(who, icon(byGrant.id)));
      const [, token, name] = mine.relativeUrl
        .slice(GUEST_PROJECT_ICON_ROUTE_PREFIX.length)
        .split("/");
      const [, otherToken, otherName] = other.relativeUrl
        .slice(GUEST_PROJECT_ICON_ROUTE_PREFIX.length)
        .split("/");
      const [payload, signature] = token!.split(".");
      const at = (nextToken: string, path: string) =>
        fetch(`${GUEST_PROJECT_ICON_ROUTE_PREFIX}/${nextToken}/${path}`);
      const forged = (claims: object) => Buffer.from(JSON.stringify(claims)).toString("base64url");

      // Whatever follows the token, the token's own project is what is served.
      for (const path of [otherName!, "favicon.svg", "..%2F..%2Fetc%2Fpasswd", "x/y/z.png", ""]) {
        const served = yield* at(token!, path);
        assert.strictEqual(served.status, 200, path);
        assert.strictEqual(new TextDecoder().decode(served.bytes), SVG, path);
      }
      // A token that was changed, re-pointed, or signed for something else opens nothing.
      const expiresAt = JSON.parse(Buffer.from(payload!, "base64url").toString()).expiresAt;
      for (const [why, tampered] of [
        [
          "re-pointed at a project the guest cannot see",
          `${forged({ version: 1, projectId: hidden.id, expiresAt })}.${signature}`,
        ],
        [
          "its expiry pushed out",
          `${forged({ version: 1, projectId: byThread.id, expiresAt: expiresAt + 1 })}.${signature}`,
        ],
        ["another link's signature", `${payload}.${otherToken!.split(".")[1]}`],
        ["a signature cut short", `${payload}.${signature!.slice(0, -2)}`],
        ["no signature", payload!],
        ["an empty signature", `${payload}.`],
        ["a third part", `${token}.extra`],
        ["not a token", "not-a-token"],
        ["nothing", ""],
      ] as const) {
        assert.strictEqual((yield* at(tampered, name!)).status, 404, why);
      }
      // A project deleted after its link was made.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${byGrant.id}`;
      assert.strictEqual((yield* at(otherToken!, otherName!)).status, 404);
      // A link past its hour: good until then, and nothing after.
      const fresh = linkOf(yield* ask(who, icon(byThread.id)));
      yield* TestClock.adjust("59 minutes");
      assert.strictEqual((yield* fetch(fresh.relativeUrl)).status, 200);
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual((yield* fetch(fresh.relativeUrl)).status, 404);
    }).pipe(Effect.scoped),
  );
});
