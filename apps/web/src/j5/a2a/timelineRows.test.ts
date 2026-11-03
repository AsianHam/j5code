import {
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import {
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  j5PromptRow,
  renderThreadA2ADelivery,
} from "./ThreadA2ARenderer";

// The classifier and renderer only matter for what reaches a message row, so each kind goes through
// the timeline's own derivation from the turn item the server stores for it.
const now = DateTime.makeUnsafe("2026-11-02T00:00:00.000Z");
const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};

const userMessage = (
  id: string,
  text: string,
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "user_message" }>> = {},
): OrchestrationV2TurnItem => ({
  ...base,
  type: "user_message",
  messageId: MessageId.make(id),
  inputIntent: "turn_start",
  text,
  attachments: [],
  createdBy: "system",
  creationSource: "server",
  ...fields,
});

const delivery = (text: string) =>
  userMessage(`${J5_A2A_DELIVERY_MESSAGE_PREFIX}notice`, text, { creationSource: "mcp" });

const rowsFor = (item: OrchestrationV2TurnItem) =>
  deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: item.threadId,
          sourceItemId: item.id,
          item,
        },
      ],
      optimisticMessages: [],
    }),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });

const messageRow = (item: OrchestrationV2TurnItem) => {
  const row = rowsFor(item).find((candidate) => candidate.kind === "message");
  if (row?.kind !== "message") throw new Error("Expected a message row");
  return row.message;
};

const terminalFooter = "This is a platform-authored terminal notice, not a peer reply.";

describe("what reaches a J5 row", () => {
  it.each([
    [
      "a silence",
      delivery(
        "[Cross-agent messaging system notice: turn-ended-no-reply]\n\nagent:b's turn ended without replying on exchange:1. The latest delivered message was processed.\n\nThis is a platform-authored delivery signal, not a peer reply.",
      ),
    ],
    [
      "a queued message removed",
      delivery(
        "[Cross-agent messaging system notice: queued-message-removed]\n\nYour message m1 to agent:b was removed from its queue before it ran, so agent:b never read it. Send it again if it still matters. The message began: Hi\n\nThis is a platform-authored delivery signal, not a peer reply.",
      ),
    ],
    [
      "a message not delivered",
      delivery(
        "[Cross-agent messaging system notice: message not delivered]\n\nYour message m1 to agent:b was not delivered: gone\n\nThis is a platform-authored notice, not a peer reply.",
      ),
    ],
    [
      "a dropped Exchange",
      delivery(
        `[Cross-agent messaging system notice: exchange dropped]\n\nExchange e1 ended because agent:b was archived (receiver-retired).\n\nFacts: replyRequired=false.\n\n${terminalFooter}`,
      ),
    ],
    [
      "a withdrawn ask",
      delivery(
        `[Cross-agent messaging system notice: exchange withdrawn]\n\nExchange e1 was withdrawn by agent:b, who no longer needs an answer.\n\n${terminalFooter}`,
      ),
    ],
    [
      "a handoff reminder",
      userMessage("agent-handoff-nudge:run-1", "Your run ended without the declared handoff."),
    ],
    [
      "a declined roster",
      userMessage(
        "message:crew",
        "<j5_crew_gate>\nproposal_id: p\nkind: roster\ndecision: declined\ncrew_name: C\n</j5_crew_gate>",
      ),
    ],
  ])("draws %s as a notice line", (_name, item) => {
    expect(renderThreadA2ADelivery({ message: messageRow(item) })).not.toBeNull();
  });

  it.each([
    [
      "a playbook step",
      userMessage(
        "message:j5:a2a:mcp:j5-playbook-step:playbook-step:run",
        "<j5_playbook_step>\nstep: a | Build\nposition: 1 of 2\n</j5_playbook_step>\n<step_prompt>\nBuild it.\n</step_prompt>\nDo this step now.",
      ),
    ],
    [
      "a native question",
      userMessage(
        "message:j5:native-question:parent:request",
        "Placed agent (threadId t, requestId r) asked a native question and can continue working. Read it with t3_pending_request.",
      ),
    ],
  ])("draws %s as a pill", (_name, item) => {
    expect(j5PromptRow(messageRow(item))).not.toBeNull();
  });

  it("draws an automation run on upstream's row", () => {
    const message = messageRow(
      userMessage("scheduled-task-message:task:1:scheduled", "Run the nightly check.", {
        createdBy: "agent",
        creationSource: "mcp",
        scheduledTaskId: ScheduledTaskId.make("task"),
      }),
    );
    expect(resolveUserMessagePresentation(message).attribution).toBe("automation");
  });
});

describe("what upstream keeps on its own rows", () => {
  it("draws a message the server made a notification as a work row, not a message", () => {
    const rows = rowsFor({
      ...base,
      type: "notification",
      source: { kind: "monitor" },
      outcome: "updated",
      summary: "#912: new comments",
    } as OrchestrationV2TurnItem);
    expect(rows.map((row) => row.kind)).toEqual(["work"]);
  });

  it("draws idle compaction as a compaction row, not a message", () => {
    const rows = rowsFor(
      userMessage("idle-compact:thread-1:run-1", "/compact", {
        createdBy: "agent",
        idleCompaction: "beforeCacheExpires",
      }),
    );
    expect(rows.some((row) => row.kind === "message")).toBe(false);
  });
});
