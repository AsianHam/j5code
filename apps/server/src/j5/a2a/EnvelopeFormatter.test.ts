import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  A2A_ENVELOPE_VERSION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
  formatClosedHumanEnvelope,
  formatClosedPeerEnvelope,
  formatMachineEnvelope,
  formatPeerEnvelope,
  formatReceiverBacklogNotice,
  formatSilenceNoticeEnvelope,
} from "./EnvelopeFormatter.ts";
import { LedgerProjectId, ExchangeId, ParticipantId } from "./contracts.ts";

const documentedSendToolContract = new URL(
  "../../../../../docs/j5/product/a2a/agent-tools.md",
  import.meta.url,
);

const readDocumentedSendToolDescription = Effect.fn("readDocumentedSendToolDescription")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const document = yield* fileSystem.readFileString(
      decodeURIComponent(documentedSendToolContract.pathname),
    );
    const description = document.match(
      /## `j5_send_message`[\s\S]*?\*\*Description:\*\* "([\s\S]*?)"\n\n\| Input/,
    )?.[1];
    if (description === undefined) {
      return yield* Effect.die(
        "j5_send_message contract description is missing from agent-tools.md",
      );
    }
    return description
      .split("\n")
      .map((line) => line.trim())
      .join(" ");
  },
  Effect.provide(NodeServices.layer),
);

it("renders the versioned peer envelope with exact reply semantics", () => {
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originProjectId: LedgerProjectId.make("project:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message: "Please verify the worker.",
  });

  assert.equal(A2A_ENVELOPE_VERSION, 24);
  assert.include(rendered, "Cross-agent message");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
  assert.include(rendered, "agent:sender");
  assert.include(rendered, "project:origin");
  assert.include(rendered, "Please verify the worker.");
  assert.include(rendered, 'j5_send_message(to="agent:sender", exchange_id="exchange:one"');
  assert.include(rendered, "Reply once");
  assert.notInclude(rendered, "{{");
});

it("names a remote sender's server in its sender line and leaves a local one unchanged", () => {
  const sender = {
    senderId: ParticipantId.make("agent:sender"),
    originProjectId: LedgerProjectId.make("project-origin"),
    message: "Build the iOS target.",
  };
  const remote = formatPeerEnvelope({ ...sender, exchangeId: null, senderServerName: "Work VM" });
  const local = formatPeerEnvelope({ ...sender, exchangeId: null });
  const closed = formatClosedPeerEnvelope({ ...sender, senderServerName: "Work VM" });

  assert.include(
    remote,
    "[Cross-agent message from agent:sender in project project-origin, on Work VM]",
  );
  assert.include(
    closed,
    "[Cross-agent message from agent:sender in project project-origin, on Work VM]",
  );
  assert.include(local, "[Cross-agent message from agent:sender in project project-origin]");
  for (const rendered of [remote, local, closed]) assert.notInclude(rendered, "{{");
});

it.effect(
  "keeps the j5_send_message runtime description byte-equal to its documented contract",
  () =>
    Effect.gen(function* () {
      assert.equal(yield* readDocumentedSendToolDescription(), A2A_SEND_TOOL_DESCRIPTION);
    }),
);

it("renders reply closures without another reply instruction for either channel", () => {
  const peerMessage = "Peer reply bytes\n  stay exact.  ";
  const humanMessage = "  Human reply bytes\nremain exact. ";
  const peer = formatClosedPeerEnvelope({
    senderId: ParticipantId.make("agent:replying-peer"),
    originProjectId: LedgerProjectId.make("project:replying-peer"),
    message: peerMessage,
  });
  const human = formatClosedHumanEnvelope({
    senderId: ParticipantId.make("human:replying-person"),
    message: humanMessage,
  });

  assert.include(peer, peerMessage);
  assert.include(human, humanMessage);
  for (const rendered of [peer, human]) {
    assert.include(rendered, "The platform closed this exchange when this reply was sent.");
    assert.include(rendered, "No further reply is required.");
    assert.notInclude(rendered, "j5_send_message(");
    assert.notInclude(rendered, "Use j5_send_message without exchange_id");
    assert.notInclude(rendered, "{{");
  }
  assert.notInclude(human, "This person is not watching this chat");
});

it("labels platform-authored silence without internal product branding", () => {
  const rendered = formatSilenceNoticeEnvelope({
    noticeType: "peer unavailable",
    message: "No reply was delivered.",
  });

  assert.include(rendered, "Cross-agent messaging system notice: peer unavailable");
  assert.include(rendered, "platform-authored delivery signal");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
});

it("does not interpret caller text as an envelope template", () => {
  const message = "Preserve this literal token: {{exchangeInstruction}}";
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originProjectId: LedgerProjectId.make("project:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message,
  });

  assert.include(rendered, message);
  assert.equal(rendered.match(/j5_send_message\(/g)?.length, 1);
});

