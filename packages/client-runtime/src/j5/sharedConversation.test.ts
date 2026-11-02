import type { MessageAuthor } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  answersWithoutPrefix,
  readAnswersFor,
  recallableMessages,
  sharedMessageView,
  typedText,
  mayBeSharedConversation,
  NO_SHARED_MESSAGES_SEEN,
  observeSharedMessages,
  sharedMessageAnsweredFor,
  sharedMessageAwaitsRead,
} from "./sharedConversation.ts";

const author = (overrides: Partial<MessageAuthor> = {}): MessageAuthor => ({
  messageId: "message-1",
  name: "Priya",
  level: "collaborator",
  editedBy: null,
  you: false,
  note: null,
  storedPrefix: "[Message from Priya (collaborator)]\n\n",
  ...overrides,
});

const view = (overrides: Partial<Parameters<typeof sharedMessageView>[0]>) =>
  sharedMessageView({
    text: "[Message from Priya (collaborator)]\n\nShip it.",
    fromServer: true,
    author: undefined,
    answeredFor: false,
    mayBeShared: true,
    typedHere: null,
    ...overrides,
  });

describe("a person's message in a shared conversation", () => {
  it("is shown as typed, without the lines the server names, whoever sent it", () => {
    expect(view({ author: author() })).toEqual({
      kind: "authored",
      typed: "Ship it.",
      note: null,
      author: author(),
    });
  });

  it("keeps a note it carried for a notice of its own", () => {
    const withNote = author({
      note: "Two people can write to this thread.",
      storedPrefix:
        "Two people can write to this thread.\n\n[Message from Priya (collaborator)]\n\n",
    });
    expect(
      view({
        text: "Two people can write to this thread.\n\n[Message from Priya (collaborator)]\n\nShip it.",
        author: withNote,
      }),
    ).toMatchObject({ typed: "Ship it.", note: "Two people can write to this thread." });
  });

  it("leaves a slash command as typed: the server stores it with no lines", () => {
    expect(typedText("/compact", author({ storedPrefix: "" }))).toBe("/compact");
  });

  it("is never stripped on its words alone: text that does not begin with the prefix stays", () => {
    expect(typedText("Ship it.", author())).toBe("Ship it.");
  });
});

describe("a message whose author the server has not answered for yet", () => {
  it("is held back until a read answers for it, so no line for the agent is drawn", () => {
    expect(view({})).toEqual({ kind: "pending", typed: null });
  });

  it("shows what this client's person typed while it waits", () => {
    expect(view({ typedHere: "Ship it." })).toEqual({ kind: "pending", typed: "Ship it." });
  });

  it("is a plain message once a read has answered for it and holds no one", () => {
    expect(view({ answeredFor: true })).toEqual({ kind: "plain" });
  });

  it("is a plain message in a thread only one person can write to, and as this client drew it", () => {
    expect(view({ mayBeShared: false })).toEqual({ kind: "plain" });
    expect(view({ fromServer: false })).toEqual({ kind: "plain" });
  });
});

describe("whether a read answers for a message", () => {
  it("is so only for a read that came back once the message had been seen", () => {
    expect(readAnswersFor({ readAt: 2_000, firstSeenAt: 1_000 })).toBe(true);
    expect(readAnswersFor({ readAt: 500, firstSeenAt: 1_000 })).toBe(false);
    expect(readAnswersFor({ readAt: null, firstSeenAt: 1_000 })).toBe(false);
  });
});

describe("an answer to the agent's question", () => {
  const prefix = "[Answer from Priya (collaborator)] ";

  it("is shown as given, without the mark the server names", () => {
    expect(
      answersWithoutPrefix(
        {
          typed: `${prefix}Keep the step.`,
          chosen: [`${prefix}Option B`, "Option C"],
          untouched: 3,
        },
        prefix,
      ),
    ).toEqual({ typed: "Keep the step.", chosen: ["Option B", "Option C"], untouched: 3 });
  });

  it("is left as it is when the server names no mark, or the answer does not carry it", () => {
    expect(answersWithoutPrefix({ typed: "Keep the step." }, "")).toEqual({
      typed: "Keep the step.",
    });
    expect(answersWithoutPrefix({ chosen: ["Option B"] }, prefix)).toEqual({
      chosen: ["Option B"],
    });
  });
});

