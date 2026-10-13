import { describe, expect, it } from "vite-plus/test";

import {
  authorName,
  authorsByMessage,
  mayHaveAuthorLine,
  queuedMessageRules,
  queuedMessageTexts,
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