it("renders the receiver backlog notice with its measured counts", () => {
  const rendered = formatReceiverBacklogNotice({
    receiverId: ParticipantId.make("agent:busy"),
    waiting: 3,
    fromYou: 2,
  });

  assert.include(rendered, "agent:busy");
  assert.include(rendered, "3 message(s) waiting");
  assert.include(rendered, "2 from you");
  assert.include(rendered, "in one message");
  assert.notInclude(rendered, "{{");
});

it("keeps the tool descriptions on their documented contracts", () => {
  assert.equal(
    A2A_SEND_TOOL_DESCRIPTION,
    "Send one durable message. To another agent, three uses: a **plain send** when you don't need a reply; an **ask** — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a **reply** — include the exchange_id from the ask you are answering, which closes that exchange. To the human, only an ask: a plain send to a person is refused — if nobody needs to act, say it in your own thread instead. Set urgency only when asking the human. Use this tool only for participants already returned by j5_list_participants; when creating a Peer Agent, put any reply expectation in j5_spawn_agent's brief instead of sending a follow-up ask. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. An agent that is busy usually handles each message as its own turn after its current one ends, so put related updates in one message rather than sending them one by one; the result's deliveryNotice says when your message will wait behind the receiver's current turn. To interrupt an agent that is busy, set mode: mode=steer puts your message into the turn it is running now, and mode=restart stops that turn and starts it again on your message. Without mode the message is delivered the ordinary way, whatever its text or its intent says: most agents take it after their current turn ends, and Codex GPT 6 agents take it into the turn they are running. intent only labels an ask. Leave mode out for updates and replies. A steer can cancel the tool calls the receiver has in flight, so keep it for a correction the receiver must see now, not for an update. An idle receiver starts a turn on your message whichever mode you set. Attach files for an agent on this server with attachments: pending uploads from t3_attachment_prepare_upload, or files its thread already holds. A provider Subagent is not a participant and is refused. Reuse client_request_id to retry the same send safely.",
  );
  assert.include(
    A2A_SEND_TOOL_DESCRIPTION,
    "To the human, only an ask: a plain send to a person is refused",
  );
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "Withdraw an ask you sent");
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "sender-cleared");
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "client_request_id");
  assert.equal(
    A2A_LIST_TOOL_DESCRIPTION,
    "Your address book, one project at a time: the project's agents, and the human, with the display name to recognize them by, the participant_id to address them with, the project_id and project_title that place them, and what each accepts (messages, exchanges, urgency). Leave project_id out to list your own project; pass another project's id, from t3_project_list, to list that one. People appear in every listing. Results come a page at a time: your own row first, then the people, then agents with the most recently active first. Narrow a listing with name_contains, or with settled=true or settled=false for settled or active agents. If this server is peered with others, each row also carries `server`: the name of the server the participant lives on, and whether it is this one (`local`), and the result names every server in `servers`; pass a peer server's name as server to list that server's agents instead of this one's. When you're told to message someone by name or role, resolve them here first. Your own row is marked self=true and its project_title is the project you work in; it cannot receive messages or open exchanges from you — use schedule_task if you need a future trigger for yourself. Provider Subagents are not participants: they do not appear here and cannot be messaged. Archived agents are hidden by default; set include_archived=true to see them with archived=true. They cannot receive messages or open Exchanges. The roster changes — after you spawn, archive, unarchive, or delete an agent, call this again instead of reusing a stale listing.",
  );
  for (const clause of [
    "Your own row is marked self=true",
    "each row also carries `server`",
    "use schedule_task if you need a future trigger for yourself",
    "Provider Subagents are not participants: they do not appear here and cannot be messaged.",
    "Archived agents are hidden by default; set include_archived=true to see them with archived=true. They cannot receive messages or open Exchanges. The roster changes — after you spawn, archive, unarchive, or delete an agent, call this again instead of reusing a stale listing.",
  ]) {
    assert.include(A2A_LIST_TOOL_DESCRIPTION, clause);
  }
  assert.include(
    A2A_SEND_TOOL_DESCRIPTION,
    "A provider Subagent is not a participant and is refused.",
  );
  for (const description of [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION]) {
    assert.notInclude(description, "wrapper-spawned");
  }
  assert.include(
    A2A_SEND_TOOL_DESCRIPTION,
    "participants already returned by j5_list_participants",
  );
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "reply expectation in j5_spawn_agent's brief");
  assert.notMatch(A2A_LIST_TOOL_DESCRIPTION, /consult.*(?:spawn|archive)/i);
  assert.notMatch(
    [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION].join("\n"),
    /\b(?:J5|A2A)\b/,
  );
});

it("renders the machine envelope as a plain send that names the sender as automation", () => {
  const rendered = formatMachineEnvelope({
    senderId: ParticipantId.make("machine:watchdog"),
    originProjectId: LedgerProjectId.make("project:monitoring"),
    message: "canary 42",
  });

  assert.match(
    rendered,
    /^\[Message from automation machine:watchdog in project project:monitoring\]\n\n/,
  );
  assert.include(rendered, "canary 42");
  assert.include(rendered, "cannot receive a reply");
  assert.notInclude(rendered, "Reply once");
  assert.notInclude(rendered, "{{");
});
