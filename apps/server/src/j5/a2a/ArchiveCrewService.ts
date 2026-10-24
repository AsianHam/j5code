import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  ArchiveAgentService,
  type ArchiveAgentConsequenceFacts,
  type ArchiveAgentError,
  type ArchiveAgentResult,
} from "./ArchiveAgentService.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const TOKEN_VERSION = "j5-crew-archive-confirmation/v1" as const;
const TOKEN_SECRET_NAME = "j5-a2a-archive-confirmation-v1";
const TOKEN_SECRET_BYTES = 32;

/** One member's consequences, keyed by seat so the Captain can see who is waiting on whom. */
export interface ArchiveCrewMemberFacts {
  readonly seatName: string;
  readonly participantId: ParticipantId;
  readonly threadId: ThreadId;
  readonly alreadyArchived: boolean;
  /**
   * The seat's row was recorded but its thread never came to exist (a launch or addition that
   * failed before reaching it). Nothing runs there, so the unit retires past it.
   */
  readonly neverCreated: boolean;
  readonly facts: ArchiveAgentConsequenceFacts;
}

export interface ArchiveCrewConsequenceFacts {
  readonly members: ReadonlyArray<ArchiveCrewMemberFacts>;
}

export interface ArchiveCrewInput {
  readonly providerSessionId: string;
  /** The Captain calling over MCP, or null when a person archives the Crew from the app. */
  readonly callerParticipantId: ParticipantId | null;
  /** The project the caller named; null when the person's route only knows the Crew. */
  readonly projectId: LedgerProjectId | null;
  readonly crewInstanceId: string;
  readonly clientRequestKey: string;
  readonly confirmationToken?: string;
  /**
   * The person already confirmed a dialog that listed every seat's consequences, so no token is
   * issued or checked. Never set on the Captain's path, where the signed token is the confirmation.
   */
  readonly confirmationSatisfied?: boolean;
  readonly archivedAt: string;
  /** Set by the Captain cascade: the Crew comes back when its Captain is unarchived. */
  readonly withCaptain?: boolean;
  /** Per-seat command ids derive from the caller's request key so retries replay each member. */
  readonly commandIds: (seatName: string) => {
    readonly interruptCommandId: CommandId;
    readonly archiveCommandId: CommandId;
  };
}

export interface ArchiveCrewMemberResult {
  readonly seatName: string;
  readonly participantId: ParticipantId;
  readonly result: ArchiveAgentResult | "never_created";
}

export interface ArchiveCrewOutcome {
  readonly status: ArchiveAgentResult;
  readonly members: ReadonlyArray<ArchiveCrewMemberResult>;
}

export class ArchiveCrewNotFoundError extends Data.TaggedError("ArchiveCrewNotFoundError")<{
  readonly crewInstanceId: string;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} is not recorded in this environment. Call j5_list_participants to inspect the roster; only Crews launched from an approved roster can be archived as a unit.`;
  }
}

export class ArchiveCrewNotCaptainError extends Data.TaggedError("ArchiveCrewNotCaptainError")<{
  readonly crewInstanceId: string;
  readonly captainParticipantId: ParticipantId;
  readonly callerParticipantId: ParticipantId;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} is commanded by ${this.captainParticipantId}, not by ${this.callerParticipantId}. Only the Captain archives a Crew (R19); send the Captain an ask instead.`;
  }
}

export class ArchiveCrewProjectMismatchError extends Data.TaggedError(
  "ArchiveCrewProjectMismatchError",
)<{
  readonly crewInstanceId: string;
  readonly projectId: LedgerProjectId;
  readonly expected: LedgerProjectId;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} lives in project ${this.expected}, and the caller is in project ${this.projectId}. A Captain archives a Crew from the Crew's own project.`;
  }
}

export class ArchiveCrewConfirmationRequiredError extends Data.TaggedError(
  "ArchiveCrewConfirmationRequiredError",
)<{ readonly facts: ArchiveCrewConsequenceFacts; readonly confirmationToken: string }> {
  override get message(): string {
    const waiting = this.facts.members.reduce(
      (count, member) => count + member.facts.openExchanges.length,
      0,
    );
    const running = this.facts.members.filter((member) => member.facts.runningTurn !== null).length;
    return `Archiving this Crew would end active work: ${waiting} open exchange(s) and ${running} running turn(s) across its seats. Review every listed member fact, check with the user before retiring a Crew that others are waiting on, then retry j5_archive_crew with the confirmation_token.`;
  }
}

