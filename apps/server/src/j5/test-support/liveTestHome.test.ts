// @effect-diagnostics nodeBuiltinImport:off - inspects the generated home with plain file and process calls.
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { PlaybookDefinition } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

import { decodeAgentPersonaDefinition } from "../agents/agentPersonas.ts";
import { buildLiveTestHome } from "./liveTestHome.ts";

const decodePlaybook = Schema.decodeUnknownEffect(PlaybookDefinition);

it.live(
  "builds a home whose only project is the test repository",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-home-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      // A base and a head build are given the same clock so their threads are dated alike.
      const fixedNow = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000 - 60 * 60 * 1000;
      const previousNow = process.env.J5_LIVE_TEST_NOW;
      process.env.J5_LIVE_TEST_NOW = String(fixedNow);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousNow === undefined) delete process.env.J5_LIVE_TEST_NOW;
          else process.env.J5_LIVE_TEST_NOW = previousNow;
        }),
      );
      const build = buildLiveTestHome({
        root,
        // Stored trimmed, under the rule every person's name is held to.
        ownerName: " Test owner ",
        replays: [
          ["multi_turn", "claudeAgent"],
          ["subagent", "codex"],
        ],
      }).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })));
      const manifest = yield* build;

      assert.equal(manifest.home, NodePath.join(root, "home"));
      assert.equal(manifest.ownerName, "Test owner");
      // Each persona's second route is recorded too: a launch can resolve to it.
      assert.deepEqual(manifest.personas, [
        { id: "haiku-helper", model: "claude-haiku-5-5", fallbackModel: "gpt-6-luna" },
        { id: "luna-helper", model: "gpt-6-luna", fallbackModel: "claude-haiku-5-5" },
      ]);
      assert.deepEqual(
        JSON.parse(NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8")),
        manifest,
      );

      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(manifest.home, "userdata/statev2.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        assert.deepEqual(
          database.prepare("SELECT project_id, workspace_root FROM projection_projects").all(),
          [{ project_id: manifest.project.id, workspace_root: manifest.testRepo }],
        );
        // The owner is named before any server starts, so sharing never waits on the dialog.
        assert.deepEqual(
          database
            .prepare(
              "SELECT display_name, name_key FROM j5_a2a_human_person WHERE is_local_operator = 1",
            )
            .all(),
          [{ display_name: "Test owner", name_key: "test owner" }],
        );
        const threads = database
          .prepare(
            "SELECT title, project_id, created_at, payload_json FROM orchestration_v2_projection_threads ORDER BY created_at",
          )
          .all();
        const titles = threads.map((thread) => String(thread.title));
        assert.include(titles, "Replay fixture: multi_turn (Claude)");
        assert.include(titles, "Replay fixture: subagent (Codex)");
        assert.include(titles, "J5 disposable A2A receiver seed");
        // Two replays, twenty minutes apart, ending twenty minutes before the given clock.
        assert.equal(Date.parse(String(threads[0]?.created_at)), fixedNow - 2 * 20 * 60 * 1000);
        const dayAgo = (yield* Clock.currentTimeMillis) - 24 * 60 * 60 * 1000;
        for (const thread of threads) {
          assert.equal(thread.project_id, manifest.project.id);
          // Replays run on a test clock, which starts in 1970 unless it is set.
          assert.isAbove(Date.parse(String(thread.created_at)), dayAgo);
          // Every path a thread carries stays inside the build.
          for (const [, path] of String(thread.payload_json).matchAll(
            /"(?:cwd|worktreePath)":"([^"]+)"/g,
          )) {
            assert.equal(path, manifest.testRepo);
          }
        }
      } finally {
        database.close();
      }

      const stateDir = NodePath.join(manifest.home, "userdata");
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(`${stateDir}/settings.json`, "utf8")), {
        defaultModelSelection: {
          instanceId: "claudeAgent",
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "low" }],
        },
      });
      // Each persona file must decode as the library decodes it, or Settings shows none at all.
      assert.deepEqual(
        NodeFS.readdirSync(`${stateDir}/personas`)
          .toSorted()
          .map((file) => {
            const persona = decodeAgentPersonaDefinition(
              parseYaml(NodeFS.readFileSync(`${stateDir}/personas/${file}`, "utf8")),
            );
            return [file, persona.id, persona.modelRoute[0].model];
          }),
        [
          ["haiku-helper.yaml", "haiku-helper", "claude-haiku-5-5"],
          ["luna-helper.yaml", "luna-helper", "gpt-6-luna"],
        ],
      );
      // The playbooks decode too, and name only personas the home has.
      for (const playbook of manifest.playbooks) {
        const definition = yield* decodePlaybook(
          parseYaml(
            NodeFS.readFileSync(
              NodePath.join(manifest.testRepo, ".j5/playbooks", `${playbook}.yaml`),
              "utf8",
            ),
          ),
        );
        for (const step of definition.steps) {
          if (step.persona !== undefined) {
            assert.include(
              manifest.personas.map((persona) => persona.id),
              step.persona,
            );
          }
        }
      }

      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd: manifest.testRepo, encoding: "utf8" });
      assert.equal(git("remote", "get-url", "origin").trim(), manifest.testRepoOrigin);
      assert.equal(git("status", "--porcelain", "--branch").trim(), "## main...origin/main");
      assert.equal(git("rev-list", "--count", "HEAD").trim(), "4");
      // Committed as executable, so every worktree of the repository can run it.
      assert.match(git("ls-files", "--stage", manifest.holdScript), /^100755 /);
      // The gate times out with no release file; with one it succeeds and removes it,
      // leaving nothing for git to report.
      const hold = (cwd: string) => {
        const result = NodeChildProcess.spawnSync(NodePath.join(cwd, manifest.holdScript), [], {
          cwd,
          env: { ...process.env, HOLD_MAX_SECONDS: "1" },
          encoding: "utf8",
        });
        // A null status means the gate never ran or was killed; say which.
        assert.isNotNull(
          result.status,
          `hold.sh in ${cwd} did not exit: error=${String(result.error)} signal=${String(result.signal)} stderr=${result.stderr}`,
        );
        return result.status;
      };
      assert.equal(hold(manifest.testRepo), 1);
      NodeFS.writeFileSync(manifest.holdReleaseFile, "");
      assert.equal(git("status", "--porcelain").trim(), "");
      // A thread's worktree waits on the main checkout's file, not its own.
      const threadWorktree = NodePath.join(root, "thread-worktree");
      git("worktree", "add", "--quiet", threadWorktree, "-b", "thread");
      assert.equal(hold(threadWorktree), 0);
      assert.isFalse(NodeFS.existsSync(manifest.holdReleaseFile));

      // A second build never writes over the first.
      assert.equal((yield* Effect.exit(build))._tag, "Failure");
      // A name no person may have is refused before anything is built.
      const unnamed = NodePath.join(root, "unnamed");
      const refused = yield* Effect.flip(buildLiveTestHome({ root: unnamed, ownerName: "[x]" }));
      assert.equal(refused._tag, "PersonNameError");
      assert.isFalse(NodeFS.existsSync(unnamed));
    }).pipe(Effect.scoped),
  60_000,
);

