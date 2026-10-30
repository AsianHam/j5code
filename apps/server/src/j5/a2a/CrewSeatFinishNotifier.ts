// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for deterministic ids and digests.
import { makeCrewFailureAlert } from "./crewFailureAlert.ts";
import { layer as sharedThreadsLayer } from "../sharing/SharedThreads.ts";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  agentHandoffArtifactPath,
  agentHandoffLogicalPath,
} from "../agents/agentPersonaArtifacts.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { ArtifactWorkspace, type ArtifactWorkspaceError } from "../artifacts/ArtifactWorkspace.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import { CrewCaptainArchiveCascade } from "./CrewCaptainArchiveCascade.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { formatRunFailureField, runFailureDetail } from "./runFailures.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";

/**
 * A seat tells its Captain when its run ends owing no reply: a notice with the measured outcome and
 * its handoff file (inline when short). The seat is never settled; upstream settles by hand, PR or
 * idle days. A notice repeats only when its facts changed, and one arriving mid-turn folds into the
 * seat notice already queued, so a Captain absorbs its Crew's news in one turn.
 */
export interface CrewSeatFinishNotifierShape {
  /** Returns the seat thread whose Captain was told, or null when the event needed no action. */
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ThreadId | null, never>;
  /**
   * The boot sweep: tell every Captain about a live seat whose last run finished while nothing
   * reported it. Covers a notice that failed (the seat was left unreported on purpose) and a
   * finish that landed while the server was down. Returns the seat threads reported.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<ThreadId>>;
}

export class CrewSeatFinishNotifier extends Context.Service<
  CrewSeatFinishNotifier,
  CrewSeatFinishNotifierShape
>()("t3/j5/a2a/CrewSeatFinishNotifier") {}

const FINISH_SESSION = "j5-crew-seat-finish";
/** Bodies up to this size ride inline in the Captain's notice; longer ones are read on demand. */
export const INLINE_HANDOFF_MAX_CHARS = 4_000;

/**
 * A seat has finished only when its run completed or failed. Interrupted, cancelled and rolled back
 * runs are not finishes: `j5_stop_crew` and Stop crew interrupt seats to brief them again, and
 * nothing is reported then (Crews AC21), so a Captain is not woken by its own stop.
 */
const finishedRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" &&
    (event.payload.status === "completed" || event.payload.status === "failed")
    ? event.payload
    : undefined;
};

const NOTICE_OPEN = "<j5_seat_finished>";

/** Each seat's section of a notice or digest: its opening tag through the text before the next. */
export const seatNoticeSections = (text: string): ReadonlyArray<string> =>
  text
    .split(NOTICE_OPEN)
    .slice(1)
    .map((part) => `${NOTICE_OPEN}${part}`.trim());

const sectionParticipant = (section: string) =>
  /^participant_id: (.+)$/m.exec(section)?.[1]?.trim() ?? null;

/**
 * The newest notice the Captain already holds for a seat, delivered or still queued. Keyed by
 * the seat's participant, not its name: one Captain commands several Crews and they reuse names
 * (reviewer, builder), so two Crews' reviewers must not replace each other's baseline.
 */
