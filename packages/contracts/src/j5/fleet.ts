import * as Schema from "effect/Schema";

export const FLEET_DISPATCH_THRESHOLD_MS = 5 * 60 * 1000;

const UnknownFact = Schema.Struct({ state: Schema.Literal("unknown"), reason: Schema.String });

export const FleetRuntimeFact = Schema.Union([
  UnknownFact,
  Schema.Struct({
    state: Schema.Literal("known"),
    status: Schema.Literals([
      "working",
      "waiting",
      "approval",
      "input",
      "failed",
      "idle",
      "waiting-to-start",
    ]),
    since: Schema.NullOr(Schema.String),
    settled: Schema.Boolean,
  }),
]);
export type FleetRuntimeFact = typeof FleetRuntimeFact.Type;

const OpenAsk = Schema.Struct({
  exchangeId: Schema.String,
  counterpartyId: Schema.String,
  counterpartyName: Schema.NullOr(Schema.String),
  intent: Schema.String,
  openedAt: Schema.String,
});

export const FleetActivityFact = Schema.Union([
  UnknownFact,
  Schema.Struct({
    state: Schema.Literal("known"),
    label: Schema.String,
    at: Schema.String,
  }),
]);
export type FleetActivityFact = typeof FleetActivityFact.Type;

export const FleetProblem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("failed-run"),
    runId: Schema.String,
    at: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("dispatch-overdue"),
    runId: Schema.String,
    at: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("delivery-failed"),
    messageId: Schema.String,
    receiverId: Schema.String,
    receiverName: Schema.NullOr(Schema.String),
    at: Schema.String,
    reason: Schema.NullOr(Schema.String),
    /** Closing the Exchange changes eligibility, not the delivery fact. */
    exchangeOpen: Schema.Boolean,
  }),
]);
export type FleetProblem = typeof FleetProblem.Type;

export const FleetAgentFacts = Schema.Struct({
  asks: Schema.Struct({ owed: Schema.Array(OpenAsk), awaited: Schema.Array(OpenAsk) }),
  problems: Schema.Array(FleetProblem),
});
export type FleetAgentFacts = typeof FleetAgentFacts.Type;
