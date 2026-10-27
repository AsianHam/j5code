/**
 * `j5 a2a` - the machine-sender CLI: send, list, whoami, participant create,
 * token issue. Scripts and watchdogs use it in place of an agent session. The
 * `peer` group is the operator's side of peering: credential, add, list, remove.
 *
 * Stable exit codes, kept in `A2A_EXIT_CODES`: 0 ok, 2 usage, 3 unauthenticated,
 * 4 recipient not found or ambiguous, 5 refused by policy, 6 server unreachable,
 * 1 anything else. Nothing here ever prompts: a missing input is a usage error.
 */
import { AuthA2ASendScope, AuthStandardClientScopes } from "@t3tools/contracts";
import {
  AddPeerResponse,
  ChangePeerOriginResponse,
  IssuePeerCredentialResponse,
  J5_PEER_API_PATHS,
  PeerListResponse,
  peerPollState,
  peerPollStoppedReason,
  RemovePeerResponse,
  type PeerRecord,
  A2ARosterResponse,
  J5_MACHINE_API_PATHS,
  MACHINE_PARTICIPANT_ID_PREFIX,
  MachineSendResponse,
  MachineWhoamiResponse,
  RegisterMachineParticipantResponse,
  machineParticipantIdForName,
  type A2ARosterEntry,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import { formatIssuedSession } from "../../cliAuthFormat.ts";
import * as ServerConfig from "../../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";

export const A2A_EXIT_CODES = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  recipientNotFound: 4,
  refused: 5,
  unreachable: 6,
} as const;

/** Documented ceiling for `--message`; larger payloads belong in a file the agent can read. */
export const A2A_MAX_MESSAGE_BYTES = 64 * 1024;

export class A2ACliFailure extends Data.TaggedError("A2ACliFailure")<{
  readonly exitCode: number;
  readonly error: string;
  readonly message: string;
  readonly extra?: Record<string, unknown> | undefined;
}> {}

interface Outcome {
  readonly json: Record<string, unknown>;
  readonly text: string;
}

const originFlag = Flag.String("origin").pipe(
  Flag.withDescription(
    "Server origin such as http://127.0.0.1:3773. Default: J5_ORIGIN, then the running local server under the base directory.",
  ),
  Flag.optional,
);
const tokenFlag = Flag.String("token").pipe(
  Flag.withDescription("Bearer token from `j5 a2a token issue`. Default: J5_TOKEN."),
  Flag.optional,
);
const tokenFileFlag = Flag.String("token-file").pipe(
  Flag.withDescription("File holding the bearer token. Default: J5_TOKEN_FILE."),
  Flag.optional,
);
const timeoutFlag = Flag.Int("timeout-ms").pipe(
  Flag.withDescription("Fail with exit 6 when the server does not answer in time."),
  Flag.withDefault(2000),
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit one JSON object instead of human-readable output."),
  Flag.withDefault(false),
);

const connectionFlags = {
  ...authLocationFlags,
  origin: originFlag,
  token: tokenFlag,
  tokenFile: tokenFileFlag,
  timeoutMs: timeoutFlag,
  json: jsonFlag,
} as const;

interface ConnectionFlags extends CliAuthLocationFlags {
  readonly origin: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly tokenFile: Option.Option<string>;
  readonly timeoutMs: number;
  readonly json: boolean;
}

const envOption = (name: string) => Config.String(name).pipe(Config.option);

const usage = (message: string) =>
  new A2ACliFailure({ exitCode: A2A_EXIT_CODES.usage, error: "usage", message });

const requireFlag = <A>(value: Option.Option<A>, flag: string) =>
  Effect.fromOption(value).pipe(Effect.mapError(() => usage(`${flag} is required.`)));

