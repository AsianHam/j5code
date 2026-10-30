# J5 Code

J5 Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code), a minimal GUI for coding agents. T3 Code's Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients. J5 builds on that base to run a **fleet**: many agents working at once, coordinating with each other, and reaching the person only when they need to.

## Know which zone you are in

Every change lands in one of three zones. Work out which one before you start, because the rules differ.

1. **J5's domain.** The features listed in the [J5 overview](docs/j5/product/overview.md) and the code under `apps/*/src/j5` and `packages/*/src/j5`. Build freely here, under the [J5 principles](docs/j5/product/principles.md) and the feature definitions in `docs/j5/product/`.
2. **Where J5 touches upstream's code.** J5 code has to be reached from, or placed inside, a file upstream owns. Put J5 code in J5-owned files, keep the edit to the upstream file as small as possible, and record it in [`FORK.md`](FORK.md) in the same PR.
3. **Upstream's product.** Anything not in J5's domain is upstream's: provider adapters, orchestration, the sidebar, settings, the composer, persistence, and everything else T3 Code does. Changing, overriding, or extending **what upstream's product does** is not your call. Bring the human:
   - what upstream does today;
   - what the change would do instead;
   - the trade-offs, including the fork cost (every upstream edit is carried through every upstream sync);
   - the alternatives, starting with "follow upstream" and "not supported here".

   The human may approve it. When they do, the decision is recorded in the [register of divergences](docs/j5/product/upstream.md), not just in FORK.md.

## What we can never compromise on

These are upstream's values, and J5 keeps them.

- **Open at the core.** J5 exists because T3 Code is open: it shares its code, its roadmap, and how it thinks, and welcomes forks. J5 works the same way. We share our code and our reasoning in the open, and offer fixes that belong upstream back to it.
- **Performance without compromise.** Audit for regressions: too much data over websockets, CSS animations spiking the GPU, lists that are hard to render.
- **Remote ready.** The server's websocket layer lets clients connect over the local network, Tailscale, or a tunnel. New features must work in every connection mode.
- **Multi-surface.** Web (hosted, and served locally by the server), desktop (Electron, which bundles the server and can host remote clients), and mobile (React Native, connecting to any server).

## A note from Theo, T3 Code's creator

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

## How J5 applies it

- **Error out instead of building machinery for rare cases.** Guards, retries, reconciliation sweeps, and extra states for edge cases that are rare or nearly impossible cost more than they return. Fail visibly and let the person fix it.
- **Prefer giving the person and agents a tool to repair a problem** over making the platform recover on its own.
- **Follow upstream** for shared concepts: its names, its semantics (settle, archive, runtime modes), and its UI conventions. Measure an upstream surface before inventing a style.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most J5 Code contributions will come from J5 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the J5 Code instance that the contributor is using.

## A small glossary

- **you** means the agent reading this file and changing J5 Code.
- **we, us, and maintainers** mean the people building J5 Code. These are who you are talking to now.
- **upstream** means T3 Code (`pingdotgg/t3code`) and the people who build it.
- **user** means the person using J5 Code to direct coding agents.
- **agent** means the coding agent a user runs inside J5 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness J5 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **J5 home** means the base data directory, `~/.j5code` (`J5CODE_HOME`). Runtime state normally lives below its `userdata` directory.

J5's own product vocabulary (Crew, Captain, Exchange, and so on) is in the [J5 glossary](docs/j5/product/glossary.md).

## The four ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.j5code/userdata` is the developer's real J5 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Inheriting the live server's port.** An agent running inside J5 Code usually inherits `T3CODE_PORT`, `T3CODE_HOST`, and `J5CODE_HOME` from the live server. The dev runner's `--port` falls back to `T3CODE_PORT`, so your dev server would take the live one's port. (`J5CODE_HOME` only matters outside a worktree, since a worktree's `.j5code` outranks it.) Start dev servers with those variables unset: `env -u T3CODE_PORT -u T3CODE_HOST -u J5CODE_HOME vp run dev`.
4. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`.
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here". For J5 features, Codex, Claude, and Cursor are the priority: support and test them first, and the rest are a lower priority. Priority isn't parity: where an adapter can't support a feature without changing upstream's adapter (zone 3), record "not supported here" for it.
- **Agents.** A capability a person can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- Setup runs in the background. While `.t3/setup-running` names a live PID, wait for it and do not run `vp i`. It ends with `.t3/setup-done` or `.t3/setup-failed` (with the error tail). With no marker at all, setup never ran here, so run `vp i` yourself.
- `vp run dev` starts server and web (with the variables from rule 3 unset). In a worktree, state defaults to that worktree's gitignored `.j5code`, which deliberately outranks an ambient `J5CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift. Confirm its `baseDir=` points inside your worktree.
- Sharing over the tailnet is three steps: run `env -u T3CODE_PORT -u T3CODE_HOST -u J5CODE_HOME vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair --person "<owner name>"`. It carries the same permissions as the startup URL, Connections settings included.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- A dev server sends no usage events by default. To check analytics, start it with `T3CODE_TELEMETRY_ENABLED=true` and `J5CODE_TELEMETRY_TAG=<a unique label>`, then filter on the `telemetryTag` property in the "J5 Code Dev" PostHog project. An opted-in dev server sends there, not to the real project; a `T3CODE_POSTHOG_KEY` in your shell or `.env` overrides that, so leave it unset.
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Test data

For a live test, run `node scripts/j5/setup-agent-live-test.ts` and follow its output (see Verifying). It builds a test home and a test repository in your worktree's `.j5code`, with nothing real in reach.

