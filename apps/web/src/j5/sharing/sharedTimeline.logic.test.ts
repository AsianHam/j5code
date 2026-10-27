import type { MessageAuthor } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  answersWithoutPrefix,
  readAnswersFor,
  recallableMessages,
  sharedMessageView,
  typedText,
} from "./sharedTimeline.logic";

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
