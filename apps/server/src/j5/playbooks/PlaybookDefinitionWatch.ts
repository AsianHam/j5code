/**
 * A run is shown from its playbook's live YAML, and a person or an agent edits that file on disk
 * without telling the store. This daemon watches the directories that hold the definitions of
 * active runs and moves the store's revision when a file there changes, so a run's views read
 * again and a broken definition shows as the run's issue.
 *
 * Only active runs are watched: a server with none holds no file handle for this. An edit to a
 * definition no run uses is seen the next time the playbook library is opened, which reads the
 * files then.
 *
 * @module PlaybookDefinitionWatch
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PlaybookStore } from "./PlaybookStore.ts";

/** An editor's save is several file events; they are one change. */
const SETTLE = Duration.millis(100);

/** The daemon holds nothing a caller could ask for, so the layer provides no service. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* PlaybookStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;

    // One watcher per directory with an active run. A watcher that ended keeps its entry until
    // its directory has no active run, so it is not started again before then: its own last
    // change moved the revision, and that must not restart a watch that cannot be held.
    const watchers = new Map<string, Fiber.Fiber<void>>();

    const watch = (directory: string) =>
      fileSystem.watch(directory).pipe(
        Stream.debounce(SETTLE),
        Stream.runForEach(() => store.definitionsChanged),
        // Told once per directory. Its runs still read the live file whenever they are read.
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.logWarning("J5 playbook directory could not be watched", { directory, cause }),
          onSuccess: () => Effect.logWarning("J5 playbook directory watch ended", { directory }),
        }),
      );

    const reconcile = Effect.gen(function* () {
      const read = yield* Effect.result(store.activeDefinitionDirectories());
      if (read._tag === "Failure") {
        // Not knowing the active runs is not knowing of none: leave every watcher running.
        yield* Effect.logWarning("J5 playbook directories could not be read", {
          cause: read.failure,
        });
        return;
      }
      const active = new Set(read.success);
      for (const [directory, watcher] of watchers) {
        if (active.has(directory)) continue;
        yield* Fiber.interrupt(watcher);
        watchers.delete(directory);
      }
      for (const directory of active) {
        if (watchers.has(directory)) continue;
        watchers.set(directory, yield* watch(directory).pipe(Effect.forkIn(scope)));
      }
    });

    // The store's first value is its current revision, so the runs already active when the
    // server starts are watched from then; every run that starts or ends moves it.
    yield* store.changes.pipe(
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );
  }),
);
