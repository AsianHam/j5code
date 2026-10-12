import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import {
  formatTimeSinceSent,
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  formatThreadA2AQueuedDelivery,
  isThreadA2ADeliveryMessage,
  participantIdsForThreadA2AEnvelope,
  presentThreadA2ADelivery,
  renderThreadA2ADelivery,
  ThreadA2ADeliveryRenderer,
} from "./ThreadA2ARenderer";

const CREATED_AT = "2026-08-29T12:00:00.000Z";
const TIMESTAMP_LABEL = "Today, 8:00 AM";
const deliveryId = (suffix: string) => MessageId.make(`${J5_A2A_DELIVERY_MESSAGE_PREFIX}${suffix}`);

function message(input: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: deliveryId("peer"),
    role: "user",
    text: "",
    runId: null,
    streaming: false,
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

const peerRaw = [
  "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]",
  "",
  "Please verify the worker.",
  "",
  'Reply once with j5_send_message(to="agent:delivery-sender", exchange_id="exchange:one", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");

const peerPlainRaw = [
  "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]",
  "",
  "Nothing further is needed.",
  "",
  "No reply is required. Use j5_send_message without exchange_id only if a new message is needed.",
].join("\n");

const closedInstruction =
  "The platform closed this exchange when this reply was sent. No further reply is required.";

const peerClosedRaw = [
  "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]",
  "",
  "Peer reply delivered verbatim.",
  "",
  closedInstruction,
].join("\n");

const humanRaw = [
  "[Message from human:viewer]",
  "",
  "Please prioritize the alert.",
  "",
  "This person is not watching this chat. They see only what you send back on this exchange.",
  "",
  'Reply once with j5_send_message(to="human:viewer", exchange_id="exchange:human", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");

const humanClosedRaw = [
  "[Message from human:viewer]",
  "",
  "Human reply delivered verbatim.",
  "",
  closedInstruction,
].join("\n");

const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

describe("ThreadA2ADeliveryRenderer", () => {
  it("renders the peer exchange badge inline beside the sender without protocol metadata", () => {
    const source = message({ text: peerRaw });
    const parsed = presentThreadA2ADelivery({
      message: source,
      participantLabels: new Map([["agent:delivery-sender", "Alice"]]),
    });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={source}
        participantLabels={new Map([["agent:delivery-sender", "Alice"]])}
        now={Date.parse(CREATED_AT) + 5 * 60_000}
      />,
    );

    expect(parsed).toMatchObject({
      kind: "peer",
      senderId: "agent:delivery-sender",
      senderLabel: "Alice",
      body: "Please verify the worker.",
      exchange: "expects-reply",
      exchangeId: "exchange:one",
      rawEnvelope: peerRaw,
    });
    expect(markup).toContain('data-j5-a2a-renderer="peer"');
    expect(markup).toContain("From");
    expect(markup).toContain("Alice");
    expect(markup).toContain("Expects reply");
    expect(markup).toContain(">5m<");
    expect(markup).toContain('dateTime="2026-08-29T12:00:00.000Z"');
    expect(markup).toContain("line-clamp-2");
    expect(markup).not.toContain("project-alpha");
    expect(markup).not.toContain("exchange:one");
    expect(markup).not.toContain("Show raw envelope");
    expect(parsed?.rawEnvelope).toBe(peerRaw);
  });

  it("falls back to an explicitly unnamed participant before the identity read supplies a label", () => {
    const parsed = presentThreadA2ADelivery({ message: message({ text: peerRaw }) });
    expect(parsed).toMatchObject({ kind: "peer", senderLabel: "Unnamed participant" });
    expect(parsed).toMatchObject({ senderTooltipParticipantId: "agent:delivery-sender" });
    expect(
      renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={message({ text: peerRaw })} />),
    ).not.toContain("agent:delivery-sender");
  });

  it("formats queued peer deliveries with the timeline identity formatter", () => {
    expect(
      formatThreadA2AQueuedDelivery(peerPlainRaw, new Map([["agent:delivery-sender", "Alice"]])),
    ).toEqual({ label: "From Alice — Nothing further is needed.", tooltipParticipantId: null });
    expect(formatThreadA2AQueuedDelivery(peerPlainRaw, new Map())).toEqual({
      label: "From Unnamed participant — Nothing further is needed.",
      tooltipParticipantId: "agent:delivery-sender",
    });
  });

  it("renders no chip for a one-shot delivery whose role is not a measured reply", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={message({ text: peerPlainRaw })} />,
    );

    expect(markup).not.toContain("Reply");
    expect(markup).not.toContain("plain");
    expect(markup).not.toContain("closed");
  });

  it("renders the exact v13 peer reply as a closed exchange without reply instructions", () => {
    const source = message({ id: deliveryId("peer-closed"), text: peerClosedRaw });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toMatchObject({
      kind: "peer",
      body: "Peer reply delivered verbatim.",
      exchange: "closed",
      exchangeId: null,
    });
    expect(markup).toContain("Closed your exchange");
    expect(markup).not.toContain("Expects reply");
    expect(markup).not.toContain(closedInstruction);
    expect(markup).not.toContain("send_message");
    expect(markup).not.toContain("Show raw envelope");
  });

  it("renders a #11 human inbox reply with a literal id until local identity is proven", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={message({ id: deliveryId("human"), createdBy: "user", text: humanRaw })}
      />,
    );

    expect(markup).toContain('data-j5-a2a-renderer="human"');
    expect(markup).toContain("Via Inbox · human:viewer");
    expect(markup).toContain("Please prioritize the alert.");
  });

  it("uses You only when the caller proves the viewer matches the sender", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={message({ id: deliveryId("human-local"), createdBy: "user", text: humanRaw })}
        resolveViewerParticipantId={() => "human:viewer"}
      />,
    );

    expect(markup).toContain("You · via Inbox");
  });

  it("renders the exact v13 human reply as a closed exchange without reply instructions", () => {
    const source = message({
      id: deliveryId("human-closed"),
      createdBy: "user",
      text: humanClosedRaw,
    });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={source}
        resolveViewerParticipantId={() => "human:viewer"}
      />,
    );

    expect(presentation).toMatchObject({
      kind: "human",
      senderId: "human:viewer",
      body: "Human reply delivered verbatim.",
      exchange: "closed",
    });
    expect(markup).toContain("You · via Inbox");
    expect(markup).toContain("Closed your exchange");
    expect(markup).not.toContain("Expects reply");
    expect(markup).not.toContain(closedInstruction);
    expect(markup).not.toContain("send_message");
    expect(markup).not.toContain("Show raw envelope");
  });

  it.each([
    [
      "peer",
      message({
        id: deliveryId("peer-future-closed"),
        text: peerClosedRaw.replace("No further reply is required.", "This exchange is complete."),
      }),
    ],
    [
      "human",
      message({
        id: deliveryId("human-future-closed"),
        createdBy: "user",
        text: humanClosedRaw.replace("No further reply is required.", "This exchange is complete."),
      }),
    ],
  ] as const)("raw-renders a future %s closed instruction instead of guessing", (_kind, source) => {
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toEqual({ kind: "raw", rawEnvelope: source.text });
    expect(markup).toContain('data-j5-a2a-renderer="raw"');
    expect(markup).toContain("Show raw envelope");
  });

  it("raw-renders the older v6 human template instead of treating it as #11", () => {
    const raw = [
      "[Message from the human]",
      "",
      "Legacy human delivery.",
      "",
      "The human is not watching this chat. They see only what you send back on this exchange.",
      "",
      "No reply is required. Use send_message without exchange_id only if a new message is needed.",
    ].join("\n");

    expect(
      presentThreadA2ADelivery({
        message: message({ id: deliveryId("human-v6"), createdBy: "user", text: raw }),
      }),
    ).toEqual({ kind: "raw", rawEnvelope: raw });
  });

  it("renders a silence notice as a muted platform line without a raw expander", () => {
    const source = message({ id: deliveryId("silence"), createdBy: "system", text: silenceRaw });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={source} timestampLabel={TIMESTAMP_LABEL} />,
    );

    expect(markup).toContain('data-j5-a2a-renderer="silence"');
    expect(markup).toContain("agent:counterpart");
    expect(markup).toContain("turn ended without replying");
    expect(markup).toContain(TIMESTAMP_LABEL);
    expect(markup).not.toContain("Show raw envelope");
    expect(presentThreadA2ADelivery({ message: source })).toMatchObject({
      kind: "silence",
      summary: "agent:counterpart's turn ended without replying",
      rawEnvelope: silenceRaw,
    });
    const summary = markup.match(/<span data-j5-a2a-silence-summary="true">(.*?)<\/span>/)?.[1];
    expect(summary).toBeDefined();
    expect(summary).not.toContain("turn-ended-no-reply");
    expect(summary).not.toContain(CREATED_AT);
  });

  it.each([
    ["peer", message({ text: peerRaw })],
    ["peer closed", message({ id: deliveryId("peer-closed-parsed"), text: peerClosedRaw })],
    ["human", message({ id: deliveryId("human-parsed"), createdBy: "user", text: humanRaw })],
    [
      "human closed",
      message({ id: deliveryId("human-closed-parsed"), createdBy: "user", text: humanClosedRaw }),
    ],
    [
      "silence",
      message({ id: deliveryId("silence-parsed"), createdBy: "system", text: silenceRaw }),
    ],
  ] as const)("keeps parsed %s cards free of raw-envelope expanders", (_kind, source) => {
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentThreadA2ADelivery({ message: source })?.kind).not.toBe("raw");
    expect(markup).not.toContain("Show raw envelope");
  });

  it.each([
    [
      "errored",
      "agent:counterpart errored without replying on exchange:one: socket closed",
      "agent:counterpart errored without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was interrupted without replying on exchange:one. The participant was interrupted.",
      "agent:counterpart was interrupted without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was cancelled without replying on exchange:one. The participant was cancelled.",
      "agent:counterpart was cancelled without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was rolled_back without replying on exchange:one. The participant was rolled back.",
      "agent:counterpart was rolled_back without replying",
    ],
    [
      "awaiting-human",
      "agent:counterpart is awaiting the human on exchange:human (awaiting-human).",
      "agent:counterpart is awaiting the human",
    ],
    [
      "blocked-on-peer",
      "agent:counterpart is blocked on agent:peer via exchange:peer.",
      "agent:counterpart is blocked on agent:peer",
    ],
  ])("maps known %s detector text to a truthful human summary", (noticeType, body, summary) => {
    const raw = [
      `[Cross-agent messaging system notice: ${noticeType}]`,
      "",
      body,
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");

    expect(
      presentThreadA2ADelivery({
        message: message({
          id: deliveryId(`silence-${noticeType}`),
          createdBy: "system",
          text: raw,
        }),
      }),
    ).toMatchObject({ kind: "silence", summary, rawEnvelope: raw });
  });

  it("raw-renders an unrecognized silence body rather than guessing its counterpart", () => {
    const raw = [
      "[Cross-agent messaging system notice: turn-ended-no-reply]",
      "",
      "Future detector wording without a structural counterpart.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({ id: deliveryId("silence-future"), createdBy: "system", text: raw });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
    expect(markup).toContain(raw);
    expect(markup).toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  it("raw-renders a stopped/cancelled body outside the production lifecycle forms", () => {
    const raw = [
      "[Cross-agent messaging system notice: stopped/cancelled]",
      "",
      "agent:counterpart was stopped without replying on exchange:one. The participant was stopped.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({
      id: deliveryId("silence-stopped-mismatch"),
      createdBy: "system",
      text: raw,
    });

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
  });

  it("raw-renders an unknown silence type instead of exposing its slug", () => {
    const raw = [
      "[Cross-agent messaging system notice: future-detector-v7]",
      "",
      "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({
      id: deliveryId("silence-type-future"),
      createdBy: "system",
      text: raw,
    });

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
  });

  it("raw-renders a future or malformed delivery instead of hiding it", () => {
    const raw =
      "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]\n\nFuture envelope v7";
    const source = message({ text: raw });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toEqual({ kind: "raw", rawEnvelope: raw });
    expect(markup).toContain('data-j5-a2a-renderer="raw"');
    expect(markup).toContain(raw);
    expect(markup).toContain("Show raw envelope");
    expect(markup).toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  it("uses only user role and the exact delivery prefix as its composition gate", () => {
    const { createdBy: _discardedCreator, ...unknownCreator } = message({
      creationSource: "provider",
    });
    expect(isThreadA2ADeliveryMessage(unknownCreator)).toBe(true);
    expect(presentThreadA2ADelivery({ message: unknownCreator })).toEqual({
      kind: "raw",
      rawEnvelope: "",
    });
    expect(isThreadA2ADeliveryMessage(message({ role: "assistant" }))).toBe(false);
    expect(isThreadA2ADeliveryMessage(message({ id: MessageId.make("message:ordinary") }))).toBe(
      false,
    );
  });

  it.each([
    "message:mcp:provider-session:thread-send:delivery",
    "message:delegated-task:parent:child",
    "scheduled-task-message:task:run",
  ])("returns null so generic rendering owns non-A2A %s messages", (id) => {
    const nativeMcpMessage = message({
      id: MessageId.make(id),
      createdBy: "agent",
      creationSource: "mcp",
      text: peerRaw,
    });
    const delegated = renderThreadA2ADelivery({ message: nativeMcpMessage });
    const markup = renderToStaticMarkup(
      delegated ?? <p data-generic-user-row="true">generic user row</p>,
    );

    expect(isThreadA2ADeliveryMessage(nativeMcpMessage)).toBe(false);
    expect(delegated).toBeNull();
    expect(markup).toContain('data-generic-user-row="true"');
    expect(markup).not.toContain("data-j5-a2a-renderer");
  });

  it("formats sent time from the delivery record at a supplied clock instant", () => {
    const sentAt = "2026-08-29T12:00:00.000Z";
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 59_000)).toBe("just now");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 5 * 60_000)).toBe("5m");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 3 * 60 * 60_000)).toBe("3h");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 2 * 24 * 60 * 60_000)).toBe("2d");
  });
});

