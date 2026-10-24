import {
  CommandId,
  OrchestrationV2RunStatus,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import {
  ThreadManagementService,
  latestActiveRun,
} from "../../orchestration-v2/ThreadManagementService.ts";
import {
  A2AArchiveFacts,
  type OpenExchangeArchiveFact,
  type ThreadPreArchiveFacts,
} from "./ArchiveFactsService.ts";
import { A2ALedger } from "./LedgerService.ts";
import { A2ALifecycleService } from "./LifecycleService.ts";
import { stopThread } from "./stopThread.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";
import {
  ExchangeDroppedPayload,
  ExchangeId,
  type LedgerCursor,
  MessageSentPayload,
  ParticipantId,
  LedgerProjectId,
  type StoredCommEvent,
  Urgency,
} from "./contracts.ts";

const TOKEN_VERSION = "j5-archive-confirmation/v1" as const;
const TOKEN_SECRET_NAME = "j5-a2a-archive-confirmation-v1";
const TOKEN_SECRET_BYTES = 32;

export interface ArchiveAgentOpenExchangeFact {
  readonly exchangeId: ExchangeId;
  readonly direction: "inbound" | "outbound";
  readonly replyObligation: "participant-owes-reply" | "counterparty-owes-reply";
  readonly counterpartyId: ParticipantId;
  readonly intent: string;
  readonly urgency: Urgency | null;
  readonly openedAt: string;
}

export interface ArchiveAgentRunningTurnFact {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
}

export interface ArchiveAgentConsequenceFacts {
  readonly openExchanges: ReadonlyArray<ArchiveAgentOpenExchangeFact>;
  readonly runningTurn: ArchiveAgentRunningTurnFact | null;
}

export interface ArchiveAgentTarget {
  readonly projectId: LedgerProjectId;
  readonly participantId: ParticipantId;
  readonly threadId: ThreadId;
}

export interface ArchiveAgentInput {
  readonly providerSessionId: string;
  readonly callerParticipantId: ParticipantId;
  readonly target: ArchiveAgentTarget;
  readonly clientRequestKey: string;
  readonly confirmationToken?: string;
  /**
   * The Crew archive path has already shown the unit's facts and holds a valid crew token, so
   * per-member confirmation is satisfied; set only by the internal crew archive flow.
   */
  readonly confirmationSatisfied?: boolean;
  readonly archivedAt: string;
  readonly interruptCommandId: CommandId;
  readonly archiveCommandId: CommandId;
}

export type ArchiveAgentResult = "archived" | "already_archived";

export class ArchiveAgentConfirmationRequiredError extends Data.TaggedError(
  "ArchiveAgentConfirmationRequiredError",
)<{
  readonly facts: ArchiveAgentConsequenceFacts;
  readonly confirmationToken: string;
}> {
  override get message(): string {
    return "Archiving would end active work. Review the exact facts and retry the archive operation with the confirmation_token.";
  }
}

export class ArchiveAgentConfirmationStaleError extends Data.TaggedError(
  "ArchiveAgentConfirmationStaleError",
)<{
  readonly facts: ArchiveAgentConsequenceFacts;
  readonly confirmationToken: string | null;
}> {
  override get message(): string {
    return this.confirmationToken === null
      ? "The confirmation_token is stale because the target no longer has consequential work. Retry the archive operation without a token."
      : "The confirmation_token is stale because the target facts changed. Review the current facts and retry the archive operation with the new confirmation_token.";
  }
}

export class ArchiveAgentConfirmationTokenError extends Data.TaggedError(
  "ArchiveAgentConfirmationTokenError",
)<{
  readonly reason: "malformed" | "unsupported-version";
}> {
  override get message(): string {
    return this.reason === "unsupported-version"
      ? "The confirmation_token uses an unsupported version. Retry the archive operation without a token to receive a current refusal."
      : "The confirmation_token is malformed or has an invalid signature. Retry the archive operation without a token to receive a current refusal.";
  }
}

export class ArchiveAgentTargetMismatchError extends Data.TaggedError(
  "ArchiveAgentTargetMismatchError",
)<{
  readonly expected: ArchiveAgentTarget;
  readonly observed: string;
}> {
  override get message(): string {
    return `The archive operation selected ${this.expected.projectId}/${this.expected.participantId}/${this.expected.threadId}, but the durable target reads resolve ${this.observed}. No archive side effect was attempted.`;
  }
}

export class ArchiveAgentOperationError extends Data.TaggedError("ArchiveAgentOperationError")<{
  readonly phase: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `The archive operation failed while ${this.phase}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}.`;
  }
}

