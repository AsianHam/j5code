import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 26));
const project = ProjectId.make("project:shared-search");
const threadId = ThreadId.make("thread:shared-search");

const NOTE =
  "<j5_shared_conversation>\nWho can write: Jackson (owner), Priya (collaborator).\n</j5_shared_conversation>\n";
const PRIYA = "[Message from Priya (collaborator)]\n\n";

const message = (id: string, text: string, minute: number): OrchestrationV2DomainEvent => {
  const time = DateTime.add(at, { minutes: minute });
  return {
    id: EventId.make(`message:${id}`),
    type: "message.updated",
    threadId,
    providerInstanceId,
    occurredAt: time,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdAt: time,
      updatedAt: time,
    },
  };
};

const seed = (stamped: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* ProjectStore.ProjectStoreV2).apply({
      sequence: 0,
      eventId: EventId.make("created:project"),
      aggregateKind: "project",
      aggregateId: project,
      occurredAt: DateTime.formatIso(at),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: project,
        title: project,
        workspaceRoot: "/work/shared",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at),
        updatedAt: DateTime.formatIso(at),
      },
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make("created:thread"),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: project,
        title: threadId,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const record = (messageId: string, storedPrefix: string) => sql`
    INSERT INTO j5_a2a_message_author (
      thread_id, message_id, person_id, display_name, level, stored_prefix, created_at
    ) VALUES (
      ${threadId}, ${messageId}, 'person:priya', 'Priya', 'collaborator', ${storedPrefix},
      ${DateTime.formatIso(at)}
    )
  `;
    // A message no one is recorded for, and a slash command, recorded with no lines.
    yield* projections.apply(message("plain", `${PRIYA}hi plain`, 3));
    yield* projections.apply(message("command", "/goal hi command", 4));
    yield* record("command", "");
    if (!stamped) return;
    yield* projections.apply(message("priya-first", `${NOTE}${PRIYA}hi there`, 1));
    yield* record("priya-first", `${NOTE}${PRIYA}`);
    // Text that does not begin with its recorded prefix is read as stored.
    yield* projections.apply(message("unmatched", "[Message from Someone]\n\nhi typed", 2));
    yield* record("unmatched", PRIYA);
  });

const snippets = (query: string) =>
  ThreadSearch.ThreadSearch.use((search) =>
    search.search({ query }).pipe(Effect.map((r) => r.matches.map((m) => m.snippet))),
  );

it.layer(layerTest)("message search in a shared conversation", (it) => {
  it.effect("shows and matches a person's words, not the platform's lines", () =>
    Effect.gen(function* () {
      yield* seed(true);
      assert.deepStrictEqual(yield* snippets("there"), ["hi there"]);
      // Words only in the note or the author line find nothing.
      assert.deepStrictEqual(yield* snippets("Who can write"), []);
      assert.deepStrictEqual(yield* snippets("Priya (collaborator)"), [
        "[Message from Priya (collaborator)] hi plain",
      ]);
      assert.deepStrictEqual(yield* snippets("hi typed"), ["[Message from Someone] hi typed"]);
      assert.deepStrictEqual(yield* snippets("hi command"), ["/goal hi command"]);
    }),
  );
});

it.layer(layerTest)("message search on a server where no message carries the lines", (it) => {
  it.effect("shows and matches every message as stored", () =>
    Effect.gen(function* () {
      yield* seed(false);
      assert.deepStrictEqual(yield* snippets("Priya (collaborator)"), [
        "[Message from Priya (collaborator)] hi plain",
      ]);
      assert.deepStrictEqual(yield* snippets("hi command"), ["/goal hi command"]);
    }),
  );
});