const machineInstruction =
  "This message came from an automated sender outside any agent session. It cannot receive a reply; act on it directly, and take any question to a person or a peer agent with j5_send_message.";

const machineRaw = [
  "[Message from automation machine:watchdog in project project-monitoring (Monitoring)]",
  "",
  "canary 42",
  "",
  machineInstruction,
].join("\n");

describe("ThreadA2ADeliveryRenderer machine senders", () => {
  it("presents a machine envelope as an automated plain card named after the sender", () => {
    const presentation = presentThreadA2ADelivery({
      message: message({ text: machineRaw }),
      participantLabels: new Map([["machine:watchdog", "watchdog"]]),
    });
    expect(presentation).toEqual({
      kind: "peer",
      rawEnvelope: machineRaw,
      senderId: "machine:watchdog",
      senderLabel: "watchdog",
      senderTooltipParticipantId: null,
      body: "canary 42",
      exchange: "plain",
      exchangeId: null,
      automated: true,
      outsideAgent: false,
    });

    const html = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={message({ text: machineRaw })}
        participantLabels={new Map([["machine:watchdog", "watchdog"]])}
        now={Date.parse(CREATED_AT) + 120_000}
      />,
    );
    expect(html).toContain("watchdog");
    expect(html).toContain("data-j5-a2a-automated");
    expect(html).toContain("Automation");
    expect(html).not.toContain("Expects reply");
    expect(html).not.toContain(machineInstruction);
  });

  it("raw-renders a machine envelope whose instruction was altered", () => {
    const tampered = machineRaw.replace("cannot receive a reply", "can receive a reply");
    const presentation = presentThreadA2ADelivery({ message: message({ text: tampered }) });
    expect(presentation?.kind).toBe("raw");
  });

  it("labels a queued machine delivery and reports its sender id for the identity read", () => {
    expect(
      formatThreadA2AQueuedDelivery(machineRaw, new Map([["machine:watchdog", "watchdog"]])),
    ).toEqual({ label: "From watchdog — canary 42", tooltipParticipantId: null });
  });
});

