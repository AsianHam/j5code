import * as CrewTurnContext from "./CrewTurnContext.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import {
  CommandReceiptStoreV2,
  type CommandReceiptV2,
} from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import { ReadChanges } from "./ReadChanges.ts";
import * as Stream from "effect/Stream";
import * as DeliveryContext from "./CrewDeliveryContext.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { LedgerProjectId } from "./contracts.ts";
import { spawnFirstTurnText } from "./spawnIds.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const base = Layer.mergeAll(
  database,
  Crews.layer.pipe(Layer.provide(database)),
  ledgerLayer.pipe(Layer.provide(database)),
);
const seatId = ThreadId.make("thread:reviewer");
const captainThreadId = ThreadId.make("thread:captain");
const projectId = LedgerProjectId.make("project:crew-context");
const member = (name: string) => ({
  seatName: name,
  agentId: null,
  threadId: ThreadId.make(`thread:${name}`),
  participantId: participantIdForThread(ThreadId.make(`thread:${name}`)),
  reason: `Responsibility of ${name}`,
});
const assignment = (id: string, createdBy: "user" | "agent" | "system" = "agent") => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:${id}`),
  threadId: seatId,
  messageId: MessageId.make(`message:${id}`),
  text: `<message_envelope>\nassignment ${id}\nreply_to: sender\n</message_envelope>`,
  senderThreadId: captainThreadId,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy,
  creationSource: "mcp" as const,
});
const fixture = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  const crews = yield* Crews.AgentCrewInstanceService;
  const createdAt = "2026-10-27T12:00:00.000Z";
  yield* (yield* A2ALedger).ensureProject({ projectId, createdAt });
  yield* crews.record({
    id: "crew:test",
    projectId,
    captainThreadId,
    captainParticipantId: participantIdForThread(captainThreadId),
    displayName: "Test crew",
    brief: "Shared goal",
    createdAt,
    members: [member("reviewer"), member("builder")],
  });
  const firstTurnText = spawnFirstTurnText({
    brief: "Shared goal",
    participantId: participantIdForThread(seatId),
    projectId,
    projectTitle: "Test",
    spawnedByParticipantId: participantIdForThread(captainThreadId),
    spawnerThreadId: captainThreadId,
    crew: {
      displayName: "Test crew",
      instanceId: "crew:test",
      seatName: "reviewer",
      captainParticipantId: participantIdForThread(captainThreadId),
      roster: [],
      seatInstructions: "Review carefully.",
    },
  });
  yield* sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
    VALUES (${seatId}, ${firstTurnText}, '{"type":"shared"}')`;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const receipts = new Map<string, CommandReceiptV2>();
  const rejected = new Set<string>();
  let receiptReads = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () => Effect.succeed({ worktreePath: null } as never),
      getThreadRecords: () => Effect.succeed({ runs: [] } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (receipts.has(command.commandId)) return { sequence: 1, storedEvents: [] };
          if (rejected.has(command.commandId))
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          yield* Ref.update(commands, (all) => [...all, command]);
          receipts.set(command.commandId, { status: "accepted" } as CommandReceiptV2);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(CommandReceiptStoreV2)({
      getByCommandId: (id) =>
        Effect.sync(() => {
          receiptReads += 1;
          return Option.fromNullishOr(receipts.get(id));
        }),
    }),
  );
  const layer = DeliveryContext.layer.pipe(Layer.provide(dependencies));
  const send = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      return yield* (yield* Orchestrator.OrchestratorV2).dispatch(command);
    });
  const notified: Array<ReadonlyArray<string>> = [];
  // What the member's thread was asked to keep, with a receipt's replay: a command id seen twice
  // lands once.
  const recorded = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const recording = { fails: false };
  const recorder = Layer.mock(Orchestrator.OrchestratorV2)({
    dispatch: (command) =>
      Effect.gen(function* () {
        if (recording.fails)
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
          });
        yield* Ref.update(recorded, (all) =>
          all.some((seen) => seen.commandId === command.commandId) ? all : [...all, command],
        );
        return { sequence: 1, storedEvents: [] };
      }),
  });
  const deliveryLayer = CrewTurnContext.layerWithChanges.pipe(
    Layer.provide(
      Layer.merge(
        recorder,
        Layer.succeed(
          ReadChanges,
          ReadChanges.of({
            notify: (...keys) => Effect.sync(() => void notified.push(keys)),
            changes: Stream.empty,
          }),
        ),
      ),
    ),
  );
  const runId = RunId.make("run:reviewer");
  const providerThread = (native: string) =>
    ({
      id: "provider-thread:reviewer",
      nativeThreadRef: { driver: "codex", nativeId: native, strength: "strong" },
    }) as never;
  /** The prompt the provider received, or null when the send reported it never happened. */
  const deliver = (
    text: string,
    options: { readonly fail?: boolean; readonly sent?: boolean; readonly native?: string } = {},
  ) =>
    Effect.gen(function* () {
      let prompt: string | null = null;
      yield* (yield* CrewTurnContext.CrewTurnContext).deliver(
        {
          threadId: seatId,
          runId: runId,
          providerThread: providerThread(options.native ?? "native-1"),
          text,
        },
        (sent) =>
          options.fail === true
            ? Effect.fail("provider refused")
            : Effect.sync(() => {
                if (options.sent !== false) prompt = sent;
                return options.sent !== false;
              }),
      );
      return prompt as string | null;
    }).pipe(Effect.provide(deliveryLayer));
  const steer = (text: string, options: { readonly fail?: boolean } = {}) =>
    Effect.gen(function* () {
      const steered: string[] = [];
      const session = (yield* CrewTurnContext.CrewTurnContext).steering({
        steerTurn: (input) =>
          options.fail === true
            ? Effect.die("provider refused")
            : Effect.sync(() => void steered.push(input.message.text)),
      });
      yield* session.steerTurn({
        threadId: seatId,
        runId,
        providerThread: providerThread("native-1"),
        message: { text },
      } as never);
      return steered[0] ?? null;
    }).pipe(Effect.provide(deliveryLayer));
  return {
    sql,
    crews,
    commands,
    receipts,
    receiptReads: () => receiptReads,
    rejected,
    layer,
    send,
    deliver,
    steer,
    notified,
    recorded,
    recording,
  };
});