const resolveOrigin = Effect.fn("j5.a2a.cli.resolveOrigin")(function* (flags: ConnectionFlags) {
  const explicit = Option.orElse(flags.origin, () => Option.none<string>());
  const fromEnv = yield* envOption("J5_ORIGIN");
  const chosen = Option.orElse(explicit, () => fromEnv);
  if (Option.isSome(chosen)) {
    const origin = chosen.value.replace(/\/+$/, "");
    const url = URL.parse(origin);
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return yield* usage(`${origin} is not an origin such as http://127.0.0.1:3773.`);
    }
    return origin;
  }

  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isSome(state) && isProcessAlive(state.value.pid)) return state.value.origin;
  return yield* new A2ACliFailure({
    exitCode: A2A_EXIT_CODES.unreachable,
    error: "server_unreachable",
    message: `No running J5 server was found under ${config.baseDir}. Start one, or pass --origin / J5_ORIGIN.`,
  });
});

/**
 * A value that cannot be a bearer header would fail in fetch before anything is
 * sent, and read as exit 6, which scripts retry forever. Help text captured in
 * place of `token issue --token-only` output is the usual case.
 */
const checkTokenShape = (token: string) =>
  token.length === 0 || /^[\x21-\x7e]+$/.test(token)
    ? Effect.succeedSome(token)
    : Effect.fail(
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.unauthenticated,
          error: "token_malformed",
          message:
            "The token holds whitespace, a line break, or a character a bearer token cannot carry. Pass the value `j5 a2a token issue --token-only` printed, unchanged.",
        }),
      );

const tryResolveToken = Effect.fn("j5.a2a.cli.tryResolveToken")(function* (flags: ConnectionFlags) {
  const fromEnv = yield* envOption("J5_TOKEN");
  const direct = Option.orElse(flags.token, () => fromEnv);
  if (Option.isSome(direct)) return yield* checkTokenShape(direct.value.trim());
  const fileFromEnv = yield* envOption("J5_TOKEN_FILE");
  const file = Option.orElse(flags.tokenFile, () => fileFromEnv);
  if (Option.isNone(file)) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(file.value).pipe(
    Effect.mapError(
      () =>
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.unauthenticated,
          error: "token_file_unreadable",
          message: `Could not read the token file ${file.value}.`,
        }),
    ),
  );
  return yield* checkTokenShape(contents.trim());
});

const resolveToken = Effect.fn("j5.a2a.cli.resolveToken")(function* (flags: ConnectionFlags) {
  const token = yield* tryResolveToken(flags);
  if (Option.isSome(token) && token.value.length > 0) return token.value;
  return yield* new A2ACliFailure({
    exitCode: A2A_EXIT_CODES.unauthenticated,
    error: "token_required",
    message:
      "No token. Pass --token, set J5_TOKEN, or point --token-file at a token from `j5 a2a token issue`.",
  });
});

const readStdin = Effect.promise(async () => {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
});

/** `--message` accepts literal text, `@path` for a file, or `-` for stdin. */
const resolveMessage = Effect.fn("j5.a2a.cli.resolveMessage")(function* (raw: string) {
  const fs = yield* FileSystem.FileSystem;
  const text =
    raw === "-"
      ? yield* readStdin
      : raw.startsWith("@")
        ? yield* fs
            .readFileString(raw.slice(1))
            .pipe(Effect.mapError(() => usage(`Could not read the message file ${raw.slice(1)}.`)))
        : raw;
  if (text.trim().length === 0) return yield* usage("The message is empty.");
  if (Buffer.byteLength(text, "utf8") > A2A_MAX_MESSAGE_BYTES) {
    return yield* usage(
      `The message exceeds ${String(A2A_MAX_MESSAGE_BYTES)} bytes. Write it to a file the agent can read and send the path instead.`,
    );
  }
  return text;
});

interface ServerReply {
  readonly status: number;
  readonly body: unknown;
}

