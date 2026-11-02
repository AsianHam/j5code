import { assert, describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  scopedInboxItemKey,
  type HumanInboxItem,
  type HumanInboxResponse,
  type ScopedHumanInboxItem,
} from "@t3tools/contracts/j5";

import type { J5ReadSource } from "./readSources.ts";
import {
  answeredByLine,
  closedLine,
  inboxBellPresentation,
  mergeHumanInboxSources,
  mergeOpenInboxCounts,
  nextKeptItems,
  submitHumanInboxAnswer,
  writesNowhere,
} from "./inbox.ts";

const item: HumanInboxItem = {
  personId: "human:alpha",
  projectId: "project:shared",
  projectTitle: "Shared",
  exchangeId: "exchange:shared",
  senderId: "agent:sender",
  senderThreadId: "thread:shared",
  intent: "Question",
  urgency: "soon",
  message: "Proceed?",
  openedAt: "2026-09-08T00:00:00Z",
  status: "open",
  terminalAt: null,
};
const source = <A>(
  id: string,
  data: A,
  overrides: Partial<J5ReadSource<A>> = {},
): J5ReadSource<A> => ({
  environmentId: EnvironmentId.make(id),
  environmentLabel: id,
  connected: true,
  status: "ready",
  data,
  error: null,
  refreshing: false,
  ...overrides,
});

it("merges obligations by urgency and age while retaining each environment and person", () => {
  const sources: Array<J5ReadSource<HumanInboxResponse>> = [
    source("alpha", { personId: "human:alpha", items: [item] }),
    source("bravo", {
      personId: "human:bravo",
      items: [{ ...item, personId: "human:bravo", urgency: "blocking" }],
    }),
  ];
  const items = mergeHumanInboxSources({ isReady: true, sources });
  expect(items.map((row) => [row.environmentId, row.personId])).toEqual([
    ["bravo", "human:bravo"],
    ["alpha", "human:alpha"],
  ]);
  expect(new Set(items.map(scopedInboxItemKey)).size).toBe(2);
  expect(items.every((row) => row.sourceReady)).toBe(true);
});

it("keeps cached obligations visible but cannot send through their disconnected environment", () => {
  const items = mergeHumanInboxSources({
    isReady: true,
    sources: [
      source(
        "offline",
        { personId: item.personId, items: [item] },
        { status: "offline", connected: false },
      ),
    ],
  });
  expect(items[0]).toMatchObject({
    environmentId: "offline",
    sourceReady: false,
    connected: false,
  });
});

it("sums known counts without treating an unavailable source as a known zero", () => {
  const result = mergeOpenInboxCounts({
    isReady: true,
    sources: [
      source("alpha", { personId: "human:alpha", count: 2 }),
      source(
        "bravo",
        { personId: "human:bravo", count: 3 },
        { status: "offline", connected: false },
      ),
    ],
  });
  expect(result).toEqual({ count: 5, incomplete: true });
  expect(
    mergeOpenInboxCounts({
      isReady: true,
      sources: [
        source("unknown", { personId: "human:unknown", count: 0 }, { data: null, status: "error" }),
      ],
    }),
  ).toEqual({ count: null, incomplete: true });
});

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

it("clears pending state when answer attempt id generation fails", async () => {
  const item = {
    environmentId: EnvironmentId.make("remote"),
    personId: "human:local-operator",
    projectId: "project:answer-test",
    projectTitle: "Answer test",
    exchangeId: "exchange:answer-test",
    senderId: "agent:answer-test",
    senderThreadId: "thread:answer-test",
    intent: "Prove pending cleanup",
    urgency: "blocking",
    message: "Question",
    openedAt: "2026-08-27T00:00:00.000Z",
    status: "open",
    terminalAt: null,
  } satisfies ScopedHumanInboxItem;
  const pending: Array<string | null> = [];
  const errors: Array<string | null> = [];
  const send = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => undefined);
  const notifyChanged = vi.fn();
  const onAccepted = vi.fn();

  await submitHumanInboxAnswer({
    item,
    message: "Answer",
    attempts: new Map(),
    randomUUID: () => {
      throw new Error("Secure random ids are unavailable.");
    },
    send,
    refresh,
    notifyChanged,
    onAccepted,
    setPendingExchangeId: (exchangeId) => pending.push(exchangeId),
    setError: (message) => errors.push(message),
  });

  assert.deepStrictEqual(pending, [scopedInboxItemKey(item), null]);
  assert.deepStrictEqual(errors, [null, "Secure random ids are unavailable."]);
  assert.equal(send.mock.calls.length, 0);
  assert.equal(refresh.mock.calls.length, 0);
  assert.equal(notifyChanged.mock.calls.length, 0);
  assert.equal(onAccepted.mock.calls.length, 0);
});

