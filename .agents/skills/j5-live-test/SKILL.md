---
name: j5-live-test
description: Live-test a J5 Code change on a real server with real agents. Use when unit tests cannot prove the change, such as UI flows, agent turns, agent-to-agent messages, Crews, Playbooks, peering, first run, or PR screenshots and videos. Covers asking for a test and running one. Sets up a safe test server with one script, then hands the browser steps to test-t3-app.
---

# Live-test J5 Code

Two roles use this skill. If you built the change, read "Ask for a test". If
you were asked to test, read "Run a test". Both need "What to cover".

## Ask for a test

Commit first. Spawn a Peer Agent (`j5_spawn_agent`) in its own worktree,
started from that commit, and keep working while it tests. Tell it:

- the commit, and what changed;
- what to test;
- which rows of "What to cover" apply;
- to follow this skill.

Do not restate this skill's rules in the brief: the tester reads them here,
and a copied rule outlives the fix to it. A plan too large for one tester's
context goes to several testers at once, each with its own part.

You may send it corrections while it runs, such as a fix to the test method.
It records them in its report.

Its report comes back as a short message naming an artifact. Put the verdict,
what was not exercised live, and what the person must test by hand in the PR's
"Live testing" section. A row the report calls partial stays partial there.

Record each testing decision there too, with its reason: which rows you
judged did not apply, and what you re-tested or did not after a later change.
A small re-test you run yourself is fine; say it was yours.

File each bug the test finds outside your change as an issue, after checking
that the base has it too.

Put the report's videos in the PR description beside the screenshots. Once
the description is saved, check each plays for a signed-out viewer: this must
print `200 video/mp4`.

```bash
curl -sL -o /dev/null -w '%{http_code} %{content_type}\n' "<url>"
```

More than one tester can run at once. Each has its own server, and they share
one browser, so one tester's timed-out call can cost another a single failed
call.

### When the code changes after the test

A test covers one commit. Before merging, re-test live whatever has changed
since on a path your change exercises, once, at the head that will merge. Unit
tests and CI do not show what an agent or a person sees, and nobody else's test
covers a path only your change uses. Text an agent reads, such as a tool
description, counts. If nothing an agent or a person sees has changed, do not
re-test. Either way, name the tested commit and the head in the PR. In a stack
tested as a whole, each layer names the run that covers its head.

## Run a test

### Set up

From your worktree, run:

```bash
node scripts/j5/setup-agent-live-test.ts
```

Follow what it prints. It builds a test home and a small test repository under
your worktree's ignored `.j5code/live-test`, starts the server, and prints the
ports, the pairing URL, the project to use, and its commands. Nothing in that
home points at a real repository or at the developer's data. Then use
[test-t3-app](../test-t3-app/SKILL.md) for the browser steps.

Each tab you open has its own storage, so it is one signed-in person and
nothing else can sign it out. Do not pass a `profileId`, except for "PR
videos": every tab that names a profile shares that profile's cookies, across
all agents on the server.

Do not seed a test home by hand, copy the live database, or start `vp run dev`
yourself for a test. The script does not install dependencies: if it says they
are missing, install them and run it again.

| Command   | What it does                                                          |
| --------- | --------------------------------------------------------------------- |
| `status`  | Says `RUNNING`, `NOT SERVING`, or `STOPPED`, with a fresh pairing URL |
| `restart` | Stops, then starts on the same home                                   |
| `stop`    | Stops the server. Run it when you finish                              |
| `rebuild` | Stops, discards the test home, builds a new one, and starts it        |

`guest` adds someone to the running test server and prints a pairing URL:

- `guest "<name>"` makes a link for another device of someone already on the
  server. For a name nobody has, it adds that person as a Viewer on the test
  project. A `--fresh` home has no test project, so give a scope there.
- `guest "<name>" --server | --project <id> | --thread <id>` adds a new person
  at that scope, with `--level viewer|collaborator|owner`. Owner is given only
  with `--server`.
- `guest --unknown` makes a link for a device the server does not know. On
  first open, the device is asked who it belongs to.

The output says which one it made. Open each URL in a new tab
(`reuseExistingTab: false`). Each tab is its own person, so open one per person
and never pair a second person in a tab that already has one.

Reach these states with `guest`, not by editing the test database.

A start returns within about two minutes. On a busy machine it can return
before it has finished, and prints the command that finishes it.

The server takes the script's environment when it starts. To give a running
server a new variable, set it on `restart`.

