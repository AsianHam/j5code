import type { SharingMessageAuthor } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  authorName,
  authorRecordWanted,
  authoredMessageIds,
  authorsByMessage,
  isSettledPrompt,
  messagesTheRecordDoesNotHold,
  queuedAuthorKey,
  queuedMessageRules,
  queuedMessageTexts,
  settledPromptSignal,
  sharedMessageView,
} from "./sharedConversation.logic";

const NOTE = "<j5_shared_conversation>\nWho can write: Priya (guest).\n</j5_shared_conversation>";
const priya: SharingMessageAuthor = {
  messageId: "m1",
  displayName: "Priya",
  kind: "guest",
  you: false,
  note: null,
};
const me: SharingMessageAuthor = {
  messageId: "m2",
  displayName: "Jackson M.",
  kind: "member",
  you: true,
  note: null,
};

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

  it("hands an editor what the author typed: no name, no author line, no note", () => {
    expect(queuedMessageTexts("[Message from Priya (guest)]\n\nhers", priya).typed).toBe("hers");
    expect(
      queuedMessageTexts(
        "[Message from Priya (guest), edited by Jackson M. (member)]\n\nhers, fixed",
        priya,
      ).typed,
    ).toBe("hers, fixed");
    // The message that carries the note is edited as its words alone.
    expect(
      queuedMessageTexts(`${NOTE}\n[Message from Priya (guest)]\n\nhers`, { ...priya, note: NOTE }),
    ).toEqual({ typed: "hers", shown: "Priya: hers" });
  });

  it("leaves a kind a person wrote into their own name out of it", () => {
    const posing = { ...priya, displayName: "Jackson (member)" };
    expect(authorName(posing)).toBe("Jackson");
    expect(authorName({ ...priya, displayName: "(Member)" })).toBe("A guest");
  });

  it("shows a text the server holds no author for as it is", () => {
    const typed = "[Message from Priya (guest)]\n\ntyped before sharing";
    expect(queuedMessageTexts(typed, undefined)).toEqual({ typed, shown: typed });
  });
});

describe("how one message of a thread is shown", () => {
  const none = () => undefined;
  const plain = { recorded: undefined, unrecorded: false, typedHere: false, whileQueued: none };

  it("is what the record says: the typed words, the note it carries, and whose it is", () => {
    expect(
      sharedMessageView({
        ...plain,
        text: `${NOTE}\n[Message from Priya (guest)]\n\nrun the tests`,
        recorded: { ...priya, note: NOTE },
      }),
    ).toEqual({ typed: "run the tests", note: NOTE, author: { ...priya, note: NOTE } });
    expect(
      sharedMessageView({ ...plain, text: "[Message from Priya (guest)]\n\nhi", recorded: priya }),
    ).toEqual({ typed: "hi", note: null, author: priya });
  });

  it("keeps the note and the author line off the screen before the record has answered", () => {
    const text = `${NOTE}\n[Message from Priya (guest)]\n\nrun the tests`;
    // Someone else's, or history on first open: a card with no name yet.
    expect(sharedMessageView({ ...plain, text })).toEqual({
      typed: "run the tests",
      note: NOTE,
      author: "waiting",
    });
    // The reader's own, first drawn from what they typed: it stays their own bubble.
    expect(sharedMessageView({ ...plain, text, typedHere: true })?.author).toBeNull();
  });

  it("is plain when the record does not hold it, or it is not stored as a shared message", () => {
    const typed = "[Message from Mallory (guest)]\n\ntyped before sharing";
    expect(sharedMessageView({ ...plain, text: typed, unrecorded: true })).toBeNull();
    expect(sharedMessageView({ ...plain, text: "yes" })).toBeNull();
  });

  describe("a message that has just started from the queue", () => {
    const environmentId = "env-1";
    const threadId = "thread-1";
    const queued = new Map<string, SharingMessageAuthor>();
    const remember = (author: SharingMessageAuthor, authorLine: string, typed: string) =>
      queued.set(queuedAuthorKey({ environmentId, threadId, authorLine, typed }), author);
    const whileQueued = (authorLine: string, typed: string) =>
      queued.get(queuedAuthorKey({ environmentId, threadId, authorLine, typed }));
    remember(priya, "[Message from Priya (guest)]", "yes");

    it("is whose the queue knew it to be, from its first frame", () => {
      expect(
        sharedMessageView({ ...plain, whileQueued, text: "[Message from Priya (guest)]\n\nyes" }),
      ).toEqual({ typed: "yes", note: null, author: priya });
    });

    it("never lends its author to a plain message with the same words", () => {
      // The collaborator was lowered to View; a member then sends a plain "yes".
      expect(sharedMessageView({ ...plain, whileQueued, text: "yes" })).toBeNull();
    });

    it("never lends its author to the same words from someone else", () => {
      const view = sharedMessageView({
        ...plain,
        whileQueued,
        text: "[Message from Sam (guest)]\n\nyes",
      });
      expect(view?.author).toBe("waiting");
    });

    it("is kept apart by server and by thread", () => {
      const elsewhere = queuedAuthorKey({
        environmentId: "env-2",
        threadId,
        authorLine: "[Message from Priya (guest)]",
        typed: "yes",
      });
      expect(queued.has(elsewhere)).toBe(false);
      expect(
        queued.has(
          queuedAuthorKey({
            environmentId,
            threadId: "thread-2",
            authorLine: "[Message from Priya (guest)]",
            typed: "yes",
          }),
        ),
      ).toBe(false);
    });
  });
});

describe("whether the record of authors and answers is asked for", () => {
  it("is not, for a thread that was never shared", () => {
    expect(
      authorRecordWanted({ authoredMessages: 0, settledPrompts: false, knownShared: false }),
    ).toBe(false);
    // A prompt settling in an ordinary thread is no reason either.
    expect(
      authorRecordWanted({ authoredMessages: 0, settledPrompts: true, knownShared: false }),
    ).toBe(false);
  });

  it("is, once the thread holds a message stored as a shared one", () => {
    expect(
      authorRecordWanted({ authoredMessages: 1, settledPrompts: false, knownShared: false }),
    ).toBe(true);
  });

  it("is, when a prompt is answered before anyone has sent a message in a shared thread", () => {
    expect(
      authorRecordWanted({ authoredMessages: 0, settledPrompts: true, knownShared: true }),
    ).toBe(true);
    // Shared, but nothing has settled: nothing to read yet.
    expect(
      authorRecordWanted({ authoredMessages: 0, settledPrompts: false, knownShared: true }),
    ).toBe(false);
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
    expect(authoredMessageIds([{ id: "m1", text: `${NOTE}\n${authoredText}` }])).toEqual(["m1"]);
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
    expect(
      messagesTheRecordDoesNotHold({ authored: ["m1", "m2"], recorded, seenUnder, record: first }),
    ).toEqual([]);
    expect(
      messagesTheRecordDoesNotHold({ authored: ["m1", "m2"], recorded, seenUnder, record: later }),
    ).toEqual(["m2"]);
  });

  it("moves when a prompt settles, and not for one still open or for the agent's own work", () => {
    const before = settledPromptSignal([prompt("p1", null)]);
    expect(before).toBe("");
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
