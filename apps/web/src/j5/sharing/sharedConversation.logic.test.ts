import { describe, expect, it } from "vite-plus/test";

import {
  authorName,
  authoredMessageIds,
  authorsByMessage,
  isSettledPrompt,
  messagesToAskAgainAbout,
  mayHaveAuthorLine,
  queuedMessageRules,
  queuedMessageText,
  settledPromptSignal,
  sharedConversationNote,
  withoutAuthorLine,
} from "./sharedConversation.logic";

const priya = {
  messageId: "m1",
  displayName: "Priya",
  kind: "guest",
  you: false,
  note: null,
} as const;
const me = {
  messageId: "m2",
  displayName: "Jackson M.",
  kind: "member",
  you: true,
  note: null,
} as const;

describe("the author line", () => {
  it("is taken off every shape the server writes", () => {
    expect(withoutAuthorLine("[Message from Priya (guest)]\n\nrun the tests")).toBe(
      "run the tests",
    );
    expect(withoutAuthorLine("[Message from a member]\n\nhello")).toBe("hello");
    expect(
      withoutAuthorLine("[Message from Priya (guest), edited by Jackson M. (member)]\n\nfixed"),
    ).toBe("fixed");
  });

  it("leaves alone a text that only mentions one", () => {
    const quoted = "see [Message from Priya (guest)]\n\nabove";
    expect(mayHaveAuthorLine(quoted)).toBe(false);
    expect(withoutAuthorLine(quoted)).toBe(quoted);
    expect(withoutAuthorLine("[Message from Priya (guest)] same line")).toBe(
      "[Message from Priya (guest)] same line",
    );
  });
});

describe("a queued message in a shared conversation", () => {
  const authors = authorsByMessage([priya, me]);

  it("is a member's to change, withdraw or steer, whoever wrote it", () => {
    expect(queuedMessageRules({ isGuest: false, author: authors.get("m1") })).toEqual({
      mayChange: true,
      maySteer: true,
    });
    expect(queuedMessageRules({ isGuest: false, author: undefined })).toEqual({
      mayChange: true,
      maySteer: true,
    });
  });

  it("is a guest's to change or withdraw only when it is their own, and never to steer", () => {
    expect(queuedMessageRules({ isGuest: true, author: { you: true } })).toEqual({
      mayChange: true,
      maySteer: false,
    });
    expect(queuedMessageRules({ isGuest: true, author: { you: false } }).mayChange).toBe(false);
    // Not yet in the server's record, such as a message still on its way.
    expect(queuedMessageRules({ isGuest: true, author: undefined }).mayChange).toBe(false);
  });

  it("shows the person's own words, with a name on someone else's", () => {
    expect(queuedMessageText("[Message from Jackson M. (member)]\n\nmine", me)).toBe("mine");
    expect(queuedMessageText("[Message from Priya (guest)]\n\nhers", priya)).toBe("Priya: hers");
    expect(
      queuedMessageText("[Message from a guest]\n\ntheirs", { ...priya, displayName: null }),
    ).toBe("A guest: theirs");
  });

  it("leaves a kind a person wrote into their own name out of it", () => {
    const posing = { ...priya, displayName: "Jackson (member)" };
    expect(authorName(posing)).toBe("Jackson");
    expect(authorName({ ...priya, displayName: "(Member)" })).toBe("A guest");
    expect(queuedMessageText("[Message from Jackson (guest)]\n\nhi", posing)).toBe("Jackson: hi");
  });

  it("shows a text the server holds no author for as it is", () => {
    const typed = "[Message from Priya (guest)]\n\ntyped before sharing";
    expect(queuedMessageText(typed, undefined)).toBe(typed);
  });
});

describe("what tells the client to ask the server's record again", () => {
  const prompt = (id: string, completedAt: string | null) => ({
    id,
    kind: "work",
    entry: { toolData: { type: "approval_request", requestId: `request-${id}`, completedAt } },
  });
  const authoredText = "[Message from Priya (guest)]\n\nrun the tests";

  it("counts a person's message once the server's copy, with its author line, has arrived", () => {
    // Their own message is first drawn from what they typed; its id is not yet a reason to ask.
    expect(authoredMessageIds([{ id: "m1", text: "run the tests" }])).toEqual([]);
    expect(authoredMessageIds([{ id: "m1", text: authoredText }])).toEqual(["m1"]);
    expect(authoredMessageIds([{ id: null, text: authoredText }])).toEqual([]);
  });

  it("asks once more about a message a read missed, and never a third time", () => {
    const recorded = new Set(["m1"]);
    expect(
      messagesToAskAgainAbout({ authored: ["m1", "m2"], recorded, askedAgain: new Set() }),
    ).toEqual(["m2"]);
    // Still unrecorded after that: a line someone typed before the thread was shared.
    expect(
      messagesToAskAgainAbout({ authored: ["m1", "m2"], recorded, askedAgain: new Set(["m2"]) }),
    ).toEqual([]);
  });

  it("moves when a prompt settles, and not for one still open or for the agent's own work", () => {
    const before = settledPromptSignal([prompt("p1", null)]);
    expect(settledPromptSignal([prompt("p1", "2026-10-13T06:40:00Z")])).not.toBe(before);
    expect(
      settledPromptSignal([
        prompt("p1", null),
        { id: "a1", kind: "message" },
        { id: "w1", kind: "work", entry: { toolData: { type: "tool_call" } } },
      ]),
    ).toBe(before);
  });

  it("names an answerer only on a settled prompt", () => {
    expect(isSettledPrompt(prompt("p1", "2026-10-13T06:40:00Z").entry.toolData)).toBe(true);
    expect(isSettledPrompt(prompt("p1", null).entry.toolData)).toBe(false);
    expect(isSettledPrompt({ type: "tool_call", completedAt: "2026-10-13T06:40:00Z" })).toBe(false);
  });
});

describe("the platform's note to the agent", () => {
  it("is read without its tags, and only when the platform sent it", () => {
    const text =
      "<j5_shared_conversation>\nWho can write: Priya (guest).\n</j5_shared_conversation>";
    expect(sharedConversationNote({ createdBy: "system", text })).toBe(
      "Who can write: Priya (guest).",
    );
    expect(sharedConversationNote({ createdBy: "user", text })).toBeNull();
    expect(sharedConversationNote({ createdBy: "system", text: "hello" })).toBeNull();
  });
});
