import { expect, it } from "vite-plus/test";

import {
  adjudicationAsks,
  commandsACrew,
  hasMoreThanExcerpt,
  isAskAlreadyClosed,
  pickShownAsk,
} from "./adjudicationDock.logic";

const ask = (
  exchangeId: string,
  overrides: Partial<{
    senderThreadId: string | null;
    status: "open" | "answered";
    openedAt: string;
  }> = {},
) => ({
  exchangeId,
  senderThreadId: "captain",
  status: "open" as const,
  openedAt: "2026-10-27T10:00:00.000Z",
  ...overrides,
});

it("pins only this thread's open asks, oldest first", () => {
  const asks = adjudicationAsks({
    items: [
      ask("later", { openedAt: "2026-10-27T10:05:00.000Z" }),
      ask("other-thread", { senderThreadId: "builder" }),
      ask("answered", { status: "answered" }),
      ask("first"),
    ],
    refused: [],
    threadId: "captain",
    hasWords: () => false,
  });
  expect(asks.map((item) => item.exchangeId)).toEqual(["first", "later"]);
  expect(
    adjudicationAsks({ items: [ask("first")], refused: [], threadId: null, hasWords: () => true }),
  ).toEqual([]);
});

it("keeps an ask a refused answer left behind only while its words are in the box", () => {
  const input = {
    items: [ask("open", { openedAt: "2026-10-27T10:05:00.000Z" })],
    refused: [ask("closed"), ask("open", { openedAt: "2026-10-27T10:05:00.000Z" })],
    threadId: "captain",
  };
  expect(
    adjudicationAsks({ ...input, hasWords: () => true }).map((item) => item.exchangeId),
  ).toEqual(["closed", "open"]);
  expect(
    adjudicationAsks({ ...input, hasWords: () => false }).map((item) => item.exchangeId),
  ).toEqual(["open"]);
});

it("shows the oldest ask in full, or the one the person picked while it is still pinned", () => {
  const asks = [ask("first"), ask("second"), ask("third")];
  expect(pickShownAsk([], null)).toBeNull();
  expect(pickShownAsk(asks, null)?.shown.exchangeId).toBe("first");
  expect(pickShownAsk(asks, null)?.others.map((item) => item.exchangeId)).toEqual([
    "second",
    "third",
  ]);
  expect(pickShownAsk(asks, "second")?.shown.exchangeId).toBe("second");
  expect(pickShownAsk(asks, "gone")?.shown.exchangeId).toBe("first");
});

it("offers the full question only for a body longer than the three-line excerpt", () => {
  expect(hasMoreThanExcerpt("One short line.")).toBe(false);
  expect(hasMoreThanExcerpt("a\nb\nc")).toBe(false);
  expect(hasMoreThanExcerpt("a\nb\nc\nd")).toBe(true);
  expect(hasMoreThanExcerpt("x".repeat(241))).toBe(true);
});

it("reads the server's closed-ask refusals as already answered and nothing else", () => {
  expect(isAskAlreadyClosed({ _tag: "J5ActionError", code: "A2AExchangeNotOpenError" })).toBe(true);
  expect(isAskAlreadyClosed({ code: "A2AAskAnsweredError" })).toBe(true);
  expect(isAskAlreadyClosed({ code: "A2AAskNotYoursError" })).toBe(false);
  expect(isAskAlreadyClosed(new Error("offline"))).toBe(false);
  expect(isAskAlreadyClosed(null)).toBe(false);
});

it("pins asks only in a Captain's thread, not a Crew member's or a plain agent's", () => {
  const crew = { crewInstanceId: "crew-1", crewName: "Steer" };
  expect(commandsACrew({ kind: "captain", crews: [crew] })).toBe(true);
  expect(commandsACrew({ kind: "captain", crews: [] })).toBe(false);
  expect(commandsACrew({ kind: "member", seat: "Builder", crew })).toBe(false);
  expect(commandsACrew(undefined)).toBe(false);
});
