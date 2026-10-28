import { describe, expect, it } from "vite-plus/test";
import { MessageId, SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  isHumanAuthoredUserMessage,
  resolveTimelineMinimapPreview,
} from "./timelineMinimapItems";
import { J5_A2A_DELIVERY_MESSAGE_PREFIX } from "../../j5/a2a/ThreadA2ARenderer";
import { markSharedNote } from "../../j5/sharing/sharedTimeline.logic";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });
});

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
