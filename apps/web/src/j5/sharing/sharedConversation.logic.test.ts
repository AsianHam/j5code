import { describe, expect, it } from "vite-plus/test";

import {
  authorName,
  authorRecordSignal,
  authorsByMessage,
  mayHaveAuthorLine,
  queuedMessageRules,
  queuedMessageText,
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
  const message = (id: string, role: string) => ({ id, kind: "message", message: { role } });
  const prompt = (id: string, status: string) => ({
    id,
    kind: "work",
    entry: { toolData: { type: "approval_request", status } },
  });

  it("moves when a person's message arrives or a prompt changes", () => {
    const before = authorRecordSignal([message("m1", "user"), prompt("p1", "pending")]);
    expect(authorRecordSignal([message("m1", "user"), prompt("p1", "resolved")])).not.toBe(before);
    expect(
      authorRecordSignal([message("m1", "user"), prompt("p1", "pending"), message("m2", "user")]),
    ).not.toBe(before);
  });

  it("stays as it was while the agent writes and works", () => {
    const before = authorRecordSignal([message("m1", "user")]);
    expect(
      authorRecordSignal([
        message("m1", "user"),
        message("a1", "assistant"),
        { id: "w1", kind: "work", entry: { toolData: { type: "tool_call" } } },
      ]),
    ).toBe(before);
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