it.effect(
  "acceptance leaves context owed; provider delivery includes the current roster and original assignment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = assignment("direct", "user");
      yield* f.send(command).pipe(Effect.provide(f.layer));
      assert.isTrue((yield* f.crews.read("crew:test"))!.members[0]!.notStarted);
      assert.deepStrictEqual((yield* Ref.get(f.commands))[0], command);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.crews.removeMembers("crew:test", ["builder"]);
      const prompt = (yield* f.deliver(command.text))!;
      assert.include(prompt, "<spawner_brief>\nShared goal\n</spawner_brief>");
      assert.include(prompt, "Review carefully.");
      assert.include(prompt, "- security:");
      assert.notInclude(prompt, "- builder:");
      assert.isTrue(prompt.endsWith(command.text));
      assert.isFalse((yield* f.crews.read("crew:test"))!.members[0]!.notStarted);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "worktree assignments use durable preparation without storing context in editable text",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET workspace = '{"type":"worktree","baseRef":"j5/main"}'`;
      const command = assignment("playbook", "system");
      yield* f.send(command).pipe(Effect.provide(f.layer));
      const [delivered] = yield* Ref.get(f.commands);
      if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
      assert.deepStrictEqual(delivered.dispatchMode, {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "j5/main" },
      });
      assert.equal(delivered.text, command.text);
    }).pipe(Effect.provide(base)),
);

it.effect("a pinned worktree is prepared from its saved commit, never fetched forward", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const baseCommit = "4".repeat(40);
    yield* f.sql`UPDATE j5_crew_seat_context SET workspace = ${JSON.stringify({
      type: "worktree",
      baseRef: "renamed-away",
      baseCommit,
      branch: "fix/pin",
      startFromOrigin: true,
    })}`;
    yield* f.send(assignment("playbook", "system")).pipe(Effect.provide(f.layer));
    const [delivered] = yield* Ref.get(f.commands);
    if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
    assert.deepStrictEqual(delivered.dispatchMode, {
      type: "defer_start",
      workspaceStrategy: {
        type: "worktree",
        baseRef: baseCommit,
        branch: "fix/pin",
        startFromOrigin: false,
      },
    });
  }).pipe(Effect.provide(base)),
);

it.effect("provider refusal keeps the introduction and roster changes owed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.equal((yield* f.deliver("first", { fail: true }).pipe(Effect.result))._tag, "Failure");
    assert.include((yield* f.deliver("retry"))!, "<j5_spawn_context>");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.crews.removeMembers("crew:test", ["builder"]);
    yield* f.deliver("refused update", { fail: true }).pipe(Effect.result);
    const prompt = (yield* f.deliver("accepted update"))!;
    assert.include(prompt, "joined: security:");
    assert.include(prompt, "left: builder:");
    assert.notInclude(prompt, "spawner_brief");
    assert.equal(yield* f.deliver("later"), "later");
  }).pipe(Effect.provide(base)),
);

it.effect(
  "queued edits, cancellation and reordering cannot consume or reorder roster changes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.deliver("first");
      yield* f.crews.addMembers("crew:test", [member("temporary")]);
      yield* f.send(assignment("queued-first")).pipe(Effect.provide(f.layer));
      yield* f.crews.removeMembers("crew:test", ["temporary", "builder"]);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.send(assignment("queued-second")).pipe(Effect.provide(f.layer));
      // The provider sees whichever editable message upstream selects, not acceptance order.
      const prompt = (yield* f.deliver("edited second assignment promoted first"))!;
      assert.include(prompt, "joined: security:");
      assert.include(prompt, "left: builder:");
      assert.notInclude(prompt, "temporary");
      assert.isTrue(prompt.endsWith("edited second assignment promoted first"));
      assert.equal(yield* f.deliver("remaining assignment"), "remaining assignment");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "an archived waiting seat cannot bypass workspace preparation when independently reopened",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET workspace = '{"type":"worktree","baseRef":"main"}'`;
      yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
      const result = yield* f
        .send(assignment("after-archive"))
        .pipe(Effect.result, Effect.provide(f.layer));
      assert.equal(result._tag, "Failure");
      assert.lengthOf(yield* Ref.get(f.commands), 0);
      assert.equal((yield* f.deliver("bypass").pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "a retired started seat still cannot run in the project root after worktree failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET delivered_roster = '[]', workspace = '{"type":"worktree","baseRef":"main"}'`;
      yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
      const result = yield* f
        .send(assignment("after-failed-preparation"))
        .pipe(Effect.result, Effect.provide(f.layer));
      assert.equal(result._tag, "Failure");
      assert.lengthOf(yield* Ref.get(f.commands), 0);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "direct human assignments preserve author prefixes without any author write or subscription invalidation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authorPrefix = "[Message from Bryant (owner)]\n\n";
      const command = { ...assignment("authored", "user"), text: authorPrefix + "Review the fix." };
      yield* f.sql`INSERT INTO j5_a2a_message_author (thread_id, message_id, person_id, display_name, level, stored_prefix, created_at)
      VALUES (${seatId}, ${command.messageId}, 'human:owner', 'Bryant', 'owner', ${authorPrefix}, '2026-10-27T12:00:00Z')`;
      yield* f.send(command).pipe(Effect.provide(f.layer));
      const prompt = (yield* f.deliver(command.text))!;
      const [author] = yield* f.sql<{
        readonly stored_prefix: string;
      }>`SELECT stored_prefix FROM j5_a2a_message_author WHERE message_id = ${command.messageId}`;
      assert.equal(author!.stored_prefix, authorPrefix);
      assert.isTrue(prompt.endsWith(command.text));
      assert.deepStrictEqual((yield* Ref.get(f.commands))[0], command);
    }).pipe(Effect.provide(base)),
);