export class ArchiveCrewConfirmationStaleError extends Data.TaggedError(
  "ArchiveCrewConfirmationStaleError",
)<{ readonly facts: ArchiveCrewConsequenceFacts; readonly confirmationToken: string | null }> {
  override get message(): string {
    return this.confirmationToken === null
      ? "The confirmation_token is stale because the Crew no longer has consequential work. Retry j5_archive_crew without a token."
      : "The confirmation_token is stale because the Crew's facts changed. Review the current member facts and retry j5_archive_crew with the new confirmation_token.";
  }
}

export class ArchiveCrewConfirmationTokenError extends Data.TaggedError(
  "ArchiveCrewConfirmationTokenError",
)<{ readonly reason: "malformed" | "unsupported-version" }> {
  override get message(): string {
    return this.reason === "unsupported-version"
      ? "The confirmation_token uses an unsupported version. Call j5_archive_crew without a token to receive a current refusal."
      : "The confirmation_token is malformed or has an invalid signature. Call j5_archive_crew without a token to receive a current refusal.";
  }
}

export class ArchiveCrewPartialFailureError extends Data.TaggedError(
  "ArchiveCrewPartialFailureError",
)<{
  readonly crewInstanceId: string;
  readonly archivedSeats: ReadonlyArray<string>;
  readonly failedSeat: string;
  readonly cause: ArchiveAgentError | unknown;
}> {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `j5_archive_crew retired seat(s) ${this.archivedSeats.join(", ") || "none"} of Crew ${this.crewInstanceId} but stopped at seat ${this.failedSeat}: ${cause} Retry j5_archive_crew with the same client_request_id and confirmation_token; retired seats replay as already archived and the rest continue.`;
  }
}

export type ArchiveCrewError =
  | ArchiveCrewNotFoundError
  | ArchiveCrewNotCaptainError
  | ArchiveCrewProjectMismatchError
  | ArchiveCrewConfirmationRequiredError
  | ArchiveCrewConfirmationStaleError
  | ArchiveCrewConfirmationTokenError
  | ArchiveCrewPartialFailureError;

const TokenMember = Schema.Struct({
  seat: Schema.String,
  participant_id: ParticipantId,
  open_exchange_ids: Schema.Array(Schema.String),
  running_turn_id: Schema.NullOr(Schema.String),
});
const TokenPayload = Schema.Struct({
  version: Schema.Literal(TOKEN_VERSION),
  provider_session_id: Schema.String,
  caller_participant_id: Schema.NullOr(ParticipantId),
  project_id: Schema.NullOr(LedgerProjectId),
  crew_instance_id: Schema.String,
  members: Schema.Array(TokenMember),
});
type TokenPayload = typeof TokenPayload.Type;
const TokenPayloadJson = Schema.fromJsonString(TokenPayload);
const decodeTokenPayloadJson = Schema.decodeUnknownEffect(TokenPayloadJson);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeTokenPayloadJson = Schema.encodeSync(TokenPayloadJson);

const payloadFor = (input: ArchiveCrewInput, facts: ArchiveCrewConsequenceFacts): TokenPayload => ({
  version: TOKEN_VERSION,
  provider_session_id: input.providerSessionId,
  caller_participant_id: input.callerParticipantId,
  project_id: input.projectId,
  crew_instance_id: input.crewInstanceId,
  members: facts.members.map((member) => ({
    seat: member.seatName,
    participant_id: member.participantId,
    open_exchange_ids: member.facts.openExchanges
      .map((exchange) => String(exchange.exchangeId))
      .toSorted(),
    running_turn_id:
      member.facts.runningTurn === null ? null : String(member.facts.runningTurn.runId),
  })),
});

const hasConsequences = (facts: ArchiveCrewConsequenceFacts) =>
  facts.members.some(
    (member) => member.facts.openExchanges.length > 0 || member.facts.runningTurn !== null,
  );

/** Retrying after a partial archive sees fewer consequences, never new ones; that still counts as confirmed. */
const isForwardOnlyRecovery = (confirmed: TokenPayload, current: TokenPayload): boolean => {
  if (
    confirmed.provider_session_id !== current.provider_session_id ||
    confirmed.caller_participant_id !== current.caller_participant_id ||
    confirmed.project_id !== current.project_id ||
    confirmed.crew_instance_id !== current.crew_instance_id
  ) {
    return false;
  }
  return current.members.every((member) => {
    const before = confirmed.members.find((candidate) => candidate.seat === member.seat);
    if (before === undefined) return false;
    const confirmedExchanges = new Set(before.open_exchange_ids);
    return (
      member.open_exchange_ids.every((id) => confirmedExchanges.has(id)) &&
      (member.running_turn_id === null || member.running_turn_id === before.running_turn_id)
    );
  });
};

