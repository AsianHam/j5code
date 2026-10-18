import { describe, expect, it } from "vite-plus/test";

import { answeredByLine, nextKeptItems } from "./inboxKept.logic";

const keyOf = (item: string) => item;

describe("an inbox item someone was answering when it closed", () => {
  it("stays, with their words, when it closes while they have typed into it", () => {
    const kept = nextKeptItems({
      previous: ["ask-1", "ask-2"],
      current: ["ask-2"],
      kept: new Map(),
      answers: { "ask-1": "Call Acme first" },
      submitting: null,
      keyOf,
    });
    expect([...kept.keys()]).toEqual(["ask-1"]);
  });

  it("goes when it closes with nothing typed, or once the words are cleared", () => {
    const untyped = nextKeptItems({
      previous: ["ask-1"],
      current: [],
      kept: new Map(),
      answers: { "ask-1": "  " },
      submitting: null,
      keyOf,
    });
    expect(untyped.size).toBe(0);
    const cleared = nextKeptItems({
      previous: [],
      current: [],
      kept: new Map([["ask-1", "ask-1"]]),
      answers: {},
      submitting: null,
      keyOf,
    });
    expect(cleared.size).toBe(0);
  });

  it("is not kept when it closed because this client sent the answer", () => {
    expect(
      nextKeptItems({
        previous: ["ask-1"],
        current: [],
        kept: new Map(),
        answers: { "ask-1": "Call Acme first" },
        submitting: "ask-1",
        keyOf,
      }).size,
    ).toBe(0);
  });
});

describe("who answered an ask", () => {
  it("names someone else and says you for the reader", () => {
    expect(answeredByLine("Priya", "Jackson")).toBe("Priya answered");
    expect(answeredByLine("Jackson", "Jackson")).toBe("You answered");
    expect(answeredByLine(undefined, "Jackson")).toBeNull();
  });
});