A copy of real data is for a server the developer will use, or for rehearsing a migration. Take no agent turns on one: its threads point at the real checkouts and resume the real provider sessions.

- A new worktree's first `vp run dev` starts on an empty database. Upstream seeds it from the live install; J5 turns that off, so real data only enters a worktree when you ask for it.
- `vp run migrate-dev-db` from a worktree makes a copy that is safe to start a server on, in one command: recent stopped threads only, with pending work, schedules, peer servers and their credentials, undelivered agent messages and live Crews stood down. Its threads still point at the real checkouts, so a message you send to one runs a real agent there.
- For a whole database, copy it yourself. Nothing in a raw copy is stood down: a server started on it resumes real deliveries and polls real peers.
- Copy from `~/.j5code/userdata` (the developer's real data, the most realistic test set) or `~/.j5code/dev`. Worktree state lives at `<worktree>/.j5code/userdata`.
- The server reads `statev2.sqlite`. A home that has not yet run a V2 server has only `state.sqlite`; once it has, `state.sqlite` is a frozen pre-V2 copy, so take `statev2.sqlite`.
- Snapshot a raw copy with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .j5code/userdata
  rm -f .j5code/userdata/statev2.sqlite*  # VACUUM INTO refuses to overwrite
  node -e "
  const live = require('node:path').join(require('node:os').homedir(), '.j5code/userdata');
  const name = require('node:fs').existsSync(live + '/statev2.sqlite') ? 'statev2.sqlite' : 'state.sqlite';
  new (require('node:sqlite').DatabaseSync)(live + '/' + name, { readOnly: true }).exec(\"VACUUM INTO '.j5code/userdata/statev2.sqlite'\");
  "
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets`, `settings.json`, and `environment-id` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. While you iterate, run `vp test run <files>` for the tests you touched; for big files, add `-t "<name>"`.
- Before you push, run `vp run check:changed origin/j5/main`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and tests beside changes. Pass J5's trunk: without it the script compares against `origin/main`, which the fork does not have.
- Use `vp run typecheck` in the package you changed, not `npx tsc`; it caches per package. Both run tsc-rs (`typescript` is the `@tsc-rs/typescript` drop-in).
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `j5/main` for that reason, in the module's existing test file), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless asked. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced, and side effects run after the command commits. Wait on typed receipts, drain the effect worker (`OrchestrationEffectWorkerV2.drain`), or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.
- When you are asked or authorized to live-test, the `j5-live-test` skill sets up a safe server and says what to cover and how to report.

For authorized mobile verification, a missing or outdated native client is an install step, not a blocker. Run `vp run mobile:install <ios|android> [device-id]` on the device host before starting Metro; it targets the only booted simulator or connected Android device when the id is omitted. It installs the dev client for this checkout's native fingerprint from the shared cache in seconds and builds only when no machine has built it yet, so prefer it over `expo run:*`, `xcodebuild`, or `gradlew`, which rebuild from scratch. Its stdout is one JSON line; build output goes to the log it names. See `test-t3-mobile` for the full workflow.

## Evals

`evals/` checks how real models behave with upstream's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before you change that text, read [evals/README.md](evals/README.md) and run the evals it names. When you fix a model behavior bug, add a case that fails before the fix. Evals call paid models, so ask the developer before running one.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- PRs target `j5/main` on `Jacksondr5/j5code`. `gh` resolves bare issue and PR numbers to upstream, so always pass `-R Jacksondr5/j5code`.
- Fill in the [PR template](.github/pull_request_template.md) and tick its checklist honestly. An unticked box with a reason is fine; a ticked box that isn't true is not.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One concern per PR. If the description says "also", split it.
- When babysitting: call `watch_pull_request` and end your turn. J5 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- **J5's docs live under `docs/j5/`.** [How the J5 docs are organized](docs/j5/process/docs.md) says what goes where. Feature definitions in `docs/j5/product/` are rewritten, never appended to.
- **User docs** help users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Keep them in the shipped product's voice, without implementation details or contributor tooling. J5's go in `docs/j5/user/`; `docs/user/` is upstream's.
- **Upstream's docs** (`docs/user/`, `docs/internals/`, `docs/operations/`) are upstream's. J5 doesn't add files there or edit its internal docs; J5's own go under `docs/j5/`.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation.
- A local reason the code can't show goes in a short nearby code comment. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active work in the GitHub issue that owns it, on `Jacksondr5/j5code`.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

J5 adds its own layer on top: a communication ledger for each project, with its own migrations, agent-to-agent delivery, and an MCP toolkit that agents call. The [J5 overview](docs/j5/product/overview.md) maps it.

Upstream's architecture and its constraints: `docs/internals/overview.md`. Upstream's glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself. J5's server code is `apps/server/src/j5`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site. J5's UI is under each app's `src/j5`.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic. J5 contracts are `packages/contracts/src/j5`.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency. If it is missing (sparse checkout), read a file with `git show origin/j5/main:.repos/<path>`.
- `FORK.md` - every place J5 edits an upstream-owned file, and the runbook for advancing to a new upstream version.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations. See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction. Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby. Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and options, and pass combinators as additional function-builder arguments. `t3code/prefer-effect-fn` enforces it.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `t3code/no-low-value-comments` enforces the length cap and the mechanical cases.
- React effects are for synchronizing with something outside React. Derive in render and act in handlers instead of syncing state, but don't hide real lifecycle work in refs or stores to dodge one. The `t3code/react-effect-budget` lint rule holds each file to its count in `scripts/effect-budget.json`; a new effect states its reason with `// oxlint-disable-next-line t3code/react-effect-budget -- <why>`.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
