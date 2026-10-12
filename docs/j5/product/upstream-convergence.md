---
title: "Upstream convergence watchlist"
kind: definition
---

# Upstream convergence watchlist

Where upstream T3 Code is building toward the areas J5 owns. Each entry says what upstream has, where J5 stands, and what would make us adopt upstream's version or change our own. Rewrite this file at every upstream advance (see [Merging upstream](../process/upstream-merge.md)); the line below names the upstream SHA it was last checked against.

Checked against `pingdotgg/t3code` `main` @ `29980a3140`. V2 has merged there (pingdotgg/t3code#2829).

## Agent-to-agent messaging and control

- **Upstream:** the orchestrator MCP toolkit can send into another thread, wait on it, interrupt it and launch threads (`t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_launch`, `create_threads`), answer another thread's pending requests (`t3_pending_request_respond`) and reconfigure it (`t3_thread_configure`). Thread tools reach any thread in the environment, not only the caller's project. Every tool declares who may call it. An agent outside the app can sign in to the MCP server with OAuth and call the tools that don't need a calling thread. Messages sent by agents carry `senderThreadId` and render "Sent by another agent" with a link, and agents link threads to the person as `t3-thread://v1/<id>`. `request_secret` blocks a turn until the person enters a secret privately.
- **J5:** a ledger for each project, addressable participants, Exchanges (asks and replies), Inbox and delivery receipts. J5 follows upstream's access model, its environment-wide reach and its outside-agent sign-in ([divergence D2](upstream.md)). It still hides upstream's send, wait, interrupt, launch and queue-mutation tools; the exact list is pinned by the registration test. An outside agent has no ledger identity yet (#498), so it can use upstream's tools and none of J5's messaging.
- **Watch for:** reply or ask semantics, an inbox, or delivery guarantees upstream. An outside client that can _receive_ messages would be upstream's version of the Inbox. Any of those is the signal to rethink the J5 verbs as a layer on top of upstream's.

## Launch, workspaces and parallel agents

- **Upstream:** workspace-aware launches (new worktree, existing worktree, project root), configurable branch names with a prefix setting, tracked worktree setup and clone progress. A "No project" (Scratch) project exists in each environment for threads started without one; it is hidden when the server's state lives inside a checkout, which includes every J5 dev worktree. Multi-model send starts the same first message on several models, each in its own worktree. There's no coordination between them: it's for comparing outputs.
- **J5:** `j5_spawn_agent` and Crews create Peer Agents with briefs, in the caller's project. Every Peer Agent and seat names its workspace: the caller's checkout, an existing worktree, or a new worktree prepared through upstream's ThreadLaunch on a thread J5 has already created and placed (#274). J5 still doesn't expose `t3_thread_launch` or `create_threads`. Multi-model send is refused from a saved-agent draft, because a saved agent locks its model. J5 accepts upstream's "No project" project as shipped.
- **Watch for:** grouping or coordination of fanned-out threads, which would come close to Crews.

## Lineage, subagents and fleet views

- **Upstream:** a thread-details panel with a Lineage section, lineage hover cards, one collapsible subagent card per turn, and subagent history in workspace cards. Stop is now a command of its own (`thread.stop`): it interrupts the turn, holds the queue, ends pull-request watches and stops the thread's delegated children. Lineage has a Stop control, and `task_cancel` stops a child the same way. A beta "Working" shelf in the sidebar groups active threads; upstream's copy calls the active section "the inbox", which is not J5's Inbox.
- **J5:** placement and provenance, the Fleet page, sidebar spawned-children and Crew chips, persona identity on lineage and subagent rows. `j5_stop_agent` and Crew stop send upstream's `thread.stop`.
- **Watch for:** cross-thread grouping beyond native subagents, or an attention queue across threads. Either would mean upstream is approaching the placement tree, the Fleet page or the Inbox.

## Handoffs and history transfer

Two different things share the word "handoff". J5 docs call upstream's history transfer a **context handoff** and J5's persona document a **handoff artifact**.

- **Upstream:** context handoffs (upstream's "portable handoffs") move a budgeted slice of history (`ContextHandoffBudget`) into a new provider conversation when a thread switches model or provider, is forked, or restarts portably. A failed native resume still falls back to a fresh conversation without telling the person.
- **J5:** persona handoff artifacts under `handoffs/` in project artifacts, with a nudge worker and a composer chip. The native-resume patch refuses a silent context handoff except when the conversation is gone ([divergence D6](upstream.md)). The future of handoff artifacts is tracked in [#284](https://github.com/Jacksondr5/j5code/issues/284).
- **Watch for:** upstream starting fresh only when the provider reports the conversation gone, and telling the person. That retires D6.

## Steering and queues

- **Upstream:** a queue-or-steer follow-up setting, a shared composer dispatch, editing, reordering and promoting queued messages, and held queues after a restart. Stop and a provider failure now hold the queue too. Scheduled tasks bound to a thread queue instead of steering. A delegated task's completion steers its parent only when the session says steering doesn't interrupt tools (`activeSteeringInterruptsTools`).
- **J5:** follows upstream's steering and queues. Agent-to-agent deliveries still queue behind a running turn, with the GPT 6 exception ([divergence D4](upstream.md)). A delivery to a thread whose queue is held waits for a resume (#272). The remaining UX gaps are in the give-back backlog (#276).
- **Watch for:** `activeSteeringInterruptsTools` is upstream's first admission that a steer can be harmful. If upstream stops steering where it would abort or restart a turn, D4 can go.

## Long-running autonomy

- **Upstream:** Limited state for usage limits, snoozing until the reset, opt-in auto-resume, scheduled tasks across environments on a shared Scheduler, and startup failures that retry and then fail visibly. New since the last check: pull-request watches that wake a thread on checks, reviews or conflicts (`watch_pull_request`); webhook-triggered schedules, held by the relay while the server is offline; an agent settling its own thread at the end of its turn; an auto-settle opt-out for a thread; and a project script that runs when a thread settles.
- **J5:** follows all of it. The committed-Stop patch is removed. A Crew seat may settle itself, and a Captain's settle carries its seats ([divergence D14](upstream.md)). A message from another agent holds a merged thread open, as a person's does ([divergence D30](upstream.md)). J5 keeps a queued-run watchdog; retire it if upstream's visible startup failures leave it with nothing to report.
- **Watch for:** upstream closing the race between Stop and an in-flight steer (pingdotgg/t3code#15013), which J5 no longer guards.

## Providers as packages

- **Upstream:** provider-facing code is moving into packages: `provider-core` holds the adapter contract, failure handling and the standing instructions, and Pi and Muse Code are packages of their own. Muse Code is a new provider, off by default.
- **J5:** J5's persona instructions, Crew-seat flag and native-resume fields are edits to `provider-core`, and J5's standing instructions live in a J5 folder inside it, behind the constant upstream exports ([divergence D1](upstream.md)). Muse Code is taken as an ordinary provider with no J5 work.
- **Watch for:** a way to supply instructions or runtime policy to a provider without editing a package or an adapter. That would let J5's package edits go.

## Skills

- **Upstream:** each provider snapshot reports the skills its CLI already has installed (`ServerProviderSkill`), and the composer's slash menu lists them. There is no catalog, install, or cross-provider linking.
- **J5:** Settings → Skills installs catalog groups from a configured Git or folder source into Codex and Claude homes, inspects each provider's skills, and links standalone skills across providers.
- **Watch for:** upstream installing or managing skills itself. That would make J5's catalog a source feeding upstream's mechanism rather than a parallel one.

## Playbooks and automations

- **Upstream:** scheduled tasks (Settings → Automations) start or continue threads on an interval, at a fixed time, or from a webhook, through the shared Scheduler. Muse Code brings its own workflow items into the timeline.
- **J5:** Playbooks are step tracking for agent-led work: a workspace library of definitions, persisted runs that agents advance through MCP tools, progress and run history on web and mobile. They carry no scheduling, git, or worktree behavior of their own.
- **Watch for:** upstream workflows or multi-step automations with durable progress, which would overlap Playbooks. Upstream has none yet.

## Give-back

Fixes J5 carries that belong upstream are tracked in #276. V2 has merged upstream, so they can be offered once the maintainer gives the go-ahead.

## History

- 2026-09-23 — started as a research watchlist, rewritten at every upstream advance ([Merging upstream](../process/upstream-merge.md)).
- 2026-09-29 — moved from `research/` to `product/`: it is kept current at every advance, so it is a maintained document rather than a dated study (Jackson, [#354](https://github.com/Jacksondr5/j5code/pull/354)).
- 2026-10-08 — rewritten against upstream `main` after V2 merged: outside-agent sign-in, environment-wide thread tools, upstream's Stop, pull-request watches, webhook schedules and provider packages added.
- 2026-10-12 — divergence D4's exception named as GPT 6, not Astra alone (Jackson, [#569](https://github.com/Jacksondr5/j5code/pull/569)).