it.effect("an accepted command still replays after its waiting Crew retires", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const command = assignment("replay");
    yield* f.send(command).pipe(Effect.provide(f.layer));
    yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
    yield* f.send(command).pipe(Effect.provide(f.layer));
    assert.lengthOf(yield* Ref.get(f.commands), 1);
  }).pipe(Effect.provide(base)),
);

it.effect("a retired member that already started continues as a plain agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("first");
    yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
    yield* f.send(assignment("after-retirement")).pipe(Effect.provide(f.layer));
    assert.equal(yield* f.deliver("new assignment"), "new assignment");
  }).pipe(Effect.provide(base)),
);

it.effect("a send that never happened leaves the introduction and roster changes owed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.isNull(yield* f.deliver("stopped before the provider", { sent: false }));
    const [owed] = yield* f.sql<{
      readonly delivered_roster: string | null;
    }>`SELECT delivered_roster FROM j5_crew_seat_context WHERE thread_id = ${seatId}`;
    assert.isNull(owed!.delivered_roster);
    assert.include((yield* f.deliver("retry"))!, "<spawner_brief>");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    assert.isNull(yield* f.deliver("superseded", { sent: false }));
    assert.include((yield* f.deliver("retry"))!, "joined: security:");
  }).pipe(Effect.provide(base)),
);