export class ArchiveAgentPartialFailureError extends Data.TaggedError(
  "ArchiveAgentPartialFailureError",
)<{
  readonly interruptRequested: boolean;
  readonly threadArchived: boolean;
  readonly participantRetired: boolean;
  readonly participantArchived: boolean;
  readonly pendingExchangeIds: ReadonlyArray<ExchangeId>;
  readonly runningTurn: ArchiveAgentRunningTurnFact | null;
  readonly cause: unknown;
}> {
  override get message(): string {
    const runClaim =
      this.runningTurn === null
        ? "No active run is currently observed."
        : `Run ${this.runningTurn.runId} is still observed as ${this.runningTurn.status}; an interrupt may have been requested, but terminal state is not yet observed.`;
    return [
      `The archive operation committed thread archive=${this.threadArchived}, participant archived=${this.participantArchived}, legacy retirement=${this.participantRetired}.`,
      this.pendingExchangeIds.length === 0
        ? "All observed lifecycle obligation events are committed."
        : `Lifecycle obligation events remain in flight for exchanges ${this.pendingExchangeIds.join(", ")}.`,
      runClaim,
      "Retry the archive operation with the same client_request_id; recovery is forward-only and idempotent.",
      `Cause: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}.`,
    ].join(" ");
  }
}

export type ArchiveAgentError =
  | ArchiveAgentConfirmationRequiredError
  | ArchiveAgentConfirmationStaleError
  | ArchiveAgentConfirmationTokenError
  | ArchiveAgentTargetMismatchError
  | ArchiveAgentOperationError
  | ArchiveAgentPartialFailureError;

const TokenOpenExchange = Schema.Struct({
  exchange_id: ExchangeId,
  direction: Schema.Literals(["inbound", "outbound"]),
  reply_obligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterparty_id: ParticipantId,
  intent: Schema.String,
  urgency: Schema.NullOr(Urgency),
  opened_at: Schema.String,
});

const TokenPayload = Schema.Struct({
  version: Schema.Literal(TOKEN_VERSION),
  provider_session_id: Schema.String,
  caller_participant_id: ParticipantId,
  project_id: LedgerProjectId,
  target_participant_id: ParticipantId,
  thread_id: ThreadId,
  thread_archived: Schema.Boolean,
  retired: Schema.Boolean,
  open_exchanges: Schema.Array(TokenOpenExchange),
  running_turn: Schema.NullOr(Schema.Struct({ run_id: RunId, status: OrchestrationV2RunStatus })),
});
type TokenPayload = typeof TokenPayload.Type;
const TokenPayloadJson = Schema.fromJsonString(TokenPayload);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeTokenPayloadJson = Schema.decodeUnknownEffect(TokenPayloadJson);
const decodeUnknownJson = Schema.decodeUnknownEffect(UnknownJson);
const encodeTokenPayloadJson = Schema.encodeSync(TokenPayloadJson);
const decodeExchangeDroppedOption = Schema.decodeUnknownOption(ExchangeDroppedPayload);
const decodeMessageSentOption = Schema.decodeUnknownOption(MessageSentPayload);

interface ReadState {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly retired: boolean;
  readonly archived: boolean;
  readonly facts: ArchiveAgentConsequenceFacts;
}

interface ClosureStatus {
  readonly participantRetired: boolean;
  readonly participantArchived: boolean;
  readonly participantLeftAt: string | null;
  readonly pendingExchangeIds: ReadonlyArray<ExchangeId>;
  readonly complete: boolean;
}

const operationError = (phase: string) => (cause: unknown) =>
  new ArchiveAgentOperationError({ phase, cause });

