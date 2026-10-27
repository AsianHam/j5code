// @effect-diagnostics nodeBuiltinImport:off - the server side listens on a real loopback port.
import * as NodeHttp from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { J5_CLI_PAIRING_PATH, type PersonLevel } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { acquireServerOwnership } from "../../serverOwnership.ts";
import { makePersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { cliEnvironmentAuth } from "./AccessGate.ts";
import { cliPairingHttpRouteLayer } from "./CliPairingHttp.ts";
import {
  CLI_SESSION_SUBJECT,
  pairingLinkFromCli,
  RuntimeFileActivationDelay,
} from "./cliPairing.ts";
import { PersonAccess } from "./PersonAccess.ts";

/**
 * `j5 pair --person` and `j5 auth pairing create` against a running server: the server makes the
 * change, so its change signal moves and an open People page re-reads. The server holds the home's
 * lock and publishes where it listens, as `server.ts` does; the CLI runs in separate layers.
 */

const homeConfig = ServerConfig.ServerConfig.pipe(
  Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-cli-pairing-http-" })),
);

/** Holds the home's lock as a server does, and publishes where it listens when told. */
const holdHome = Effect.fn("test.holdHome")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const ownership = yield* acquireServerOwnership(config.serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
  );
  return (port: number, pid?: number) =>
    makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port,
    }).pipe(
      Effect.flatMap((state) => ownership.publish(pid === undefined ? state : { ...state, pid })),
      Effect.orDie,
      Effect.provide(NodeServices.layer),
    );
});

/** A plain HTTP server on a loopback port, closed with the test's scope. */
const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  ).pipe(
    Effect.map((server) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    }),
  );

/** The running server for the home in `config`: the route, its auth and its people services. */
const startServer = Effect.fn("test.startServer")(function* (
  config: ServerConfig.ServerConfig["Service"],
  options: { readonly published: boolean } = { published: true },
) {
  const publish = yield* holdHome(config);
  const services = yield* Layer.build(
    HttpRouter.serve(cliPairingHttpRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(cliEnvironmentAuth(EnvironmentAuth.layerRuntime)),
      // The same instance the people services announce on, as on the server (`ReadChanges.ts`).
      Layer.provideMerge(readChangesLayer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          disablePreemptiveShutdown: true,
        }),
      ),
    ),
  );
  const address = Context.get(services, HttpServer.HttpServer).address;
  const port = "port" in address ? address.port : 0;
  if (options.published) yield* publish(port);
  return {
    port,
    publish,
    origin: `http://127.0.0.1:${String(port)}`,
    auth: Context.get(services, EnvironmentAuth.EnvironmentAuth),
    people: Context.get(services, PersonAccess),
    readChanges: Context.get(services, ReadChanges),
  };
});

/** The home's auth and people, read from the database as another process would. */
const homeServices = (config: ServerConfig.ServerConfig["Service"]) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      cliEnvironmentAuth(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
      ),
    );
    return {
      auth: Context.get(services, EnvironmentAuth.EnvironmentAuth),
      people: Context.get(services, PersonAccess),
    };
  });

/**
 * The People page's revision on `readChanges`, as an open page next reads it: after the window
 * the server gathers changes in.
 */
const sharingRevision = (readChanges: ReadChanges["Service"]) =>
  TestClock.withLive(Stream.runHead(readChanges.changes)).pipe(
    Effect.map((revisions) => Option.getOrThrow(revisions).sharing),
  );

const cliFlags = (input: { readonly person?: string; readonly level?: PersonLevel }) => ({
  person: Option.fromUndefinedOr(input.person),
  level: Option.fromUndefinedOr(input.level),
  project: Option.none<string>(),
  thread: Option.none<string>(),
});

const pairFromCli = (
  config: ServerConfig.ServerConfig["Service"],
  input: { readonly person?: string; readonly level?: PersonLevel },
) =>
  pairingLinkFromCli({
    config,
    minimumLogLevel: "Error",
    flags: cliFlags(input),
    scopes: { scopes: AuthStandardClientScopes, given: false },
    ttl: Option.none(),
    label: Option.some("j5 pair"),
    withoutPerson: "refuse",
  });

/** Records each activation wait, running `then` for the n-th. */
const activationWaits = (then: (n: number) => Effect.Effect<void> = () => Effect.void) => {
  const waits: Array<number> = [];
  return {
    waits,
    provide: Effect.provideService(RuntimeFileActivationDelay, (duration: Duration.Duration) =>
      Effect.suspend(() => {
        waits.push(Duration.toMillis(duration));
        return then(waits.length);
      }),
    ),
  };
};