export const latestSeatNotice = (
  captain: OrchestrationV2ThreadProjection,
  participantId: string,
): string | null => {
  const newestFirst = captain.messages
    .filter((message) => message.role === "user" && message.createdBy === "system")
    .toSorted((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
  for (const message of newestFirst) {
    const sections = seatNoticeSections(message.text).filter(
      (section) => sectionParticipant(section) === participantId,
    );
    if (sections.length > 0) return sections[sections.length - 1] ?? null;
  }
  return null;
};

/** A seat notice still queued behind the Captain's running turn; a new notice folds into it. */
export const queuedSeatDigest = (captain: OrchestrationV2ThreadProjection) => {
  if (ThreadManagement.latestActiveRun(captain) === undefined) return null;
  for (const run of captain.runs) {
    if (run.status !== "queued") continue;
    const message = captain.messages.find((item) => item.id === run.userMessageId);
    if (
      message?.role === "user" &&
      message.createdBy === "system" &&
      message.text.startsWith(NOTICE_OPEN)
    )
      return { run, message };
  }
  return null;
};

/**
 * A seat's body must not be able to end the body block and continue as platform voice, nor open
 * a seat section of its own: a Critic reviewing this feature will quote a notice, and both the
 * notifier's sections and the card's parser split on the opening tag.
 */
const noticeBody = (body: string) =>
  body
    .replace(/<\/handoff_body>/g, "<\\/handoff_body>")
    .replace(/<j5_seat_finished>/g, "<\\j5_seat_finished>");

/** Twelve hex characters of the body's SHA-256, so a rewritten handoff changes the notice text. */
const handoffDigest = (body: string) =>
  NodeCrypto.createHash("sha256").update(body).digest("hex").slice(0, 12);

export type SeatHandoffFact =
  | {
      readonly status: "written";
      readonly kind: string;
      readonly path: string;
      readonly body: string | null;
      /** Over the artifact read limit: it exists and is read by path, never inlined. */
      readonly tooLarge?: true;
    }
  | { readonly status: "missing"; readonly kind: string; readonly path: string }
  /** Something is at the path but it can never be a handoff; the reason says why. */
  | {
      readonly status: "unavailable";
      readonly kind: string;
      readonly path: string;
      readonly reason: string;
    }
  | { readonly status: "none declared" };

/**
 * The platform-composed notice the Captain receives when a seat finishes: measured facts about
 * the run and the handoff, then the handoff body when it exists and is short. A written handoff
 * always carries its size and digest in the facts, so a re-briefed seat that rewrites a body too
 * long to inline still produces a changed notice and the Captain hears of it.
 */
export const seatFinishedNoticeText = (input: {
  readonly seatName: string;
  /** Which Crew the seat sits in; a Captain may command several. */
  readonly crewName: string;
  readonly participantId: string;
  readonly threadId: string;
  readonly runStatus: string;
  /** The run's recorded error when it failed; the notice leads with it, not the handoff lines. */
  readonly failure: OrchestrationV2ProviderFailure | null;
  readonly handoff: SeatHandoffFact;
}) => {
  const handoffLine =
    input.handoff.status === "none declared"
      ? "handoff: none declared"
      : input.handoff.status === "missing"
        ? `handoff: missing (${input.handoff.kind})\nartifact: ${agentHandoffLogicalPath(input.handoff.path)}`
        : input.handoff.status === "unavailable"
          ? `handoff: unavailable (${input.handoff.kind})\nartifact: ${agentHandoffLogicalPath(input.handoff.path)}\nhandoff_reason: ${input.handoff.reason}`
          : `handoff: written (${input.handoff.kind})\nartifact: ${agentHandoffLogicalPath(input.handoff.path)}${input.handoff.tooLarge === true ? "\nhandoff_size: over the read limit" : `\nhandoff_chars: ${input.handoff.body?.length ?? 0}\nhandoff_digest: ${input.handoff.body === null ? "binary" : handoffDigest(input.handoff.body)}`}`;
  // The outcome first: a seat that died read as "finished, forgot its handoff" when the failure
  // was one line among the handoff lines (Jackson's dogfood, 2026-09-17).
  const failureLine =
    input.runStatus === "failed" ? `\nfailure: ${formatRunFailureField(input.failure)}` : "";
  const head = `<j5_seat_finished>\nrun_status: ${input.runStatus}${failureLine}\nseat: ${input.seatName}\ncrew: ${input.crewName}\nparticipant_id: ${input.participantId}\nthread_id: ${input.threadId}\n${handoffLine}\n</j5_seat_finished>`;
  if (input.handoff.status !== "written") return head;
  return input.handoff.body !== null && input.handoff.body.length <= INLINE_HANDOFF_MAX_CHARS
    ? `${head}\n\n<handoff_body>\n${noticeBody(input.handoff.body)}\n</handoff_body>`
    : `${head}\n\nRead it with j5_read_artifact (path: ${input.handoff.path}).`;
};

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewSeatFinishNotifier,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const alertHumanOfCrewFailure = yield* makeCrewFailureAlert;
      const crews = yield* AgentCrewInstanceService;
      const reporter = yield* CrewLaunchReporter;
      const cascade = yield* CrewCaptainArchiveCascade;
      const workspace = yield* ArtifactWorkspace;
      const agents = yield* makeAgentPersonaLibrary;
      const sql = yield* SqlClient.SqlClient;

      const owedReplies = Effect.fn("j5.a2a.crewSeatFinish.owedReplies")(function* (
        participantId: string,
      ) {
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_exchange
          WHERE status = 'open' AND receiver_id = ${participantId}
        `;
        return Number(rows[0]?.count ?? 0);
      });

      /**
       * Where the seat's declared handoff stands, read from the file: none is "missing", too large
       * to inline is "written", a directory or a link out of the artifacts directory is
       * "unavailable". Those never change on retry, so the notice goes out; only a real I/O failure
       * fails it, for the next finish or the boot sweep.
       */
      const handoffFact = Effect.fn("j5.a2a.crewSeatFinish.handoffFact")(function* (
        projection: OrchestrationV2ThreadProjection,
        kind: string | null,
      ): Effect.fn.Return<SeatHandoffFact, ArtifactWorkspaceError, never> {
        const assignment = projection.thread.agentPersonaAssignment;
        if (kind === null || assignment === undefined) return { status: "none declared" } as const;
        const path = agentHandoffArtifactPath({
          personaId: assignment.personaId,
          artifact: kind,
          threadId: projection.thread.id,
        });
        const projectId = projection.thread.projectId;
        // One read answers both questions; listing the whole artifacts tree to check for a single
        // known path is a full directory walk on every seat finish.
        const content = yield* Effect.result(workspace.read({ projectId, relativePath: path }));
        if (Result.isFailure(content)) {
          switch (content.failure.reason) {
            case "not_found":
              return { status: "missing", kind, path };
            case "too_large":
              return { status: "written", kind, path, body: null, tooLarge: true };
            case "not_a_file":
              return { status: "unavailable", kind, path, reason: "not a regular file" };
            case "outside_root":
              return {
                status: "unavailable",
                kind,
                path,
                reason: "link leaves the artifacts directory",
              };
            default:
              return yield* content.failure;
          }
        }
        return {
          status: "written",
          kind,
          path,
          body: content.success.encoding === "utf8" ? content.success.content : null,
        } as const;
      });

      /**
       * Tells the Captain what changed. Ids derive from the run, so a redelivered event cannot
       * post twice; a fold checks the digest for the same text for the same reason.
       */
      const notifyCaptain = Effect.fn("j5.a2a.crewSeatFinish.notifyCaptain")(function* (
        instance: AgentCrewInstance,
        seatName: string,
        projection: OrchestrationV2ThreadProjection,
        run: OrchestrationV2Run,
        handoff: SeatHandoffFact,
      ) {
        const threadId = projection.thread.id;
        const captain = yield* threads.getThreadProjection(instance.captainThreadId);
        const stable = { providerSessionId: FINISH_SESSION, requestKey: `${threadId}:${run.id}` };
        const text = seatFinishedNoticeText({
          seatName,
          crewName: instance.displayName,
          participantId: participantIdForThread(threadId),
          threadId,
          runStatus: run.status,
          failure: run.status === "failed" ? runFailureDetail(projection, run.id) : null,
          handoff,
        });
        if (latestSeatNotice(captain, participantIdForThread(threadId)) === text.trim())
          return "unchanged" as const;
        const digest = queuedSeatDigest(captain);
        if (digest !== null) {
          if (!digest.message.text.includes(text)) {
            yield* threads.dispatch({
              type: "queued-run.edit",
              commandId: lifecycleCommandId({ ...stable, operation: "seat-finished-fold" }),
              threadId: instance.captainThreadId,
              runId: digest.run.id,
              text: `${digest.message.text}\n\n${text}`,
            });
          }
          return "folded" as const;
        }
        yield* threads.dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: lifecycleCommandId({ ...stable, operation: "seat-finished" }),
          threadId: instance.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "seat-finished" }),
          ),
          text,
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        return "posted" as const;
      });

      const notifyIfFinished = Effect.fn("j5.a2a.crewSeatFinish.notifyIfFinished")(function* (
        threadId: ThreadId,
        run: OrchestrationV2Run,
      ) {
        const participantId = participantIdForThread(threadId);
        const membership = yield* crews.findMembership(participantId);
        if (membership === null) return null;
        const instance = yield* crews.read(membership.crewInstanceId);
        if (instance === null || instance.archivedAt !== null) return null;
        const projection = yield* threads.getThreadProjection(threadId);
        if (projection.thread.archivedAt !== null) return null;
        if (ThreadManagement.latestActiveRun(projection) !== undefined) return null;
        if (run.status === "failed")
          yield* alertHumanOfCrewFailure({
            instance,
            seatName: membership.seatName,
            runId: run.id,
            failure: runFailureDetail(projection, run.id),
          });
        // A failed first turn belongs to an owed launch report, or to the exact run ids in
        // its durable message. This remains true after the report posts and after restart.
        if (run.status === "failed" && (yield* reporter.coversFailure(threadId, run))) return null;
        // A completed run whose seat still owes a reply is left to that reply and the silence
        // detector. A failed run is reported whatever the seat owes: the silence detector stays
        // quiet about a seat's failure to its Captain, so this is where the Captain hears it.
        if (run.status === "completed" && (yield* owedReplies(participantId)) > 0) return null;
        // What the seat owes comes from its immutable snapshot, not today's library. A snapshot
        // that cannot be read leaves the seat unreported and logged rather than quietly finished.
        const assignment = projection.thread.agentPersonaAssignment;
        const owedKind =
          assignment === undefined
            ? null
            : ((yield* agents.readSnapshot(assignment)).outputArtifact ?? null);
        const handoff = yield* handoffFact(projection, owedKind);
        // A failed dispatch or an unreadable handoff is logged. Retry is passive: a later finish
        // or the boot sweep; there is no guarantee of prompt delivery while the seat stays idle.
        yield* notifyCaptain(instance, membership.seatName, projection, run, handoff);
        return threadId;
      });

      /** Only report the latest run, never an older finish hidden behind a later interruption. */
      const outstandingFinish = (projection: OrchestrationV2ThreadProjection) => {
        if (ThreadManagement.latestActiveRun(projection) !== undefined) return undefined;
        const newest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        return newest?.status === "completed" || newest?.status === "failed" ? newest : undefined;
      };

      const reconcile: CrewSeatFinishNotifierShape["reconcile"] = Effect.gen(function* () {
        const reportedNow: Array<ThreadId> = [];
        for (const instance of yield* crews.listLive()) {
          for (const member of instance.members) {
            // A seat whose thread cannot be read (gone, or the store hiccuped) is skipped this pass.
            const projection = yield* threads
              .getThreadProjection(member.threadId)
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            if (projection === null) continue;
            if (projection.thread.archivedAt !== null) continue;
            const run = outstandingFinish(projection);
            if (run === undefined) continue;
            const outcome = yield* notifyIfFinished(member.threadId, run).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew seat finish sweep skipped a seat", {
                  threadId: member.threadId,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
            if (outcome !== null) reportedNow.push(outcome);
          }
        }
        if (reportedNow.length > 0)
          yield* Effect.logInfo("J5 crew seat finish sweep reported finished seats", {
            reportedNow,
          });
        return reportedNow;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("J5 crew seat finish sweep failed", { cause }).pipe(Effect.as([])),
        ),
      );

      const handleStoredEvent: CrewSeatFinishNotifierShape["handleStoredEvent"] = Effect.fn(
        "j5.a2a.crewSeatFinish.handleStoredEvent",
      )(
        function* (stored) {
          const run = finishedRun(stored);
          if (run === undefined) return null;
          return yield* notifyIfFinished(run.threadId, run);
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 crew seat finish notice skipped", { cause }).pipe(Effect.as(null)),
        ),
      );

      if (daemon) {
        // The stream starts from the event store's current high-water mark, so everything that
        // landed while the server was down, and every reaction that failed before it, is caught
        // up by one sweep first: orphaned Crews retire, finished seats tell their Captains.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 crew seat finish notifier");
          // Launches the server lost mid-report are reported first, so a first turn that failed
          // while it was down is a launch outcome rather than a finish.
          yield* reporter.reconcile;
          yield* cascade.reconcile;
          yield* reconcile;
          // Suspended so each resume after a stream failure starts from the last handled
          // sequence rather than from the daemon's start.
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              // One stream serves both Crew reactions: seats settling, and a Captain's archive
              // retiring its Crews (CrewCaptainArchiveCascade).
              Stream.runForEach((event) =>
                reporter.handleStoredEvent(event).pipe(
                  Effect.andThen(handleStoredEvent(event)),
                  Effect.andThen(cascade.handleStoredEvent(event)),
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew seat finish stream failed; resuming", {
                  cause,
                }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewSeatFinishNotifier.of({ handleStoredEvent, reconcile });
    }),
  );

export const manualLayer = makeLayer(false).pipe(Layer.provide(sharedThreadsLayer));
export const layer = makeLayer(true).pipe(Layer.provide(sharedThreadsLayer));