describe("up-arrow recall in a shared conversation", () => {
  const stamped = {
    id: "message-1",
    role: "user",
    text: "[Message from Priya (collaborator)]\n\nShip it.",
  };
  const reply = { id: "message-2", role: "assistant", text: "Shipped." };
  const recall = (overrides: Partial<Parameters<typeof sharedMessageView>[0]>) =>
    recallableMessages([stamped, reply], () => view(overrides)).map((message) => message.text);

  it("offers nothing of a message whose author has not been read yet", () => {
    expect(recall({})).toEqual(["Shipped."]);
  });

  it("offers what this client's person typed while the author is still being read", () => {
    expect(recall({ typedHere: "Ship it." })).toEqual(["Ship it.", "Shipped."]);
  });

  it("offers the typed words once the author is read", () => {
    expect(recall({ author: author(), answeredFor: true })).toEqual(["Ship it.", "Shipped."]);
  });

  it("offers a message as stored once a read answers that no one is recorded for it", () => {
    expect(recall({ answeredFor: true })).toEqual([stamped.text, "Shipped."]);
  });

  it("offers nothing of a person's message the timeline has not drawn", () => {
    expect(
      recallableMessages([stamped, reply], () => undefined).map((message) => message.text),
    ).toEqual(["Shipped."]);
  });
});

describe("mayBeSharedConversation", () => {
  const person = (
    level: "viewer" | "collaborator" | "owner",
    you: boolean,
    firstOwner = false,
  ) => ({
    level,
    you,
    firstOwner,
  });
  const unshared = { shared: false, authors: [], answers: [] };

  it("holds every message until the first read answers or fails", () => {
    expect(mayBeSharedConversation({ record: null, failed: false, people: null })).toBe(true);
    expect(mayBeSharedConversation({ record: null, failed: true, people: null })).toBe(false);
  });

  it("knows a thread is shared from who reaches it, before any author is recorded", () => {
    const firstOwner = person("owner", true, true);
    expect(
      mayBeSharedConversation({
        record: unshared,
        failed: false,
        people: [firstOwner, person("collaborator", false)],
      }),
    ).toBe(true);
    expect(
      mayBeSharedConversation({
        record: unshared,
        failed: false,
        people: [firstOwner, person("viewer", false)],
      }),
    ).toBe(false);
    // To a Viewer, a message nobody is recorded for may be the first owner's.
    expect(
      mayBeSharedConversation({
        record: unshared,
        failed: false,
        people: [person("owner", false, true), person("viewer", true)],
      }),
    ).toBe(true);
  });
});

describe("holding a message for its author", () => {
  const message = (id: string) => ({ id, role: "user", text: "Hello", createdBy: "user" });
  const clock = (...times: ReadonlyArray<number>) => {
    let index = 0;
    return () => times[index++]!;
  };

  it("never holds a message already on screen when the thread comes to be shared", () => {
    const unshared = observeSharedMessages(
      NO_SHARED_MESSAGES_SEEN,
      [message("old")],
      false,
      clock(2),
    );
    const shared = observeSharedMessages(unshared, [message("old")], true, clock(5));
    expect(shared.sharedSince).toBe(5);
    expect(sharedMessageAnsweredFor({ messageId: "old", readAt: 1, seen: shared })).toBe(true);
  });

  it("holds a message first seen once the thread may be shared, until a read answers for it", () => {
    const seen = observeSharedMessages(NO_SHARED_MESSAGES_SEEN, [message("new")], true, clock(5));
    expect(sharedMessageAnsweredFor({ messageId: "new", readAt: 1, seen })).toBe(false);
    expect(sharedMessageAnsweredFor({ messageId: "new", readAt: 6, seen })).toBe(true);
  });

  it("still asks the record about a message left on screen, until a read answers for it", () => {
    const seen = { ...NO_SHARED_MESSAGES_SEEN, firstSeen: new Map([["old", 2]]), sharedSince: 5 };
    const asks = (overrides: { readAt: number; mayBeShared?: boolean; failed?: boolean }) =>
      sharedMessageAwaitsRead({
        messageId: "old",
        seen,
        mayBeShared: true,
        failed: false,
        ...overrides,
      });
    expect(asks({ readAt: 1 })).toBe(true);
    expect(asks({ readAt: 3 })).toBe(false);
    expect(asks({ readAt: 1, mayBeShared: false })).toBe(false);
    expect(asks({ readAt: 1, failed: true })).toBe(false);
  });

  it("stores nothing new while nothing has changed", () => {
    const seen = observeSharedMessages(NO_SHARED_MESSAGES_SEEN, [message("a")], true, clock(5));
    expect(observeSharedMessages(seen, [message("a")], true, clock(9))).toBe(seen);
  });

  it("forgets the thread was shared when a read says it is not", () => {
    const seen = observeSharedMessages(NO_SHARED_MESSAGES_SEEN, [], true, clock(5));
    expect(observeSharedMessages(seen, [], false, clock(9)).sharedSince).toBeNull();
  });
});
