import { describe, expect, it } from "vite-plus/test";
import { MessageId, SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";
import { deriveTimelineMinimapItems } from "../../components/chat/timelineMinimapItems";
import type { ChatMessage } from "../../types";
import { isHumanAuthoredUserMessage } from "./minimapMessages";
import { J5_A2A_DELIVERY_MESSAGE_PREFIX } from "./ThreadA2ARenderer";
import { markSharedNote } from "../sharing/sharedTimeline.logic";

describe("timeline minimap items", () => {
  const message = (overrides: Omit<Partial<ChatMessage>, "id"> & { id: string }): ChatMessage => ({
    role: "user",
    text: `text for ${overrides.id}`,
    runId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
    id: MessageId.make(overrides.id),
  });
  const row = (msg: ChatMessage): MessagesTimelineRow => ({
    kind: "message",
    id: String(msg.id),
    createdAt: msg.createdAt,
    message: msg,
    durationStart: msg.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  });

  it("keeps only messages the person sent, including Inbox replies", () => {
    expect(isHumanAuthoredUserMessage(message({ id: "typed" }))).toBe(true);
    expect(isHumanAuthoredUserMessage(message({ id: "web", createdBy: "user" }))).toBe(true);
    expect(isHumanAuthoredUserMessage(message({ id: "steer", inputIntent: "steer" }))).toBe(true);

    expect(isHumanAuthoredUserMessage(message({ id: "reply", role: "assistant" }))).toBe(false);
    expect(isHumanAuthoredUserMessage(message({ id: "delegated", createdBy: "agent" }))).toBe(
      false,
    );
    expect(isHumanAuthoredUserMessage(message({ id: "nudge", createdBy: "system" }))).toBe(false);
    expect(
      isHumanAuthoredUserMessage(
        message({ id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}inbox`, createdBy: "user" }),
      ),
    ).toBe(true);
    expect(
      isHumanAuthoredUserMessage(
        message({ id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}peer`, createdBy: "agent" }),
      ),
    ).toBe(false);
    expect(
      isHumanAuthoredUserMessage(
        message({ id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}silence`, createdBy: "system" }),
      ),
    ).toBe(false);
    expect(
      isHumanAuthoredUserMessage(
        message({ id: `${SCHEDULED_TASK_MESSAGE_ID_PREFIX}fire-1`, createdBy: "user" }),
      ),
    ).toBe(false);
  });

  // Also proves upstream's deriveTimelineMinimapItems still reaches the J5 classifier (case 24).
  it("skips automated turns but still previews each kept turn's own reply", () => {
    const rows = [
      row(message({ id: "u1", text: "first ask" })),
      row(message({ id: "a1", role: "assistant", text: "first reply" })),
      row(message({ id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}peer`, createdBy: "agent" })),
      row(message({ id: "a2", role: "assistant", text: "reply to peer" })),
      row(message({ id: `${SCHEDULED_TASK_MESSAGE_ID_PREFIX}f1`, createdBy: "user" })),
      row(message({ id: "a3", role: "assistant", text: "reply to schedule" })),
      row(message({ id: "u2", text: "second ask" })),
      row(message({ id: "a4", role: "assistant", text: "second reply" })),
      row(
        message({
          id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}inbox`,
          createdBy: "user",
          text: "inbox reply",
        }),
      ),
      row(message({ id: "a5", role: "assistant", text: "reply to inbox" })),
    ];

    expect(deriveTimelineMinimapItems(rows)).toEqual([
      { id: "u1", rowIndex: 0, userText: "first ask", assistantText: "first reply" },
      { id: "u2", rowIndex: 6, userText: "second ask", assistantText: "second reply" },
      {
        id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}inbox`,
        rowIndex: 8,
        userText: "inbox reply",
        assistantText: "reply to inbox",
      },
    ]);
  });

  it("leaves out a shared conversation's note and keeps the message it came with", () => {
    const note = markSharedNote(
      message({
        id: "u1:shared-note",
        createdBy: "user",
        text: "<j5_shared_conversation>\nWho can write: Priya (collaborator).\n</j5_shared_conversation>",
      }),
    );
    const rows = [
      row(note),
      row(message({ id: "u1", createdBy: "user", text: "the ask" })),
      row(message({ id: "a1", role: "assistant", text: "the reply" })),
    ];

    expect(deriveTimelineMinimapItems(rows)).toEqual([
      { id: "u1", rowIndex: 1, userText: "the ask", assistantText: "the reply" },
    ]);
  });
});