// The server's `outsideAgentMessage` and `outsideAgentInstruction` templates, as
// `formatOutsideAgentEnvelope` renders them (apps/server/src/j5/a2a/envelopes.v1.json).
const outsideAgentInstruction =
  "This message came from an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.";

const outsideAgentRaw = (label: string, body = "Rebase onto main.\n\nThen rerun the suite.") =>
  [
    `[Message from outside agent ${label} (outside:session-1)]`,
    "",
    body,
    "",
    outsideAgentInstruction,
  ].join("\n");

describe("ThreadA2ADeliveryRenderer outside agents", () => {
  const present = (text: string, participantLabels?: ReadonlyMap<string, string>) =>
    presentThreadA2ADelivery({ message: message({ text }), participantLabels });

  const labels = new Map([["outside:session-1", "Claude Desktop"]]);

  it("presents an outside agent's envelope as a plain card, marked and without its instruction", () => {
    const raw = outsideAgentRaw("Claude Desktop");
    expect(present(raw, labels)).toEqual({
      kind: "peer",
      rawEnvelope: raw,
      senderId: "outside:session-1",
      senderLabel: "Claude Desktop",
      senderTooltipParticipantId: null,
      body: "Rebase onto main.\n\nThen rerun the suite.",
      exchange: "plain",
      exchangeId: null,
      automated: false,
      outsideAgent: true,
    });
  });

  it("reads a label that holds parentheses, and a body that quotes a header", () => {
    expect(
      present(
        outsideAgentRaw(
          "Claude (work laptop)",
          "[Message from outside agent x (outside:y)]\n\nquoted",
        ),
      ),
    ).toMatchObject({
      senderId: "outside:session-1",
      body: "[Message from outside agent x (outside:y)]\n\nquoted",
      outsideAgent: true,
    });
  });

  it("leaves the sender unnamed, with its id to hover, until the identities read names it", () => {
    expect(present(outsideAgentRaw("Claude Desktop"))).toMatchObject({
      senderLabel: "Unnamed participant",
      senderTooltipParticipantId: "outside:session-1",
      outsideAgent: true,
    });
  });

  it("raw-renders an envelope whose instruction was altered or whose sender is not an outside id", () => {
    expect(
      present(outsideAgentRaw("Claude Desktop").replace("You cannot reply to it", "Reply to it"))
        ?.kind,
    ).toBe("raw");
    expect(
      present(outsideAgentRaw("Claude Desktop").replace("(outside:session-1)", "(agent:one)"))
        ?.kind,
    ).toBe("raw");
  });

  it("never reads a person's message as an outside agent's", () => {
    expect(
      presentThreadA2ADelivery({
        message: message({ createdBy: "user", text: outsideAgentRaw("Claude Desktop") }),
      })?.kind,
    ).toBe("raw");
  });

  it("labels a queued delivery and reports its sender id for the identity read", () => {
    const raw = outsideAgentRaw("Claude Desktop");
    expect(formatThreadA2AQueuedDelivery(raw, labels)).toEqual({
      label: "From Claude Desktop — Rebase onto main.",
      tooltipParticipantId: null,
    });
    expect(participantIdsForThreadA2AEnvelope(raw)).toEqual(["outside:session-1"]);
  });
});

