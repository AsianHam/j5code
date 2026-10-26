import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/**
 * A steer from an agent or the server waits for a Claude turn's running tool calls instead of
 * cancelling them (FORK.md case 84, register D4). Upstream sends every steer with priority
 * "now", which cancels the turn's running tool calls and makes Claude report a refusal nobody
 * gave. Priority "next" is Claude Code's own mid-turn path: the CLI lets the running tool calls
 * finish and adds the message to the turn at the next tool result. A person's steer keeps
 * upstream's "now", so it still cuts in at once.
 *
 * A "next" steer offered after the turn's last tool call is still queued when the turn's result
 * arrives, and Claude runs it as another native turn. The adapter keeps the turn open for it by
 * following the steer's `command_lifecycle` frames. A CLI that sends none never holds a turn
 * open: the steer's native turn then reaches the thread through upstream's wake-turn path.
 *
 * Kept as a leaf module so the Claude adapter carries only its hook calls. A turn's steers are
 * forgotten when the turn ends.
 */

type SteerState = "offered" | "queued" | "taken" | "cancelled";

interface TrackedSteer {
  state: SteerState;
  /** The thread message the steer carries, so terminal runs can release their tracked steers. */
  readonly messageId: string;
  readonly query: ClaudeAgentSdkQuerySession;
}

/** Steers by provider turn, then uuid. A turn's entry goes when the turn ends. */
const steersByTurn = new Map<string, Map<string, TrackedSteer>>();
/** Queries whose CLI has sent a command_lifecycle frame. */
const reportsLifecycle = new WeakSet<ClaudeAgentSdkQuerySession>();

const stillToRun = (steer: TrackedSteer) =>
  steer.state === "queued" || (steer.state === "offered" && reportsLifecycle.has(steer.query));

export interface J5ClaudeSteerFields {
  readonly priority: "now" | "next";
  readonly uuid?: SteerUuid;
}

type SteerUuid = NonNullable<SDKUserMessage["uuid"]>;
const isSteerUuid = (value: string): value is SteerUuid =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Spread into the steer's user message in place of upstream's `priority: "now"`. */
export const j5ClaudeSteerFields = Effect.fnUntraced(function* (
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy">,
  crypto: Crypto.Crypto,
) {
  if (message.createdBy === "user") return { priority: "now" } satisfies J5ClaudeSteerFields;
  const uuid = yield* crypto.randomUUIDv4().pipe(Effect.filterOrFail(isSteerUuid));
  return { priority: "next", uuid } satisfies J5ClaudeSteerFields;
});

/**
 * Offers the steer, tracking a "next" one from before the offer so a lifecycle frame can't
 * arrive untracked. A failed offer leaves nothing behind that would hold the turn.
 */
export const j5OfferClaudeSteer = <E>(input: {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly providerTurnId: string;
  readonly messageId: string;
  readonly steer: J5ClaudeSteerFields;
  readonly offer: Effect.Effect<void, E>;
}): Effect.Effect<void, E> => {
  const uuid = input.steer.uuid;
  if (uuid === undefined) return input.offer;
  const withdraw = Effect.sync(() => {
    steersByTurn.get(input.providerTurnId)?.delete(uuid);
  });
  return Effect.sync(() => {
    const steers = steersByTurn.get(input.providerTurnId) ?? new Map<string, TrackedSteer>();
    steers.set(uuid, { state: "offered", messageId: input.messageId, query: input.query });
    steersByTurn.set(input.providerTurnId, steers);
  }).pipe(
    Effect.andThen(input.offer),
    Effect.onError(() => withdraw),
  );
};

/** Called for every SDK frame on the query. */
export const j5ObserveClaudeSteer = (query: ClaudeAgentSdkQuerySession, message: SDKMessage) => {
  // The SDK doesn't type command_lifecycle frames; upstream reads them the same way.
  const type: unknown = Reflect.get(message, "type");
  if (type !== "command_lifecycle") return;
  const uuid: unknown = Reflect.get(message, "command_uuid");
  const state: unknown = Reflect.get(message, "state");
  if (typeof uuid !== "string" || typeof state !== "string") return;
  reportsLifecycle.add(query);
  const next = lifecycleStates.get(state);
  if (next === undefined) return;
  for (const turn of steersByTurn.values()) {
    const steer = turn.get(uuid);
    if (steer?.query === query) steer.state = next;
  }
};

const lifecycleStates = new Map<string, SteerState>([
  ["queued", "queued"],
  ["started", "taken"],
  ["completed", "taken"],
  ["cancelled", "cancelled"],
]);

/**
 * Whether the turn's result is one segment of the turn rather than its end: a steer of the turn
 * is still to run. Only a clean completion is held, so a failure ends the turn and shows. The
 * adapter holds a person's aborting "now" steer itself without calling this, so the turn keeps
 * its steers across it.
 *
 * For a fresh uuid user message, a held turn ends at the result of the turn consuming it.
 * Neither J5 nor upstream asks the CLI to cancel a queued command, and a person's Stop
 * closes the query, which ends the turn whether or not it is held.
 */
export const j5ClaudeSteerHoldsResult = (
  query: ClaudeAgentSdkQuerySession,
  providerTurnId: string,
  result: SDKResultMessage,
): boolean => {
  const turn = steersByTurn.get(providerTurnId);
  if (turn === undefined) return false;
  const waiting = [...turn.values()].some(stillToRun);
  const completed =
    result.subtype === "success" &&
    !result.is_error &&
    (result.terminal_reason === undefined || result.terminal_reason === "completed");
  if (waiting && completed) return true;
  steersByTurn.delete(providerTurnId);
  return false;
};

/** Releases tracked turns carrying these messages when a run ends without a clean SDK result. */
export const j5ForgetClaudeSteers = (messageIds: ReadonlyArray<string>): void => {
  const wanted = new Set(messageIds);
  for (const [providerTurnId, turn] of steersByTurn) {
    if ([...turn.values()].some((steer) => wanted.has(steer.messageId))) {
      steersByTurn.delete(providerTurnId);
    }
  }
};
