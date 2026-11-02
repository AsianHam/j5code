import {
  isSharedNote,
  NO_SHARED_MESSAGES_SEEN,
} from "@t3tools/client-runtime/j5/shared-conversation";
import { MessageId, ThreadId } from "@t3tools/contracts";
import type { MessageAuthor, ThreadAuthors } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { presentSharedConversationFeed } from "./sharedConversationFeed";

const prefix = "[Note for the agent]\n\n[Message from Priya (collaborator)]\n\n";
const message = (id: string, text: string): ThreadFeedEntry => ({
  type: "message",
  id,
  createdAt: "2026-10-31T00:00:00.000Z",
  message: {
    id: MessageId.make(id),
    role: "user",
    text,
    attachments: [],
    runId: null,
    streaming: false,
    createdBy: "user",
    visibility: "local",
    sourceThreadId: ThreadId.make("thread-1"),
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  },
});
const priya: MessageAuthor = {
  messageId: "m-1",
  name: "Priya",
  level: "collaborator",
  editedBy: null,
  you: false,
  note: "[Note for the agent]",
  storedPrefix: prefix,
};
const record = (overrides: Partial<ThreadAuthors> = {}): ThreadAuthors => ({
  shared: true,
  authors: [priya],
  answers: [],
  ...overrides,
});
const seenAt = (ids: ReadonlyArray<string>, at: number) => ({
  ...NO_SHARED_MESSAGES_SEEN,
  firstSeen: new Map(ids.map((id) => [id, at])),
});
const texts = (feed: ReadonlyArray<ThreadFeedEntry>) =>
  feed.map((entry) => (entry.type === "message" ? [entry.id, entry.message.text] : [entry.id]));

describe("presentSharedConversationFeed", () => {
  it("shows another person's message as typed, after its note to the agent", () => {
    const { feed, pendingKey } = presentSharedConversationFeed({
      feed: [message("m-1", `${prefix}Ship the fix.`)],
      record: record(),
      failed: false,
      readAt: 2,
      seen: seenAt(["m-1"], 1),
      people: null,
    });
    expect(texts(feed)).toEqual([
      ["m-1:shared-note", "[Note for the agent]"],
      ["m-1", "Ship the fix."],
    ]);
    const note = feed[0];
    expect(note?.type === "message" && isSharedNote(note.message)).toBe(true);
    expect(pendingKey).toBe("");
  });

  it("holds back a message whose author is not read yet, so no line for the agent shows", () => {
    const { feed, pendingKey } = presentSharedConversationFeed({
      feed: [message("m-2", `${prefix}Ship it.`)],
      record: null,
      failed: false,
      readAt: null,
      seen: seenAt(["m-2"], 1),
      people: null,
    });
    expect(feed).toEqual([]);
    expect(pendingKey).toBe("m-2");
  });

  it("holds a new writer's first message in a thread shared after its record was read", () => {
    // The record was read before the thread was shared, so it still says not shared.
    const input = {
      feed: [message("m-4", `${prefix}First words from Priya.`)],
      record: record({ shared: false, authors: [] }),
      failed: false,
      readAt: 1,
      seen: seenAt(["m-4"], 2),
    };
    const owner = { level: "owner" as const, you: true, firstOwner: true };
    const collaborator = { level: "collaborator" as const, you: false, firstOwner: false };
    const reaching = (people: ReadonlyArray<typeof owner | typeof collaborator>) =>
      people.map((person, index) => ({
        ...person,
        personId: `human:${index}`,
        name: null,
        via: [],
      }));
    expect(
      presentSharedConversationFeed({ ...input, people: reaching([owner, collaborator]) }),
    ).toEqual({ feed: [], pendingKey: "m-4" });
    expect(presentSharedConversationFeed({ ...input, people: reaching([owner]) }).feed).toEqual(
      input.feed,
    );
  });

  it("keeps a message already on screen when the thread becomes shared", () => {
    // The owner's message hydrated after the record's last read, and was drawn while unshared.
    const stored = message("m-5", "My words from before sharing.");
    const owner = { level: "owner" as const, you: true, firstOwner: true };
    const collaborator = { level: "collaborator" as const, you: false, firstOwner: false };
    const reaching = [owner, collaborator].map((person, index) => ({
      ...person,
      personId: `human:${index}`,
      name: null,
      via: [],
    }));
    const shared = {
      feed: [stored],
      record: record({ shared: false, authors: [] }),
      failed: false,
      seen: { ...seenAt(["m-5"], 2), sharedSince: 3 },
      people: reaching,
    };
    // It stays on screen, and the record is asked once more, since it may yet name the author.
    expect(presentSharedConversationFeed({ ...shared, readAt: 1 })).toEqual({
      feed: [stored],
      pendingKey: "m-5",
    });
    expect(presentSharedConversationFeed({ ...shared, readAt: 4 })).toEqual({
      feed: [stored],
      pendingKey: "",
    });
  });

  it("leaves a thread only one person writes to as stored", () => {
    const stored = message("m-3", "Just me.");
    const { feed } = presentSharedConversationFeed({
      feed: [stored],
      record: record({ shared: false, authors: [] }),
      failed: false,
      readAt: 2,
      seen: seenAt(["m-3"], 1),
      people: null,
    });
    expect(feed).toEqual([stored]);
  });

  it("takes the platform's mark off an answer to the agent's question", () => {
    const group = {
      type: "activity-group",
      id: "group-1",
      createdAt: "2026-10-31T00:00:00.000Z",
      runId: null,
      activities: [
        {
          workEntry: {
            questionAnswer: {
              requestId: "request-1",
              answers: { color: ["[Answer from Priya (collaborator)] Blue"] },
            },
          },
        },
      ],
    } as unknown as ThreadFeedEntry;
    const { feed } = presentSharedConversationFeed({
      feed: [group],
      record: record({
        answers: [
          {
            requestId: "request-1",
            name: "Priya",
            level: "collaborator",
            you: false,
            storedPrefix: "[Answer from Priya (collaborator)] ",
          },
        ],
      }),
      failed: false,
      readAt: 2,
      seen: NO_SHARED_MESSAGES_SEEN,
      people: null,
    });
    const shown = feed[0];
    expect(
      shown?.type === "activity-group" && shown.activities[0]?.workEntry.questionAnswer?.answers,
    ).toEqual({ color: ["Blue"] });
  });
});
