import { EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { assert, it, vi } from "@effect/vitest";

import {
  captureHumanInboxAnswer,
  submitHumanInboxAnswer,
} from "./HumanInboxPage";
import type { ScopedHumanInboxItem as HumanInboxItem } from "./humanInboxClient";

it("captures typed answer text before the state updater runs", () => {
  const event: { currentTarget: { value: string } | null } = {
    currentTarget: { value: "Verbatim answer" },
  };
  let update:
    | ((current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>)
    | undefined;

  captureHumanInboxAnswer(
    event as { readonly currentTarget: { readonly value: string } },
    "exchange:deferred-update",
    (next) => {
      update = next;
    },
  );
  event.currentTarget = null;

  assert.deepStrictEqual(update?.({ existing: "Kept" }), {
    existing: "Kept",
    "exchange:deferred-update": "Verbatim answer",
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
  } satisfies HumanInboxItem;
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
  } satisfies HumanInboxItem;
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
  } satisfies HumanInboxItem;
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
  const submit = (current: HumanInboxItem) =>
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