const projectExchange = (fact: OpenExchangeArchiveFact): ArchiveAgentOpenExchangeFact => ({
  exchangeId: fact.exchangeId,
  direction: fact.direction,
  replyObligation: fact.replyObligation,
  counterpartyId: fact.counterpartyId,
  intent: fact.intent,
  urgency: fact.urgency,
  openedAt: fact.openedAt,
});

const canonicalExchanges = (facts: ReadonlyArray<ArchiveAgentOpenExchangeFact>) =>
  facts.toSorted(
    (left, right) =>
      left.openedAt.localeCompare(right.openedAt) ||
      left.exchangeId.localeCompare(right.exchangeId),
  );

const tokenPayload = (input: {
  readonly providerSessionId: string;
  readonly callerParticipantId: ParticipantId;
  readonly target: ArchiveAgentTarget;
  readonly state: ReadState;
}): TokenPayload => ({
  version: TOKEN_VERSION,
  provider_session_id: input.providerSessionId,
  caller_participant_id: input.callerParticipantId,
  project_id: input.target.projectId,
  target_participant_id: input.target.participantId,
  thread_id: input.target.threadId,
  thread_archived: input.state.projection.thread.archivedAt !== null,
  retired: input.state.retired,
  open_exchanges: canonicalExchanges(input.state.facts.openExchanges).map((exchange) => ({
    exchange_id: exchange.exchangeId,
    direction: exchange.direction,
    reply_obligation: exchange.replyObligation,
    counterparty_id: exchange.counterpartyId,
    intent: exchange.intent,
    urgency: exchange.urgency,
    opened_at: exchange.openedAt,
  })),
  running_turn:
    input.state.facts.runningTurn === null
      ? null
      : {
          run_id: input.state.facts.runningTurn.runId,
          status: input.state.facts.runningTurn.status,
        },
});

const canonicalPayload = (payload: TokenPayload): string => encodeTokenPayloadJson(payload);

const payloadHasConsequences = (payload: TokenPayload): boolean =>
  payload.open_exchanges.length > 0 || payload.running_turn !== null;

const stateHasConsequences = (state: ReadState): boolean =>
  state.facts.openExchanges.length > 0 || state.facts.runningTurn !== null;

const isForwardOnlyRecovery = (confirmed: TokenPayload, current: TokenPayload): boolean => {
  if (
    confirmed.provider_session_id !== current.provider_session_id ||
    confirmed.caller_participant_id !== current.caller_participant_id ||
    confirmed.project_id !== current.project_id ||
    confirmed.target_participant_id !== current.target_participant_id ||
    confirmed.thread_id !== current.thread_id
  ) {
    return false;
  }
  const confirmedExchangeIds = new Set(
    confirmed.open_exchanges.map((exchange) => exchange.exchange_id),
  );
  if (!current.open_exchanges.every((exchange) => confirmedExchangeIds.has(exchange.exchange_id))) {
    return false;
  }
  if (
    current.running_turn !== null &&
    (confirmed.running_turn === null ||
      current.running_turn.run_id !== confirmed.running_turn.run_id)
  ) {
    return false;
  }
  return current.thread_archived || current.retired;
};

export interface ArchiveAgentTargetFacts {
  readonly facts: ArchiveAgentConsequenceFacts;
  readonly threadArchived: boolean;
  readonly retired: boolean;
}

export interface ArchiveAgentServiceShape {
  readonly archive: (
    input: ArchiveAgentInput,
  ) => Effect.Effect<ArchiveAgentResult, ArchiveAgentError>;
  /**
   * Consequence facts without side effects, so a unit archive can warn about every member at once.
   * Null when the target provably never came to exist: no home is registered for its thread and
   * the projection store answers not-found for it. A Crew records every seat's row before the seat
   * spawns, so a launch that failed partway leaves such rows behind, and the unit verbs pass them
   * by. Every other failure propagates: absence is never inferred from a store that could not
   * answer, and a home without a thread is a mismatch, not an absence.
   */
  readonly readFacts: (
    target: ArchiveAgentTarget,
  ) => Effect.Effect<ArchiveAgentTargetFacts | null, ArchiveAgentError>;
}

