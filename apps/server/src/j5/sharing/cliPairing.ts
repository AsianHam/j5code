import {
  type AuthEnvironmentScope,
  AuthAccessWriteScope,
  AuthGrantScope,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  type CliPairingRequest,
  CliPairingResponse,
  J5_CLI_PAIRING_PATH,
  type PersonLevel,
  type PersonScope,
  devicePermissions,
  highestLevel,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerAlreadyRunningError, acquireServerOwnership } from "../../serverOwnership.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { Access } from "./Access.ts";
import { cliEnvironmentAuth } from "./AccessGate.ts";
import { requireScope } from "./Links.ts";
import { PairingIntents } from "./PairingIntents.ts";
import { checkedPersonName } from "./personNames.ts";
import {
  type HeldLevel,
  OwnerOutsideServerError,
  PersonAccess,
  personNameKey,
} from "./PersonAccess.ts";

/**
 * `j5 pair` and `j5 auth pairing create` name the person a device is for (register D36, People
 * and access AC4). Upstream's commands carry these flags and make their link through
 * `pairingLinkForPerson` (FORK.md case 79). A name that matches someone makes the link for them
 * at their levels; one that matches no one creates that person at the level and scope given.
 * Upstream's `--scope` keeps its meaning: it narrows the device's permissions within the level,
 * and becomes the device's ceiling.
 *
 * `j5 pair` refuses without `--person`. `j5 auth pairing create` without it makes upstream's own
 * link, for a device the server will ask about: upstream's desktop app runs that bare command on
 * a host it reaches over SSH, and knows no one's name there. Such a device reaches nothing until
 * it says whose it is (AC5), so it never silently belongs to someone the server assumed.
 *
 * While a server runs for the home, the commands ask it to make the link
 * (`CliPairingHttp.ts`): only the running server can tell open clients, such as a People page,
 * that someone was added. With none running, they write the database themselves, holding the
 * home's server lock (`serverOwnership.ts`) so that none starts meanwhile.
 */

export const personPairingFlags = {
  person: Flag.String("person").pipe(
    Flag.withDescription(
      "Who the device is for. A name already on the server pairs a device for that person; a new name adds them, with --level.",
    ),
    Flag.optional,
  ),
  level: Flag.Literals("level", ["viewer", "collaborator", "owner"]).pipe(
    Flag.withDescription("The level a new person is added at. Needed only for a new person."),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("Add a new person at this project's scope rather than the server's."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Add a new person at this thread's scope rather than the server's."),
    Flag.optional,
  ),
};

/** The permissions `--scope` asked for, or the command's default, and whether it was given. */
export interface PairingScopes {
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  readonly given: boolean;
}

/**
 * Upstream's `--scope` flag (`cli/authScopes.ts`), which also says whether it was given at all:
 * given, it is the device's ceiling; left out, the device follows its person's level, whatever
 * upstream's default is.
 */
export const pairingScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  Flag.Literals("scope", AuthGrantScope.literals).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes): PairingScopes => ({
      scopes: [...new Set(scopes.length > 0 ? scopes : defaults)],
      given: scopes.length > 0,
    })),
  );

export interface PersonPairingFlags {
  readonly person: Option.Option<string>;
  readonly level: Option.Option<PersonLevel>;
  readonly project: Option.Option<string>;
  readonly thread: Option.Option<string>;
}

export class PairingPersonError extends Schema.TaggedError<PairingPersonError>()(
  "PairingPersonError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * A name that matches no one, given without the level a new person needs. Its own tag, so the
 * live-test rig's `guest` can tell it apart from every other refusal and add the person instead.
 */
export class PairingPersonUnknownError extends Schema.TaggedError<PairingPersonUnknownError>()(
  "PairingPersonUnknownError",
  { personName: Schema.String },
) {
  override get message(): string {
    return `No one on this server is called ${this.personName}. To add them, give --level (viewer, collaborator or owner), with --project or --thread for a scope narrower than the server.`;
  }
}

const LEVEL_NAMES: Record<PersonLevel, string> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  owner: "Owner",
};