const parseJson = (text: string): unknown => {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Exit 6 tells scripts to queue and retry, so it is kept for a request that got
 * no answer: the connection failed or timed out. Anything else is exit 1.
 */
const requestFailure = (target: string) => (cause: unknown) => {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Cause.isTimeoutError(cause) ||
    (HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError")
    ? new A2ACliFailure({
        exitCode: A2A_EXIT_CODES.unreachable,
        error: "server_unreachable",
        message: `Could not reach ${target}: ${detail}`,
      })
    : new A2ACliFailure({
        exitCode: A2A_EXIT_CODES.failure,
        error: "request_failed",
        message: `The request to ${target} failed: ${detail}`,
      });
};

const callServer = Effect.fn("j5.a2a.cli.callServer")(function* (input: {
  readonly origin: string;
  readonly token: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = `${input.origin}${input.path}`;
  const base = (
    input.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  ).pipe(HttpClientRequest.bearerToken(input.token), HttpClientRequest.acceptJson);
  const attempt = Effect.gen(function* () {
    const request =
      input.body === undefined ? base : yield* HttpClientRequest.bodyJson(base, input.body);
    const response = yield* client
      .execute(request)
      .pipe(Effect.timeout(Duration.millis(input.timeoutMs)));
    const text = yield* response.text;
    return { status: response.status, body: parseJson(text) } satisfies ServerReply;
  });
  return yield* attempt.pipe(Effect.mapError(requestFailure(input.origin)));
});

const failureFromReply = (
  reply: ServerReply,
  options: { readonly conflictExitCode?: number } = {},
) => {
  const body = isRecord(reply.body) ? reply.body : {};
  const error = typeof body.error === "string" ? body.error : `http_${String(reply.status)}`;
  const message =
    typeof body.message === "string"
      ? body.message
      : `The server answered HTTP ${String(reply.status)}.`;
  // Status → exit code, with the two refinements the server's error codes carry.
  const exitCodeByStatus: Record<number, number> = {
    400: A2A_EXIT_CODES.usage,
    401: A2A_EXIT_CODES.unauthenticated,
    403: A2A_EXIT_CODES.unauthenticated,
    404: A2A_EXIT_CODES.recipientNotFound,
    409: options.conflictExitCode ?? A2A_EXIT_CODES.recipientNotFound,
    502: A2A_EXIT_CODES.unreachable,
  };
  const exitCode =
    reply.status === 403 && error === "policy_refused"
      ? A2A_EXIT_CODES.refused
      : (exitCodeByStatus[reply.status] ?? A2A_EXIT_CODES.failure);
  const { error: _error, message: _message, ...extra } = body;
  return new A2ACliFailure({ exitCode, error, message, extra });
};

const decodeReply = <S extends Schema.Top>(schema: S, body: unknown) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) =>
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.failure,
          error: "unexpected_response",
          message: `The server answered with an unexpected shape: ${cause.message}`,
        }),
    ),
  );

/** Every verb ends here: one line of JSON or text, and the process exit code. */
const runOutcome = <E, R>(json: boolean, body: Effect.Effect<Outcome, E | A2ACliFailure, R>) =>
  body.pipe(
    Effect.flatMap((outcome) =>
      Console.log(
        json
          ? JSON.stringify({ ok: true, exit_code: A2A_EXIT_CODES.ok, ...outcome.json })
          : outcome.text,
      ),
    ),
    Effect.catch((error) => {
      const failure =
        error instanceof A2ACliFailure
          ? error
          : new A2ACliFailure({
              exitCode: A2A_EXIT_CODES.failure,
              error: "failure",
              message: error instanceof Error ? error.message : String(error),
            });
      process.exitCode = failure.exitCode;
      return json
        ? Console.log(
            JSON.stringify({
              ok: false,
              exit_code: failure.exitCode,
              error: failure.error,
              message: failure.message,
              ...failure.extra,
            }),
          )
        : Console.error(`${failure.error}: ${failure.message}`);
    }),
    Effect.provide(FetchHttpClient.layer),
  );

