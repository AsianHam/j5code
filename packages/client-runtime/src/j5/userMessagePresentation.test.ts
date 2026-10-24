import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  firstLine,
  isJ5DeliveryMessage,
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  parseJ5AgentEnvelope,
  participantIdsForJ5UserMessage,
  presentJ5SpawnBrief,
  presentJ5UserMessage,
  resolveJ5UserMessagePresentation,
  type J5UserMessageInput,
} from "./userMessagePresentation.ts";

const deliveryId = (suffix: string) => `${J5_A2A_DELIVERY_MESSAGE_PREFIX}${suffix}`;

const agentMessage = (text: string, input: Partial<J5UserMessageInput> = {}) => ({
  id: deliveryId("peer"),
  role: "user",
  text,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  ...input,
});
const personReply = (text: string) => agentMessage(text, { createdBy: "user" });
const systemDelivery = (text: string) => agentMessage(text, { createdBy: "system" });

// The server's templates (apps/server/src/j5/a2a/envelopes.v1.json) as `EnvelopeFormatter` renders them.
const askInstruction =
  'Reply once with j5_send_message(to="agent:delivery-sender", exchange_id="exchange:one", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.';
const plainInstruction =
  "The sender did not request a reply to this message. Use j5_send_message without exchange_id only if a new message is needed.";
const closedInstruction =
  "The platform closed this exchange when this reply was sent. No further reply is required.";
const machineInstruction =
  "This message came from an automated sender outside any agent session. It cannot receive a reply; act on it directly, and take any question to a person or a peer agent with j5_send_message.";
const outsideAgentInstruction =
  "This message came from an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.";

const peerHeader =
  "[Cross-agent message from agent:delivery-sender in project project-alpha (Alpha)]";
const letter = "Please verify the worker.\n\n- check the queue\n- check the logs";
const envelope = (header: string, body: string, instruction: string) =>
  `${header}\n\n${body}\n\n${instruction}`;

const peerAsk = envelope(peerHeader, letter, askInstruction);
const peerPlain = envelope(peerHeader, "Nothing further is needed.", plainInstruction);
const peerReply = envelope(peerHeader, "Peer reply delivered verbatim.", closedInstruction);
const machineRaw = envelope(
  "[Message from automation machine:watchdog in project project-monitoring (Monitoring)]",
  "canary 42",
  machineInstruction,
);
const outsideAgentRaw = (label: string, body = "Rebase onto main.\n\nThen rerun the suite.") =>
  envelope(
    `[Message from outside agent ${label} (outside:session-1)]`,
    body,
    outsideAgentInstruction,
  );

