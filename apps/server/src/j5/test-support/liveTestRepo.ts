// @effect-diagnostics nodeBuiltinImport:off - a build-time helper for the live-test home; plain git and file writes.
/**
 * The repository an agent live-tests against: a small TODO app with a few
 * commits, a test suite, a gate script that holds a turn open, and two
 * playbooks. It is written from the strings below so nothing in it comes from,
 * or points at, a real repository. Its `origin` is a bare repository beside it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const LIVE_TEST_PLAYBOOKS = ["two-step", "add-a-feature"] as const;
export const LIVE_TEST_HOLD_SCRIPT = "scripts/hold.sh";
/** Created in the test repository root to release `scripts/hold.sh`, which then deletes it. */
export const LIVE_TEST_HOLD_RELEASE_FILE = ".hold-release";

interface RepoCommit {
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
}

const README = `# TODO app

A tiny command-line TODO list, used as the project for J5 Code live tests.
Change anything here; it is a disposable copy.

    node src/cli.js add "Buy milk"
    node src/cli.js done 1
    node src/cli.js list
    pnpm test

\`scripts/hold.sh\` blocks until \`.hold-release\` exists in this directory, then
deletes it. Ask an agent to run it to hold a turn open, then
\`touch .hold-release\` here to let the turn finish.
`;

const PACKAGE_JSON = `{
  "name": "todo-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const TODO_JS = `/** Returns a new list with the todo added. */
export const add = (todos, title) => [
  ...todos,
  { id: todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1, title, done: false },
];