const sendCommand = Command.make("send", {
  ...connectionFlags,
  to: Flag.String("to").pipe(
    Flag.withDescription("Recipient: participant id, thread id, or an agent's exact display name."),
    Flag.optional,
  ),
  message: Flag.String("message").pipe(
    Flag.withDescription("Message text, `@path` to read a file, or `-` to read stdin."),
    Flag.optional,
  ),
  clientRequestId: Flag.String("client-request-id").pipe(
    Flag.withDescription(
      "Idempotency key: retrying with the same id returns the original receipt.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Send one plain message to an agent as the machine participant this token is bound to.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const to = yield* requireFlag(flags.to, "--to");
        const rawMessage = yield* requireFlag(flags.message, "--message");
        const clientRequestId = yield* requireFlag(flags.clientRequestId, "--client-request-id");
        const message = yield* resolveMessage(rawMessage);
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "POST",
          path: J5_MACHINE_API_PATHS.send,
          body: { to, message, clientRequestId },
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const sent = yield* decodeReply(MachineSendResponse, reply.body);
        return {
          json: { ...sent },
          text: `Sent ${sent.result.messageId} to ${sent.receiver} as ${sent.sender} (durable at seq ${String(sent.result.durableAtSeq)}).`,
        } satisfies Outcome;
      }),
    ),
  ),
);

const formatRosterLine = (entry: A2ARosterEntry) =>
  [
    entry.kind,
    entry.participantId,
    entry.displayName ?? "-",
    entry.projectTitle ?? "-",
    entry.liveness === null ? "-" : `${entry.liveness.state}/${entry.liveness.runStatus}`,
    entry.archived ? "archived" : entry.canReceiveMessage ? "reachable" : "no-receive",
  ].join("\t");

const listCommand = Command.make("list", connectionFlags).pipe(
  Command.withDescription(
    "List every participant with its measured liveness: kind, id, display name, project, run state, reachability.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "GET",
          path: J5_MACHINE_API_PATHS.roster,
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const roster = yield* decodeReply(A2ARosterResponse, reply.body);
        return {
          json: { participants: roster.participants },
          text: roster.participants.map(formatRosterLine).join("\n"),
        } satisfies Outcome;
      }),
    ),
  ),
);

const whoamiCommand = Command.make("whoami", connectionFlags).pipe(
  Command.withDescription(
    "Show the machine participant this token is bound to, its project, and the server version.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "GET",
          path: J5_MACHINE_API_PATHS.whoami,
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const identity = yield* decodeReply(MachineWhoamiResponse, reply.body);
        return {
          json: { ...identity, origin },
          text: `${identity.participant.participantId} in project ${identity.participant.projectTitle} (${identity.participant.projectId}), server v${identity.server.version} at ${origin}`,
        } satisfies Outcome;
      }),
    ),
  ),
);

/** Runs against the local auth control plane, exactly like `j5 auth`; no server is needed. */
const withLocalEnvironmentAuth = Effect.fn("j5.a2a.cli.withLocalEnvironmentAuth")(function* <
  A,
  E,
  R,
>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.flatMap(EnvironmentAuth.EnvironmentAuth, run).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

/**
 * Runs `use` with an explicit token when one was given; otherwise, on the server
 * host, with a temporary local admin session that is revoked afterwards.
 */
const withAdminToken = Effect.fn("j5.a2a.cli.withAdminToken")(function* <A, E, R>(
  flags: ConnectionFlags,
  label: string,
  use: (token: string) => Effect.Effect<A, E, R>,
) {
  const explicitToken = yield* tryResolveToken(flags);
  if (Option.isSome(explicitToken) && explicitToken.value.length > 0) {
    return yield* use(explicitToken.value);
  }
  return yield* withLocalEnvironmentAuth(flags, (environmentAuth) =>
    Effect.acquireUseRelease(
      environmentAuth.issueSession({ scopes: AuthStandardClientScopes, label }),
      (issued) => use(issued.token),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    ),
  );
});

const participantCreateCommand = Command.make("create", {
  ...connectionFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("The id of the project the machine sends from. It never changes."),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription(
      "Server-unique name, 1-64 lowercase letters, digits, or hyphens; the id becomes machine:<name>.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Register a machine participant in a project. Needs an orchestration:operate token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const projectId = yield* requireFlag(flags.project, "--project");
        const name = yield* requireFlag(flags.name, "--name");
        const origin = yield* resolveOrigin(flags);
        const register = Effect.fn("j5.a2a.cli.register")(function* (token: string) {
          const reply = yield* callServer({
            origin,
            token,
            method: "POST",
            path: J5_MACHINE_API_PATHS.machineParticipants,
            body: { projectId, name },
            timeoutMs: flags.timeoutMs,
          });
          if (reply.status !== 200 && reply.status !== 201) {
            return yield* failureFromReply(reply, { conflictExitCode: A2A_EXIT_CODES.refused });
          }
          const registered = yield* decodeReply(RegisterMachineParticipantResponse, reply.body);
          return {
            json: { ...registered },
            text: `${registered.created ? "Registered" : "Already registered"} ${registered.participant.participantId} in project ${registered.participant.projectTitle}. Next: j5 a2a token issue --participant ${registered.participant.name}`,
          } satisfies Outcome;
        });
        return yield* withAdminToken(flags, "j5 a2a participant create", register);
      }),
    ),
  ),
);

