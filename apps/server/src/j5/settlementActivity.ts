import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Messages that hold a thread open after its PR merges or closes (register D30, FORK.md case 62).
 * Beyond upstream's person-written messages, J5 counts tool sends by another participant
 * (`createdBy: "agent"`, `creationSource: "mcp"`): A2A deliveries, briefs, upstream's agent sends.
 * Not server wakes, system notices, or an agent's scheduled task (`scheduledTaskId`).
 */
export const isSettlementActivityMessage = (
  message: Pick<
    OrchestrationV2ConversationMessage,
    "role" | "createdBy" | "creationSource" | "scheduledTaskId"
  >,
): boolean =>
  message.role === "user" &&
  (message.createdBy === "user" ||
    (message.createdBy === "agent" &&
      message.creationSource === "mcp" &&
      message.scheduledTaskId === undefined));

/**
 * The same rule as a SQL condition on a row of `orchestration_v2_projection_messages` aliased
 * `message`. It holds no input, so the settlement candidate query includes it as a literal.
 */
export const SETTLEMENT_ACTIVITY_MESSAGE_SQL = `message.role = 'user' AND (
  json_extract(message.payload_json, '$.createdBy') = 'user'
  OR (
    json_extract(message.payload_json, '$.createdBy') = 'agent'
    AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
    AND json_extract(message.payload_json, '$.scheduledTaskId') IS NULL
  )
)`;

/** The newest message that counts, for the settlement candidates the in-memory store builds. */
export const latestSettlementActivityMessageAt = (
  messages: ReadonlyArray<
    Pick<
      OrchestrationV2ConversationMessage,
      "role" | "createdBy" | "creationSource" | "scheduledTaskId" | "updatedAt"
    >
  >,
): DateTime.Utc | null =>
  messages
    .filter(isSettlementActivityMessage)
    .reduce<DateTime.Utc | null>(
      (latest, message) =>
        latest === null || DateTime.isGreaterThan(message.updatedAt, latest)
          ? message.updatedAt
          : latest,
      null,
    );
