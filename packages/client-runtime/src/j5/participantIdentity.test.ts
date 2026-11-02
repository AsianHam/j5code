import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../environment/scoped.ts";
import {
  j5MessageAuthorName,
  j5SenderThreadRef,
  participantIdentitiesFromResponse,
} from "./participantIdentity.ts";
import {
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  presentJ5UserMessage,
  type J5UserMessagePresentation,
} from "./userMessagePresentation.ts";

const here = EnvironmentId.make("environment-here");
const peer = EnvironmentId.make("environment-peer");
const ref = (environmentId: EnvironmentId, threadId: string) =>
  scopeThreadRef(environmentId, ThreadId.make(threadId));

const peerLetter = presentJ5UserMessage({
  id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}one`,
  role: "user",
  createdBy: "agent",
  text: [
    "[Cross-agent message from agent:sender in project project-alpha (Alpha)]",
    "",
    "Ship it.",
    "",
    "The sender did not request a reply to this message. Use j5_send_message without exchange_id only if a new message is needed.",
  ].join("\n"),
});
const brief = presentJ5UserMessage({
  id: "message:j5:a2a:mcp:session:spawn-brief:key",
  role: "user",
  createdBy: "agent",
  text: [
    "<j5_spawn_context>",
    "participant_id: agent:child",
    "project_id: project-alpha",
    "project_title: Alpha",
    "spawned_by: agent:spawner",
    "spawner_thread_id: thread-spawner",
    "</j5_spawn_context>",
    "",
    "<spawner_brief>",
    "Build it.",
    "</spawner_brief>",
  ].join("\n"),
});
const otherPersonReply: J5UserMessagePresentation = {
  group: "other-person",
  side: "left",
  text: "Yes.",
  viaInbox: true,
  unwrapped: true,
  senderId: "human:priya",
  senderName: null,
};

describe("participantIdentitiesFromResponse", () => {
  it("names known participants and places each thread on the server that holds it", () => {
    const identities = participantIdentitiesFromResponse(here, {
      entries: [
        {
          participantId: "agent:local",
          identity: { kind: "known", displayName: "Builder", threadId: "t-1" },
        },
        {
          participantId: "agent:remote",
          identity: {
            kind: "known",
            displayName: "Reviewer",
            threadId: "t-2",
            threadEnvironmentId: peer,
          },
        },
        { participantId: "machine:cron", identity: { kind: "known", displayName: "Nightly" } },
        { participantId: "agent:gone", identity: { kind: "unknown" } },
      ],
    });
    expect(identities.labels).toEqual(
      new Map([
        ["agent:local", "Builder"],
        ["agent:remote", "Reviewer"],
        ["machine:cron", "Nightly"],
      ]),
    );
    expect(identities.threads).toEqual(
      new Map([
        ["agent:local", ref(here, "t-1")],
        ["agent:remote", ref(peer, "t-2")],
      ]),
    );
  });
});

describe("j5SenderThreadRef", () => {
  it("opens a peer's thread from the identity read, on whichever server it is", () => {
    expect(
      j5SenderThreadRef({
        environmentId: here,
        presentation: peerLetter,
        messageSenderThreadId: undefined,
        participantThreads: new Map([["agent:sender", ref(peer, "t-2")]]),
      }),
    ).toEqual(ref(peer, "t-2"));
  });

  it("opens a spawner's thread from its brief when the identity read has none", () => {
    expect(
      j5SenderThreadRef({
        environmentId: here,
        presentation: brief,
        messageSenderThreadId: undefined,
        participantThreads: new Map(),
      }),
    ).toEqual(ref(here, "thread-spawner"));
  });

  it("has nothing to open for a sender with no thread", () => {
    expect(
      j5SenderThreadRef({
        environmentId: here,
        presentation: peerLetter,
        messageSenderThreadId: undefined,
        participantThreads: new Map(),
      }),
    ).toBeNull();
  });
});

describe("j5MessageAuthorName", () => {
  it("names a participant by label, then the sender thread's title, then Agent", () => {
    const name = (labels: ReadonlyMap<string, string>, title?: string) =>
      j5MessageAuthorName({
        presentation: peerLetter,
        participantLabels: labels,
        senderThreadTitle: title,
      });
    expect(name(new Map([["agent:sender", "Captain"]]), "Thread title")).toBe("Captain");
    expect(name(new Map(), "  Thread title ")).toBe("Thread title");
    expect(name(new Map())).toBe("Agent");
  });

  it("names another person by the name they sent with, else the identity read", () => {
    expect(
      j5MessageAuthorName({
        presentation: otherPersonReply,
        participantLabels: new Map([["human:priya", "Priya"]]),
        senderThreadTitle: undefined,
      }),
    ).toBe("Priya");
    expect(
      j5MessageAuthorName({
        presentation: otherPersonReply,
        participantLabels: new Map(),
        senderThreadTitle: undefined,
      }),
    ).toBe("Someone without a name");
  });
});