const participantCommand = Command.make("participant").pipe(
  Command.withDescription("Manage machine participants."),
  Command.withSubcommands([participantCreateCommand]),
);

const normalizeMachineName = (value: string) =>
  value.startsWith(MACHINE_PARTICIPANT_ID_PREFIX)
    ? value.slice(MACHINE_PARTICIPANT_ID_PREFIX.length)
    : value;

const tokenIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  participant: Flag.String("participant").pipe(
    Flag.withDescription("The machine participant name (or machine:<name>) the token is bound to."),
    Flag.optional,
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "TTL such as `30d` or `1h`. Default: the auth control plane's session default.",
    ),
    Flag.optional,
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription("Label shown in Settings → Connections. Default: the participant id."),
    Flag.optional,
  ),
  tokenOnly: Flag.Boolean("token-only").pipe(
    Flag.withDescription("Print only the bearer token."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Issue a bearer token bound to a machine participant with only the a2a:send scope. Runs on the server host against the local auth database.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isNone(flags.participant)) {
        process.exitCode = A2A_EXIT_CODES.usage;
        return yield* Console.error("usage: --participant is required.");
      }
      const name = normalizeMachineName(flags.participant.value.trim());
      const participantId = machineParticipantIdForName(name);
      yield* withLocalEnvironmentAuth(flags, (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: [AuthA2ASendScope],
            subject: participantId,
            label: Option.getOrElse(flags.label, () => participantId),
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, { json: flags.json, tokenOnly: flags.tokenOnly }),
          );
        }),
      );
    }),
  ),
);

const tokenCommand = Command.make("token").pipe(
  Command.withDescription("Mint tokens for machine participants."),
  Command.withSubcommands([tokenIssueCommand]),
);

/** How messages travel, in the dialog's words. */
const peerLinkDescription = (peer: PeerRecord) =>
  peer.linkMode === "store"
    ? "polls this server for its messages"
    : peer.linkMode === "poll"
      ? `this server polls it at ${peer.origin ?? "?"}`
      : `sends directly both ways, at ${peer.origin ?? "?"}`;

/**
 * Polling stopped, online, offline since, or not polled yet, as Settings →
 * Connections words it; empty for a direct peer. A stopped poller makes no
 * claim about the last poll that worked.
 */
const peerPollHealth = (peer: PeerRecord, nowMs: number) => {
  const stopped = peerPollStoppedReason(peer);
  if (stopped !== null) return `polling stopped: ${stopped}`;
  const state = peerPollState(peer, nowMs);
  if (state === null) return "";
  if (state.kind === "never") {
    return peer.linkMode === "store" ? "has not polled yet" : "not polled yet";
  }
  return state.kind === "online"
    ? `online, last polled ${state.lastPolledAt}`
    : `offline since ${state.since}`;
};