it.live(
  "leaves a message with an image and a question waiting for an answer",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-home-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const manifest = yield* buildLiveTestHome({
        root,
        ownerName: "Test owner",
        replays: [
          ["simple", "claudeAgent", "image"],
          ["simple", "codex", "question"],
        ],
      }).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })));
      assert.deepEqual(manifest.stateThreads, [
        "Message with an image",
        "Question waiting for an answer",
      ]);

      const stateDir = NodePath.join(manifest.home, "userdata");
      const database = new NodeSqlite.DatabaseSync(`${stateDir}/statev2.sqlite`, {
        readOnly: true,
      });
      try {
        const threadId = (title: string) =>
          database
            .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = ?")
            .get(title)?.thread_id ?? null;
        const payloads = (sql: string, title: string) =>
          database
            .prepare(sql)
            .all(threadId(title))
            .map((row) => JSON.parse(String(row.payload_json)));

        // The timeline reads the turn item and the message list reads the message.
        const [message, ...otherMessages] = payloads(
          "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user'",
          "Message with an image",
        );
        const [item] = payloads(
          "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type = 'user_message'",
          "Message with an image",
        );
        assert.deepEqual(otherMessages, []);
        assert.deepEqual(item.attachments, message.attachments);
        const [attachment] = message.attachments;
        assert.deepInclude(attachment, { type: "image", mimeType: "image/png" });
        // The server serves an attachment from the file its id names.
        const stored = NodeFS.readFileSync(`${stateDir}/attachments/${attachment.id}.png`);
        assert.equal(stored.byteLength, attachment.sizeBytes);
        assert.equal(stored.subarray(1, 4).toString(), "PNG");

        // Startup recovery expires every pending request but one answered by message.
        const requests = payloads(
          "SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ?",
          "Question waiting for an answer",
        );
        assert.equal(requests.length, 1);
        assert.equal(requests[0].status, "pending");
        assert.equal(requests[0].responseCapability.type, "message");
        // The question stands in for the agent's reply; it is not shown beside one.
        const items = payloads(
          "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? ORDER BY ordinal",
          "Question waiting for an answer",
        );
        assert.deepEqual(
          items.map((entry) => entry.type),
          ["user_message", "user_input_request", "checkpoint"],
        );
        assert.include(JSON.stringify(items[1]), "Which colour should the banner be?");
      } finally {
        database.close();
      }
    }).pipe(Effect.scoped),
  60_000,
);
