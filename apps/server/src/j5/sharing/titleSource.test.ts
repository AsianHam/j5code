import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { layer as titleSourceLayer } from "./titleSource.ts";

const threadId = ThreadId.make("thread:shared-title");
const PRIYA = "[Message from Priya (collaborator)]\n\n";

const stored = [
  {
    id: "message:note",
    role: "user",
    text: `<j5_shared_conversation>…</j5_shared_conversation>\n${PRIYA}hi`,
  },
  { id: "message:command", role: "user", text: "/compact" },
  { id: "message:plain", role: "user", text: "from before it was shared" },
  { id: "message:answer", role: "assistant", text: `${PRIYA}quoted by the agent` },
];

const upstream = Layer.succeed(
  ThreadManagementService,
  ThreadManagementService.of({
    getThreadRecords: (_threadId: ThreadId, fields: ReadonlyArray<string>) =>
      Effect.succeed(fields.includes("messages") ? { messages: stored } : {}),
  } as unknown as ThreadManagementService["Service"]),
);

const layerTest = titleSourceLayer.pipe(
  Layer.provide(upstream),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.layer(layerTest)("the title generator's messages in a shared conversation", (it) => {
  it.effect("are each person's words, and every other message as stored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const record = (messageId: string, storedPrefix: string) => sql`
        INSERT INTO j5_a2a_message_author (
          thread_id, message_id, person_id, display_name, level, stored_prefix, created_at
        ) VALUES (
          ${threadId}, ${messageId}, 'person:priya', 'Priya', 'collaborator', ${storedPrefix},
          '2026-10-26T00:00:00.000Z'
        )
      `;
      yield* record("message:note", stored[0]!.text.slice(0, -"hi".length));
      yield* record("message:command", "");
      const threads = yield* ThreadManagementService;
      const read = yield* threads.getThreadRecords(threadId, ["messages"]);
      assert.deepStrictEqual(
        read.messages.map((message) => message.text),
        ["hi", "/compact", "from before it was shared", `${PRIYA}quoted by the agent`],
      );
    }),
  );
});