const formatPeerLine = (peer: PeerRecord, nowMs: number) =>
  [
    peer.environmentId,
    peer.label,
    peerLinkDescription(peer),
    peer.createdAt,
    // A poller never holds a session from the server it polls, so it has no inbound to report.
    peer.linkMode === "poll"
      ? ""
      : peer.inboundSession === "active"
        ? "inbound: active"
        : "inbound: no live session",
    peer.credentialExpiresAt === null ? "" : `our credential expires ${peer.credentialExpiresAt}`,
    peerPollHealth(peer, nowMs),
    peer.waitingCount === 0
      ? ""
      : `${String(peer.waitingCount)} waiting since ${peer.oldestWaitingAt ?? "?"}`,
    peer.lastError === null || peerPollStoppedReason(peer) !== null
      ? ""
      : `last error: ${peer.lastError}`,
  ]
    .filter((part) => part.length > 0)
    .join("\t");

const peerCredentialCommand = Command.make("credential", {
  ...connectionFlags,
  for: Flag.String("for").pipe(
    Flag.withDescription("The environment id of the server that will hold this credential."),
    Flag.optional,
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription(
      "Shown in Settings → Connections as `Peer: <label>`. Default: the environment id.",
    ),
    Flag.optional,
  ),
  credentialOnly: Flag.Boolean("credential-only").pipe(
    Flag.withDescription("Print only the credential."),
    Flag.withDefault(false),
  ),
  store: Flag.Boolean("store").pipe(
    Flag.withDescription(
      "The holder cannot be reached and will poll this server, which stores its messages until it does. It is recorded as a peer when it first presents the credential.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Issue the credential another server presents when it delivers here: subject peer:<its environment id>, scope a2a:peer only. Issuing again for the same environment revokes the earlier credential. Needs an access:write token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const environmentId = yield* requireFlag(flags.for, "--for");
        const origin = yield* resolveOrigin(flags);
        return yield* withAdminToken(flags, "j5 a2a peer credential", (token) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "POST",
              path: J5_PEER_API_PATHS.credentials,
              body: {
                environmentId,
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
                ...(flags.store ? { store: true } : {}),
              },
              timeoutMs: flags.timeoutMs,
            });
            if (reply.status !== 201) return yield* failureFromReply(reply);
            const issued = yield* decodeReply(IssuePeerCredentialResponse, reply.body);
            return {
              json: { ...issued },
              text: flags.credentialOnly
                ? issued.credential
                : [
                    `Issued peer credential ${issued.sessionId} for ${issued.subject}; this server is environment ${issued.environmentId}.`,
                    `Credential: ${issued.credential}`,
                    `Expires at: ${issued.expiresAt}`,
                    `Next, on the other server: j5 a2a peer add --peer-origin ${origin} --credential <the credential above>${flags.store ? " --poll" : ""}`,
                  ].join("\n"),
            } satisfies Outcome;
          }),
        );
      }),
    ),
  ),
);

