import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  DevDeliverySeedArgumentError,
  parseDevDeliverySeedArgs,
  runDevDeliverySeed,
  validateIsolatedBaseDir,
} from "./devDeliverySeed.ts";

const isDevDeliverySeedArgumentError = Schema.is(DevDeliverySeedArgumentError);

it.effect("requires an explicit isolated base and emits a provider-safe receipt", () =>
  Effect.gen(function* () {
    const missingBaseDirError = (() => {
      try {
        parseDevDeliverySeedArgs([]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.isTrue(isDevDeliverySeedArgumentError(missingBaseDirError));
    const fileSystem = yield* FileSystem.FileSystem;
    const fakeHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-home-" });
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      for (const name of [".t3", ".j5code"]) {
        const sharedHome = `${fakeHome}/${name}`;
        yield* fileSystem.makeDirectory(sharedHome, { recursive: true });
        const sharedStateError = yield* Effect.flip(
          validateIsolatedBaseDir(`${sharedHome}/userdata`),
        );
        assert.isTrue(isDevDeliverySeedArgumentError(sharedStateError));
      }
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
    const baseDir = yield* fileSystem.makeTempDirectory({
      directory: NodeOS.tmpdir(),
      prefix: "j5-a2a-dev-delivery-seed-test-",
    });
    try {
      assert.equal(yield* validateIsolatedBaseDir(baseDir), yield* fileSystem.realPath(baseDir));
      const receipt = yield* runDevDeliverySeed(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      assert.isTrue(
        receipt.scenarios.ta1PeerExchange.deliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.match(receipt.scenarios.ta2HumanAnswer.personId, /^human:/);
      assert.isTrue(
        receipt.scenarios.ta2HumanAnswer.replyDeliveryMessageId.startsWith(
          "message:j5:a2a:delivery:",
        ),
      );
      assert.equal(
        receipt.scenarios.ta2HumanAnswer.targetThreadId,
        receipt.threads.sender.threadId,
      );
      assert.isTrue(
        receipt.scenarios.ta3Silence.noticeDeliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.match(
        receipt.scenarios.machineMessage.senderParticipantId,
        /^machine:seed-watchdog-[0-9a-f]{12}$/,
      );
      assert.isTrue(
        receipt.scenarios.machineMessage.deliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.equal(
        receipt.scenarios.machineMessage.targetThreadId,
        receipt.threads.receiver.threadId,
      );
      assert.isTrue(
        receipt.scenarios.rawFutureEnvelope.deliveryMessageId.startsWith(
          "message:j5:a2a:delivery:",
        ),
      );
      assert.isTrue(receipt.scenarios.normalNonA2AContrast.messageId.startsWith("message:mcp:"));
      assert.equal(receipt.noProviderWork.runnerStartedEffectWorker, false);
      assert.equal(receipt.noProviderWork.providerAdapterOpenSessionCalls, 0);
      assert.equal(receipt.noProviderWork.activeProviderSessionCount, 0);
      assert.equal(receipt.noProviderWork.activeRunCount, 0);
      assert.equal(receipt.noProviderWork.cancelledProviderStartEffectCount, 7);
      assert.equal(receipt.noProviderWork.nextClaimableAt, null);
      assert.equal(receipt.notSeeded.ta4Trailing.status, "held");
      const lock = new NodeSqlite.DatabaseSync(receipt.dbPath);
      lock.exec("BEGIN IMMEDIATE");
      try {
        const locked = yield* Effect.exit(
          runDevDeliverySeed(baseDir).pipe(
            Effect.provide(Logger.layer([], { mergeWithExisting: false })),
          ),
        );
        assert.equal(locked._tag, "Failure");
        if (locked._tag === "Failure") {
          assert.include(
            Cause.pretty(locked.cause),
            "could not acquire its rollback write preflight",
          );
        }
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
      // A reused home seeds again: each run registers its own machine sender.
      const rerun = yield* runDevDeliverySeed(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      assert.notEqual(
        rerun.scenarios.machineMessage.senderParticipantId,
        receipt.scenarios.machineMessage.senderParticipantId,
      );
    } finally {
      yield* fileSystem.remove(baseDir, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "accepts a linked worktree's own .j5code below the shared home, and nothing else there",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fakeHome = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-home-" }),
      );
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
          if (originalUserProfile === undefined) delete process.env.USERPROFILE;
          else process.env.USERPROFILE = originalUserProfile;
        }),
      );
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const sharedHome = `${fakeHome}/.j5code`;
      const worktree = `${sharedHome}/worktrees/project/feature`;
      yield* fileSystem.makeDirectory(`${sharedHome}/userdata`, { recursive: true });
      yield* fileSystem.makeDirectory(`${worktree}/.j5code`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${worktree}/.git`,
        "gitdir: /somewhere/project/.git/worktrees/feature\n",
      );

      const testHome = `${worktree}/.j5code/live-test/home`;
      assert.equal(yield* validateIsolatedBaseDir(testHome), testHome);

      const rejected = (baseDir: string) =>
        Effect.flip(validateIsolatedBaseDir(baseDir)).pipe(
          Effect.map(isDevDeliverySeedArgumentError),
        );
      // The worktree's checkout is not its disposable state.
      assert.isTrue(yield* rejected(`${worktree}/apps`));
      // A directory below the shared home that is not a linked worktree.
      yield* fileSystem.makeDirectory(`${sharedHome}/worktrees/plain/.j5code`, { recursive: true });
      assert.isTrue(yield* rejected(`${sharedHome}/worktrees/plain/.j5code/home`));
      // A link out of the worktree's .j5code into the shared state.
      yield* fileSystem.symlink(`${sharedHome}/userdata`, `${worktree}/.j5code/escape`);
      assert.isTrue(yield* rejected(`${worktree}/.j5code/escape`));
      assert.isTrue(yield* rejected(`${worktree}/.j5code/escape/home`));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("seeds into an existing project instead of creating its own", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "j5-a2a-dev-delivery-seed-project-",
    });
    const seed = (project?: { readonly id: ProjectId; readonly workspaceRoot: string }) =>
      runDevDeliverySeed(baseDir, project === undefined ? {} : { project }).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
    const first = yield* seed();
    const second = yield* seed({ id: first.project.id, workspaceRoot: process.cwd() });
    assert.equal(second.project.id, first.project.id);

    const database = new NodeSqlite.DatabaseSync(first.dbPath, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT project_id FROM projection_projects").all(), [
        { project_id: first.project.id },
      ]);
      assert.deepEqual(
        database
          .prepare("SELECT DISTINCT project_id FROM orchestration_v2_projection_threads")
          .all(),
        [{ project_id: first.project.id }],
      );
    } finally {
      database.close();
    }

    const wrongRoot = yield* Effect.exit(
      seed({ id: first.project.id, workspaceRoot: `${process.cwd()}/elsewhere` }),
    );
    assert.equal(wrongRoot._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);