/** One live Crew a Captain commands, with every seat's consequences, for the person's archive dialog. */
export interface ArchiveCrewCaptainFacts {
  readonly instance: AgentCrewInstance;
  readonly facts: ArchiveCrewConsequenceFacts;
}

export interface ArchiveCrewServiceShape {
  readonly archive: (
    input: ArchiveCrewInput,
  ) => Effect.Effect<ArchiveCrewOutcome, ArchiveCrewError>;
  /**
   * The live Crews directly under a Captain and their seats' open Exchanges and running turns,
   * read without mutation. A Captain is never archived alone (Crews AC17), so the person's
   * archive dialog shows these before the Crews retire ahead of their Captain.
   */
  readonly readCaptainFacts: (input: {
    readonly projectId: LedgerProjectId;
    readonly captainParticipantId: ParticipantId;
  }) => Effect.Effect<ReadonlyArray<ArchiveCrewCaptainFacts>, ArchiveCrewPartialFailureError>;
}

export class ArchiveCrewService extends Context.Service<
  ArchiveCrewService,
  ArchiveCrewServiceShape
>()("t3/j5/a2a/ArchiveCrewService") {}

/**
 * Crews archive only as a unit (R14) and only by their Captain (R19). The Captain sees every
 * member's open Exchanges and running turn in one refusal, confirms once with a signed token over
 * those facts, and then each member retires through the ordinary single-agent archive with its own
 * confirmation already satisfied. The platform composes nothing for a successor; it only records.
 */