const cliSessionsLeft = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  auth
    .listSessions()
    .pipe(
      Effect.map((sessions) =>
        sessions.filter((session) => session.client.label === "j5 pair cli"),
      ),
    );

const post = (origin: string, token: string | null, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post(`${origin}${J5_CLI_PAIRING_PATH}`);
    const request = yield* HttpClientRequest.bodyJson(
      token === null ? base : HttpClientRequest.bearerToken(base, token),
      body,
    );
    const response = yield* client.execute(request);
    return { status: response.status, body: (yield* response.json) as Record<string, unknown> };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const pairingRequest = {
  person: "Priya",
  level: "viewer",
  scopes: [...AuthStandardClientScopes],
  scopesGiven: false,
  withoutPerson: "refuse",
};

it.layer(NodeServices.layer)("j5 pair with a server running", (it) => {
  it.effect("asks the running server, which tells open People pages, and revokes its session", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const server = yield* startServer(config);
      const before = yield* sharingRevision(server.readChanges);

      const made = yield* pairFromCli(config, { person: "Priya", level: "collaborator" });
      assert.strictEqual(
        made.said,
        "Added Priya (Collaborator on the server), and made a link for them.",
      );

      assert.isAbove(yield* sharingRevision(server.readChanges), before);
      const priya = (yield* server.people.listPeople).find(
        (record) => record.person.displayName === "Priya",
      );
      assert.deepStrictEqual(priya?.levels, [{ scope: { kind: "server" }, level: "collaborator" }]);
      const links = yield* server.auth.listPairingLinks();
      assert.isTrue(links.some((link) => link.id === made.link.id && link.label === "j5 pair"));
      assert.deepStrictEqual(yield* cliSessionsLeft(server.auth), []);
    }),
  );

  it.effect("keeps each refusal's tag, so the live-test rig can tell an unknown name", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const server = yield* startServer(config);

      const unknown = yield* pairFromCli(config, { person: "Newcomer" }).pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "PairingPersonUnknownError");
      // The rig reads the tag from the CLI's log line, which prints the error's name.
      assert.strictEqual(unknown.name, "PairingPersonUnknownError");
      assert.include(unknown.message, "No one on this server is called Newcomer");

      const refused = yield* pairFromCli(config, {}).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "PairingPersonError");
      assert.include(refused.message, "--person");
      assert.deepStrictEqual(yield* cliSessionsLeft(server.auth), []);
    }),
  );

  it.effect("writes nothing behind a server that holds the home but does not answer", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const publish = yield* holdHome(config);
      // Never says where it listens, however long `j5 pair` waits.
      const activation = activationWaits();
      const starting = yield* pairFromCli(config, { person: "Priya", level: "viewer" }).pipe(
        activation.provide,
        Effect.flip,
      );
      assert.strictEqual(starting._tag, "PairingServerUnreachableError");
      assert.include(starting.message, "has not said where it listens");
      assert.deepStrictEqual(activation.waits, [1_000, 1_000, 1_000]);

      // Where it said it listens, nothing does any more.
      const port = yield* Layer.build(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ).pipe(
        Effect.map((services) => Context.get(services, HttpServer.HttpServer).address),
        Effect.map((address) => ("port" in address ? address.port : 0)),
        Effect.scoped,
      );
      yield* publish(port);
      const silent = yield* pairFromCli(config, { person: "Priya", level: "viewer" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(silent._tag, "PairingServerUnreachableError");
      assert.include(silent.message, `at http://127.0.0.1:${String(port)}`);

      const { auth, people } = yield* homeServices(config);
      assert.isFalse(
        (yield* people.listPeople).some((record) => record.person.displayName === "Priya"),
      );
      assert.deepStrictEqual(yield* cliSessionsLeft(auth), []);
    }),
  );

  it.effect("waits for a starting server to say where it listens, past a crashed one's file", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const server = yield* startServer(config, { published: false });
      // Left by a server that died: no process has this pid.
      yield* server.publish(1, 2 ** 31 - 1);
      const activation = activationWaits((n) =>
        n === 2 ? server.publish(server.port) : Effect.void,
      );

      const made = yield* pairFromCli(config, { person: "Priya", level: "viewer" }).pipe(
        activation.provide,
      );
      assert.strictEqual(
        made.said,
        "Added Priya (Viewer on the server), and made a link for them.",
      );
      assert.deepStrictEqual(activation.waits, [1_000, 1_000]);
      assert.isTrue(
        (yield* server.people.listPeople).some((record) => record.person.displayName === "Priya"),
      );
    }),
  );

  it.effect("gives up on a server that stalls partway through its answer", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const publish = yield* holdHome(config);
      const port = yield* listen((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
          response.write('{"id":');
        });
      });
      yield* publish(port);
      // Only the body is left to read once the CLI holds the answer's headers.
      const headers = Promise.withResolvers<void>();
      const fetch = yield* FetchHttpClient.Fetch;
      const pairing = yield* pairFromCli(config, { person: "Priya", level: "viewer" }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, (url, init) =>
          fetch(url, init).then((response) => {
            headers.resolve();
            return response;
          }),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Effect.promise(() => headers.promise);
      yield* TestClock.adjust(Duration.seconds(10));

      const stalled = yield* Fiber.join(pairing);
      assert.strictEqual(stalled._tag, "PairingServerUnconfirmedError");
      const { auth } = yield* homeServices(config);
      assert.deepStrictEqual(yield* cliSessionsLeft(auth), []);
    }),
  );

  it.effect("says it cannot tell when the answer is lost after the server made the change", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const server = yield* startServer(config);
      // Passes the request on, then drops the connection instead of the server's answer.
      const proxy = yield* listen((request, response) => {
        const forwarded = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (answer) => {
            answer.resume();
            answer.on("end", () => response.socket?.destroy());
          },
        );
        request.pipe(forwarded);
      });
      yield* server.publish(proxy);

      const lost = yield* pairFromCli(config, { person: "Priya", level: "viewer" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(lost._tag, "PairingServerUnconfirmedError");
      assert.include(lost.message, "may have added the person");
      assert.include(lost.message, "j5 auth pairing list");
      assert.isTrue(
        (yield* server.people.listPeople).some((record) => record.person.displayName === "Priya"),
      );
      assert.deepStrictEqual(yield* cliSessionsLeft(server.auth), []);
    }),
  );

  it.effect("refuses anything but the CLI's own session with Manage access", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const server = yield* startServer(config);
      const issue = (
        subject: string,
        scopes: ReadonlyArray<typeof AuthAccessWriteScope | typeof AuthOrchestrationReadScope>,
      ) => server.auth.issueSession({ subject, scopes }).pipe(Effect.map((issued) => issued.token));

      assert.strictEqual((yield* post(server.origin, null, pairingRequest)).status, 401);
      const reader = yield* issue(CLI_SESSION_SUBJECT, [AuthOrchestrationReadScope]);
      assert.strictEqual((yield* post(server.origin, reader, pairingRequest)).status, 403);
      // A service session is not narrowed, so only the subject keeps it out: here a peer's, given
      // Manage access as no peer is.
      const peer = yield* issue("peer:environment-home", [AuthAccessWriteScope]);
      const fromPeer = yield* post(server.origin, peer, pairingRequest);
      assert.strictEqual(fromPeer.status, 403);
      assert.strictEqual(fromPeer.body.error, "cli_session_required");

      const cli = yield* issue(CLI_SESSION_SUBJECT, [AuthAccessWriteScope]);
      // A permission no client may be given is not one a link may carry.
      const machineScope = yield* post(server.origin, cli, {
        ...pairingRequest,
        scopes: ["a2a:peer"],
        scopesGiven: true,
      });
      assert.strictEqual(machineScope.status, 400);
      assert.isFalse(
        (yield* server.people.listPeople).some((record) => record.person.displayName === "Priya"),
      );

      const made = yield* post(server.origin, cli, pairingRequest);
      assert.strictEqual(made.status, 200);
      assert.strictEqual(
        made.body.said,
        "Added Priya (Viewer on the server), and made a link for them.",
      );
    }),
  );
});

it.layer(NodeServices.layer)("j5 pair with no server running", (it) => {
  it.effect("writes the person and the link to the home itself", () =>
    Effect.gen(function* () {
      const config = yield* homeConfig;
      const made = yield* pairFromCli(config, { person: "Priya", level: "viewer" });
      assert.strictEqual(
        made.said,
        "Added Priya (Viewer on the server), and made a link for them.",
      );

      const { auth, people } = yield* homeServices(config);
      assert.isTrue(
        (yield* people.listPeople).some((record) => record.person.displayName === "Priya"),
      );
      assert.isTrue((yield* auth.listPairingLinks()).some((link) => link.id === made.link.id));
    }),
  );
});