/** Makes a pairing link for the person `--person` names, and says what it did. */
export const pairingLinkForPerson = Effect.fn("j5.sharing.cliPairing.pairingLinkForPerson")(
  function* <L extends { readonly id: string; readonly credential: string }, E, R>(input: {
    readonly flags: PersonPairingFlags;
    readonly scopes: PairingScopes;
    readonly mint: (scopes: ReadonlyArray<AuthEnvironmentScope>) => Effect.Effect<L, E, R>;
    /** What a link without `--person` is: refused, or one for a device the server will ask about. */
    readonly withoutPerson: "refuse" | "ask";
  }) {
    const sql = yield* SqlClient.SqlClient;
    const people = yield* PersonAccess;
    const access = yield* Access;
    const intents = yield* PairingIntents;
    const refuse = (reason: string) => Effect.fail(new PairingPersonError({ reason }));

    const titleOf = (scope: PersonScope) =>
      scope.kind === "server"
        ? Effect.succeed("the server")
        : (scope.kind === "project"
            ? sql<{ readonly title: string }>`
                SELECT title FROM projection_projects WHERE project_id = ${scope.projectId}
              `
            : sql<{ readonly title: string }>`
                SELECT title FROM orchestration_v2_projection_threads
                WHERE thread_id = ${scope.threadId}
              `
          ).pipe(Effect.map((rows) => `${scope.kind} "${rows[0]?.title ?? "?"}"`));
    const describeLevels = (levels: ReadonlyArray<HeldLevel>) =>
      levels.length === 0
        ? Effect.succeed("no level")
        : Effect.forEach(levels, (held) =>
            titleOf(held.scope).pipe(
              Effect.map((title) => `${LEVEL_NAMES[held.level]} on ${title}`),
            ),
          ).pipe(Effect.map((parts) => parts.join(", ")));

    const everyone = yield* people.listPeople;
    const { flags } = input;
    if (
      Option.isNone(flags.person) &&
      input.withoutPerson === "ask" &&
      Option.isNone(flags.level) &&
      Option.isNone(flags.project) &&
      Option.isNone(flags.thread)
    ) {
      // Upstream's link as upstream makes it, with no record of a person.
      return {
        link: yield* input.mint(input.scopes.scopes),
        said: "Made a link for a device the server does not know yet: whoever pairs it is asked who they are before they can use anything.",
      };
    }
    if (Option.isNone(flags.person)) {
      const named = yield* Effect.forEach(
        everyone.filter((record) => record.person.displayName !== null),
        (record) =>
          describeLevels(record.levels).pipe(
            Effect.map((levels) => `  ${record.person.displayName} (${levels})`),
          ),
      );
      return yield* refuse(
        [
          "Name the person this device is for with --person.",
          ...(named.length === 0 ? [] : ["People on this server:", ...named]),
          "A name that matches no one adds that person; give --level with it.",
        ].join("\n"),
      );
    }
    const name = yield* checkedPersonName(flags.person.value);
    const ceiling = input.scopes.given ? input.scopes.scopes : null;
    // The link and the record of whose it is commit together: a link made without it would pair
    // a device the server could not place. Upstream's link is written through the same database
    // client (`cliEnvironmentAuth` builds both over one runtime).
    const mintFor = (personId: ParticipantId, levels: ReadonlyArray<HeldLevel>) =>
      Effect.gen(function* () {
        const granted = devicePermissions(highestLevel(levels.map((held) => held.level)), ceiling);
        if (granted.length === 0) {
          return yield* refuse(`--scope gives nothing within ${name}'s level.`);
        }
        const link = yield* input.mint(granted);
        yield* intents.record({
          pairingLinkId: link.id,
          credential: link.credential,
          personId,
          linkId: null,
          ceiling,
        });
        return link;
      });
    const existing = everyone.find(
      (record) =>
        record.person.displayName !== null &&
        personNameKey(record.person.displayName) === personNameKey(name),
    );

    if (existing !== undefined) {
      if (
        Option.isSome(flags.level) ||
        Option.isSome(flags.project) ||
        Option.isSome(flags.thread)
      ) {
        return yield* refuse(
          `${existing.person.displayName} is already on this server. Change what they reach from the People page, or leave out --level, --project and --thread to pair a device for them.`,
        );
      }
      const link = yield* sql.withTransaction(mintFor(existing.person.personId, existing.levels));
      const levels = yield* describeLevels(existing.levels);
      return { link, said: `Made a link for ${existing.person.displayName} (${levels}).` };
    }

    if (Option.isNone(flags.level)) {
      return yield* new PairingPersonUnknownError({ personName: name });
    }
    if (Option.isSome(flags.project) && Option.isSome(flags.thread)) {
      return yield* refuse("Give --project or --thread, not both.");
    }
    const scope: PersonScope = Option.isSome(flags.project)
      ? { kind: "project", projectId: ProjectId.make(flags.project.value) }
      : Option.isSome(flags.thread)
        ? { kind: "thread", threadId: ThreadId.make(flags.thread.value) }
        : { kind: "server" };
    const level = flags.level.value;
    if (level === "owner" && scope.kind !== "server") return yield* new OwnerOutsideServerError({});
    yield* requireScope(sql, scope);
    // The person, their level and their link commit together, so a failure leaves no one behind.
    const made = yield* sql.withTransaction(
      Effect.gen(function* () {
        const person = yield* people.createPerson({ displayName: name });
        yield* access.setLevel({ personId: person.personId, scope, level });
        return yield* mintFor(person.personId, [{ scope, level }]);
      }),
    );
    const levels = yield* describeLevels([{ scope, level }]);
    return { link: made, said: `Added ${name} (${levels}), and made a link for them.` };
  },
);

