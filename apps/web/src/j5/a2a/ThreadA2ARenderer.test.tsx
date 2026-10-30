import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { presentJ5UserMessage } from "@t3tools/client-runtime/j5/user-message";

import { resolveUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatMessage } from "~/types";
import {
  formatThreadA2AQueuedDelivery,
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  literalUserMessageContext,
  participantIdsForThreadA2ADelivery,
  participantIdsForThreadA2AEnvelope,
  renderThreadA2ADelivery,
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

const peerPlainRaw = [
  "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]",
  "",
  "Nothing further is needed.",
  "",
  "The sender did not request a reply to this message. Use j5_send_message without exchange_id only if a new message is needed.",
].join("\n");

const humanClosedRaw = [
  "[Message from human:viewer]",
  "",
  "Human reply delivered verbatim.",
  "",
  "The platform closed this exchange when this reply was sent. No further reply is required.",
].join("\n");

const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

const machineRaw = [
  "[Message from automation machine:watchdog in project project-monitoring (Monitoring)]",
  "",
  "canary 42",
  "",
  "This message came from an automated sender outside any agent session. It cannot receive a reply; act on it directly, and take any question to a person or a peer agent with j5_send_message.",
].join("\n");

const outsideAgentRaw = [
  "[Message from outside agent Claude Desktop (outside:session-1)]",
  "",
  "Rebase onto main.\n\nThen rerun the suite.",
  "",
  "This message came from an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.",
].join("\n");

describe("renderThreadA2ADelivery", () => {
  it("draws a silence notice as a muted line with its summary and the timeline's time", () => {
    const markup = renderToStaticMarkup(
      renderThreadA2ADelivery({
        message: message({ id: deliveryId("silence"), createdBy: "system", text: silenceRaw }),
        timestampLabel: TIMESTAMP_LABEL,
      }),
    );
    const summary = markup.match(/<span data-j5-a2a-silence-summary="true">(.*?)<\/span>/)?.[1];
    expect(summary).toContain("agent:counterpart&#x27;s turn ended without replying");
    expect(summary).toContain(TIMESTAMP_LABEL);
    expect(summary).not.toContain("turn-ended-no-reply");
  });

  it("keeps the raw card for a platform notice it cannot read yet", () => {
    const raw = silenceRaw.replace("turn-ended-no-reply", "future-detector-v7");
    const markup = renderToStaticMarkup(
      renderThreadA2ADelivery({
        message: message({ id: deliveryId("future"), createdBy: "system", text: raw }),
      }),
    );
    expect(markup).toContain('data-j5-a2a-renderer="raw"');
    expect(markup).toContain("future-detector-v7");
  });

  it.each([
    ["an agent's letter", message({ text: peerPlainRaw })],
    [
      "an Inbox reply",
      message({ id: deliveryId("human"), createdBy: "user", text: humanClosedRaw }),
    ],
    ["an unrecognized agent envelope", message({ text: "[Cross-agent message from x]\n\nv7" })],
    [
      "a message that is not a delivery",
      message({ id: MessageId.make("message:mcp:session:thread-send:1"), text: peerPlainRaw }),
    ],
  ])("leaves %s to upstream's row", (_name, source) => {
    expect(renderThreadA2ADelivery({ message: source })).toBeNull();
  });
});

describe("queued deliveries", () => {
  it("label each sender's first line, with the id to hover until the identity read names it", () => {
    expect(
      formatThreadA2AQueuedDelivery(peerPlainRaw, new Map([["agent:delivery-sender", "Alice"]])),
    ).toEqual({ label: "From Alice: Nothing further is needed.", tooltipParticipantId: null });
    expect(formatThreadA2AQueuedDelivery(peerPlainRaw, new Map())).toEqual({
      label: "From Unnamed participant: Nothing further is needed.",
      tooltipParticipantId: "agent:delivery-sender",
    });
    expect(
      formatThreadA2AQueuedDelivery(machineRaw, new Map([["machine:watchdog", "watchdog"]])),
    ).toEqual({ label: "From watchdog: canary 42", tooltipParticipantId: null });
    expect(
      formatThreadA2AQueuedDelivery(
        outsideAgentRaw,
        new Map([["outside:session-1", "Claude Desktop"]]),
      ),
    ).toEqual({ label: "From Claude Desktop: Rebase onto main.", tooltipParticipantId: null });
    expect(formatThreadA2AQueuedDelivery("Plain text.", new Map())).toBeNull();
  });

  it("report each sender's id for the identity read", () => {
    expect(participantIdsForThreadA2AEnvelope(outsideAgentRaw)).toEqual(["outside:session-1"]);
    expect(participantIdsForThreadA2AEnvelope("Plain text.")).toEqual([]);
  });
});

describe("participantIdsForThreadA2ADelivery", () => {
  it("names a letter's sender and the seats a Crew notice lists", () => {
    expect(participantIdsForThreadA2ADelivery(message({ text: peerPlainRaw }))).toEqual([
      "agent:delivery-sender",
    ]);
    const gate = [
      "<j5_crew_gate>",
      "proposal_id: crew:proposal:1",
      "kind: roster",
      "decision: approved",
      "roster:",
      "- reviewer: participant_id=agent:reviewer persona=critic thread_id=thread-reviewer",
      "</j5_crew_gate>",
    ].join("\n");
    expect(
      participantIdsForThreadA2ADelivery(
        message({ id: MessageId.make("message:crew"), createdBy: "system", text: gate }),
      ),
    ).toEqual(["agent:reviewer"]);
  });
});

describe("literalUserMessageContext", () => {
  it("shows a letter that quotes composer context tags verbatim", () => {
    const quoting = [
      "Review the terminal capture format. A user message ends like this:",
      "",
      "<terminal_context>",
      "- Build line 7:",
      "  npm test",
      "</terminal_context>",
    ].join("\n");
    const letter = presentJ5UserMessage(
      message({ text: peerPlainRaw.replace("Nothing further is needed.", quoting) }),
    );
    expect(letter).toMatchObject({ text: quoting, unwrapped: true });

    // Upstream's derivation upgrades the quoted block into a context record.
    expect(resolveUserMessageContext({ text: quoting }).text).not.toBe(quoting);
    const context = literalUserMessageContext(quoting);
    expect(context.text).toBe(quoting);
    expect(context.records).toEqual([]);
    expect(context.recordsById.size).toBe(0);
  });
});
