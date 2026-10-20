import { describe, expect, it } from "vite-plus/test";

import { answeredByLine, closedLine, nextKeptItems } from "./inboxKept.logic";

const keyOf = (item: string) => item;

describe("an inbox item someone was answering when it closed", () => {
  it("stays, with their words, when it closes while they have typed into it", () => {
    const kept = nextKeptItems({
      previous: ["ask-1", "ask-2"],
      current: ["ask-2"],
      kept: new Map(),
      answers: { "ask-1": "Call Acme first" },
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
      keyOf,
    });
    expect(untyped.size).toBe(0);
    const cleared = nextKeptItems({
      previous: [],
      current: [],
      kept: new Map([["ask-1", "ask-1"]]),
      answers: {},
      keyOf,
    });
    expect(cleared.size).toBe(0);
  });

  it("goes when this client's own answer won: its confirmation clears the words", () => {
    const whileSending = nextKeptItems({
      previous: ["ask-1"],
      current: [],
      kept: new Map(),
      answers: { "ask-1": "Call Acme first" },
      keyOf,
    });
    const confirmed = nextKeptItems({
      previous: [],
      current: [],
      kept: whileSending,
      answers: {},
      keyOf,
    });
    expect(confirmed.size).toBe(0);
  });

  it("stays when someone else's answer won while this client was sending its own", () => {
    const lost = nextKeptItems({
      previous: ["ask-1"],
      current: [],
      kept: new Map(),
      answers: { "ask-1": "Call Acme first" },
      keyOf,
    });
    expect([...lost.keys()]).toEqual(["ask-1"]);
    expect(
      closedLine({
        answered: { answeredBy: "Priya" },
        answeredReadSinceClose: true,
        ownName: "Jackson",
      }),
    ).toBe("Priya answered");
  });
});

describe("what a kept item says", () => {
  it("says the agent withdrew it once the answered asks were read and do not hold it", () => {
    expect(closedLine({ answered: null, answeredReadSinceClose: true, ownName: null })).toBe(
      "The agent withdrew this",
    );
    expect(closedLine({ answered: null, answeredReadSinceClose: false, ownName: null })).toBe(
      "No longer open",
    );
  });
});

describe("who answered an ask", () => {
  it("names someone else and says you for the reader", () => {
    expect(answeredByLine("Priya", "Jackson")).toBe("Priya answered");
    expect(answeredByLine("Jackson", "Jackson")).toBe("You answered");
    expect(answeredByLine(undefined, "Jackson")).toBeNull();
  });
});