/** The subject upstream gives a session the CLI issues; the pairing route answers only it. */
export const CLI_SESSION_SUBJECT = "cli-issued-session";

/** How long the session the CLI asks a running server with may live, should revoking it fail. */
const CLI_SESSION_TTL = Duration.minutes(2);
const LIVE_SERVER_TIMEOUT = Duration.seconds(10);

/** A server holds the home but could not be reached, so nothing was written. */
export class PairingServerUnreachableError extends Schema.TaggedError<PairingServerUnreachableError>()(
  "PairingServerUnreachableError",
  { origin: Schema.NullOr(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.origin === null
      ? "A J5 Code server holds this home but has not said where it listens yet, so nothing was written. Retry once it has started."
      : `A J5 Code server is running for this home at ${this.origin}, but it did not answer, so nothing was written. Retry once it answers, or stop it.`;
  }
}

/** The running server was asked, but its answer never arrived, so it may have made the change. */
export class PairingServerUnconfirmedError extends Schema.TaggedError<PairingServerUnconfirmedError>()(
  "PairingServerUnconfirmedError",
  { origin: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The server at ${this.origin} was asked to make the link, but its answer did not arrive, so it may have added the person and made the link. Check the People page or \`j5 auth pairing list\` before you retry.`;
  }
}

/** Upstream's bounded wait for a starting server to say where it listens (`cli/pair.ts`). */
export interface RuntimeFileActivation {
  readonly attempts: number;
  readonly delay: Duration.Duration;
  readonly wait: (duration: Duration.Duration) => Effect.Effect<void>;
}

/** The running server could not make the link, for a reason that is not one of the flags'. */
export class PairingServerError extends Schema.TaggedError<PairingServerError>()(
  "PairingServerError",
  { origin: Schema.String, status: Schema.Number, reason: Schema.String },
) {
  override get message(): string {
    return `The server at ${this.origin} did not make the link (HTTP ${String(this.status)}): ${this.reason}`;
  }
}

const decodeResponse = Schema.decodeUnknownEffect(CliPairingResponse);
const isServerAlreadyRunning = Schema.is(ServerAlreadyRunningError);

// Errors that mean the request never reached the server: anything else may come after it did.
const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const neverConnected = (cause: unknown): boolean => {
  for (let at = cause, depth = 0; typeof at === "object" && at !== null && depth < 4; depth += 1) {
    if ("code" in at && typeof at.code === "string" && NOT_CONNECTED_CODES.has(at.code)) {
      return true;
    }
    at = "cause" in at ? at.cause : undefined;
  }
  return false;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const field = (body: unknown, name: string) =>
  typeof body === "object" && body !== null && name in body
    ? (body as Record<string, unknown>)[name]
    : undefined;

/** Asks the running server at `origin` to make the link, with a session revoked afterwards. */
const pairThroughServer = (input: {
  readonly origin: string;
  readonly request: CliPairingRequest;
}) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const client = yield* HttpClient.HttpClient;
    const call = (token: string) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(
          new URL(J5_CLI_PAIRING_PATH, input.origin).toString(),
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJson(input.request),
        );
        // The timeout covers the body too: a server that stalls mid-answer must not hold the CLI,
        // or its session, open.
        return yield* Effect.gen(function* () {
          const response = yield* client.execute(request);
          // An older server's 404 need not be JSON.
          const body = parseJson(yield* response.text);
          return { status: response.status, body };
        }).pipe(
          Effect.timeout(LIVE_SERVER_TIMEOUT),
          Effect.mapError((cause) =>
            cause._tag === "HttpClientError" &&
            cause.reason._tag === "TransportError" &&
            neverConnected(cause.reason.cause)
              ? new PairingServerUnreachableError({ origin: input.origin, cause })
              : new PairingServerUnconfirmedError({ origin: input.origin, cause }),
          ),
        );
      }).pipe(
        Effect.catchTags({
          HttpBodyError: (cause) =>
            Effect.fail(new PairingServerUnreachableError({ origin: input.origin, cause })),
        }),
      );
    const reply = yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes: [AuthAccessWriteScope],
        label: "j5 pair cli",
        ttl: CLI_SESSION_TTL,
      }),
      (issued) => call(issued.token),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
    if (reply.status !== 200) {
      const error = field(reply.body, "error");
      const message = field(reply.body, "message");
      const personName = field(reply.body, "personName");
      if (error === "PairingPersonUnknownError" && typeof personName === "string") {
        return yield* new PairingPersonUnknownError({ personName });
      }
      const reason =
        typeof message === "string"
          ? message
          : reply.status === 404
            ? "it does not take links from the CLI. It may be an older build: restart it on this one."
            : "it gave no reason.";
      return yield* reply.status === 400 && typeof error === "string" && error !== "invalid_request"
        ? new PairingPersonError({ reason })
        : new PairingServerError({ origin: input.origin, status: reply.status, reason });
    }
    const made = yield* decodeResponse(reply.body).pipe(
      Effect.mapError(
        () =>
          new PairingServerError({
            origin: input.origin,
            status: reply.status,
            reason: "it answered in a shape this CLI does not read.",
          }),
      ),
    );
    const link: EnvironmentAuth.IssuedPairingLink = {
      id: made.id,
      credential: made.credential,
      scopes: made.scopes,
      subject: "one-time-token",
      ...(made.label === undefined ? {} : { label: made.label }),
      createdAt: DateTime.makeUnsafe(made.createdAt),
      expiresAt: DateTime.makeUnsafe(made.expiresAt),
    };
    return { link, said: made.said };
  });

