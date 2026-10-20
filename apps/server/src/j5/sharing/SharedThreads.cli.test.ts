import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import { Access } from "./Access.ts";
import { cliEnvironmentAuth } from "./AccessGate.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { OTHER_PROJECT, PROJECT, thread } from "./test-support/accessHarness.ts";

/**
 * The `j5` CLI builds its own access core in its own process (`cli/auth.ts`), so a person it
 * gives a writer's level is recorded there, inside its own transaction: the running server never
 * hears of it.
 */
const cliLayer = cliEnvironmentAuth(EnvironmentAuth.layerRuntime).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-cli-shared-threads-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "a person the CLI makes a Collaborator marks the threads they now write to as shared",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const theirs = yield* thread("thread:cli-theirs", PROJECT);
      const elsewhere = yield* thread("thread:cli-elsewhere", OTHER_PROJECT);
      const people = yield* PersonAccess;
      const priya = yield* people.createPerson({ displayName: "Priya" });
      yield* (yield* Access).setLevel({
        personId: priya.personId,
        scope: { kind: "project", projectId: PROJECT },
        level: "collaborator",
      });
      const shared = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM j5_a2a_shared_thread ORDER BY thread_id
    `;
      assert.deepStrictEqual(
        shared.map((row) => row.thread_id),
        [theirs],
      );
      assert.notInclude(
        shared.map((row) => row.thread_id),
        elsewhere,
      );
    }).pipe(Effect.provide(cliLayer)),
);