it.effect("the introduction is sent again only when the provider conversation changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.include((yield* f.deliver("first", { native: "native-1" }))!, "<spawner_brief>");
    assert.equal(
      yield* f.deliver("same conversation", { native: "native-1" }),
      "same conversation",
    );
    yield* f.crews.addMembers("crew:test", [member("security")]);
    const replaced = (yield* f.deliver("after fallback", { native: "native-2" }))!;
    assert.include(replaced, "<spawner_brief>\nShared goal\n</spawner_brief>");
    assert.include(replaced, "Review carefully.");
    assert.include(replaced, "- security:");
    assert.notInclude(replaced, "joined:");
    assert.equal(
      yield* f.deliver("replaced conversation", { native: "native-2" }),
      "replaced conversation",
    );
  }).pipe(Effect.provide(base)),
);

it.effect("a delivery that changes nothing writes and announces nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`CREATE TABLE seat_context_writes (n INTEGER)`;
    yield* f.sql`CREATE TRIGGER count_seat_context_writes AFTER UPDATE ON j5_crew_seat_context
      BEGIN INSERT INTO seat_context_writes VALUES (1); END`;
    const writes = () =>
      f.sql<{ readonly n: number }>`SELECT count(*) AS n FROM seat_context_writes`.pipe(
        Effect.map(([row]) => row!.n),
      );

    yield* f.deliver("first", { native: "native-1" });
    assert.equal(yield* writes(), 1);
    assert.lengthOf(f.notified, 1);

    yield* f.deliver("follow-up", { native: "native-1" });
    yield* f.steer("steer");
    assert.equal(yield* writes(), 1);
    assert.lengthOf(f.notified, 1);

    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.deliver("after the roster changed", { native: "native-1" });
    assert.equal(yield* writes(), 2);
    assert.deepStrictEqual(f.notified.at(-1), ["crew", "fleet"]);
    assert.lengthOf(f.notified, 2);

    yield* f.deliver("replaced conversation", { native: "native-2" });
    assert.equal(yield* writes(), 3);
    yield* f.deliver("and again", { native: "native-2" });
    assert.equal(yield* writes(), 3);
    assert.lengthOf(f.notified, 3);
  }).pipe(Effect.provide(base)),
);

it.effect("a refused delivery records nothing, so the next one still carries what is owed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("first");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.deliver("refused", { fail: true }).pipe(Effect.result);
    assert.lengthOf(f.notified, 1);
    assert.include((yield* f.deliver("accepted"))!, "joined: security:");
    assert.lengthOf(f.notified, 2);
  }).pipe(Effect.provide(base)),
);

