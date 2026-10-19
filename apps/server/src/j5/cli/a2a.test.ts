// @effect-diagnostics nodeBuiltinImport:off - the CLI is exercised against a stub HTTP server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { peerCredentialRejectedReason, peerPollStoppedError } from "@t3tools/contracts/j5";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { cli } from "../../binCli.ts";
import { A2A_EXIT_CODES } from "./a2a.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(CliRuntimeLayer));

interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface StubServer {
  readonly origin: string;
  readonly requests: Array<StubRequest>;
  readonly close: () => Promise<void>;
}

type StubReply = { readonly status: number; readonly body: unknown };

const startStub = (respond: (request: StubRequest) => StubReply) =>
  new Promise<StubServer>((resolve) => {
    const requests: Array<StubRequest> = [];
    const server = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (raw += chunk));
      request.on("end", () => {
        const stubRequest: StubRequest = {
          method: request.method ?? "GET",
          url: request.url ?? "/",
          authorization: request.headers.authorization,
          body: raw.length === 0 ? null : (JSON.parse(raw) as unknown),
        };
        requests.push(stubRequest);
        const reply = respond(stubRequest);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

/** One stub per test body; the server is closed even when an assertion fails. */
const withStub = <A, E, R>(
  respond: (request: StubRequest) => StubReply,
  use: (stub: StubServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => startStub(respond)),
    use,
    (stub) => Effect.promise(() => stub.close()),
  );

let logged: Array<string> = [];
let errored: Array<string> = [];

beforeEach(() => {
  logged = [];
  errored = [];
  vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: Array<unknown>) => {
    errored.push(args.map(String).join(" "));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const lastJson = () => JSON.parse(logged.at(-1) ?? "null") as Record<string, unknown>;
const lastText = () => logged.at(-1) ?? "";

const sendArgs = (origin: string, extra: ReadonlyArray<string> = ["--token", "t"]) => [
  "a2a",
  "send",
  "--origin",
  origin,
  ...extra,
  "--to",
  "obs-sentinel",
  "--message",
  "canary 42",
  "--client-request-id",
  "canary-42",
  "--json",
];

const receipt = {
  sender: "machine:watchdog",
  receiver: "agent:j5:a2a:thread:sentinel",
  result: {
    messageId: "message:j5:a2a:one",
    exchangeId: null,
    exchangeState: "none",
    joinedExistingExchange: false,
    durableAtSeq: 7,
  },
};

it.live(
  "sends with the bearer token and prints the receipt; a retry simply sends the same id",
  () =>
    withStub(
      () => ({ status: 200, body: receipt }),
      (stub) =>
        Effect.gen(function* () {
          yield* runCli(sendArgs(stub.origin, ["--token", "secret-token"]));
          yield* runCli(sendArgs(stub.origin, ["--token", "secret-token"]));
          assert.equal(process.exitCode, undefined);
          assert.equal(stub.requests.length, 2);
          assert.equal(stub.requests[0]!.method, "POST");
          assert.equal(stub.requests[0]!.url, "/api/j5/a2a/send");
          assert.equal(stub.requests[0]!.authorization, "Bearer secret-token");
          assert.deepStrictEqual(stub.requests[0]!.body, {
            to: "obs-sentinel",
            message: "canary 42",
            clientRequestId: "canary-42",
          });
          const output = lastJson();
          assert.equal(output.ok, true);
          assert.deepStrictEqual(output.result, receipt.result);
        }),
    ),
);

it.live("maps server refusals to the documented exit codes", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{ readonly reply: StubReply; readonly exitCode: number }> = [
      {
        reply: { status: 401, body: { error: "unauthorized", message: "bad token" } },
        exitCode: 3,
      },
      {
        reply: { status: 403, body: { error: "machine_subject_required", message: "no" } },
        exitCode: 3,
      },
      {
        reply: { status: 404, body: { error: "recipient_not_found", message: "nobody" } },
        exitCode: 4,
      },
      {
        reply: {
          status: 409,
          body: {
            error: "recipient_ambiguous",
            message: "two",
            candidates: [{ participantId: "a" }],
          },
        },
        exitCode: 4,
      },
      {
        reply: {
          status: 403,
          body: { error: "policy_refused", message: "cannot receive", reason: "x" },
        },
        exitCode: 5,
      },
    ];
    for (const testCase of cases) {
      yield* withStub(
        () => testCase.reply,
        (stub) =>
          Effect.gen(function* () {
            process.exitCode = undefined;
            yield* runCli(sendArgs(stub.origin));
            assert.equal(
              process.exitCode,
              testCase.exitCode,
              `HTTP ${String(testCase.reply.status)}`,
            );
            const output = lastJson();
            assert.equal(output.ok, false);
            assert.equal(output.exit_code, testCase.exitCode);
            assert.equal(output.error, (testCase.reply.body as { error: string }).error);
            if (testCase.reply.status === 409) assert.isArray(output.candidates);
          }),
      );
    }
  }),
);

it.live("fails fast with exit 6 when nothing listens at the origin", () =>
  Effect.gen(function* () {
    const closedOrigin = yield* withStub(
      () => ({ status: 200, body: {} }),
      (stub) => Effect.succeed(stub.origin),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    yield* runCli(sendArgs(closedOrigin).filter((arg) => arg !== "--json"));
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    assert.equal(process.exitCode, A2A_EXIT_CODES.unreachable);
    assert.isBelow(elapsed, 2_000);
    assert.match(errored.at(-1) ?? "", /server_unreachable/);
  }),
);

it.live(
  "treats a missing recipient as a usage error and a missing token as unauthenticated, before any request",
  () =>
    withStub(
      () => ({ status: 200, body: receipt }),
      (stub) =>
        Effect.gen(function* () {
          yield* runCli([
            "a2a",
            "send",
            "--origin",
            stub.origin,
            "--token",
            "t",
            "--message",
            "m",
            "--json",
          ]);
          assert.equal(process.exitCode, A2A_EXIT_CODES.usage);
          assert.equal(lastJson().error, "usage");

          process.exitCode = undefined;
          yield* runCli(sendArgs(stub.origin, []));
          assert.equal(process.exitCode, A2A_EXIT_CODES.unauthenticated);
          assert.equal(lastJson().error, "token_required");
          assert.equal(stub.requests.length, 0);
        }),
    ),
);

it.live(
  "rejects a token that cannot be a bearer header with exit 3, never the retryable exit 6",
  () =>
    withStub(
      () => ({ status: 200, body: receipt }),
      (stub) =>
        Effect.gen(function* () {
          const capturedHelp =
            "DESCRIPTION\n  Issue a bearer token.\n\nUSAGE\n  j5 a2a token issue";
          for (const verb of ["send", "whoami", "list"]) {
            process.exitCode = undefined;
            const args =
              verb === "send"
                ? sendArgs(stub.origin, ["--token", capturedHelp])
                : ["a2a", verb, "--origin", stub.origin, "--token", capturedHelp, "--json"];
            yield* runCli(args);
            assert.equal(process.exitCode, A2A_EXIT_CODES.unauthenticated, verb);
            assert.equal(lastJson().error, "token_malformed", verb);
          }
          assert.equal(stub.requests.length, 0);
        }),
    ),
);

it.live("treats an origin that is not an http(s) URL as a usage error", () =>
  Effect.gen(function* () {
    for (const origin of ["127.0.0.1:3773", "ftp://127.0.0.1"]) {
      process.exitCode = undefined;
      yield* runCli(["a2a", "whoami", "--origin", origin, "--token", "t", "--json"]);
      assert.equal(process.exitCode, A2A_EXIT_CODES.usage, origin);
      assert.equal(lastJson().error, "usage", origin);
    }
  }),
);

it.live("lists the roster as one line per participant and answers whoami", () => {
  const roster = {
    participants: [
      {
        participantId: "agent:j5:a2a:thread:sentinel",
        kind: "agent",
        projectId: "project:monitoring",
        projectTitle: "Monitoring",
        displayName: "obs-sentinel",
        threadId: "thread:sentinel",
        archived: false,
        canReceiveMessage: true,
        acceptsUrgency: false,
        liveness: {
          state: "idle",
          runStatus: "completed",
          latestRunStartedAt: null,
          latestRunCompletedAt: "2026-09-15T12:00:00.000Z",
          lastError: null,
        },
      },
      {
        participantId: "machine:watchdog",
        kind: "machine",
        projectId: "project:monitoring",
        projectTitle: "Monitoring",
        displayName: "watchdog",
        threadId: null,
        archived: false,
        canReceiveMessage: false,
        acceptsUrgency: false,
        liveness: null,
      },
    ],
  };
  const whoami = {
    participant: {
      participantId: "machine:watchdog",
      projectId: "project:monitoring",
      projectTitle: "Monitoring",
      name: "watchdog",
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    server: { version: "0.0.39" },
  };
  return withStub(
    (request) =>
      request.url === "/api/j5/a2a/roster"
        ? { status: 200, body: roster }
        : { status: 200, body: whoami },
    (stub) =>
      Effect.gen(function* () {
        yield* runCli(["a2a", "list", "--origin", stub.origin, "--token", "t"]);
        assert.equal(process.exitCode, undefined);
        const lines = (logged.at(-1) ?? "").split("\n");
        assert.deepStrictEqual(lines, [
          "agent\tagent:j5:a2a:thread:sentinel\tobs-sentinel\tMonitoring\tidle/completed\treachable",
          "machine\tmachine:watchdog\twatchdog\tMonitoring\t-\tno-receive",
        ]);

        yield* runCli(["a2a", "whoami", "--origin", stub.origin, "--token", "t", "--json"]);
        assert.equal(process.exitCode, undefined);
        const output = lastJson();
        assert.equal(output.ok, true);
        assert.deepStrictEqual(output.participant, whoami.participant);
        assert.equal(output.origin, stub.origin);
      }),
  );
});

/** A record as a server from before poll mode answers it, with none of the poll-mode fields. */
const homePeer = {
  environmentId: "environment-home",
  label: "Home",
  origin: "https://home.example:3773",
  credentialExpiresAt: "2036-09-16T00:00:00.000Z",
  inboundSession: "active",
  createdAt: "2026-09-16T00:00:00.000Z",
};
/** The same record decoded here: a peer of an older server sends directly, and nothing waits for it. */
const homePeerDecoded = {
  ...homePeer,
  linkMode: "push",
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
};

it.live("issues a peer credential, adds, lists, and removes a peer through the admin routes", () =>
  withStub(
    (request) =>
      request.url === "/api/j5/a2a/peers/credentials"
        ? {
            status: 201,
            body: {
              environmentId: "environment-work",
              credential: "home-will-present-this",
              sessionId: "auth-session:peer",
              subject: "peer:environment-home",
              expiresAt: "2027-01-01T00:00:00.000Z",
            },
          }
        : request.url === "/api/j5/a2a/peers" && request.method === "POST"
          ? { status: 201, body: { peer: homePeer, created: true } }
          : request.url === "/api/j5/a2a/peers"
            ? { status: 200, body: { peers: [homePeer] } }
            : request.url === "/api/j5/a2a/peers/remove"
              ? { status: 200, body: { removed: true, revokedSessions: 1 } }
              : { status: 404, body: { error: "not_found", message: "no" } },
    (stub) =>
      Effect.gen(function* () {
        const common = ["--origin", stub.origin, "--token", "admin", "--json"];
        yield* runCli([
          "a2a",
          "peer",
          "credential",
          "--for",
          "environment-home",
          "--label",
          "Home",
          ...common,
        ]);
        assert.equal(process.exitCode, undefined);
        assert.deepStrictEqual(stub.requests[0]!.body, {
          environmentId: "environment-home",
          label: "Home",
        });
        assert.equal(stub.requests[0]!.authorization, "Bearer admin");
        assert.equal(lastJson().credential, "home-will-present-this");
        assert.equal(lastJson().environmentId, "environment-work");

        yield* runCli([
          "a2a",
          "peer",
          "add",
          "--peer-origin",
          "https://home.example:3773/",
          "--credential",
          "issued-by-home",
          ...common,
        ]);
        assert.equal(process.exitCode, undefined);
        assert.deepStrictEqual(
          stub.requests[1]!.body,
          { origin: "https://home.example:3773", credential: "issued-by-home" },
          "the peer names itself at hello; no name is typed here",
        );
        assert.deepStrictEqual(lastJson().peer, homePeerDecoded);

        yield* runCli(["a2a", "peer", "list", ...common]);
        assert.equal(stub.requests[2]!.method, "GET");
        assert.deepStrictEqual(lastJson().peers, [homePeerDecoded]);

        yield* runCli(["a2a", "peer", "remove", "--environment", "environment-home", ...common]);
        assert.deepStrictEqual(stub.requests[3]!.body, { environmentId: "environment-home" });
        assert.deepStrictEqual(lastJson(), {
          ok: true,
          exit_code: 0,
          removed: true,
          revokedSessions: 1,
        });
      }),
  ),
);

it.live(
  "lists each peer's health as Settings does: online, offline since, or not polled yet",
  () => {
    const recent = DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { seconds: 30 }));
    const old = "2020-01-01T00:00:00.000Z";
    const peers = [
      {
        ...homePeerDecoded,
        environmentId: "environment-laptop",
        label: "JM-LT-04213",
        linkMode: "store",
        origin: null,
        credentialExpiresAt: null,
        lastPolledAt: recent,
        waitingCount: 2,
        oldestWaitingAt: "2026-10-02T11:00:00.000Z",
      },
      {
        ...homePeerDecoded,
        environmentId: "environment-vm",
        label: "Work VM",
        linkMode: "poll",
        origin: "https://vm.example:3773",
        lastPolledAt: old,
        lastError: "could not reach Work VM: ECONNREFUSED",
      },
      {
        ...homePeerDecoded,
        environmentId: "environment-mac",
        label: "Home Mac",
        linkMode: "store",
        origin: null,
        credentialExpiresAt: null,
      },
      homePeerDecoded,
      {
        ...homePeerDecoded,
        environmentId: "environment-office",
        label: "Office VM",
        linkMode: "poll",
        origin: "https://office.example:3773",
        lastPolledAt: recent,
        lastError: peerPollStoppedError(peerCredentialRejectedReason("Office VM")),
      },
    ];
    return withStub(
      () => ({ status: 200, body: { peers } }),
      (stub) =>
        Effect.gen(function* () {
          yield* runCli(["a2a", "peer", "list", "--origin", stub.origin, "--token", "admin"]);
          assert.equal(process.exitCode, undefined);
          const [laptop, vm, mac, home, office] = lastText().split("\n");
          assert.include(laptop, `online, last polled ${recent}`);
          assert.include(laptop, "2 waiting since 2026-10-02T11:00:00.000Z");
          assert.include(vm, `offline since ${old}`);
          assert.include(vm, "last error: could not reach Work VM: ECONNREFUSED");
          assert.include(mac, "has not polled yet");
          assert.notInclude(home ?? "", "polled", "a peer sending directly has no poll health");
          assert.include(office, `polling stopped: ${peerCredentialRejectedReason("Office VM")}`);
          assert.notInclude(
            office,
            "Polling stopped:",
            "the poller's mark is shown once, stripped",
          );
          assert.notInclude(
            office,
            "online",
            "a stopped poller claims nothing about its last poll",
          );
          assert.notInclude(office, "last error", "the stop reason is said once");
          assert.notInclude(vm, "inbound", "a poller holds no session from the server it polls");
          assert.include(laptop, "inbound:");
        }),
    );
  },
);

it.live(
  "issues a store credential and adds a peer to poll, for a server that cannot be reached",
  () =>
    withStub(
      (request) =>
        request.url === "/api/j5/a2a/peers/credentials"
          ? {
              status: 201,
              body: {
                environmentId: "environment-vm",
                credential: "laptop-will-present-this",
                sessionId: "auth-session:peer",
                subject: "peer:environment-laptop",
                expiresAt: "2036-10-02T00:00:00.000Z",
              },
            }
          : {
              status: 201,
              body: {
                peer: { ...homePeerDecoded, label: "Work VM", linkMode: "poll" },
                created: true,
              },
            },
      (stub) =>
        Effect.gen(function* () {
          const common = ["--origin", stub.origin, "--token", "admin"];
          yield* runCli([
            "a2a",
            "peer",
            "credential",
            "--for",
            "environment-laptop",
            "--store",
            ...common,
          ]);
          assert.deepStrictEqual(stub.requests[0]!.body, {
            environmentId: "environment-laptop",
            store: true,
          });
          assert.include(lastText(), "--poll", "the next step says to poll");

          yield* runCli([
            "a2a",
            "peer",
            "add",
            "--peer-origin",
            "https://vm.example:3773",
            "--credential",
            "issued-by-vm",
            "--poll",
            ...common,
          ]);
          assert.equal(process.exitCode, undefined);
          assert.deepStrictEqual(stub.requests[1]!.body, {
            origin: "https://vm.example:3773",
            credential: "issued-by-vm",
            poll: true,
          });
          assert.include(lastText(), "This server polls it for its messages");
        }),
    ),
);

it.live("maps peer-add refusals: unreachable origin exits 6, a foreign credential exits 5", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{ readonly reply: StubReply; readonly exitCode: number }> = [
      {
        reply: { status: 502, body: { error: "peer_unreachable", message: "ECONNREFUSED" } },
        exitCode: A2A_EXIT_CODES.unreachable,
      },
      {
        reply: {
          status: 409,
          body: { error: "peer_credential_mismatch", message: "issued for another server" },
        },
        exitCode: A2A_EXIT_CODES.refused,
      },
      {
        reply: { status: 400, body: { error: "peer_is_self", message: "that is you" } },
        exitCode: A2A_EXIT_CODES.usage,
      },
    ];
    for (const testCase of cases) {
      yield* withStub(
        () => testCase.reply,
        (stub) =>
          Effect.gen(function* () {
            process.exitCode = undefined;
            yield* runCli([
              "a2a",
              "peer",
              "add",
              "--peer-origin",
              "https://home.example:3773",
              "--credential",
              "t",
              "--origin",
              stub.origin,
              "--token",
              "admin",
              "--json",
            ]);
            assert.equal(process.exitCode, testCase.exitCode, String(testCase.reply.status));
            assert.equal(lastJson().error, (testCase.reply.body as { error: string }).error);
          }),
      );
    }

    process.exitCode = undefined;
    yield* runCli([
      "a2a",
      "peer",
      "add",
      "--peer-origin",
      "https://x.example",
      "--token",
      "t",
      "--origin",
      "http://127.0.0.1:1",
      "--json",
    ]);
    assert.equal(process.exitCode, A2A_EXIT_CODES.usage, "a missing credential is a usage error");
    assert.equal(lastJson().error, "usage");
  }),
);
