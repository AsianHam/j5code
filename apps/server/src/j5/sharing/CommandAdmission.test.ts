import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { makeCommandAdmission } from "./CommandAdmission.ts";
import {
  OTHER_PROJECT,
  PROJECT,
  accessLayer,
  device,
  person,
  thread,
} from "./test-support/accessHarness.ts";

const command = (fields: Record<string, unknown>) =>
  ({ commandId: CommandId.make("command:test"), ...fields }) as unknown as OrchestrationV2Command;

/** Whether the command would reach upstream's handler for this device, or why not. */
const admitted = Effect.fn("test.admitted")(function* (
  session: { readonly sessionId: string; readonly subject: string },
  sent: OrchestrationV2Command,
) {
  const admission = yield* makeCommandAdmission(() => Effect.void, session as never);
  return yield* admission.admit(sent).pipe(
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

it.layer(accessLayer)("CommandAdmission", (it) => {
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
        yield* admitted(onThread, command({ type: "message.dispatch", threadId: mine })),
        "admitted",
      );
      assert.match(
        yield* admitted(onThread, command({ type: "message.dispatch", threadId: sibling })),
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
      for (const type of ["message.dispatch", "run.interrupt", "thread.visit"]) {
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
});