export const layer = Layer.effect(
  ArchiveCrewService,
  Effect.gen(function* () {
    const archiveAgent = yield* ArchiveAgentService;
    const crews = yield* AgentCrewInstanceService;
    const playbooks = yield* PlaybookStore;
    const secrets = yield* ServerSecretStore;
    const secret = secrets
      .getOrCreateRandom(TOKEN_SECRET_NAME, TOKEN_SECRET_BYTES)
      .pipe(Effect.orDie);

    const issueToken = Effect.fn("j5.a2a.archiveCrew.issueToken")(function* (
      payload: TokenPayload,
    ) {
      const encoded = base64UrlEncode(encodeTokenPayloadJson(payload));
      return `${encoded}.${signPayload(encoded, yield* secret)}`;
    });

    const parseToken = Effect.fn("j5.a2a.archiveCrew.parseToken")(function* (token: string) {
      const parts = token.split(".");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "")
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "malformed" });
      const [encoded, signature] = parts as [string, string];
      if (!timingSafeEqualBase64Url(signature, signPayload(encoded, yield* secret)))
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "malformed" });
      const text = yield* Effect.result(
        Effect.try({
          try: () => base64UrlDecodeUtf8(encoded),
          catch: () => new ArchiveCrewConfirmationTokenError({ reason: "malformed" }),
        }),
      );
      if (Result.isFailure(text))
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "malformed" });
      const unknown = yield* Effect.result(decodeUnknownJson(text.success));
      if (Result.isFailure(unknown))
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "malformed" });
      const value = unknown.success;
      if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version !== TOKEN_VERSION
      )
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "unsupported-version" });
      const payload = yield* Effect.result(decodeTokenPayloadJson(text.success));
      if (Result.isFailure(payload))
        return yield* new ArchiveCrewConfirmationTokenError({ reason: "malformed" });
      return payload.success;
    });

    const readFacts = Effect.fn("j5.a2a.archiveCrew.readFacts")(function* (
      instance: AgentCrewInstance,
    ) {
      const members: Array<ArchiveCrewMemberFacts> = [];
      for (const member of instance.members) {
        const state = yield* archiveAgent
          .readFacts({
            projectId: instance.projectId,
            participantId: member.participantId,
            threadId: member.threadId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ArchiveCrewPartialFailureError({
                  crewInstanceId: instance.id,
                  archivedSeats: [],
                  failedSeat: member.seatName,
                  cause,
                }),
            ),
          );
        members.push({
          seatName: member.seatName,
          participantId: member.participantId,
          threadId: member.threadId,
          alreadyArchived: state !== null && state.threadArchived && state.retired,
          neverCreated: state === null,
          facts: state?.facts ?? { openExchanges: [], runningTurn: null },
        });
      }
      return { members } satisfies ArchiveCrewConsequenceFacts;
    });

    // The roster is read, confirmed, and retired as one unit step, so an approved launch or
    // addition either lands before the read and retires with the rest, or waits and meets the
    // retired stamp before it reserves a seat.
    const archive: ArchiveCrewServiceShape["archive"] = Effect.fn("j5.a2a.archiveCrew.archive")(
      function* (input) {
        const decodedToken =
          input.confirmationToken === undefined
            ? undefined
            : yield* parseToken(input.confirmationToken);
        const instance = yield* crews.read(input.crewInstanceId).pipe(Effect.orDie);
        if (instance === null)
          return yield* new ArchiveCrewNotFoundError({ crewInstanceId: input.crewInstanceId });
        if (input.projectId !== null && instance.projectId !== input.projectId)
          return yield* new ArchiveCrewProjectMismatchError({
            crewInstanceId: instance.id,
            projectId: input.projectId,
            expected: instance.projectId,
          });
        // A person is not a participant and holds the authority the gate gave them; only an
        // agent caller has to be the Captain (R19).
        if (
          input.callerParticipantId !== null &&
          instance.captainParticipantId !== input.callerParticipantId
        )
          return yield* new ArchiveCrewNotCaptainError({
            crewInstanceId: instance.id,
            captainParticipantId: instance.captainParticipantId,
            callerParticipantId: input.callerParticipantId,
          });

        // Archiving a Crew ends its playbook run. Idempotent, and also on the already-archived
        // retry, so a crash between the cancel and the retired stamp is repaired.
        const cancelPlaybookRun = playbooks.cancelForCrew(instance.id).pipe(Effect.orDie);
        const facts = yield* readFacts(instance);
        if (
          instance.archivedAt !== null &&
          facts.members.every((member) => member.alreadyArchived || member.neverCreated)
        ) {
          yield* cancelPlaybookRun;
          return {
            status: "already_archived" as const,
            members: facts.members.map((member) => ({
              seatName: member.seatName,
              participantId: member.participantId,
              result: member.neverCreated
                ? ("never_created" as const)
                : ("already_archived" as const),
            })),
          };
        }

        const payload = payloadFor(input, facts);
        if (
          input.confirmationSatisfied !== true &&
          decodedToken === undefined &&
          hasConsequences(facts)
        ) {
          return yield* new ArchiveCrewConfirmationRequiredError({
            facts,
            confirmationToken: yield* issueToken(payload),
          });
        }
        if (
          input.confirmationSatisfied !== true &&
          decodedToken !== undefined &&
          encodeTokenPayloadJson(decodedToken) !== encodeTokenPayloadJson(payload) &&
          !isForwardOnlyRecovery(decodedToken, payload)
        ) {
          return yield* new ArchiveCrewConfirmationStaleError({
            facts,
            confirmationToken: hasConsequences(facts) ? yield* issueToken(payload) : null,
          });
        }

        const results: Array<ArchiveCrewMemberResult> = [];
        for (const member of facts.members) {
          if (member.neverCreated) {
            results.push({
              seatName: member.seatName,
              participantId: member.participantId,
              result: "never_created",
            });
            continue;
          }
          const ids = input.commandIds(member.seatName);
          const result = yield* archiveAgent
            .archive({
              providerSessionId: input.providerSessionId,
              // The single-agent archive only folds the caller into a token it never issues
              // here (confirmation is already satisfied); a person's archive runs under the
              // Captain's identity because the unit retires as the Captain's Crew.
              callerParticipantId: input.callerParticipantId ?? instance.captainParticipantId,
              target: {
                projectId: instance.projectId,
                participantId: member.participantId,
                threadId: member.threadId,
              },
              clientRequestKey: input.clientRequestKey,
              confirmationSatisfied: true,
              archivedAt: input.archivedAt,
              interruptCommandId: ids.interruptCommandId,
              archiveCommandId: ids.archiveCommandId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ArchiveCrewPartialFailureError({
                    crewInstanceId: instance.id,
                    archivedSeats: results
                      .filter(({ result }) => result !== "never_created")
                      .map(({ seatName }) => seatName),
                    failedSeat: member.seatName,
                    cause,
                  }),
              ),
            );
          results.push({ seatName: member.seatName, participantId: member.participantId, result });
        }
        yield* cancelPlaybookRun;
        yield* crews
          .markArchived(instance.id, input.archivedAt, { withCaptain: input.withCaptain === true })
          .pipe(Effect.orDie);
        return { status: "archived" as const, members: results };
      },
      (unit, input) => crews.serialize(input.crewInstanceId, unit),
    );

    const readCaptainFacts: ArchiveCrewServiceShape["readCaptainFacts"] = Effect.fn(
      "j5.a2a.archiveCrew.readCaptainFacts",
    )(function* (input) {
      const commanded = yield* crews.listForCaptain(input).pipe(Effect.orDie);
      const live = commanded.filter((instance) => instance.archivedAt === null);
      return yield* Effect.forEach(
        live,
        (instance) => readFacts(instance).pipe(Effect.map((facts) => ({ instance, facts }))),
        { concurrency: 1 },
      );
    });

    return ArchiveCrewService.of({ archive, readCaptainFacts });
  }),
);