export const format = (todos) =>
  todos.map((todo) => \`\${todo.done ? "[x]" : "[ ]"} \${todo.id} \${todo.title}\`).join("\\n");
`;

const TODO_TEST_JS = `import assert from "node:assert/strict";
import test from "node:test";

import { add, format } from "../src/todo.js";

test("add gives each todo the next id", () => {
  const todos = add(add([], "first"), "second");
  assert.deepEqual(
    todos.map((todo) => todo.id),
    [1, 2],
  );
});

test("format shows one line per todo", () => {
  assert.equal(format(add([], "first")), "[ ] 1 first");
});
`;

const TODO_JS_WITH_DONE = `${TODO_JS}
/** Returns a new list with the todo marked done. Unknown ids change nothing. */
export const complete = (todos, id) =>
  todos.map((todo) => (todo.id === id ? { ...todo, done: true } : todo));
`;

const TODO_TEST_JS_WITH_DONE = `${TODO_TEST_JS.replace(
  'import { add, format } from "../src/todo.js";',
  'import { add, complete, format } from "../src/todo.js";',
)}
test("complete marks only the matching todo", () => {
  const todos = complete(add(add([], "first"), "second"), 2);
  assert.equal(format(todos), "[ ] 1 first\\n[x] 2 second");
});
`;

const CLI_JS = `import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { add, complete, format } from "./todo.js";

const file = process.env.TODO_FILE ?? "todos.json";
const todos = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const [command, argument] = process.argv.slice(2);

if (command === "add" && argument) {
  writeFileSync(file, JSON.stringify(add(todos, argument), null, 2));
} else if (command === "done" && argument) {
  writeFileSync(file, JSON.stringify(complete(todos, Number(argument)), null, 2));
} else if (command === "list") {
  console.log(format(todos));
} else {
  console.error("Usage: node src/cli.js add <title> | done <id> | list");
  process.exitCode = 64;
}
`;

const HOLD_SH = `#!/usr/bin/env bash
# Holds a turn open: blocks until ${LIVE_TEST_HOLD_RELEASE_FILE} exists in the root of the test
# repository, then deletes that file and exits 0.
#
#   scripts/hold.sh
#
# Release it from outside the turn, in the test repository root, with:
#   touch ${LIVE_TEST_HOLD_RELEASE_FILE}
# From a thread's worktree it still waits on the main checkout's file. It gives
# up with exit 1 after 540 seconds, so a forgotten gate cannot hold a turn forever.
set -euo pipefail

here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
file="$root/${LIVE_TEST_HOLD_RELEASE_FILE}"
max_seconds="\${HOLD_MAX_SECONDS:-540}"
echo "holding until $file exists"
for ((waited = 0; waited < max_seconds; waited++)); do
  if [ -e "$file" ]; then
    rm -f "$file"
    echo "released"
    exit 0
  fi
  sleep 1
done
echo "gave up after $max_seconds seconds: $file never appeared" >&2
exit 1
`;

const TWO_STEP_PLAYBOOK = `title: Two step
description: A trivial playbook for live tests. Each step is one short reply.
steps:
  - id: first
    title: First step
    prompt: Say the word FIRST and nothing else.
  - id: second
    title: Second step
    prompt: Say the word SECOND and nothing else.
`;

const ADD_A_FEATURE_PLAYBOOK = `title: Add a feature
description: A small build and review loop on the TODO app, for live tests with personas.
steps:
  - id: build
    title: Build
    persona: haiku-helper
    prompt: Add a "remove <id>" command to src/cli.js with a test, and run pnpm test.
  - id: review
    title: Review
    persona: luna-helper
    prompt: Read the change from the build step and say in one sentence whether it is correct.
  - id: report
    title: Report
    prompt: Say in one sentence what was built and what the review said.
`;

const COMMITS: ReadonlyArray<RepoCommit> = [
  {
    message: "Add a todo list",
    files: {
      "README.md": README,
      "package.json": PACKAGE_JSON,
      ".gitignore": `todos.json\n${LIVE_TEST_HOLD_RELEASE_FILE}\n`,
      "src/todo.js": TODO_JS,
      "test/todo.test.js": TODO_TEST_JS,
    },
  },
  {
    message: "Mark todos done",
    files: { "src/todo.js": TODO_JS_WITH_DONE, "test/todo.test.js": TODO_TEST_JS_WITH_DONE },
  },
  { message: "Add the command line", files: { "src/cli.js": CLI_JS } },
  {
    message: "Add the hold gate and two playbooks",
    files: {
      [LIVE_TEST_HOLD_SCRIPT]: HOLD_SH,
      ".j5/playbooks/two-step.yaml": TWO_STEP_PLAYBOOK,
      ".j5/playbooks/add-a-feature.yaml": ADD_A_FEATURE_PLAYBOOK,
    },
  },
];

/**
 * Creates the TODO app at `repoDir` on branch `main`, with a bare `origin` at
 * `originDir` that `main` tracks. Both directories must not exist yet.
 */
export function createLiveTestRepo(input: {
  readonly repoDir: string;
  readonly originDir: string;
}): void {
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });

  NodeFS.mkdirSync(input.repoDir, { recursive: true });
  git(input.repoDir, "init", "--initial-branch", "main");
  // Local identity, so commits here work whatever the machine's git config says.
  git(input.repoDir, "config", "user.name", "J5 Live Test");
  git(input.repoDir, "config", "user.email", "live-test@example.invalid");
  git(input.repoDir, "config", "commit.gpgsign", "false");
  for (const commit of COMMITS) {
    for (const [relativePath, contents] of Object.entries(commit.files)) {
      const file = NodePath.join(input.repoDir, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, contents, relativePath.endsWith(".sh") ? { mode: 0o755 } : {});
    }
    git(input.repoDir, "add", "--all");
    // Record the executable bit explicitly: where git is configured not to trust
    // file modes it would commit the script as a plain file, and a thread's
    // worktree would then check it out unable to run.
    for (const relativePath of Object.keys(commit.files)) {
      if (relativePath.endsWith(".sh")) {
        git(input.repoDir, "update-index", "--chmod=+x", relativePath);
      }
    }
    git(input.repoDir, "commit", "--message", commit.message);
  }

  NodeFS.mkdirSync(input.originDir, { recursive: true });
  git(input.originDir, "init", "--bare", "--initial-branch", "main");
  git(input.repoDir, "remote", "add", "origin", input.originDir);
  git(input.repoDir, "push", "--set-upstream", "origin", "main");
}

// Run directly, it makes just the repository, for a home that has no project yet:
//   node liveTestRepo.ts <repo directory> <origin directory>
if (import.meta.main) {
  const [repoDir, originDir] = process.argv.slice(2);
  if (repoDir === undefined || originDir === undefined || process.argv.length !== 4) {
    process.stderr.write("Usage: liveTestRepo.ts <repo directory> <origin directory>\n");
    process.exit(64);
  }
  createLiveTestRepo({ repoDir, originDir });
}