const peerAddCommand = Command.make("add", {
  ...connectionFlags,
  peerOrigin: Flag.String("peer-origin").pipe(
    Flag.withDescription(
      "The origin this server reaches the peer at, such as https://home.example:3773. It may differ from the one your client uses.",
    ),
    Flag.optional,
  ),
  credential: Flag.String("credential").pipe(
    Flag.withDescription(
      "The credential the peer issued for this environment (`j5 a2a peer credential` there).",
    ),
    Flag.optional,
  ),
  credentialFile: Flag.String("credential-file").pipe(
    Flag.withDescription("File holding that credential."),
    Flag.optional,
  ),
  replaceOrigin: Flag.Boolean("replace-origin").pipe(
    Flag.withDescription(
      "Move a known peer to a new origin. Without it, re-adding a peer at a different origin is refused, because hello proves reachability, not identity.",
    ),
    Flag.withDefault(false),
  ),
  poll: Flag.Boolean("poll").pipe(
    Flag.withDescription(
      "This server cannot be reached, so it polls the peer for its messages. The peer must have issued the credential with --store.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Record a peer after proving the credential at its origin. Re-adding a known peer rotates its credential; a different origin needs --replace-origin. Needs an access:write token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const peerOrigin = (yield* requireFlag(flags.peerOrigin, "--peer-origin")).replace(
          /\/+$/,
          "",
        );
        const credential = yield* resolvePeerCredential(flags.credential, flags.credentialFile);
        const origin = yield* resolveOrigin(flags);
        return yield* withAdminToken(flags, "j5 a2a peer add", (token) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "POST",
              path: J5_PEER_API_PATHS.peers,
              body: {
                origin: peerOrigin,
                credential,
                ...(flags.replaceOrigin ? { replaceOrigin: true } : {}),
                ...(flags.poll ? { poll: true } : {}),
              },
              timeoutMs: Math.max(flags.timeoutMs, 10_000),
            });
            if (reply.status !== 200 && reply.status !== 201) {
              return yield* failureFromReply(reply, { conflictExitCode: A2A_EXIT_CODES.refused });
            }
            const added = yield* decodeReply(AddPeerResponse, reply.body);
            return {
              json: { ...added },
              text:
                added.peer.linkMode === "poll"
                  ? `${added.created ? "Recorded" : "Updated"} peer ${added.peer.label} (${added.peer.environmentId}) at ${added.peer.origin}. This server polls it for its messages and sends to it directly; nothing more to run on that server.`
                  : `${added.created ? "Recorded" : "Updated"} peer ${added.peer.label} (${added.peer.environmentId}) at ${added.peer.origin}. Peering is mutual: run the matching \`peer credential\` and \`peer add\` on that server too.`,
            } satisfies Outcome;
          }),
        );
      }),
    ),
  ),
);

const resolvePeerCredential = Effect.fn("j5.a2a.cli.resolvePeerCredential")(function* (
  direct: Option.Option<string>,
  file: Option.Option<string>,
) {
  if (Option.isSome(direct)) return direct.value.trim();
  if (Option.isNone(file)) return yield* usage("--credential or --credential-file is required.");
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(file.value)
    .pipe(Effect.mapError(() => usage(`Could not read the credential file ${file.value}.`)));
  return contents.trim();
});

const peerListCommand = Command.make("list", connectionFlags).pipe(
  Command.withDescription(
    "List recorded peers: environment id, the peer's own name, how messages travel, recorded at, the session it holds here, when the credential it issued expires, its last poll, what waits for it, and the last error. Needs an access:read token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        return yield* withAdminToken(flags, "j5 a2a peer list", (token) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "GET",
              path: J5_PEER_API_PATHS.peers,
              timeoutMs: flags.timeoutMs,
            });
            if (reply.status !== 200) return yield* failureFromReply(reply);
            const listed = yield* decodeReply(PeerListResponse, reply.body);
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
            return {
              json: { peers: listed.peers },
              text:
                listed.peers.length === 0
                  ? "No peers recorded."
                  : listed.peers.map((peer) => formatPeerLine(peer, nowMs)).join("\n"),
            } satisfies Outcome;
          }),
        );
      }),
    ),
  ),
);

const peerRemoveCommand = Command.make("remove", {
  ...connectionFlags,
  environment: Flag.String("environment").pipe(
    Flag.withDescription("The peer's environment id, from `j5 a2a peer list`."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Remove a peer and revoke the credential it held for this server; delivery ends in both directions. Messages still waiting for it are cancelled and open Exchanges with its agents are dropped, and each agent here that was involved is told. Needs an access:write token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const environmentId = yield* requireFlag(flags.environment, "--environment");
        const origin = yield* resolveOrigin(flags);
        return yield* withAdminToken(flags, "j5 a2a peer remove", (token) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "POST",
              path: J5_PEER_API_PATHS.remove,
              body: { environmentId },
              timeoutMs: flags.timeoutMs,
            });
            if (reply.status !== 200) return yield* failureFromReply(reply);
            const removed = yield* decodeReply(RemovePeerResponse, reply.body);
            return {
              json: { ...removed },
              text: removed.removed
                ? `Removed peer ${environmentId} and revoked ${String(removed.revokedSessions)} session(s) it held.`
                : `No peer ${environmentId} was recorded; revoked ${String(removed.revokedSessions)} session(s) it held.`,
            } satisfies Outcome;
          }),
        );
      }),
    ),
  ),
);

