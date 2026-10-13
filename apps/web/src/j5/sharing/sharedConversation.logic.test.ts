import { describe, expect, it } from "vite-plus/test";

import {
  authorName,
  authoredMessageIds,
  authorsByMessage,
  isSettledPrompt,
  mayHaveAuthorLine,
  messageStanding,
  messagesTheRecordDoesNotHold,
  queuedMessageRules,
  queuedMessageTexts,
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

  it("matches every form the server writes", () => {
    for (const line of [
      "[Message from Priya (guest)]",
      "[Message from Jackson M. (member)]",
      "[Message from a member]",
      "[Message from a guest]",
      "[Message from Priya (guest), edited by Jackson M. (member)]",
      "[Message from a guest, edited by a member]",
    ]) {
      expect(mayHaveAuthorLine(`${line}\n\nwords`)).toBe(true);
      expect(withoutAuthorLine(`${line}\n\nwords`)).toBe("words");
    }
  });

  it("does not match J5's older envelopes, which also begin with Message from", () => {
    for (const envelope of [
      // A person's inbox reply, an automation's message, an outside agent's message.
      "[Message from human:local-operator]\n\nyes, go ahead\n\n",
      "[Message from automation task:nightly in project Billing]\n\nrun it\n\n",
      "[Message from outside agent Reviewer (outside:42)]\n\nlooks fine\n\n",
    ]) {
      expect(mayHaveAuthorLine(envelope)).toBe(false);
      expect(withoutAuthorLine(envelope)).toBe(envelope);
    }
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
    expect(queuedMessageTexts("[Message from Jackson M. (member)]\n\nmine", me).shown).toBe("mine");
    expect(queuedMessageTexts("[Message from Priya (guest)]\n\nhers", priya).shown).toBe(
      "Priya: hers",
    );
    expect(
      queuedMessageTexts("[Message from a guest]\n\ntheirs", { ...priya, displayName: null }).shown,
    ).toBe("A guest: theirs");
  });

  it("hands an editor what the author typed, never the name the queue shows", () => {
    // A member who edits a guest's queued message sends back the guest's words, edited.
    expect(queuedMessageTexts("[Message from Priya (guest)]\n\nhers", priya).typed).toBe("hers");
    expect(
      queuedMessageTexts(
        "[Message from Priya (guest), edited by Jackson M. (member)]\n\nhers, fixed",
        priya,
      ).typed,
    ).toBe("hers, fixed");
  });

  it("leaves a kind a person wrote into their own name out of it", () => {
    const posing = { ...priya, displayName: "Jackson (member)" };
    expect(authorName(posing)).toBe("Jackson");
    expect(authorName({ ...priya, displayName: "(Member)" })).toBe("A guest");
    expect(queuedMessageTexts("[Message from Jackson (guest)]\n\nhi", posing).shown).toBe(
      "Jackson: hi",
    );
  });

  it("shows a text the server holds no author for as it is", () => {
    const typed = "[Message from Priya (guest)]\n\ntyped before sharing";
    expect(queuedMessageTexts(typed, undefined)).toEqual({ typed, shown: typed });
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

  it("takes a message the record does not hold for a typed line, once a later read says so", () => {
    const first = { read: 1 };
    const later = { read: 2 };
    const seenUnder = new Map([
      ["m1", first],
      ["m2", first],
    ]);
    const recorded = new Set(["m1"]);
    // The read the client held when the message appeared says nothing about it yet.
    expect(
      messagesTheRecordDoesNotHold({ authored: ["m1", "m2"], recorded, seenUnder, record: first }),
    ).toEqual([]);
    // A read made since does: m2 is a line someone typed before the thread was shared.
    expect(
      messagesTheRecordDoesNotHold({ authored: ["m1", "m2"], recorded, seenUnder, record: later }),
    ).toEqual(["m2"]);
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

describe("a message before the server has said whose it is", () => {
  const asked = { looksAuthored: true, recorded: false, unrecorded: false };

  it("keeps the agent's line off the screen while it waits", () => {
    // The reader's own message, first drawn from what they typed, stays their own bubble.
    expect(messageStanding({ ...asked, typedHere: true })).toBe("waiting-own");
    // Anyone else's, and history on first open, is a card with no name yet.
    expect(messageStanding({ ...asked, typedHere: false })).toBe("waiting-unknown");
  });

  it("is whose the record says once it answers", () => {
    expect(messageStanding({ ...asked, recorded: true, typedHere: false })).toBe("recorded");
  });

  it("is shown as typed when the record does not hold it, or it never looked authored", () => {
    expect(messageStanding({ ...asked, unrecorded: true, typedHere: false })).toBe("plain");
    expect(
      messageStanding({
        looksAuthored: false,
        recorded: false,
        unrecorded: false,
        typedHere: true,
      }),
    ).toBe("plain");
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