it.effect("the roster names each seat as it was launched, not by its persona id", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace, agent_display_name)
      VALUES ('thread:builder', '', '{"type":"shared"}', 'Team Builder')`;
    yield* f.sql`UPDATE j5_agent_crew_member SET agent_id = 'builder-persona' WHERE seat_name = 'builder'`;
    const prompt = (yield* f.deliver("first"))!;
    assert.include(prompt, "- builder: participant_id=");
    assert.include(prompt, "persona=Team Builder");
    assert.notInclude(prompt, "builder-persona");
    assert.include(prompt, "- reviewer (you):");
    assert.include(prompt, "persona=custom");
  }).pipe(Effect.provide(base)),
);

it.effect("a migrated seat has no introduction to send again", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("first", { native: "native-1" });
    yield* f.sql`UPDATE j5_crew_seat_context SET delivered_conversation = NULL, first_turn_text = ''`;
    assert.equal(yield* f.deliver("one", { native: "native-1" }), "one");
    assert.equal(yield* f.deliver("two", { native: "native-2" }), "two");
  }).pipe(Effect.provide(base)),
);

it.effect("steering a busy seat carries the roster change and records it only once accepted", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("first");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.steer("refused", { fail: true }).pipe(Effect.exit);
    const steered = (yield* f.steer("steer the builder"))!;
    assert.include(steered, "joined: security:");
    assert.isTrue(steered.endsWith("steer the builder"));
    assert.equal(yield* f.steer("again"), "again");
  }).pipe(Effect.provide(base)),
);

it.effect(
  "authored text is delivered byte for byte, even when it begins with the context marker",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authored =
        "<j5_crew_delivery_context>\nmine\n</j5_crew_delivery_context>\n\nPlease review.";
      assert.isTrue((yield* f.deliver(authored))!.endsWith(authored));
      assert.equal(yield* f.deliver(authored), authored);
    }).pipe(Effect.provide(base)),
);

it.effect("a thread that is not a Crew seat is dispatched untouched, without a receipt read", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const command = { ...assignment("plain"), threadId: ThreadId.make("thread:plain") };
    yield* f.send(command).pipe(Effect.provide(f.layer));
    assert.deepStrictEqual((yield* Ref.get(f.commands))[0], command);
    assert.equal(f.receiptReads(), 0);
  }).pipe(Effect.provide(base)),
);

/** What the member's thread was asked to keep: the text, not the assignment that followed it. */
const recordedTexts = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command) => (command.type === "platform-message.record" ? [command.text] : []));

it.effect(
  "the introduction and each roster change are kept in the member's thread once, as the model read them",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = (yield* f.deliver("Review the fix.", { native: "native-1" }))!;
      const [introduction] = recordedTexts(yield* Ref.get(f.recorded));
      assert.isTrue(first.startsWith(`${introduction}\n\n`));
      assert.isTrue(introduction!.startsWith("<j5_crew_delivery_context>\n"));
      assert.include(introduction, "<spawner_brief>\nShared goal\n</spawner_brief>");
      assert.notInclude(introduction, "Review the fix.");

      yield* f.deliver("follow-up", { native: "native-1" });
      yield* f.steer("steer");
      assert.lengthOf(recordedTexts(yield* Ref.get(f.recorded)), 1);

      yield* f.crews.addMembers("crew:test", [member("security")]);
      const second = (yield* f.deliver("after the roster changed", { native: "native-1" }))!;
      const changed = recordedTexts(yield* Ref.get(f.recorded)).at(-1)!;
      assert.isTrue(second.startsWith(`${changed}\n\n`));
      assert.include(changed, "<j5_crew_roster_changed>\njoined: security:");
      assert.notInclude(changed, "after the roster changed");

      yield* f.deliver("replaced conversation", { native: "native-2" });
      const all = yield* Ref.get(f.recorded);
      assert.lengthOf(recordedTexts(all), 3);
      assert.include(recordedTexts(all).at(-1)!, "<spawner_brief>");
      assert.lengthOf(new Set(all.map((command) => command.commandId)), 3);
      const messages = all.flatMap((command) =>
        command.type === "platform-message.record" ? [command.messageId] : [],
      );
      assert.lengthOf(new Set(messages), 3);
    }).pipe(Effect.provide(base)),
);

it.effect("a refused or superseded send keeps nothing in the member's thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("refused", { fail: true }).pipe(Effect.result);
    assert.isNull(yield* f.deliver("stopped", { sent: false }));
    assert.lengthOf(yield* Ref.get(f.recorded), 0);
    yield* f.deliver("accepted");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.steer("refused", { fail: true }).pipe(Effect.exit);
    assert.lengthOf(yield* Ref.get(f.recorded), 1);
  }).pipe(Effect.provide(base)),
);

it.effect(
  "a record that cannot be kept never fails the turn, and a retried delivery keeps it once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.recording.fails = true;
      assert.isTrue((yield* f.deliver("first"))!.endsWith("first"));
      assert.lengthOf(yield* Ref.get(f.recorded), 0);
      f.recording.fails = false;

      // The prompt was accepted but its bookkeeping failed, so the next delivery carries the
      // same context again and must land on the same record.
      yield* f.sql`UPDATE j5_crew_seat_context SET delivered_roster = NULL`;
      yield* f.sql`CREATE TRIGGER refuse_seat_context_update BEFORE UPDATE ON j5_crew_seat_context
        BEGIN SELECT RAISE(ABORT, 'locked'); END`;
      yield* f.deliver("second");
      yield* f.sql`DROP TRIGGER refuse_seat_context_update`;
      yield* f.deliver("third");
      assert.lengthOf(yield* Ref.get(f.recorded), 1);
    }).pipe(Effect.provide(base)),
);
