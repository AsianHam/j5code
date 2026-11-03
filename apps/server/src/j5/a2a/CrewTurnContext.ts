import { type OrchestrationV2ProviderThread, type RunId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as ReadChanges from "./ReadChanges.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { crewContextRecordIds, crewContextText } from "./spawnIds.ts";

class CrewTurnContextError extends Schema.TaggedError<CrewTurnContextError>()(
  "CrewTurnContextError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Cannot deliver this Crew seat's context. Restore its Crew before starting a waiting member.";
  }
}

const isCrewTurnContextError = Schema.is(CrewTurnContextError);

export interface CrewDelivery {
  readonly threadId: ThreadId;
  /** The run the text belongs to; the member's thread keeps what it was told under that run. */
  readonly runId: RunId;
  /** The provider conversation about to receive the text; a new one needs the introduction again. */
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">;
  readonly text: string;
}

export class CrewTurnContext extends Context.Service<
  CrewTurnContext,
  {
    /** Whether the thread is a Crew seat. Every other thread skips this service. */
    readonly isSeat: (threadId: ThreadId) => Effect.Effect<boolean, CrewTurnContextError>;
    /**
     * Sends the text with the seat's current Crew context in front. `send` answers whether the
     * provider took the text; only then is the context recorded as delivered, so a send that
     * never happened (stopped, superseded) leaves it owed for the next one.
     */
    readonly deliver: <E, R>(
      delivery: CrewDelivery,
      send: (text: string) => Effect.Effect<boolean, E, R>,
    ) => Effect.Effect<boolean, E | CrewTurnContextError, R>;
    /** A steered message reaches a busy seat with the same context a fresh turn would carry. */
    readonly steering: (session: {
      readonly steerTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"];
    }) => {
      readonly steerTurn: (
        input: ProviderAdapter.ProviderAdapterV2SteerInput,
      ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error | CrewTurnContextError>;
    };
  }
>()("t3/j5/a2a/CrewTurnContext") {}

const DELIVERY_OPEN = "<j5_crew_delivery_context>\n";
const DELIVERY_CLOSE = "\n</j5_crew_delivery_context>\n\n";
/** Keeps the platform's context apart from the assignment that follows it. */
const deliveryContext = (context: string) =>
  context === ""
    ? ""
    : `${DELIVERY_OPEN}${context.replaceAll("</j5_crew_delivery_context>", "<\\/j5_crew_delivery_context>")}${DELIVERY_CLOSE}`;

const conversationOf = (providerThread: CrewDelivery["providerThread"]) =>
  `${providerThread.id}:${providerThread.nativeThreadRef?.nativeId ?? ""}`;

const Roster = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      agentDisplayName: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
);
const encodeRoster = Schema.encodeSync(Roster);
const decodeRoster = Schema.decodeUnknownEffect(Roster);
const line = (value: string) => value.replace(/\s+/g, " ").replace(/<\//g, "<\\/").trim();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crews = yield* Crews.AgentCrewInstanceService;
  const changes = yield* ReadChanges.ReadChanges;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const prepare = Effect.fn("j5.crewTurnContext.prepare")(function* (delivery: CrewDelivery) {
    const { threadId } = delivery;
    const conversation = conversationOf(delivery.providerThread);
    return yield* Effect.gen(function* () {
      const [context] = yield* sql<{
        readonly first_turn_text: string;
        readonly delivered_roster: string | null;
        readonly delivered_conversation: string | null;
      }>`
        SELECT first_turn_text, delivered_roster, delivered_conversation
        FROM j5_crew_seat_context WHERE thread_id = ${threadId}
      `;
      if (context === undefined) return null;
      const membership = yield* crews.findMembership(participantIdForThread(threadId));
      if (membership === null) {
        if (context.delivered_roster === null) return yield* new CrewTurnContextError({ threadId });
        return null;
      }
      const crew = yield* crews.read(membership.crewInstanceId);
      if (crew === null) return yield* new CrewTurnContextError({ threadId });
      // The name each seat was launched with; a seat from before it was recorded falls back to
      // its persona id.
      const launched = yield* sql<{
        readonly thread_id: string;
        readonly agent_display_name: string | null;
      }>`
        SELECT thread_id, agent_display_name FROM j5_crew_seat_context
        WHERE thread_id IN ${sql.in(crew.members.map((member) => member.threadId))}
      `;
      const displayNames = new Map(launched.map((row) => [row.thread_id, row.agent_display_name]));
      const roster = crew.members.map((member) => ({
        seat: member.seatName,
        participantId: member.participantId,
        agentDisplayName: displayNames.get(member.threadId) ?? member.agentId ?? "custom",
        reason: member.reason,
      }));
      const rosterJson = encodeRoster(roster);
      let prefix = "";
      // A conversation the introduction never reached (first turn, or the provider rebuilt it
      // from history after a model switch or lost session) gets it whole. A seat from before
      // conversations were recorded has none stored and is not introduced again.
      const introduce =
        context.delivered_roster === null ||
        (context.delivered_conversation !== null &&
          context.delivered_conversation !== conversation);
      if (introduce) {
        prefix = context.first_turn_text.replace(
          /<j5_crew_context>[\s\S]*?<\/j5_crew_context>/,
          () =>
            crewContextText({
              displayName: crew.displayName,
              instanceId: crew.id,
              seatName: membership.seatName,
              captainParticipantId: crew.captainParticipantId,
              roster,
            }),
        );
      } else {
        const previous = yield* decodeRoster(context.delivered_roster);
        const joined = roster.filter(
          (member) => !previous.some((old) => old.participantId === member.participantId),
        );
        const left = previous.filter(
          (member) => !roster.some((current) => current.participantId === member.participantId),
        );
        const describe = (member: (typeof Roster.Type)[number]) =>
          `${line(member.seat)}: participant_id=${member.participantId} responsibility=${line(member.reason ?? "")}`;
        if (joined.length > 0 || left.length > 0)
          prefix = [
            "<j5_crew_roster_changed>",
            ...joined.map((member) => `joined: ${describe(member)}`),
            ...left.map((member) => `left: ${describe(member)}`),
            "</j5_crew_roster_changed>",
          ].join("\n");
      }

      // Only a first delivery, a new roster or a new conversation changes what the Crew reads.
      const unchanged =
        context.delivered_roster === rosterJson && context.delivered_conversation === conversation;
      const delivered = deliveryContext(prefix);
      const recordedText = delivered.trimEnd();
      return {
        prefix: delivered,
        // What the model read, kept in the member's thread without the assignment after it.
        record:
          recordedText === ""
            ? null
            : {
                threadId,
                runId: delivery.runId,
                text: recordedText,
                ...crewContextRecordIds({ threadId, conversation, text: recordedText }),
              },
        delivered: unchanged
          ? Effect.void
          : sql`
              UPDATE j5_crew_seat_context
              SET delivered_roster = ${rosterJson}, delivered_conversation = ${conversation}
              WHERE thread_id = ${threadId}
            `.pipe(
              Effect.andThen(changes.notify("crew", "fleet")),
              Effect.asVoid,
              Effect.mapError((cause) => new CrewTurnContextError({ threadId, cause })),
            ),
      };
    }).pipe(
      Effect.mapError((cause) =>
        isCrewTurnContextError(cause) ? cause : new CrewTurnContextError({ threadId, cause }),
      ),
    );
  });
  const isSeat = (threadId: ThreadId) =>
    sql`SELECT 1 AS present FROM j5_crew_seat_context WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError((cause) => new CrewTurnContextError({ threadId, cause })),
    );
  const deliver = Effect.fn("CrewTurnContext.deliver")(function* <E, R>(
    delivery: CrewDelivery,
    send: (text: string) => Effect.Effect<boolean, E, R>,
  ) {
    const context = yield* prepare(delivery);
    if (context === null) return yield* send(delivery.text);
    const sent = yield* send(`${context.prefix}${delivery.text}`);
    if (!sent) return false;
    // The provider accepted the prompt; bookkeeping failure must not fail its running turn.
    yield* context.delivered.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to record delivered Crew context", {
          threadId: delivery.threadId,
          cause,
        }),
      ),
    );
    // Best effort like the bookkeeping above: the member already has the context.
    if (context.record !== null)
      yield* orchestrator.dispatch({ type: "platform-message.record", ...context.record }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to record the Crew context in the member's thread", {
            threadId: delivery.threadId,
            cause,
          }),
        ),
      );
    return true;
  });
  const steering: CrewTurnContext["Service"]["steering"] = (session) => ({
    steerTurn: (input) =>
      deliver(
        {
          threadId: input.threadId,
          runId: input.runId,
          providerThread: input.providerThread,
          text: input.message.text,
        },
        (text) =>
          session
            .steerTurn({ ...input, message: { ...input.message, text } })
            .pipe(Effect.as(true)),
      ).pipe(Effect.asVoid),
  });
  return CrewTurnContext.of({ isSeat, deliver, steering });
});

/** The service over the caller's `ReadChanges`, so a test can watch what it announces. */
export const layerWithChanges = Layer.effect(CrewTurnContext, make).pipe(
  Layer.provide(Crews.layer),
);

export const layer = layerWithChanges.pipe(Layer.provide(ReadChanges.layer));
