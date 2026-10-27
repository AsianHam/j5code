import { assert, it } from "@effect/vitest";

import { formatClosedPeerEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { ExchangeId, LedgerProjectId, ParticipantId } from "./contracts.ts";
import { bodyInEnvelope, envelopeAround } from "./queuedEdits.ts";

const senderId = ParticipantId.make("agent:j5:a2a:thread:sender");
const originProjectId = LedgerProjectId.make("project:edits");
const peer = envelopeAround((message) =>
  formatPeerEnvelope({
    senderId,
    originProjectId,
    originProjectTitle: "Edits",
    exchangeId: ExchangeId.make("exchange:edits"),
    message,
  }),
);

it("finds the body inside the exact envelope, blank lines and brackets in the body included", () => {
  const body = `First paragraph.\n\n[${senderId}] quoted]\n\nLast paragraph.`;
  assert.equal(bodyInEnvelope(`${peer.prefix}${body}${peer.suffix}`, peer), body);
  const closed = envelopeAround((message) =>
    formatClosedPeerEnvelope({ senderId, originProjectId, message }),
  );
  assert.equal(bodyInEnvelope(`${closed.prefix}${body}${closed.suffix}`, closed), body);
});

it("reads any change to the header or instruction as a rewritten envelope", () => {
  const text = `${peer.prefix}Body${peer.suffix}`;
  assert.isUndefined(bodyInEnvelope(text.replace("Reply once", "Reply twice"), peer));
  assert.isUndefined(bodyInEnvelope(`[Message from Sam (owner)]\n\n${text}`, peer));
  // A person removed the real header; a quoted line naming the sender is not taken for it.
  assert.isUndefined(
    bodyInEnvelope(
      `[different header]\n\nQuote:\n\n[${senderId}]\n\nActual body\n\nFinal paragraph`,
      peer,
    ),
  );
});