To see what a client asked the server for, read the log the script names and
`server.trace.ndjson` under the test home's `userdata/logs`. The trace is
sampled, so it shows that a request happened but cannot show that one did not.

Live turns also leave provider session files in `~/.claude` and `~/.codex`,
and Browser panel screenshots are saved by the server you are running in.

### Other setups

A worktree holds one setup at a time. Pass a flag to the first start, or to
`rebuild` to switch.

| If you need                                     | Add                                  |
| ----------------------------------------------- | ------------------------------------ |
| An empty home, so the first-run wizard shows    | `--fresh`                            |
| Two peered servers, named Local and Remote      | `--peer`                             |
| The same, with Remote polling Local             | `--peer --poll`                      |
| A base and a head server for before/after shots | `--base <ref>`                       |
| The head build opening a home Base wrote        | `upgrade`, in a `--base <ref>` build |

- **After any `rebuild`**, a tab that was open before it can stay on the
  pairing form. Press "Reload app" there.
- **`--fresh`.** The home has no project and no pinned model. After pairing, wait
  for the wizard's heading, "Set up J5 Code", since there is no composer yet.
  Its import step pre-selects projects it found on this machine, real ones
  among them: add only the test repository the script names, or choose "Do
  not import projects". Pick your model by hand.
- **`--peer`.** Pair the browser with Local, then open the "Add to the
  browser" link the script prints to add Remote. After a `rebuild`, remove the
  old Remote from Settings > Connections first: the browser keeps its own list.
- **`--base <ref>`.** See "PR screenshots".
- **`upgrade`.** To test a change that acts on old state, make that state on
  Base, in its tab or with the base checkout's own `guest`
  (`node .j5code/live-test/base/scripts/j5/setup-agent-live-test.ts guest "<name>"`),
  then run `upgrade`. Do not write the state into a test database by hand.
  Base's tabs stay signed in: reload them. Run `upgrade` again to start over
  from the same old state; before reloading a tab then, clear its cached state
  with `preview_evaluate`: `indexedDB.deleteDatabase("t3code:connection-runtime")`.
  After `upgrade`, `guest` adds people to the upgraded server; do not run the
  base checkout's own script.

### Live turns

- Send live turns only in new threads in the test project. The threads the
  script made are for looking at.
- Use only the models the person has authorized for live test turns. If none
  are, ask the person for one before you start: a test without a real turn
  misses the change's own flow, so lacking a model does not make those rows
  not applicable. The test home defaults new threads to Claude Haiku, a cheap
  one.
- Take live turns in "Current checkout" mode. In a Crew roster that choice is
  "Captain's checkout". A first turn in "New worktree" mode can be interrupted
  or hang.
- After editing a Crew roster, check each seat's model again before approving:
  an edit can change it.
- Write to a test agent the way a person would: say what you want done and
  what you want to see. Do not stack guards such as "do nothing else" or "do
  not message anyone". An agent that wanders is a finding, not something to
  fence off.
- Keep messaging words for messaging. "Reply" means responding to an A2A
  message. To see something in an agent's own thread, ask it to "say X in your
  thread". To prove a message was delivered, ask its receiver to write a file.
- A test agent on Claude can still reach real Claude sessions on this machine
  through its own harness tools (`ListAgents`, `SendMessage`). Tell a test
  agent to use J5's tools when it messages other agents, and check which tool
  it called.
- An agent's own account of what it did is not evidence. Check the tool
  result, the stored row, or the screen.
- To hold a turn open, ask the agent to run `./scripts/hold.sh` in the test
  repository, in the foreground. It blocks until you create `.hold-release` in
  the test repository's root, deletes that file, and exits. It gives up after
  nine minutes.
- The thread "Question waiting for an answer" can be answered once; `rebuild`
  brings it back. The image in "Message with an image" is display only.
- A pending approval or a question from Claude does not survive a restart, so
  make one live: set a new thread's access to "Supervised" and ask for a file
  edit, or ask the agent to ask you a question with two options.

### Restarts

Restart only at rest, or during a held turn. Do not try to catch the server in
a narrow window, such as mid-migration. A bug that needs one gets a
deterministic test.

A turn a restart interrupts carries on by itself: after `restart`, the server
sends it "Continue where you left off."

### Report

Save the report with `j5_write_artifact` at
`test-reports/<branch>/<commit>.md`, one report for each commit you test, then
send whoever asked for the test a short message with the verdict and that path.
Put the verdict first. Quote an agent's words only where they are the
evidence; a full transcript goes in an appendix, and only when asked for.

