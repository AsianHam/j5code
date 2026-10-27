import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  j5ClaudeSteerFields,
  j5ClaudeSteerHoldsResult,
  j5ObserveClaudeSteer,
  j5OfferClaudeSteer,
  j5ForgetClaudeSteers,
} from "./claudeAgentSteers.ts";

// Steer state is module-wide, so each test uses turns and messages of its own.
let nextTurn = 0;
const newTurn = () => `provider-turn-${++nextTurn}`;

const newQuery = () => ({}) as ClaudeAgentSdkQuerySession;

const lifecycle = (commandUuid: string, state: string) =>
  ({ type: "command_lifecycle", command_uuid: commandUuid, state }) as unknown as SDKMessage;

const result = (overrides: Partial<SDKResultMessage> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    ...overrides,
  }) as SDKResultMessage;

const offerAgentSteer = Effect.fnUntraced(function* (
  query: ClaudeAgentSdkQuerySession,
  providerTurnId: string,
  messageId = `message-${providerTurnId}`,
) {
  const steer = yield* j5ClaudeSteerFields({ createdBy: "agent" }, yield* Crypto.Crypto);
  yield* j5OfferClaudeSteer({ query, providerTurnId, messageId, steer, offer: Effect.void });
  return steer.uuid ?? assert.fail("An agent's steer has a uuid.");
});

it.effect("keeps a person's steer on now and sends any other with next and a uuid", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    assert.deepEqual(yield* j5ClaudeSteerFields({ createdBy: "user" }, crypto), {
      priority: "now",
    });
    for (const createdBy of ["agent", "system"] as const) {
      const steer = yield* j5ClaudeSteerFields({ createdBy }, crypto);
      assert.equal(steer.priority, "next");
      assert.isString(steer.uuid);
    }
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("holds a clean result while a steer is queued, and not once Claude takes it", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const uuid = yield* offerAgentSteer(query, turn);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isTrue(j5ClaudeSteerHoldsResult(query, turn, result()));
    j5ObserveClaudeSteer(query, lifecycle(uuid, "started"));
    assert.isFalse(j5ClaudeSteerHoldsResult(query, turn, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("holds for an unacknowledged steer only once the CLI has reported lifecycle", () =>
  Effect.gen(function* () {
    const silent = newQuery();
    const silentTurn = newTurn();
    yield* offerAgentSteer(silent, silentTurn);
    assert.isFalse(j5ClaudeSteerHoldsResult(silent, silentTurn, result()));

    const reporting = newQuery();
    const reportingTurn = newTurn();
    j5ObserveClaudeSteer(reporting, lifecycle("the-turn-prompt", "started"));
    yield* offerAgentSteer(reporting, reportingTurn);
    assert.isTrue(j5ClaudeSteerHoldsResult(reporting, reportingTurn, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each([
  { failure: "an execution error", overrides: { subtype: "error_during_execution" } },
  { failure: "a success flagged as an error", overrides: { is_error: true } },
  { failure: "the turn limit", overrides: { terminal_reason: "max_turns" } },
] as const)("never holds a result that ends on $failure", ({ overrides }) =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const uuid = yield* offerAgentSteer(query, turn);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isFalse(j5ClaudeSteerHoldsResult(query, turn, result(overrides as never)));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("follows a steer's lifecycle only on its own query, and only for known states", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const uuid = yield* offerAgentSteer(query, turn);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    j5ObserveClaudeSteer(newQuery(), lifecycle(uuid, "started"));
    j5ObserveClaudeSteer(query, lifecycle(uuid, "paused"));
    assert.isTrue(j5ClaudeSteerHoldsResult(query, turn, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("leaves nothing behind when the offer fails", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    j5ObserveClaudeSteer(query, lifecycle("the-turn-prompt", "started"));
    const steer = yield* j5ClaudeSteerFields({ createdBy: "agent" }, yield* Crypto.Crypto);
    const offered = yield* j5OfferClaudeSteer({
      query,
      providerTurnId: turn,
      messageId: "message-failed-offer",
      steer,
      offer: Effect.fail("closed"),
    }).pipe(Effect.flip);
    assert.equal(offered, "closed");
    assert.isFalse(j5ClaudeSteerHoldsResult(query, turn, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("releases a terminated turn's steers without clearing another turn", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const otherTurn = newTurn();
    const waiting = yield* offerAgentSteer(query, turn, "message-waiting");
    const other = yield* offerAgentSteer(query, otherTurn, "message-other-turn");
    j5ObserveClaudeSteer(query, lifecycle(waiting, "queued"));
    j5ObserveClaudeSteer(query, lifecycle(other, "queued"));
    assert.isTrue(j5ClaudeSteerHoldsResult(query, turn, result()));
    j5ForgetClaudeSteers(["message-waiting"]);
    assert.isFalse(j5ClaudeSteerHoldsResult(query, turn, result()));
    assert.isTrue(j5ClaudeSteerHoldsResult(query, otherTurn, result()));
    j5ForgetClaudeSteers(["message-other-turn"]);
    assert.isFalse(j5ClaudeSteerHoldsResult(query, otherTurn, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
