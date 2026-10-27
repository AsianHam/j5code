import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { Links, layer as linksLayer } from "./Links.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { SharedConversation } from "./SharedConversation.ts";
import { anySessionId, thread } from "./test-support/accessHarness.ts";
import { conversationLayer } from "./test-support/conversationHarness.ts";

/**
 * A link brings a person in through the access core, so the shared-thread write hook records the
 * thread shared as they join, before they or anyone else writes to it (Shared conversations AC6).
 */

const ownerDesktop = { sessionId: anySessionId("owner-desktop"), subject: "desktop-bootstrap" };

it.effect("a person brought in as a Collaborator on a thread makes it shared as they join", () =>
  Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const links = yield* Links;
    const sql = yield* SqlClient.SqlClient;
    const owner = yield* people.firstOwner;
    yield* people.setName({ personId: owner.personId, displayName: "Jackson" });
    const threadId = yield* thread("thread:invited");
    const link = yield* links.create(ownerDesktop, {
      kind: "invite",
      scope: { kind: "thread", threadId },
      level: "collaborator",
      use: "one",
      name: "Priya",
    });
    yield* links.join({ token: link.token, name: "Priya", session: null });

    const recorded = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM j5_a2a_shared_thread WHERE thread_id = ${threadId}
    `;
    assert.lengthOf(recorded, 1);

    const priya = (yield* people.listPeople).find(
      (record) => record.person.displayName === "Priya",
    )!.person.personId;
    const admitted = (yield* (yield* SharedConversation).dispatch(
      priya,
      {
        type: "message.dispatch",
        commandId: CommandId.make("command:first"),
        threadId,
        messageId: MessageId.make("message:first"),
        text: "Hello.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      } as unknown as OrchestrationV2Command,
      Effect.succeed,
    )) as { readonly text: string };
    assert.include(admitted.text, "Who can write: Jackson (owner), Priya (collaborator).");
    assert.isTrue(admitted.text.endsWith("[Message from Priya (collaborator)]\n\nHello."));
  }).pipe(Effect.provide(linksLayer.pipe(Layer.provideMerge(conversationLayer)))),
);