export class ArchiveAgentService extends Context.Service<
  ArchiveAgentService,
  ArchiveAgentServiceShape
>()("t3/j5/a2a/ArchiveAgentService") {}

export const layer = Layer.effect(
  ArchiveAgentService,
  Effect.gen(function* () {
    const archiveFacts = yield* A2AArchiveFacts;
    const ledger = yield* A2ALedger;
    const lifecycle = yield* A2ALifecycleService;
    const threadManagement = yield* ThreadManagementService;
    const threadLifecycle = yield* ThreadLifecycleService;
    const secrets = yield* ServerSecretStore;

    const secret = secrets
      .getOrCreateRandom(TOKEN_SECRET_NAME, TOKEN_SECRET_BYTES)
      .pipe(Effect.mapError(operationError("loading the confirmation-token signing secret")));

    const readArchiveFacts = (target: ArchiveAgentTarget) =>
      archiveFacts
        .readForThread(target.threadId)
        .pipe(Effect.mapError(operationError("reading A2A archive facts")));

    const readStateWith = Effect.fn("j5.a2a.archiveAgent.readState")(function* (
      target: ArchiveAgentTarget,
      facts: ThreadPreArchiveFacts,
    ) {
      const projection = yield* threadManagement
        .getThreadProjection(target.threadId)
        .pipe(Effect.mapError(operationError("reading the target thread projection")));
      if (
        facts.state !== "registered" ||
        facts.projectId !== target.projectId ||
        facts.participantId !== target.participantId ||
        projection.thread.id !== target.threadId
      ) {
        const observed =
          facts.state === "registered"
            ? `${facts.projectId}/${facts.participantId}/${projection.thread.id}`
            : `${facts.state}/${projection.thread.id}`;
        return yield* new ArchiveAgentTargetMismatchError({ expected: target, observed });
      }
      const activeRun = latestActiveRun(projection);
      return {
        projection,
        retired: facts.retired,
        archived: facts.archived,
        facts: {
          openExchanges: canonicalExchanges(facts.openExchanges.map(projectExchange)),
          runningTurn:
            activeRun === undefined ? null : { runId: activeRun.id, status: activeRun.status },
        },
      } satisfies ReadState;
    });

    const readState = (target: ArchiveAgentTarget) =>
      readArchiveFacts(target).pipe(Effect.flatMap((facts) => readStateWith(target, facts)));

    const issueToken = Effect.fn("j5.a2a.archiveAgent.issueToken")(function* (
      payload: TokenPayload,
    ) {
      const encoded = base64UrlEncode(canonicalPayload(payload));
      return `${encoded}.${signPayload(encoded, yield* secret)}`;
    });

    const parseToken = Effect.fn("j5.a2a.archiveAgent.parseToken")(function* (token: string) {
      const parts = token.split(".");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      const [encoded, signature] = parts as [string, string];
      const expected = signPayload(encoded, yield* secret);
      if (!timingSafeEqualBase64Url(signature, expected)) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      const decodedText = yield* Effect.result(
        Effect.try({
          try: () => base64UrlDecodeUtf8(encoded),
          catch: () => new ArchiveAgentConfirmationTokenError({ reason: "malformed" }),
        }),
      );
      if (Result.isFailure(decodedText)) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      const unknownResult = yield* Effect.result(decodeUnknownJson(decodedText.success));
      if (Result.isFailure(unknownResult)) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      const unknown = unknownResult.success;
      if (
        typeof unknown === "object" &&
        unknown !== null &&
        "version" in unknown &&
        typeof unknown.version === "string" &&
        unknown.version !== TOKEN_VERSION
      ) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "unsupported-version" });
      }
      const decodedPayload = yield* Effect.result(decodeTokenPayloadJson(decodedText.success));
      if (Result.isFailure(decodedPayload)) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      const payload = decodedPayload.success;
      if (!payloadHasConsequences(payload)) {
        return yield* new ArchiveAgentConfirmationTokenError({ reason: "malformed" });
      }
      return payload;
    });

    const readLedgerEvents = Effect.fn("j5.a2a.archiveAgent.readLedgerEvents")(function* (
      projectId: LedgerProjectId,
    ) {
      const events: Array<StoredCommEvent> = [];
      let cursor: LedgerCursor = { afterSeq: 0 };
      while (true) {
        const page = yield* ledger
          .readEvents({ projectId, cursor, limit: 500 })
          .pipe(Effect.mapError(operationError("reading durable lifecycle evidence")));
        events.push(...page.events);
        if (page.complete) return events;
        cursor = page.nextCursor;
      }
    });

    const readLifecycleEvents = Effect.fn("j5.a2a.archiveAgent.readLifecycleEvents")(function* () {
      const projects = yield* ledger
        .listProjectLedgers()
        .pipe(Effect.mapError(operationError("listing lifecycle evidence projects")));
      const events: Array<StoredCommEvent> = [];
      for (const project of projects) {
        events.push(...(yield* readLedgerEvents(project.id)));
      }
      return events;
    });

    const readClosureStatus = Effect.fn("j5.a2a.archiveAgent.readClosureStatus")(function* (
      target: ArchiveAgentTarget,
      expectedExchangeIds: ReadonlyArray<ExchangeId>,
    ) {
      const post = yield* readState(target);
      // A9 writes each dropped Exchange and its terminal notice to that
      // Exchange's owning project, which can differ from the retired agent's
      // immutable home. Completion therefore scans every durable project and
      // filters to this exact participant below.
      const events = yield* readLifecycleEvents();
      const participantLeftAt =
        events.findLast(
          (event) =>
            (event.kind === "participant.archived" || event.kind === "participant.left") &&
            event.receiver === target.participantId &&
            event.payload.participant.kind === "agent" &&
            event.payload.participant.id === target.participantId &&
            event.payload.participant.threadId === target.threadId,
        )?.createdAt ?? null;
      const lifecycleDroppedIds = events.flatMap((event) => {
        if (event.kind !== "exchange.dropped" || event.exchangeId === null) return [];
        const decoded = decodeExchangeDroppedOption(event.payload);
        return Option.isSome(decoded) && decoded.value.cause.participantId === target.participantId
          ? [event.exchangeId]
          : [];
      });
      const exchangeIds = [...new Set([...expectedExchangeIds, ...lifecycleDroppedIds])].sort();
      const pending: Array<ExchangeId> = [];
      for (const exchangeId of exchangeIds) {
        const normallyClosed = events.some(
          (event) => event.kind === "exchange.closed" && event.exchangeId === exchangeId,
        );
        const dropped = events.some((event) => {
          if (event.kind !== "exchange.dropped" || event.exchangeId !== exchangeId) return false;
          const decoded = decodeExchangeDroppedOption(event.payload);
          return (
            Option.isSome(decoded) && decoded.value.cause.participantId === target.participantId
          );
        });
        const terminalNotice = events.some((event) => {
          if (event.kind !== "message.sent" || event.exchangeId !== exchangeId) return false;
          const decoded = decodeMessageSentOption(event.payload);
          return (
            Option.isSome(decoded) &&
            decoded.value.exchangeRole === "terminal_notice" &&
            decoded.value.envelopeChannel === "lifecycle_notice"
          );
        });
        if (!normallyClosed && !(dropped && terminalNotice)) pending.push(exchangeId);
      }
      return {
        participantRetired: post.retired,
        participantArchived: post.archived,
        participantLeftAt,
        pendingExchangeIds: pending,
        complete:
          (post.archived || post.retired) &&
          participantLeftAt !== null &&
          post.facts.openExchanges.length === 0 &&
          pending.length === 0,
      } satisfies ClosureStatus;
    });

    const partialFailure = Effect.fn("j5.a2a.archiveAgent.partialFailure")(function* (
      input: ArchiveAgentInput,
      expectedExchangeIds: ReadonlyArray<ExchangeId>,
      interruptRequested: boolean,
      cause: unknown,
    ) {
      const post = yield* readState(input.target);
      const closure = yield* readClosureStatus(input.target, expectedExchangeIds);
      return new ArchiveAgentPartialFailureError({
        interruptRequested,
        threadArchived: post.projection.thread.archivedAt !== null,
        participantRetired: closure.participantRetired,
        participantArchived: closure.participantArchived,
        pendingExchangeIds: closure.pendingExchangeIds,
        runningTurn: post.facts.runningTurn,
        cause,
      });
    });

    const archive: ArchiveAgentServiceShape["archive"] = Effect.fn("j5.a2a.archiveAgent.archive")(
      function* (input) {
        const decodedToken =
          input.confirmationToken === undefined
            ? undefined
            : yield* parseToken(input.confirmationToken);
        const before = yield* readState(input.target);
        if (before.projection.thread.archivedAt !== null && (before.archived || before.retired)) {
          const closure = yield* readClosureStatus(input.target, []);
          if (closure.complete) return "already_archived" as const;
        }

        const payload = tokenPayload({
          providerSessionId: input.providerSessionId,
          callerParticipantId: input.callerParticipantId,
          target: input.target,
          state: before,
        });
        if (
          input.confirmationSatisfied !== true &&
          decodedToken === undefined &&
          stateHasConsequences(before)
        ) {
          return yield* new ArchiveAgentConfirmationRequiredError({
            facts: before.facts,
            confirmationToken: yield* issueToken(payload),
          });
        }
        if (
          input.confirmationSatisfied !== true &&
          decodedToken !== undefined &&
          canonicalPayload(decodedToken) !== canonicalPayload(payload) &&
          !isForwardOnlyRecovery(decodedToken, payload)
        ) {
          return yield* new ArchiveAgentConfirmationStaleError({
            facts: before.facts,
            confirmationToken: stateHasConsequences(before) ? yield* issueToken(payload) : null,
          });
        }

        const expectedExchangeIds = before.facts.openExchanges.map((fact) => fact.exchangeId);
        let interruptRequested = false;
        if (before.facts.runningTurn !== null) {
          yield* stopThread(threadManagement, {
            commandId: input.interruptCommandId,
            threadId: input.target.threadId,
            reason: "Peer Agent archived as part of Crew retirement",
          }).pipe(Effect.mapError(operationError("requesting interruption of the active run")));
          interruptRequested = true;
        }

        if (before.projection.thread.archivedAt === null) {
          const archiveAttempt = yield* Effect.result(
            threadLifecycle.archive({
              commandId: input.archiveCommandId,
              threadId: input.target.threadId,
            }),
          );
          const afterArchive = yield* readState(input.target);
          if (afterArchive.projection.thread.archivedAt === null) {
            return yield* operationError("committing the target thread archive")(
              Result.isFailure(archiveAttempt)
                ? archiveAttempt.failure
                : "thread.archive returned without a durable archived projection",
            );
          }
        }

        const lifecycleAttempt = yield* Effect.result(
          lifecycle.archiveParticipant({
            participantId: input.target.participantId,
            archivedAt: input.archivedAt,
          }),
        );
        const closure = yield* readClosureStatus(input.target, expectedExchangeIds);
        if (!closure.complete) {
          const error = yield* partialFailure(
            input,
            expectedExchangeIds,
            interruptRequested,
            Result.isFailure(lifecycleAttempt)
              ? lifecycleAttempt.failure
              : "lifecycle service returned before durable closure completed",
          );
          return yield* error;
        }
        return "archived" as const;
      },
    );

    const readFacts: ArchiveAgentServiceShape["readFacts"] = Effect.fn(
      "j5.a2a.archiveAgent.readFacts",
    )(function* (target) {
      const facts = yield* readArchiveFacts(target);
      if (facts.state === "not-an-a2a-participant") {
        const projection = yield* getThreadProjectionIfPresent(
          threadManagement,
          target.threadId,
        ).pipe(Effect.mapError(operationError("reading the target thread projection")));
        if (projection === null) return null;
      }
      const state = yield* readStateWith(target, facts);
      return {
        facts: state.facts,
        threadArchived: state.projection.thread.archivedAt !== null,
        retired: state.retired,
      };
    });

    return ArchiveAgentService.of({ archive, readFacts });
  }),
);
