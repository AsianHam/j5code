import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { makeCommandAdmission } from "./CommandAdmission.ts";
import { OTHER_PROJECT, PROJECT, device, person, thread } from "./test-support/accessHarness.ts";
import { conversationLayer } from "./test-support/conversationHarness.ts";

const command = (fields: Record<string, unknown>) =>
  ({ commandId: CommandId.make("command:test"), ...fields }) as unknown as OrchestrationV2Command;

/** Whether the command would reach upstream's handler for this device, or why not. */
const admitted = Effect.fn("test.admitted")(function* (
  session: { readonly sessionId: string; readonly subject: string },
  sent: OrchestrationV2Command,
) {
  const admission = yield* makeCommandAdmission(() => Effect.void, session as never);
  return yield* admission
    .dispatchCommand(sent, () => Effect.void)
    .pipe(
      Effect.as("admitted"),
      Effect.catch((error) => Effect.succeed(`refused: ${error.message}`)),
    );
});

const deviceOf = Effect.fn("test.deviceOf")(function* (
  name: string,
  levels: Parameters<typeof person>[1],
) {
  const created = yield* person(name, levels);
  return (yield* device(created.personId, LEVEL_PERMISSIONS.collaborator)).identity;
});

it.layer(conversationLayer)("CommandAdmission", (it) => {
  it.effect("lets only an Owner archive or delete a thread, for now", () =>
    Effect.gen(function* () {
      const threadId = yield* thread("thread:archive");
      const collaborator = yield* deviceOf("Wide collaborator", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      const owner = yield* deviceOf("Second owner", [
        { scope: { kind: "server" }, level: "owner" },
      ]);
      for (const type of ["thread.archive", "thread.unarchive", "thread.delete"]) {
        assert.match(
          yield* admitted(collaborator, command({ type, threadId })),
          /^refused: Only an Owner/,
        );
        assert.strictEqual(yield* admitted(owner, command({ type, threadId })), "admitted");
      }
      assert.strictEqual(
        yield* admitted(collaborator, command({ type: "thread.settle", threadId })),
        "admitted",
      );
    }),
  );

  it.effect("holds a narrowed Collaborator's commands to their scope", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:mine");
      const sibling = yield* thread("thread:sibling");
      const onThread = yield* deviceOf("Thread collaborator", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      assert.strictEqual(
        yield* admitted(
          onThread,
          command({
            type: "message.dispatch",
            threadId: mine,
            messageId: "message:mine",
            text: "Hi",
          }),
        ),
        "admitted",
      );
      assert.match(
        yield* admitted(
          onThread,
          command({
            type: "message.dispatch",
            threadId: sibling,
            messageId: "message:sibling",
            text: "Hi",
          }),
        ),
        /^refused/,
      );
      // Stop is upstream's client command: a Collaborator stops the thread shared, and no other.
      assert.strictEqual(
        yield* admitted(onThread, command({ type: "thread.stop", threadId: mine })),
        "admitted",
      );
      assert.match(
        yield* admitted(onThread, command({ type: "thread.stop", threadId: sibling })),
        /^refused/,
      );
      // At thread scope a Collaborator starts, forks and merges back nothing (AC14).
      for (const sent of [
        command({ type: "thread.create", threadId: "thread:new", projectId: PROJECT }),
        command({ type: "thread.fork", sourceThreadId: mine, targetThreadId: "thread:fork" }),
        command({ type: "thread.merge_back", sourceThreadId: mine, targetThreadId: mine }),
      ]) {
        assert.match(yield* admitted(onThread, sent), /^refused/, sent.type);
      }

      const onProject = yield* deviceOf("Project collaborator", [
        { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
      ]);
      assert.strictEqual(
        yield* admitted(
          onProject,
          command({ type: "thread.fork", sourceThreadId: mine, targetThreadId: "thread:fork" }),
        ),
        "admitted",
      );
      assert.match(
        yield* admitted(
          onProject,
          command({
            type: "thread.create",
            threadId: "thread:elsewhere",
            projectId: OTHER_PROJECT,
          }),
        ),
        /^refused/,
      );
    }),
  );

  it.effect("refuses a narrowed Viewer every command", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:viewed");
      const viewer = yield* deviceOf("Narrow viewer", [
        { scope: { kind: "thread", threadId: mine }, level: "viewer" },
      ]);
      for (const type of ["message.dispatch", "run.interrupt", "thread.stop", "thread.visit"]) {
        assert.match(yield* admitted(viewer, command({ type, threadId: mine })), /^refused/, type);
      }
    }),
  );

  it.effect("starts a thread only in a project the person writes to", () =>
    Effect.gen(function* () {
      const projectOnly = yield* deviceOf("Launcher", [
        { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
      ]);
      const admission = yield* makeCommandAdmission(() => Effect.void, projectOnly);
      const launch = (projectId: string) =>
        admission.admitLaunch({ projectId } as unknown as OrchestrationV2ThreadLaunchInput).pipe(
          Effect.as("admitted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
      assert.strictEqual(yield* launch(PROJECT), "admitted");
      assert.strictEqual(yield* launch(OTHER_PROJECT), "refused");
    }),
  );

  it.effect("names the person who edits a queued agent message, for the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* thread("thread:queued-edits");
      const editor = yield* person("Queue editor", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      const session = (yield* device(editor.personId, LEVEL_PERMISSIONS.collaborator)).identity;
      const queue = (ordinal: number, runId: string, messageId: string) => sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, ${ordinal}, 'codex', 'queued', '2026-10-24T00:00:00.000Z',
          ${JSON.stringify({ userMessageId: messageId, startedAt: null })}
        )
      `;
      yield* queue(1, "run:agent", "message:j5:a2a:delivery:message%3Aagent");
      yield* queue(2, "run:typed", "message:typed");
      const edit = (commandId: string, runId: string) =>
        command({
          type: "queued-run.edit",
          commandId: CommandId.make(commandId),
          threadId,
          runId,
          text: "Edited",
        });
      const admission = yield* makeCommandAdmission(() => Effect.void, session as never);
      const claims = () => sql`SELECT command_id, editor_id FROM j5_a2a_queued_edit_claim`;
      yield* admission.dispatchCommand(edit("command:edit-agent", "run:agent"), () => Effect.void);
      yield* admission.dispatchCommand(edit("command:edit-typed", "run:typed"), () => Effect.void);
      assert.deepStrictEqual(yield* claims(), [
        { command_id: "command:edit-agent", editor_id: editor.personId },
      ]);
      // Upstream refuses the edit: the claim it took goes with it.
      const refused = yield* admission
        .dispatchCommand(edit("command:edit-refused", "run:agent"), () =>
          Effect.fail("Run run:agent is not queued."),
        )
        .pipe(Effect.flip);
      assert.strictEqual(refused, "Run run:agent is not queued.");
      assert.deepStrictEqual(yield* claims(), [
        { command_id: "command:edit-agent", editor_id: editor.personId },
      ]);
      // Once upstream took the edit and the ledger recorded it, a retry of the same command
      // replays upstream's receipt with no new edit, and leaves no claim behind.
      yield* sql`DELETE FROM j5_a2a_queued_edit_claim`;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence,
          status, error
        ) VALUES (
          'command:edit-agent', 'thread', ${threadId}, 'queued-run.edit',
          '2026-10-24T00:00:00.000Z', 1, 'accepted', NULL
        )
      `;
      yield* admission.dispatchCommand(edit("command:edit-agent", "run:agent"), () => Effect.void);
      assert.deepStrictEqual(yield* claims(), []);
    }),
  );
});