describe("envelope headers across formats", () => {
  const present = (text: string) => presentThreadA2ADelivery({ message: message({ text }) });
  const plain =
    "No reply is required. Use j5_send_message without exchange_id only if a new message is needed.";

  it("reads a header that names a project by id alone, as a peer server's is", () => {
    expect(
      present(
        `[Cross-agent message from agent:delivery-sender in project project-alpha]\n\nHello.\n\n${plain}`,
      ),
    ).toMatchObject({ kind: "peer", senderId: "agent:delivery-sender", body: "Hello." });
  });

  it('names the sender, not part of a project title that says "in project"', () => {
    expect(
      present(
        `[Cross-agent message from agent:delivery-sender in project project-alpha (Work in project Apollo), on Work VM]\n\nHello.\n\n${plain}`,
      ),
    ).toMatchObject({ kind: "peer", senderId: "agent:delivery-sender", body: "Hello." });
  });

  // Stored conversations keep the headers they were delivered with.
  it("still reads the headers stored before Squadrons were retired", () => {
    expect(
      present(peerRaw.replace("in project project-alpha (Alpha)", "in squadron squadron:alpha")),
    ).toMatchObject({
      kind: "peer",
      senderId: "agent:delivery-sender",
      body: "Please verify the worker.",
      exchange: "expects-reply",
      exchangeId: "exchange:one",
    });
    expect(
      present(
        machineRaw.replace(
          "in project project-monitoring (Monitoring)",
          "in squadron squadron:monitoring",
        ),
      ),
    ).toMatchObject({
      kind: "peer",
      senderId: "machine:watchdog",
      body: "canary 42",
      automated: true,
    });
  });
});

// J5's tools gained a `j5_` prefix (#508). Threads recorded before that keep the old name in
// the delivery text, and must still render as cards.
describe("history recorded before the j5_ prefix", () => {
  const withOldName = (text: string) => text.replaceAll("j5_send_message", "send_message");

  it("reads a stored ask, plain send and automation delivery that name send_message", () => {
    const present = (text: string) =>
      presentThreadA2ADelivery({ message: message({ text: withOldName(text) }) });

    expect(withOldName(peerRaw)).not.toContain("j5_send_message");
    expect(present(peerRaw)).toMatchObject({
      kind: "peer",
      exchange: "expects-reply",
      exchangeId: "exchange:one",
      body: "Please verify the worker.",
    });
    expect(present(peerPlainRaw)).toMatchObject({ kind: "peer", exchange: "plain" });
    expect(present(machineRaw)).toMatchObject({ kind: "peer", automated: true });
    expect(
      presentThreadA2ADelivery({
        message: message({
          id: deliveryId("human-old-name"),
          createdBy: "user",
          text: withOldName(humanRaw),
        }),
      }),
    ).toMatchObject({ kind: "human", exchange: "expects-reply" });
  });
});