it("reports a stale inbox without treating a delivered answer as failed", async () => {
  const item = {
    environmentId: EnvironmentId.make("remote"),
    personId: "human:local-operator",
    projectId: "project:refresh-test",
    projectTitle: "Refresh test",
    exchangeId: "exchange:refresh-test",
    senderId: "agent:refresh-test",
    senderThreadId: "thread:refresh-test",
    intent: "Distinguish delivery from refresh",
    urgency: "blocking",
    message: "Question",
    openedAt: "2026-08-27T00:00:00.000Z",
    status: "open",
    terminalAt: null,
  } satisfies ScopedHumanInboxItem;
  const attempts = new Map<string, { message: string; clientRequestId: string }>();
  const pending: Array<string | null> = [];
  const errors: Array<string | null> = [];
  const send = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => {
    throw new Error("Network unavailable.");
  });
  const notifyChanged = vi.fn();
  const onAccepted = vi.fn();

  await submitHumanInboxAnswer({
    item,
    message: "Delivered answer",
    attempts,
    randomUUID: () => "request:refresh-test",
    send,
    refresh,
    notifyChanged,
    onAccepted,
    setPendingExchangeId: (exchangeId) => pending.push(exchangeId),
    setError: (message) => errors.push(message),
  });

  assert.deepStrictEqual(pending, [scopedInboxItemKey(item), null]);
  assert.deepStrictEqual(errors, [
    null,
    "Answer delivered, but the inbox could not be refreshed. The list may be stale.",
  ]);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(refresh.mock.calls.length, 1);
  assert.equal(notifyChanged.mock.calls.length, 1);
  assert.equal(onAccepted.mock.calls.length, 1);
  assert.equal(attempts.has(scopedInboxItemKey(item)), false);
});

it("retries an uncertain answer on its original server with the same request id and isolates other servers", async () => {
  const item = {
    environmentId: EnvironmentId.make("remote"),
    personId: "human:remote",
    projectId: "project:shared",
    projectTitle: "Shared",
    exchangeId: "exchange:shared",
    senderId: "agent:sender",
    senderThreadId: "thread:shared",
    intent: "Proceed",
    urgency: "blocking",
    message: "Question",
    openedAt: "2026-09-08T00:00:00Z",
    status: "open",
    terminalAt: null,
  } satisfies ScopedHumanInboxItem;
  const attempts = new Map<string, { message: string; clientRequestId: string }>();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection lost after sending"))
    .mockResolvedValue(undefined);
  const refresh = vi.fn(async () => undefined);
  const notifyChanged = vi.fn();
  const randomUUID = vi
    .fn()
    .mockReturnValueOnce("request:remote")
    .mockReturnValueOnce("request:other");
  const submit = (current: ScopedHumanInboxItem) =>
    submitHumanInboxAnswer({
      item: current,
      message: "Go",
      attempts,
      randomUUID,
      send,
      refresh,
      notifyChanged,
      onAccepted: vi.fn(),
      setPendingExchangeId: vi.fn(),
      setError: vi.fn(),
    });
  await submit(item);
  await submit({ ...item, environmentId: EnvironmentId.make("other"), personId: "human:other" });
  await submit(item);
  assert.deepStrictEqual(
    send.mock.calls.map(([environmentId, input]) => [
      environmentId,
      "personId" in input,
      input.clientRequestId,
    ]),
    // The request names no person: the server answers as the connection's own.
    [
      ["remote", false, "request:remote"],
      ["other", false, "request:other"],
      ["remote", false, "request:remote"],
    ],
  );
  assert.deepStrictEqual(refresh.mock.calls, [
    ["other", "human:other"],
    ["remote", "human:remote"],
  ]);
  assert.deepStrictEqual(notifyChanged.mock.calls, [["other"], ["remote"]]);
});

describe("who has an inbox", () => {
  const person = (levels: Array<"viewer" | "collaborator" | "owner">) =>
    ({
      kind: "person",
      personId: "human:priya",
      name: "Priya",
      firstOwner: false,
      levels: levels.map((level) => ({ scope: { kind: "server" as const }, level })),
      wide: true,
      owner: levels.includes("owner"),
      retiredLinks: null,
    }) as const;

  it("is no one's who writes nowhere: an unknown device or a Viewer everywhere", () => {
    expect(writesNowhere({ kind: "unknown" })).toBe(true);
    expect(writesNowhere(person(["viewer"]))).toBe(true);
  });

  it("is someone's who writes anywhere, and a server that has not answered withholds nothing", () => {
    expect(writesNowhere(person(["viewer", "collaborator"]))).toBe(false);
    expect(writesNowhere({ kind: "service" })).toBe(false);
    expect(writesNowhere(null)).toBe(false);
  });
});

describe("what the inbox bell says", () => {
  it("shows the open count, and nothing when none is open", () => {
    expect(inboxBellPresentation({ count: 3, incomplete: false })).toEqual({
      badge: "3",
      label: "Open inbox, 3 open",
    });
    expect(inboxBellPresentation({ count: 0, incomplete: false }).badge).toBeNull();
    expect(inboxBellPresentation({ count: null, incomplete: false })).toEqual({
      badge: null,
      label: "Open inbox",
    });
  });

  it("marks a count some server could not refresh", () => {
    expect(inboxBellPresentation({ count: 2, incomplete: true })).toEqual({
      badge: "2*",
      label: "Open inbox, last known 2 open; some environments could not be refreshed",
    });
    expect(inboxBellPresentation({ count: null, incomplete: true }).badge).toBe("?");
  });
});