1. Verdict: pass, fail, or blocked, with the commit and the script flags.
2. Not exercised live: each gap, why, and whether it needs the person.
3. For the person to test by hand: exact steps. Leave out when empty.
4. What ran: each row of "What to cover" as run, partial with what was
   missed, or not applicable with a reason. Say how each was verified: live,
   by test, or from code.
5. Bugs found, each with steps to reproduce.
6. Rig problems: anything in the test setup that got in the way.
7. Videos: each URL with a one-line caption. Leave out when empty.

A claim without one of those three labels counts as not verified.

## What to cover

Always: the change's own flow, including the way back out, and one real turn
sent through the UI.

| When the change touches                        | Also run                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The turn path, provider adapters, or MCP tools | One turn each on Codex and Claude                                                                                                                                                            |
| Stored state, deliveries, or recovery          | `restart` at rest, then use the state                                                                                                                                                        |
| Interrupted runs                               | `restart` during a held turn                                                                                                                                                                 |
| Migrations                                     | `upgrade` from the PR's base, and a `--fresh` run. When a migration converts existing rows, also run it on a copy of real data with `vp run migrate-dev-db`, and check the rows it converted |
| Startup, onboarding, or settings defaults      | A `--fresh` run                                                                                                                                                                              |
| Anything an agent is meant to use              | Ask a real agent in plain words, without naming the tool                                                                                                                                     |
| Peering or cross-server messages               | A `--peer` run                                                                                                                                                                               |

## PR screenshots

Use `--base <ref>` so base and head show the same data. The ref is the PR's
own base, which for a stacked PR is the layer beneath it. Fetch, then name the
remote branch, such as `origin/j5/main`: a local branch can be behind. Open
each server in its own tab. Capture at 1280x800 as test-t3-app describes,
then upload:

```bash
node scripts/j5/pr-evidence.ts <pr> --pair "<caption>" <before.png> <after.png>
```

Repeat `--pair` for each state. For a state the change adds, use
`--new "<caption>" <after.png>`. It prints the before/after table for the PR
description. Run `rebuild` with no flag when you are done, which removes the
base checkout. It refuses if you edited a file there, so do not.

## PR videos

Motion, timing, or an interaction sequence needs a video. Record base and head
with the same steps, each on its own server as for screenshots.

1. Resize the tab to 1280x800, call `preview_recording_start`, do the steps,
   then call `preview_recording_stop`. It returns an MP4 in the server's data
   directory. Copy it out under a name that says what it shows: GitHub shows
   the name above the player.
2. Open the PR in a new tab with `preview_open`, passing the "GitHub Video
   Upload" profile from `preview_status` as `profileId`. If there is no PR
   yet, open its tracking issue. That profile is signed in to the developer's
   GitHub account: open nothing else under it.
3. Call `preview_upload` with `locator: "#fc-new_comment_field"` and the MP4's
   path. GitHub uploads it and writes a
   `https://github.com/user-attachments/assets/<id>` URL into the comment
   box. `preview_wait_for` cannot see text in that box, so read
   `document.getElementById("new_comment_field").value` with
   `preview_evaluate` until the URL is there.
4. Empty the box (set its value to `""` and dispatch an `input` event), never
   submit it, and close the tab.
5. Check GitHub renders the URL as a player. This must print `<video`:

   ```bash
   printf '%s' "<url>" | jq -Rs '{text: ., mode: "gfm", context: "Jacksondr5/j5code"}' \
     | gh api markdown --input - | grep -o '<video'
   ```

   This checks rendering only. The URL refuses signed-out requests until a
   posted PR or comment contains it, so whoever opens the PR checks playback
   (see "Ask for a test"). `curl -sI` gets a 403 even then; use a GET.

6. Put each URL in the report with its caption. In the PR description, each
   URL goes on a line of its own, which GitHub renders as a player.

If the profile is missing, or GitHub shows it signed out, stop and ask the
developer to sign in to it. Never sign in yourself.

## A server for the developer

`--for-dev` starts a server on a copy of the developer's data and shares it
with them. It is only for sharing with the developer: do not test on it, take
no turns on it, and never publish a screenshot from it. Its threads belong to
real checkouts and real provider sessions.

## What this cannot test

Say so in the report instead of implying coverage:

- the desktop app: Electron, the packaged build, the updater, installers;
- relay and tunnel connections, a second machine, an unreachable peer;
- continuing one of the threads the script made;
- a person added to the Remote server of a peer build;
- threads without a project: a test home inside a checkout does not offer them;
- behavior under the developer's real data volume;
- providers other than Codex and Claude on this host.
