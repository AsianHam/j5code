import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { stringify } from "yaml";

import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { layer } from "./PlaybookDefinitionWatch.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";
import { seedPlaybookOwners } from "./testFixtures.ts";

const owner = ThreadId.make("thread:playbook:owner");
const otherOwner = ThreadId.make("thread:playbook:other");
const MemoryLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

/**
 * A store over real playbook files, and a file system whose `watch` the test drives: it says
 * which directory a watcher started or stopped on, and hands out the events pushed to it. A
 * directory in `unwatchable` fails as a missing one does.
 */
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([owner, otherOwner]);
  const store = yield* makePlaybookStore;
  const makeWorkspace = Effect.gen(function* () {
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-watch-" });
    const directory = path.join(workspaceRoot, ".j5", "playbooks");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "demo.yaml"),
      stringify({
        title: "Test playbook",
        description: "Watched while a run uses it.",
        steps: [{ id: "research", title: "Research", prompt: "Follow research." }],
      }),
    );
    return { workspaceRoot, directory };
  });

  const started = yield* Queue.unbounded<string>();
  const stopped = yield* Queue.unbounded<string>();
  const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const watched: Array<string> = [];
  const unwatchable = new Set<string>();
  const watching = FileSystem.FileSystem.of({
    ...fs,
    watch: (directory) => {
      watched.push(directory);
      if (unwatchable.has(directory)) return fs.watch(path.join(directory, "missing"));
      return Stream.fromEffect(Queue.offer(started, directory)).pipe(
        Stream.flatMap(() => Stream.fromQueue(events)),
        Stream.ensuring(Queue.offer(stopped, directory)),
      );
    },
  });
  const startDaemon = Layer.build(
    layer.pipe(
      Layer.provide(Layer.succeed(PlaybookStore, store)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, watching)),
    ),
  );
  const revision = store.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
  /** Waits for the revision to pass the one given, as a subscribed client would see it. */
  const revisionAfter = (seen: number) =>
    store.changes.pipe(
      Stream.filter((current) => current > seen),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const end = (
    operation: "cancel" | "complete",
    thread: ThreadId,
    run: { readonly runId: string },
  ) =>
    store.mutate(thread, {
      operation,
      runId: run.runId,
      client_request_id: `${operation}:${run.runId}`,
      ...(operation === "complete" ? { expectedStepId: "research" } : {}),
    } as Parameters<typeof store.mutate>[1]);
  return {
    store,
    makeWorkspace,
    startDaemon,
    started,
    stopped,
    events,
    watched,
    unwatchable,
    revision,
    revisionAfter,
    end,
  };
});

// The watcher settles a burst of file events on the real clock, so these wait for the one
// revision each expects and for nothing else.
it.live("watches a directory while a run there is active, and says when a file in it changes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const { store, started, stopped, events, watched } = fixture;
    const { workspaceRoot, directory } = yield* fixture.makeWorkspace;
    yield* fixture.startDaemon;

    // No run is active, so nothing is watched.
    assert.deepStrictEqual(watched, []);
    const first = yield* store.start(owner, workspaceRoot, "demo", "first");
    assert.equal(yield* Queue.take(started), directory);
    // A second run in the same directory shares its watcher.
    const second = yield* store.start(otherOwner, workspaceRoot, "demo", "second");

    // An editor's save is several events and one change.
    const before = yield* fixture.revision;
    yield* Queue.offerAll(events, [
      { _tag: "Update", path: "demo.yaml" },
      { _tag: "Update", path: "demo.yaml" },
    ]);
    assert.equal(yield* fixture.revisionAfter(before), before + 1);

    // The watcher outlives the first run to end there, and stops with the last.
    yield* fixture.end("complete", owner, first);
    yield* fixture.end("cancel", otherOwner, second);
    assert.equal(yield* Queue.take(stopped), directory);
    assert.deepStrictEqual(watched, [directory]);

    // A later run there is watched again.
    yield* store.start(owner, workspaceRoot, "demo", "third");
    assert.equal(yield* Queue.take(started), directory);
    assert.deepStrictEqual(watched, [directory, directory]);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.live("watches the runs already active when the server starts", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const { workspaceRoot, directory } = yield* fixture.makeWorkspace;
    yield* fixture.store.start(owner, workspaceRoot, "demo", "before-start");
    yield* fixture.startDaemon;
    assert.equal(yield* Queue.take(fixture.started), directory);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.live("does not start a failed watch again while its run stays active", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const { store, started, stopped, watched, unwatchable } = fixture;
    const gone = yield* fixture.makeWorkspace;
    const kept = yield* fixture.makeWorkspace;
    unwatchable.add(gone.directory);
    yield* fixture.startDaemon;

    const run = yield* store.start(owner, gone.workspaceRoot, "demo", "gone");
    // Each of these moves the revision, and each reconcile that follows still finds the failed
    // directory with an active run. A watcher started and stopped elsewhere proves the daemon
    // has reconciled past them.
    yield* store.definitionsChanged;
    const other = yield* store.start(otherOwner, kept.workspaceRoot, "demo", "kept");
    assert.equal(yield* Queue.take(started), kept.directory);
    yield* fixture.end("cancel", otherOwner, other);
    assert.equal(yield* Queue.take(stopped), kept.directory);
    assert.deepStrictEqual(watched, [gone.directory, kept.directory]);

    // Once its run has ended, a new run there is a new attempt.
    yield* fixture.end("cancel", owner, run);
    unwatchable.delete(gone.directory);
    yield* store.start(owner, gone.workspaceRoot, "demo", "back");
    assert.equal(yield* Queue.take(started), gone.directory);
    assert.deepStrictEqual(watched, [gone.directory, kept.directory, gone.directory]);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);
