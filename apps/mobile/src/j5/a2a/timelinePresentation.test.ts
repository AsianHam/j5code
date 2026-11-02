import { J5_A2A_DELIVERY_MESSAGE_PREFIX } from "@t3tools/client-runtime/j5/user-message";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentJ5TimelineNotice,
  resolveJ5FeedMessage,
  type J5Timeline,
} from "./timelinePresentation";

const delivery = (createdBy: "agent" | "user" | "system", text: string) => ({
  id: `${J5_A2A_DELIVERY_MESSAGE_PREFIX}${createdBy}`,
  role: "user",
  createdBy,
  text,
});
const timeline = (viewerParticipantId: string | null): J5Timeline => ({
  environmentId: EnvironmentId.make("environment-here"),
  viewerParticipantId,
  labels: new Map(),
  threads: new Map(),
  sharedAuthors: new Map(),
});

const askRaw = [
  "[Cross-agent message from agent:captain in project project-alpha (Alpha)]",
  "",
  "Which schema version do we target?",
  "",
  'Reply once with j5_send_message(to="agent:captain", exchange_id="exchange:one", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");
const inboxReplyRaw = [
  "[Message from Priya (human:priya)]",
  "",
  "Target v2.",
  "",
  "The platform closed this exchange when this reply was sent. No further reply is required.",
].join("\n");
const briefRaw = [
  "<j5_spawn_context>",
  "participant_id: agent:child",
  "project_id: project-alpha",
  "project_title: Alpha",
  "spawned_by: agent:spawner",
  "</j5_spawn_context>",
  "",
  "<j5_crew_context>",
  "crew: Wave 1",
  "",
  "<spawner_brief>",
  "Build the timeline.",
  "</spawner_brief>",
].join("\n");
const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "Captain's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

describe("resolveJ5FeedMessage", () => {
  it("folds an agent's letter on the left, without its envelope", () => {
    const row = resolveJ5FeedMessage(delivery("agent", askRaw), timeline(null));
    expect(row).toMatchObject({
      attribution: "agent",
      side: "left",
      text: "Which schema version do we target?",
      preview: "Which schema version do we target?",
      j5: { badge: "expects-reply", senderId: "agent:captain" },
    });
  });

  it("previews a Crew seat's brief by the spawner's words, not the crew context", () => {
    const row = resolveJ5FeedMessage(
      {
        id: "message:j5:a2a:mcp:session:spawn-brief:key",
        role: "user",
        createdBy: "agent",
        text: briefRaw,
      },
      timeline(null),
    );
    expect(row).toMatchObject({
      attribution: "agent",
      side: "left",
      preview: "Build the timeline.",
    });
    expect(row.text).not.toContain("<j5_spawn_context>");
  });

  it("puts an Inbox reply on the right only for the person who sent it", () => {
    const reply = delivery("user", inboxReplyRaw);
    expect(resolveJ5FeedMessage(reply, timeline("human:priya"))).toMatchObject({
      attribution: null,
      side: "right",
      text: "Target v2.",
      j5: { group: "person", viaInbox: true },
    });
    expect(resolveJ5FeedMessage(reply, timeline("human:sam"))).toMatchObject({
      side: "left",
      text: "Target v2.",
      j5: { group: "other-person", senderName: "Priya" },
    });
  });

  it("puts another person's message in a shared conversation on the left, and the reader's on the right", () => {
    const typed = {
      id: "message-typed",
      role: "user",
      createdBy: "user" as const,
      text: "Ship it.",
    };
    const author = {
      messageId: "message-typed",
      name: "Priya",
      level: "collaborator" as const,
      editedBy: null,
      note: null,
      storedPrefix: "",
    };
    const shared = (you: boolean): J5Timeline => ({
      ...timeline("human:sam"),
      sharedAuthors: new Map([["message-typed", { ...author, you }]]),
    });
    expect(resolveJ5FeedMessage(typed, shared(false))).toMatchObject({
      side: "left",
      sharedAuthor: { name: "Priya" },
    });
    expect(resolveJ5FeedMessage(typed, shared(true))).toMatchObject({ side: "right" });
    expect(resolveJ5FeedMessage(typed, timeline("human:sam"))).toMatchObject({
      side: "right",
      sharedAuthor: undefined,
    });
  });

  it("leaves a message J5 cannot read to upstream's row as stored", () => {
    const unknown = delivery("agent", "[Cross-agent message from x]\n\nv7");
    expect(resolveJ5FeedMessage(unknown, timeline(null))).toMatchObject({
      j5: null,
      side: "right",
      preview: null,
      text: unknown.text,
    });
  });
});

describe("presentJ5TimelineNotice", () => {
  it("summarizes a silence in one line", () => {
    expect(presentJ5TimelineNotice(delivery("system", silenceRaw))).toEqual({
      kind: "silence",
      summary: "Captain's turn ended without replying",
    });
  });

  it("keeps a delivery notice it cannot read, and a Crew notice, as a labelled raw card", () => {
    expect(
      presentJ5TimelineNotice(delivery("system", "[Cross-agent messaging system notice: v7]\n\n?")),
    ).toEqual({ kind: "raw", label: "Raw A2A delivery" });
    expect(
      presentJ5TimelineNotice({
        id: "message:crew",
        role: "user",
        createdBy: "system",
        text: "<j5_crew_gate>\nproposal_id: crew:proposal:1\nkind: roster\ndecision: declined\n</j5_crew_gate>",
      }),
    ).toEqual({ kind: "raw", label: "Crew notice" });
  });

  it("leaves letters and upstream's own messages to their rows", () => {
    expect(presentJ5TimelineNotice(delivery("agent", askRaw))).toBeNull();
    expect(
      presentJ5TimelineNotice({
        id: "message:pr-watch:1",
        role: "user",
        createdBy: "system",
        text: "PR merged",
      }),
    ).toBeNull();
  });
});