/**
 * What `j5 pair` and `j5 auth pairing create` run: the link for the person the flags name, made
 * by the server running for the home in `config`, or written here when none is.
 */
export const pairingLinkFromCli = Effect.fn("j5.sharing.cliPairing.pairingLinkFromCli")(
  function* (input: {
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly minimumLogLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
    readonly flags: PersonPairingFlags;
    readonly scopes: PairingScopes;
    readonly ttl: Option.Option<Duration.Duration>;
    readonly label: Option.Option<string>;
    readonly withoutPerson: "refuse" | "ask";
    readonly activation: RuntimeFileActivation;
  }) {
    const { config } = input;
    const runtime = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
      layer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, input.minimumLogLevel)),
      );
    // The lock is what tells whether a server holds the home, a starting one included.
    const owned = yield* Effect.result(
      acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.provide(ProcessRunner.layer),
      ),
    );
    if (owned._tag === "Failure") {
      if (!isServerAlreadyRunning(owned.failure)) return yield* owned.failure;
      // A server says where it listens only once it has started, a moment after taking the lock,
      // and the file a crashed one left behind stays until then.
      let origin: string | null = null;
      for (let attempt = 1; origin === null; attempt += 1) {
        const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isSome(state) && isProcessAlive(state.value.pid)) {
          origin = state.value.origin;
        } else if (attempt >= input.activation.attempts) {
          return yield* new PairingServerUnreachableError({ origin: null });
        } else {
          yield* input.activation.wait(input.activation.delay);
        }
      }
      return yield* pairThroughServer({
        origin,
        request: {
          ...(Option.isSome(input.flags.person) ? { person: input.flags.person.value } : {}),
          ...(Option.isSome(input.flags.level) ? { level: input.flags.level.value } : {}),
          ...(Option.isSome(input.flags.project) ? { project: input.flags.project.value } : {}),
          ...(Option.isSome(input.flags.thread) ? { thread: input.flags.thread.value } : {}),
          scopes: input.scopes.scopes,
          scopesGiven: input.scopes.given,
          ...(Option.isSome(input.ttl) ? { ttlMs: Duration.toMillis(input.ttl.value) } : {}),
          ...(Option.isSome(input.label) ? { label: input.label.value } : {}),
          withoutPerson: input.withoutPerson,
        },
      }).pipe(
        Effect.provide(
          runtime(EnvironmentAuth.layerRuntime).pipe(Layer.merge(FetchHttpClient.layer)),
        ),
      );
    }
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* pairingLinkForPerson({
        flags: input.flags,
        scopes: input.scopes,
        withoutPerson: input.withoutPerson,
        mint: (scopes) =>
          environmentAuth.createPairingLink({
            scopes,
            subject: "one-time-token",
            ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
            ...(Option.isSome(input.label) ? { label: input.label.value } : {}),
          }),
      });
    }).pipe(Effect.provide(runtime(cliEnvironmentAuth(EnvironmentAuth.layerRuntime))));
  },
  Effect.scoped,
);