const peerMoveCommand = Command.make("move", {
  ...connectionFlags,
  environment: Flag.String("environment").pipe(
    Flag.withDescription("The peer's environment id, from `j5 a2a peer list`."),
    Flag.optional,
  ),
  peerOrigin: Flag.String("peer-origin").pipe(
    Flag.withDescription(
      "The origin this server now reaches the peer at. It may differ from the one your client uses.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Change the origin this server reaches a peer at, once the peer answers there to the credential this server already holds for it. Nothing is revoked or cancelled. Needs an access:write token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const environmentId = yield* requireFlag(flags.environment, "--environment");
        const peerOrigin = (yield* requireFlag(flags.peerOrigin, "--peer-origin")).replace(
          /\/+$/,
          "",
        );
        const origin = yield* resolveOrigin(flags);
        return yield* withAdminToken(flags, "j5 a2a peer move", (token) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "POST",
              path: J5_PEER_API_PATHS.origin,
              body: { environmentId, origin: peerOrigin },
              timeoutMs: Math.max(flags.timeoutMs, 10_000),
            });
            if (reply.status !== 200) {
              return yield* failureFromReply(reply, { conflictExitCode: A2A_EXIT_CODES.refused });
            }
            const changed = yield* decodeReply(ChangePeerOriginResponse, reply.body);
            return {
              json: { ...changed },
              text: `This server now reaches ${changed.peer.label} (${changed.peer.environmentId}) at ${changed.peer.origin}.`,
            } satisfies Outcome;
          }),
        );
      }),
    ),
  ),
);

const peerIdentityCommand = Command.make("identity", {
  ...authLocationFlags,
  origin: originFlag,
  timeoutMs: timeoutFlag,
  json: jsonFlag,
  token: tokenFlag,
  tokenFile: tokenFileFlag,
}).pipe(
  Command.withDescription(
    "Print this server's environment id, the value the other server passes to `peer credential --for`. Reads the public environment descriptor; no token is needed.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        const client = yield* HttpClient.HttpClient;
        const reply = yield* client
          .execute(
            HttpClientRequest.get(`${origin}/.well-known/t3/environment`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          .pipe(
            Effect.timeout(Duration.millis(flags.timeoutMs)),
            Effect.flatMap((response) => response.json),
            Effect.mapError(requestFailure(`the environment descriptor at ${origin}`)),
          );
        const descriptor = isRecord(reply) ? reply : {};
        const environmentId =
          typeof descriptor.environmentId === "string" ? descriptor.environmentId : null;
        if (environmentId === null) {
          return yield* new A2ACliFailure({
            exitCode: A2A_EXIT_CODES.failure,
            error: "unexpected_response",
            message: `${origin} did not answer with an environment id.`,
          });
        }
        const label = typeof descriptor.label === "string" ? descriptor.label : null;
        return {
          json: { environmentId, label, origin },
          text: environmentId,
        } satisfies Outcome;
      }),
    ),
  ),
);

const peerCommand = Command.make("peer").pipe(
  Command.withDescription("Peer this server with another so their agents can exchange messages."),
  Command.withSubcommands([
    peerIdentityCommand,
    peerCredentialCommand,
    peerAddCommand,
    peerListCommand,
    peerMoveCommand,
    peerRemoveCommand,
  ]),
);

export const a2aCommand = Command.make("a2a").pipe(
  Command.withDescription(
    "Send and inspect agent-to-agent messages from scripts, as a registered machine participant.",
  ),
  Command.withSubcommands([
    sendCommand,
    listCommand,
    whoamiCommand,
    participantCommand,
    tokenCommand,
    peerCommand,
  ]),
);