const humanAskRaw = [
  "[Message from human:viewer]",
  "",
  "Please prioritize the alert.",
  "",
  "This person is not watching this chat. They see only what you send back on this exchange.",
  "",
  'Reply once with j5_send_message(to="human:viewer", exchange_id="exchange:human", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");
const humanReplyRaw = envelope(
  "[Message from human:viewer]",
  "Call Acme first.",
  closedInstruction,
);

const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

describe("group 3: agents and other participants", () => {
  it("strips the envelope to the letter and badges an ask as expecting a reply", () => {
    expect(presentJ5UserMessage(agentMessage(peerAsk))).toEqual({
      group: "participant",
      side: "left",
      text: letter,
      preview: "Please verify the worker.",
      senderId: "agent:delivery-sender",
      senderThreadId: null,
      badge: "expects-reply",
      tag: null,
      unwrapped: true,
    });
  });

  it("badges a reply that closed an Exchange, and leaves a plain message unbadged", () => {
    expect(presentJ5UserMessage(agentMessage(peerReply))).toMatchObject({
      text: "Peer reply delivered verbatim.",
      badge: "replied",
      tag: null,
    });
    expect(presentJ5UserMessage(agentMessage(peerPlain))).toMatchObject({
      text: "Nothing further is needed.",
      badge: null,
      tag: null,
    });
  });

  it("tags a machine participant as automation, never with a badge", () => {
    expect(presentJ5UserMessage(agentMessage(machineRaw))).toMatchObject({
      group: "participant",
      senderId: "machine:watchdog",
      text: "canary 42",
      badge: null,
      tag: "automation",
    });
  });

  it("tags an outside agent, reading a label that holds parentheses and a quoted header", () => {
    const quoting = "[Message from outside agent x (outside:y)]\n\nquoted";
    expect(
      presentJ5UserMessage(agentMessage(outsideAgentRaw("Claude (work laptop)", quoting))),
    ).toMatchObject({
      group: "participant",
      senderId: "outside:session-1",
      text: quoting,
      preview: "[Message from outside agent x (outside:y)]",
      badge: null,
      tag: "outside-agent",
    });
  });

  it("reads a peer on another server, and a header naming a project by id alone", () => {
    for (const header of [
      "[Cross-agent message from agent:delivery-sender in project project-alpha (Work in project Apollo), on Work VM]",
      "[Cross-agent message from agent:delivery-sender in project project-alpha]",
    ]) {
      expect(
        presentJ5UserMessage(agentMessage(envelope(header, "Hello.", plainInstruction))),
      ).toMatchObject({ group: "participant", senderId: "agent:delivery-sender", text: "Hello." });
    }
  });

  it("still reads history written before Squadrons, the j5_ prefix and the plain footer rewording", () => {
    const olderFooter =
      "No reply is required. Use send_message without exchange_id only if a new message is needed.";
    expect(
      presentJ5UserMessage(
        agentMessage(
          envelope(
            "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]",
            "Old.",
            olderFooter,
          ),
        ),
      ),
    ).toMatchObject({ senderId: "agent:delivery-sender", text: "Old.", badge: null });
    expect(
      presentJ5UserMessage(agentMessage(peerAsk.replaceAll("j5_send_message", "send_message"))),
    ).toMatchObject({ badge: "expects-reply", text: letter });
    expect(
      presentJ5UserMessage(agentMessage(machineRaw.replace("j5_send_message", "send_message"))),
    ).toMatchObject({ tag: "automation" });
  });

  it("previews the letter's first non-empty line, raw, never the envelope", () => {
    const body = "\n  **Status:** green  \nsecond line";
    expect(
      presentJ5UserMessage(agentMessage(envelope(peerHeader, body, plainInstruction))),
    ).toMatchObject({ preview: "**Status:** green" });
    expect(firstLine("\n\n")).toBe("");
  });

  it("folds upstream's own agent messages too, with their text as stored", () => {
    const message = {
      id: "message:mcp:session:thread-send:1",
      role: "user",
      text: "\nFrom the other agent.\nMore.",
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    expect(presentJ5UserMessage(message)).toEqual({
      group: "participant",
      side: "left",
      text: message.text,
      preview: "From the other agent.",
      senderId: null,
      senderThreadId: null,
      badge: null,
      tag: null,
      unwrapped: false,
    });
  });
});

describe("unrecognized envelopes fall back to upstream's row", () => {
  it.each([
    ["a missing footer", `${peerHeader}\n\nFuture envelope v7`],
    ["a future closed wording", peerReply.replace("No further reply is required.", "Done.")],
    ["an altered machine footer", machineRaw.replace("cannot receive a reply", "can reply")],
    [
      "an outside header with a non-outside id",
      outsideAgentRaw("Claude").replace("(outside:session-1)", "(agent:one)"),
    ],
  ])("returns null for %s", (_name, text) => {
    expect(presentJ5UserMessage(agentMessage(text))).toBeNull();
  });

  it("reads nothing from a delivery whose author does not match its template", () => {
    expect(presentJ5UserMessage(personReply(outsideAgentRaw("Claude")))).toBeNull();
    expect(presentJ5UserMessage(agentMessage(humanReplyRaw))).toBeNull();
    expect(presentJ5UserMessage({ id: deliveryId("x"), role: "user", text: peerAsk })).toBeNull();
  });

  it("returns null for the older v6 human template", () => {
    const v6 = [
      "[Message from the human]",
      "",
      "Legacy human delivery.",
      "",
      "The human is not watching this chat. They see only what you send back on this exchange.",
      "",
      "No reply is required. Use send_message without exchange_id only if a new message is needed.",
    ].join("\n");
    expect(presentJ5UserMessage(personReply(v6))).toBeNull();
  });

  it("keeps upstream's presentation whole for a message J5 cannot read", () => {
    const raw = `${peerHeader}\n\nFuture envelope v7`;
    expect(resolveJ5UserMessagePresentation(agentMessage(raw))).toEqual({
      text: raw,
      attribution: "agent",
      scheduledTaskId: undefined,
      j5: null,
    });
  });

  it("gates on the delivery id and a user role, never on envelope-looking text", () => {
    expect(isJ5DeliveryMessage(agentMessage(peerAsk))).toBe(true);
    expect(isJ5DeliveryMessage(agentMessage(peerAsk, { role: "assistant" }))).toBe(false);
    const elsewhere = agentMessage(peerAsk, { id: "message:mcp:session:thread-send:1" });
    expect(presentJ5UserMessage(elsewhere)).toMatchObject({
      group: "participant",
      text: peerAsk,
      senderId: null,
      unwrapped: false,
    });
    expect(presentJ5UserMessage(agentMessage(peerAsk, { role: "assistant" }))).toBeNull();
  });
});

describe("groups 1 and 2: people", () => {
  it("puts the reader's own Inbox reply on the right, without its envelope", () => {
    expect(
      presentJ5UserMessage(personReply(humanReplyRaw), { viewerParticipantId: "human:viewer" }),
    ).toEqual({
      group: "person",
      side: "right",
      text: "Call Acme first.",
      viaInbox: true,
      unwrapped: true,
    });
    expect(
      presentJ5UserMessage(personReply(humanAskRaw), { viewerParticipantId: "human:viewer" }),
    ).toMatchObject({ group: "person", text: "Please prioritize the alert." });
  });

  it("puts another person's Inbox reply on the left, named without the level the agent is told", () => {
    for (const [header, name] of [
      ["[Message from Priya (collaborator) (human:priya)]", "Priya"],
      ["[Message from Ada (she/her) Lovelace (owner) (human:priya)]", "Ada (she/her) Lovelace"],
      ["[Message from human:priya]", null],
    ] as const) {
      expect(
        presentJ5UserMessage(personReply(envelope(header, "Call Acme first.", closedInstruction)), {
          viewerParticipantId: "human:viewer",
        }),
      ).toEqual({
        group: "other-person",
        side: "left",
        text: "Call Acme first.",
        viaInbox: true,
        unwrapped: true,
        senderId: "human:priya",
        senderName: name,
      });
    }
  });

  it("does not claim a reply is the reader's own when the client cannot say who is reading", () => {
    expect(presentJ5UserMessage(personReply(humanReplyRaw))).toMatchObject({
      group: "other-person",
      senderId: "human:viewer",
    });
  });

  it("leaves a message the person typed as upstream has it", () => {
    const typed = { id: "message:1", role: "user", text: "Ship it.", createdBy: "user" as const };
    expect(presentJ5UserMessage(typed)).toEqual({
      group: "person",
      side: "right",
      text: "Ship it.",
      viaInbox: false,
      unwrapped: false,
    });
    expect(presentJ5UserMessage({ role: "user", text: "Optimistic." })).toMatchObject({
      group: "person",
    });
    expect(resolveJ5UserMessagePresentation(typed)).toMatchObject({
      text: "Ship it.",
      attribution: null,
    });
  });
});

describe("spawn and Crew seat briefs", () => {
  const spawnId = "message:j5:a2a:mcp:session-1:spawn-brief:spawn-arch-review-20260917";
  const brief = [
    "IDENTITY: You are the ARCHITECTURE REVIEWER.",
    "",
    "TASK: Review both repos: agent-ops and obs-sentinel.",
  ].join("\n");
  const identity = (spawner: string) =>
    [
      "<j5_spawn_context>",
      "Platform-provided identity facts:",
      "participant_id: agent:reviewer",
      "project_id: project-prod",
      "project_title: Production Monitoring",
      spawner,
      "</j5_spawn_context>",
    ].join("\n");
  const director = "spawned_by: agent:director\nspawner_thread_id: thread-director";
  const spawnRaw = `${identity(director)}\n\n<spawner_brief>\n${brief}\n</spawner_brief>`;
  const spawn = (text: string, id = spawnId) => agentMessage(text, { id });

  it("never shows the identity block and previews the spawner's brief", () => {
    expect(presentJ5UserMessage(spawn(spawnRaw))).toEqual({
      group: "participant",
      side: "left",
      text: brief,
      preview: "IDENTITY: You are the ARCHITECTURE REVIEWER.",
      senderId: "agent:director",
      senderThreadId: "thread-director",
      badge: null,
      tag: "brief",
      unwrapped: true,
    });
    expect(resolveJ5UserMessagePresentation(spawn(spawnRaw))).toMatchObject({
      text: brief,
      attribution: "agent",
    });
  });

  it("keeps a Crew seat's crew facts verbatim and previews the brief at its end", () => {
    const seatRemainder = [
      "<j5_crew_context>",
      "Platform-provided crew facts:",
      "crew: Change review",
      "your_seat: reviewer",
      "captain_participant_id: agent:director",
      "</j5_crew_context>",
      "",
      "<seat_instructions>",
      "Review correctness: report concrete risks.",
      "</seat_instructions>",
      "",
      "<spawner_brief>",
      "\nCheck the invoice export.",
      "</spawner_brief>",
    ].join("\n");
    const seat = presentJ5UserMessage(spawn(`${identity(director)}\n\n${seatRemainder}`));
    expect(seat).toMatchObject({
      text: seatRemainder,
      preview: "Check the invoice export.",
      senderId: "agent:director",
      tag: "brief",
    });
    expect(seat?.text).not.toContain("<j5_spawn_context>");
  });

  it("reads briefs stored before Squadrons and before the spawner was recorded", () => {
    const preFold = spawnRaw
      .replace("project_id: project-prod", "squadron_id: squadron:prod")
      .replace("project_title: ", "squadron_name: ");
    expect(presentJ5SpawnBrief(spawn(preFold))).toMatchObject({
      spawnedBy: "agent:director",
      spawnerThreadId: "thread-director",
    });
    const unattributed = spawnRaw.replace(`${director}\n`, "");
    expect(presentJ5UserMessage(spawn(unattributed))).toMatchObject({
      text: brief,
      senderId: null,
      senderThreadId: null,
    });
  });

  it("names an outside agent as the spawner, with no thread to open", () => {
    const outside = spawnRaw.replace(
      director,
      "spawned_by: outside:session-1\nspawned_by_outside_agent: Claude Desktop\nspawner_reply: You were started by an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.",
    );
    expect(presentJ5UserMessage(spawn(outside))).toMatchObject({
      senderId: "outside:session-1",
      senderThreadId: null,
      tag: "brief",
    });
  });

  it("gates on the spawn-brief id and falls back to upstream's row on a changed template", () => {
    expect(presentJ5UserMessage(spawn(spawnRaw, "message-1"))).toMatchObject({
      text: spawnRaw,
      unwrapped: false,
    });
    for (const changed of [
      "Just a brief with no wrapper.",
      spawnRaw.replace("project_title: ", "name: "),
      spawnRaw.slice(0, -5),
      spawnRaw.replace("<spawner_brief>\n", "<brief>\n"),
      spawnRaw.replace("<spawner_brief>\n", "Some prose first.\n\n"),
    ]) {
      expect(presentJ5UserMessage(spawn(changed))).toBeNull();
    }
  });
});

describe("groups 4 and 5: classified, drawn elsewhere", () => {
  it("summarizes a silence notice and keeps its text", () => {
    expect(presentJ5UserMessage(systemDelivery(silenceRaw))).toEqual({
      group: "notice",
      side: "left",
      kind: "silence",
      summary: "agent:counterpart's turn ended without replying",
      text: silenceRaw,
    });
  });

  it.each([
    [
      "errored",
      "agent:counterpart errored without replying on exchange:one: socket closed",
      "agent:counterpart errored without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was rolled_back without replying on exchange:one. The participant was rolled back.",
      "agent:counterpart was rolled_back without replying",
    ],
    [
      "queued-message-removed",
      "Your message to agent:counterpart was removed from its queue before it ran, so agent:counterpart never read it. The message began: Review part 2.",
      "agent:counterpart never read a queued message: it was removed before it ran",
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
  ])("summarizes a %s notice", (noticeType, body, summary) => {
    const raw = `[Cross-agent messaging system notice: ${noticeType}]\n\n${body}\n\nThis is a platform-authored delivery signal, not a peer reply.`;
    expect(presentJ5UserMessage(systemDelivery(raw))).toMatchObject({ kind: "silence", summary });
  });

  it("returns null for a notice it cannot read rather than guessing", () => {
    expect(
      presentJ5UserMessage(systemDelivery(silenceRaw.replace("turn-ended-no-reply", "future-v7"))),
    ).toBeNull();
    expect(
      presentJ5UserMessage(
        systemDelivery(
          silenceRaw.replace(
            "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
            "Future detector wording.",
          ),
        ),
      ),
    ).toBeNull();
  });

  it("classifies Crew notices and upstream's platform messages, leaving upstream's row as is", () => {
    const gate = [
      "<j5_crew_gate>",
      "proposal_id: crew:proposal:1",
      "kind: roster",
      "decision: declined",
      "</j5_crew_gate>",
    ].join("\n");
    expect(
      presentJ5UserMessage({ id: "message:crew", role: "user", text: gate, createdBy: "system" }),
    ).toMatchObject({ group: "notice", kind: "crew-gate" });
    expect(
      presentJ5UserMessage({
        id: "message:restart-continuation:run-1",
        role: "user",
        text: "Go on.",
      }),
    ).toMatchObject({ group: "notice", kind: "restart-continuation" });
    expect(
      presentJ5UserMessage({ id: "idle-compact:thread:run", role: "user", text: "/compact" }),
    ).toMatchObject({ group: "prompt", kind: "compaction" });
    const automation = {
      id: "message:1",
      role: "user",
      text: "Run the nightly check.",
      createdBy: "user" as const,
      scheduledTaskId: ScheduledTaskId.make("task-1"),
    };
    expect(presentJ5UserMessage(automation)).toMatchObject({ group: "prompt", kind: "automation" });
    expect(resolveJ5UserMessagePresentation(automation)).toEqual({
      text: "Run the nightly check.",
      attribution: "automation",
      scheduledTaskId: "task-1",
      j5: null,
    });
  });
});

describe("participant ids for the identity read", () => {
  it("names each sender once, and nothing for a person's own words", () => {
    expect(participantIdsForJ5UserMessage(agentMessage(peerAsk))).toEqual([
      "agent:delivery-sender",
    ]);
    expect(participantIdsForJ5UserMessage(personReply(humanReplyRaw))).toEqual(["human:viewer"]);
    expect(participantIdsForJ5UserMessage(systemDelivery(silenceRaw))).toEqual([]);
    expect(participantIdsForJ5UserMessage({ role: "user", text: "Hi." })).toEqual([]);
  });

  it("parses a queued delivery's envelope the same way", () => {
    expect(parseJ5AgentEnvelope(machineRaw)).toEqual({
      senderId: "machine:watchdog",
      letter: "canary 42",
      exchange: "plain",
      tag: "automation",
    });
  });
});
