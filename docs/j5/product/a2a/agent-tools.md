---
title: "The agent tool surface — verb contracts"
kind: definition
---

# The agent tool surface

## Problem

An agent learns what it can do from its tools, and it reads a tool's description in the middle of its work, once, under pressure. If the description is written by whoever happens to implement the tool, the agent-facing product is decided by accident. This definition states each verb on the J5 agent surface — what it does, what it takes, what it returns, how it fails — and the description string is part of the contract, because the description _is_ the agent's experience of the product. [The substrate definition](substrate.md) decides which verbs exist; this one decides what each verb is.

## Definition

### Conventions for every verb

- **Naming**: snake_case verbs and parameters. Every tool J5 owns carries a `j5_` prefix, so none can be mistaken for a tool the harness ships itself (Claude Code has its own `SendMessage`). Upstream's tools keep upstream's names, including the ones J5 re-declares with its own description. A name without the prefix is not a tool: calling one returns the server's unknown-tool error. Threads recorded before the prefix still render, because the timeline reads both names.
- **Idempotency**: every mutating verb accepts an optional `client_request_id`. When supplied, retrying the same logical call replays the original result instead of acting twice; when omitted, each call is a fresh command. Every mutating verb's description carries its own one-clause reminder to reuse the id, because the description is the only text an agent reliably reads at call time.
- **Errors — the toolsmith rule**: a failure returns a code and a message, and the message names the _actual state_ and the _next command_, so a caller never has to discover state by failing twice.
- **Events**: every mutation commits its ledger and placement events in the same transaction as its state change; the call returns after that commit, and delivery and other side effects continue asynchronously.
- **Descriptions** are written for the agent reading them mid-turn: trigger first, distinct uses named, positive instruction over negation, and no more than the agent needs to act.

### `j5_send_message`

**Description:** "Send one durable message. To another agent, three uses: a **plain send** when you don't need a reply; an **ask** — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a **reply** — include the exchange_id from the ask you are answering, which closes that exchange. To the human, only an ask: a plain send to a person is refused — if nobody needs to act, say it in your own thread instead. Set urgency only when asking the human. Use this tool only for participants already returned by j5_list_participants; when creating a Peer Agent, put any reply expectation in j5_spawn_agent's brief instead of sending a follow-up ask. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. An agent that is busy usually handles each message as its own turn after its current one ends, so put related updates in one message rather than sending them one by one; the result's deliveryNotice says when your message will wait behind the receiver's current turn. To interrupt an agent that is busy, set mode: mode=steer puts your message into the turn it is running now, and mode=restart stops that turn and starts it again on your message. Without mode the message is delivered the ordinary way, whatever its text or its intent says: most agents take it after their current turn ends, and Codex GPT 6 agents take it into the turn they are running. intent only labels an ask. Leave mode out for updates and replies. A steer can cancel the tool calls the receiver has in flight, so keep it for a correction the receiver must see now, not for an update. An idle receiver starts a turn on your message whichever mode you set. Attach files for an agent on this server with attachments: pending uploads from t3_attachment_prepare_upload, or files its thread already holds. A provider Subagent is not a participant and is refused. Reuse client_request_id to retry the same send safely."

| Input               | Type              | Required                             | Meaning                                                                         |
| ------------------- | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `to`                | ParticipantId     | yes                                  | A recipient listed by `j5_list_participants`; a person accepts only an ask      |
| `message`           | string, non-empty | yes                                  | The body; the envelope adds sender identity, project and a remote server        |
| `expect_reply`      | boolean           | no                                   | Opens an Exchange (or, between agents, joins the open one); requires `intent`   |
| `intent`            | string            | with `expect_reply`                  | One-line summary shown wherever the Exchange is listed                          |
| `urgency`           | Urgency           | when opening an Exchange to a person | How soon the answer is needed                                                   |
| `regarding`         | ExchangeId        | no                                   | Follow up on an open Exchange you opened with this person; the message joins it |
| `exchange_id`       | ExchangeId        | no                                   | Marks this send as the reply that closes that Exchange                          |
| `client_request_id` | string            | no                                   | Reuse to retry safely                                                           |
| `mode`              | SendMode          | no                                   | `queue` (the default), `steer` or `restart`: how it lands on a mid-turn agent   |
| `attachments`       | attachment list   | no                                   | One to eight files for an agent on this server                                  |

**Landing.** `mode` carries upstream's own words and meanings for a send into a thread. `queue`, the default, is ordinary delivery: the message waits for the receiver's turn to end and runs as a turn of its own, except on a Codex GPT 6 receiver, which takes a peer's message into its running turn without being asked ([divergence D4](../upstream.md)). `steer` joins the receiver's running turn. `restart` interrupts that turn and restarts it with the message. Upstream's fourth choice, `auto`, is not offered: it steers whenever it can, which is the harm [divergence D4](../upstream.md) records. A receiver with no running turn to steer or restart, or one whose provider can do neither, takes the message as any other: an idle agent starts a turn on it and a busy one queues it. `steer` and `restart` are writes to the receiver's thread, so upstream's rule applies and the receiver may not run with broader permission or interaction modes than the sender; an ordinary message has no such check, including one a GPT 6 receiver takes mid-turn. The check runs when the message is sent, and the sender's limit is kept with the message so that upstream checks it again at delivery, in case the receiver's modes were raised in between; a message refused then, or one whose target turn has just ended, is delivered as any other. Both reach an agent on this server only.

**Attachments.** Each is a pending upload from `t3_attachment_prepare_upload`, or an attachment the receiver's thread already holds. They are claimed into the receiver's thread before the message is committed, and released if the send is refused before anything is committed (an unacceptable sender, receiver or request). A storage failure leaves the claims in place, because nobody knows then whether the message was committed. A person and an agent on a peer server take no attachments. This replaces J5's own version of `t3_thread_send_attachments`, which sent a thinner message through the same ledger: no ask or reply, no retry key, no landing choice.

**Result:** the message id and the Exchange's state. When the receiver is an agent that is mid-turn and will not take the message into that turn, the result also carries a `deliveryNotice` stating how many messages are waiting for it, how many of them are the caller's, and that each will run as its own turn. When the recipient lives on a peer server, the result also names that server. When that server is offline, the result says the message is waiting for the recipient and when the server was last available, and its wording names the server: "Recorded. <B> is on Laptop, which is offline, last available 3 h ago; it receives this when Laptop is next available." A recipient on this server adds nothing; one on an online peer server adds only that server's name.

**Rules.** A message to the caller itself is refused. A send to a person that is not an ask is refused; a person never opens an Exchange, so there is nothing for an agent to reply to. Between agents, a further ask to a peer that already holds an open Exchange from the caller joins it as a follow-up. To a person, a further ask opens a new Exchange and a new inbox item unless it names an open one in `regarding`, in which case it joins that Exchange and is shown beneath the original ask. An ask to a person without an urgency is refused.

**Errors**, each naming the actual state and the next command: the caller is not a participant (a provider Subagent or a deleted thread); the recipient is not addressable (pointing at `j5_list_participants`); the recipient is the caller (naming the caller's own id, and `schedule_task` for a future trigger to oneself); an ask without an intent; a send to a person that is not an ask (naming the legal move and the own-thread alternative); an ask to a person without urgency; an `exchange_id` or `regarding` that is unknown, already closed, or not the caller's (naming the Exchange's actual state); a first message to a participant on a peer server whose address book cannot be read, or that has not polled yet (naming that reason).

**Events:** message and Exchange events in the ledger; delivery receipts follow asynchronously.

**Not delivered.** When the recipient's server refuses a message, or the message is cancelled before it was delivered, the sender gets a platform notice saying so, naming the recipient, its server and the reason: "Your message to <B> on Laptop was not delivered: Laptop refused it; the recipient is archived or does not accept messages from this sender." The reason is the platform's own words for each refusal it knows; any other is quoted on one line as what the server said. Removing a peer server cancels everything still waiting for it, with the reason that the server is no longer peered; for a message the server may already hold, the sender is told it may not have been delivered: one a polling server had already picked up, or one sent directly whose answer never came back. A refused ask also ends its Exchange: the same notice says so, the Exchange is dropped as refused rather than as an archive, and the sender owes nothing and should not retry it.

### `j5_list_participants`

**Description:** "Your address book, one project at a time: the project's agents, and the human, with the display name to recognize them by, the participant_id to address them with, the project_id and project_title that place them, and what each accepts (messages, exchanges, urgency). Leave project_id out to list your own project; pass another project's id, from t3_project_list, to list that one. People appear in every listing. Results come a page at a time: your own row first, then the people, then agents with the most recently active first. Narrow a listing with name_contains, or with settled=true or settled=false for settled or active agents. If this server is peered with others, each row also carries `server`: the name of the server the participant lives on, and whether it is this one (`local`), and the result names every server in `servers`; pass a peer server's name as server to list that server's agents instead of this one's. When you're told to message someone by name or role, resolve them here first. Your own row is marked self=true and its project_title is the project you work in; it cannot receive messages or open exchanges from you — use schedule_task if you need a future trigger for yourself. Provider Subagents are not participants: they do not appear here and cannot be messaged. Archived agents are hidden by default; set include_archived=true to see them with archived=true. They cannot receive messages or open Exchanges. The roster changes — after you spawn, archive, unarchive, or delete an agent, call this again instead of reusing a stale listing."

| Input              | Type      | Required | Meaning                                                                  |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------ |
| `project_id`       | ProjectId | no       | The project to list; the caller's own when omitted                       |
| `server`           | string    | no       | A peer server's name, to list its agents; this server when omitted       |
| `name_contains`    | string    | no       | Keep agents and machines whose display name contains this text, any case |
| `settled`          | boolean   | no       | `true` keeps settled agents, `false` active ones; both when omitted      |
| `include_archived` | boolean   | no       | Also list archived agents, each marked `archived`; default off           |
| `cursor`           | integer   | no       | Where the page starts; the previous page's `next_cursor`                 |
| `limit`            | integer   | no       | Rows in the page, 1 to 100; 50 when omitted                              |

Read-only; no events.

**Scope and paging.** A listing covers one project and follows the pattern of upstream's own listing tools (`t3_thread_list`): an offset cursor, a capped limit, optional filters, and pages read from current state, so they can shift between calls. The caller's own row comes first, then the people, then agents with the most recently active first. The caller's row and the people are kept whatever the filters say. The result carries `next_cursor` (null on the last page) and `total`, the number of rows that match. A project that does not exist is refused; `settled` with `server` is refused, because a peer server does not report it.

**Result rows:** `display_name` (the agent's thread title, or the Role name once Roles exist), `project_id` and `project_title` (on the self row, the caller's own project), `participant_id`, the participant kind, `self`, `archived`, `can_receive_message`, `can_open_exchange`, `accepts_urgency`, plus `provenance` (spawned by whom, forked from what, unrecorded, or not applicable for a person) and `placement_parent_id`. A person's row reports that it cannot receive a plain message and can be asked. A machine participant's row carries kind `machine`, its registered name as `display_name`, provenance `not-applicable`, and reports that it can receive nothing and open no Exchange. An archived agent's row, when requested, reports that it can receive nothing. A peer server's agents are listed when `server` names it, with the people; this server's agents are not in that listing. Server names are not unique: a name a peer carries always selects that peer, this server's own name included, and this server's agents are the listing with no name. Once this server has a peer, the result names every server in `servers`, and every row carries `server`: its `name`, `local` (true for this server), and, for a participant on a peer server that polls this one, `available` and, once that server has polled, `last_available_at`. Nothing measures a peer server this one sends to directly, so its rows carry neither; a server with no peers omits the field. A peer that could not be read is reported as unread in the result rather than omitted, and the rows of a peer server that polls are its last snapshot, kept while it is offline. Provenance and placement are carried for callers and the UI; they are not part of the description's pitch.

### `j5_spawn_agent`

**Description (contract):** "Spawn a Peer Agent: a full-citizen teammate with its own top-level
thread, starting on your brief as its first turn. It joins your project, is placed under you, and
records you as its immutable spawner; it is addressable the moment this returns. In your brief, tell
the new agent what it should do first and whether it should reply to you. Choose provider, model,
and reasoning for the work in the brief — see orchestrator_capabilities for what's available. To run
a persona from j5_list_personas, set `persona` to its id: the spawn gets that persona's instructions
and runtime policy, and provider, model, and reasoning must be one of that persona's declared
routes. Choose its workspace every time (see the workspace field). A new worktree is prepared after
this returns, and the agent begins once it is bound, possibly while the project's setup script is
still running; if preparing it fails, the agent's thread shows why, and it is not retried. Reuse
client_request_id to retry the same spawn safely; a retry replays the first spawn, so a different
base_ref or worktree_path needs a fresh client_request_id."

| Input               | Type                                 | Required | Meaning                                           |
| ------------------- | ------------------------------------ | -------- | ------------------------------------------------- |
| `brief`             | string, non-empty                    | yes      | The first-turn prompt the new agent starts with   |
| `title`             | string                               | no       | Thread title; derived from the brief when omitted |
| `persona`           | persona id from `j5_list_personas`   | no       | Persona spawn: the child carries that persona's   |
|                     |                                      |          | immutable assignment (SP3 below)                  |
| `provider`          | id from `orchestrator_capabilities`  | yes      | Chosen per task — no inherit default (Jackson,    |
|                     |                                      |          | 2026-08-29: inheriting is wrong more than right)  |
| `model`             | id from `orchestrator_capabilities`  | yes      | Chosen per task                                   |
| `reasoning`         | option from capabilities descriptors | yes      | Chosen per task                                   |
| `workspace`         | `{type: "shared"}`, `{type:          | yes      | Where the agent works; see Workspace below        |
|                     | "worktree", base_ref, branch?,       |          |                                                   |
|                     | start_from_origin?}`, or `{type:     |          |                                                   |
|                     | "existing_worktree", worktree_path}` |          |                                                   |
| `client_request_id` | string, non-empty                    | no       | Supply and reuse to make retries safe             |

**Rules.** The new agent is an ordinary root-lineage thread created through upstream's creation seam, never through delegation. It is created in the caller's project, so it joins the same ledger as the caller. Placement and provenance are recorded atomically with creation; then the brief starts as the first turn. The new agent's first turn also states its own participant id and project as platform-provided facts, beside the brief and never inside it. Provider, model and reasoning are required and explicit even when a Role is given: a Role's allowlist constrains the choice and an out-of-list pick is an error naming the Role, never a silent default. The brief carries the task and the reply expectation; the spawner does not follow a spawn with a reply-expected `j5_send_message` — that form is for later work owed by an existing participant. Selection guidance and brief-writing conventions live in the [Spawning Guide](../features/spawning-guide.md).

**Workspace.** The spawner chooses where a Peer Agent works every time; there is no default, because the spawner knows whether it is starting a reviewer that must see uncommitted work, a builder that must not collide, or a scout that can't collide at all (Jackson, 2026-10-03). `{type: "shared"}` is the caller's own checkout and branch, and asks nothing of git. `{type: "worktree"}` is a new worktree from `base_ref`, which is required and must resolve to a commit (with `start_from_origin`, its fetched origin copy counts); a `branch` that already exists is refused. `{type: "existing_worktree"}` is one of the project's git worktrees other than its main checkout, named by path; the agent works on the branch git has checked out there, and any other path is refused with the valid ones listed. A choice that needs git is refused when the repository can't be read, before anything is created. A new worktree's thread is created unbound, with its registration and placement committed, so `j5_spawn_agent` returns as soon as the agent is registered and its brief accepted, not once the worktree is ready. Upstream's ThreadLaunch then creates the worktree, names a temporary `j5code/<hash>` branch and renames it from the brief in the background, and holds the brief as a preparing run until the worktree is bound and the project's setup script has started. The setup script is awaited first only when it is set to finish before the agent starts (`async: false`); otherwise the agent may begin while it is still running. If preparation fails, the agent's thread shows the failed preparation, as any upstream launch does; it is not retried or retired, and the spawner is not told. The agent is then unbound, which upstream reads as the project's checkout, so a later message to it runs there, where every Peer Agent worked before workspaces existed. J5 doesn't guard this upstream behaviour: in Jackson's install, 3 of 61 preparations failed, all on the first day, and none was messaged again (Jackson, 2026-10-06). A shared checkout or an existing worktree binds at creation, so its brief starts at once. A `client_request_id` stays bound to the workspace type it was first accepted with: a retry that asks for another type is refused before anything is dispatched, even after a restart, since the type is encoded in the create command's durable receipt. A retry with the same type replays the first spawn, so a different `base_ref` or `worktree_path` has no effect, for an existing worktree too; changing them needs a fresh `client_request_id`. A second start for the same thread while one is in flight is refused with a retry instruction, so two concurrent retries cannot both create it. An existing worktree is looked up in upstream's ref listing, which refreshes every few seconds, so one created moments ago may be refused once; retry in a moment. Closing or archiving a Peer Agent never removes its worktree.

**Result:** the new agent's `participant_id` and `thread_id`, its `project_id` and `project_title`, and its placement under the caller with the caller recorded as spawner.

**Errors**, each naming state and next command: the caller is a provider Subagent; the caller's membership is missing or ambiguous; the caller's project ledger cannot be read; the caller sits in a Crew (naming its Captain as the escalation and `delegate_task` for its own subagents; only a Captain grows a Crew, through the gate); the chosen workspace can't be used (a path that isn't one of the project's worktrees, a `base_ref` that doesn't resolve, a `branch` that exists, an unreadable repository); the `client_request_id` is bound to another workspace type, or a start for it is already in flight; creation failed.

**Events:** participant joined, placement created.

### `j5_stop_agent`

**Persona spawn (built 2026-09-09 as the `agent` input, `persona` since 2026-09-17):** the persona's declared routes are the
allowlist SP3 describes. The explicit provider/model/reasoning pick must equal one route target on
a provider instance that runs that driver and currently advertises the model and reasoning option;
otherwise the call refuses, naming the persona and listing its routes, and nothing is created. The
matching route becomes the child's immutable persona assignment (same snapshot and digest as a
composer launch), and its authority policy sets the child's runtime mode. The child's permissions
come from its own persona's policy, never from the parent's: J5 carries no parent-child
permission ceiling between Peer Agents (Jackson, 2026-09-16), since any such guard is one message
to a trusting peer away from bypass. Disabled, removed, and unknown personas refuse before creation.
A plain spawn without `persona` is unchanged and inherits the parent's runtime mode as before.

**Description:** "Stop one Peer Agent the way a user Stop does: its running turn is interrupted now, turns already queued behind it, messages you sent it included, are held until a person resumes its queue (no tool releases them, and a message sent after the stop runs ahead of them), its pull request watches end, and the tasks it delegated stop too. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. It reaches any agent on this server, in any project. Reuse client_request_id to retry safely."

| Input               | Type          | Required                    |
| ------------------- | ------------- | --------------------------- |
| `participant_id`    | ParticipantId | yes — the one agent to stop |
| `client_request_id` | string        | no                          |

**Result:** exactly one of `interrupt_requested` (the agent has an active run, which is being interrupted) or `already_idle` (the agent has no active run; its queue is still held). A run that is preparing, starting, running or waiting is active. An interrupt acknowledgement and an observed terminal run state are separate facts; the tool never claims a turn stopped merely because interruption was requested. The target is any agent on this server, in any project, archived ones included; an id this server does not know is an error pointing at `j5_list_participants`.

**Rules.** A caller's runtime policy never gates `j5_stop_crew` or `j5_archive_crew`: a read-only persona may run them, because identity (the Captain, its own Crew) and the human's confirmation token are the gates, and the sandbox guards the workspace rather than the platform's verbs (Bryant, 2026-09-14). `j5_stop_agent` follows upstream's rule for a write to another thread: the target may not run with broader permission or interaction modes than the caller, so an agent in a narrower mode asks the target's Captain or the person. A Captain stopping a seat of its own Crew is exempt, as it is for `j5_stop_crew`. This reverses the 2026-09-14 rule for `j5_stop_agent` alone (Jackson, 2026-10-11, [#519](https://github.com/Jacksondr5/j5code/issues/519)). Stop and archive are single-target; the unit cascade belongs to Crews, which stop and archive as units through their own verbs when they exist. Stop is upstream's Stop. Besides interrupting the turn, it holds the turns queued behind it, ends the thread's pull request watches and stops the tasks it delegated, so a message already queued for a stopped agent waits until a person resumes its queue. No agent tool releases it, and a message sent after the stop runs ahead of it. Upstream does not continue a stopped run after a restart.

**Amendment (Jackson, 2026-08-29):** the A6 build cascaded over the placement subtree; that blast
radius makes the tool less useful, so `j5_stop_agent` and thread archive are single-target. The
unit-cascade concept already has its home in the crew rulings (2026-08-21: crews spawn and archive
as units) — `j5_stop_crew`/`j5_archive_crew` arrive with Crews, and the A6 `PlacementCascadeService`
survives as their engine (a cascade of one is its degenerate case).

## `t3_thread_organize` — archive and restore

Use `action: "archive"` with an agent's `threadId`, or omit it to archive the calling thread. Upstream's access check is the only rule: the tool reaches any thread in the environment, within the limits upstream sets for the caller. The tool archives one thread, hides it from the active directory, and closes its open Exchanges through the shared lifecycle reactor. It does not interrupt an existing run. Use `j5_stop_agent` when work must stop.

Use `action: "unarchive"` to restore the same identity. Old Exchanges remain closed and cancelled messages do not replay. Historical permanently retired agents remain retired. The human UI retains its archive warning; this tool uses upstream archive semantics without a separate confirmation-token flow. `archive_agent` has been retired.

**Errors:** upstream's own checks apply: the thread is unknown, or is not in the caller's project. J5 adds one refusal: the target is an active Crew seat, which is retired with its Crew through `j5_archive_crew` or Archive crew on the Fleet page.

**Events:** the archive, and an obligation-closure event for each Exchange it ended — loud in the ledger, not only in the dialog.

### `j5_clear_own_ask`

**Description:** "Withdraw an ask you sent: closes your open exchange without a reply message. Use when the answer already arrived outside the exchange — for example, the human answered you directly in your thread — so the obligation exits their inbox honestly. Only the exchange's sender may clear it; the closure is recorded as sender-cleared, distinct from an answered exchange. Reuse client_request_id to retry safely."

| Input               | Type       | Required                                        |
| ------------------- | ---------- | ----------------------------------------------- |
| `exchange_id`       | ExchangeId | yes — an Exchange the caller opened, still open |
| `client_request_id` | string     | yes                                             |

**Result:** the closed Exchange's state — id, closure kind `sender-cleared`, closed-at.

**Errors**, each naming state and next command: the caller is not the Exchange's sender; the Exchange is already closed; unknown Exchange.

**Events:** an Exchange-closure event distinguishable from a reply's closure, so the inbox, the Exchange projections and the communication graph render the withdrawal honestly.

### `j5_list_personas`

**Description (contract):** "List the personas in this environment: id, purpose, runtime policy,
whether each can start now, and the provider, model, and reasoning it would run on. Read this
before choosing a persona for j5_spawn_agent or a crew roster so the choice fits the task and the
user's budget. Read-only."

Named `list_agents` until 2026-09-17. No inputs. Result: `personas[]` with `id`, `display_name`, `description`, `runtime_policy`,
`availability` (`available`, `blocked`, `disabled`) and `route` (driver · model · reasoning, or
null when blocked). The same catalog Settings → Personas shows; disabled imports read as disabled,
unroutable or unenforceable personas as blocked. This is the P-B(a) spawn listing the spawning guide
asked for.

### `j5_propose_crew`

**Description (contract):** "Propose the crew you need for the brief you were given. Use it when the
user asks for a crew or the work splits into distinct responsibilities that should run at once. Mix
saved personas and custom seats in the same roster: call j5_list_personas when choosing a saved
persona, or leave persona unset for a custom seat with its own instructions (required) and the
brief. Custom seats inherit your harness, model, and reasoning by default and run with full-access
unless you set runtime_mode; to choose different ones, set model_selection (instanceId, model,
options) and/or runtime_mode using orchestrator_capabilities. Saved personas are proposed with their
own configuration; only the human may override their runtime before approval. To have the crew
follow a playbook, set playbook to a name from j5_playbook_list and give seats the step ids they own
(steps, from j5_playbook_read); a step has one owner, steps no seat owns are yours as Captain, and the
result reports unowned steps and any step whose persona differs from its seat's. For a crew built
from a playbook, staff one seat per distinct persona its steps name, each owning that persona's
steps, and propose a custom seat, noted in its reason, where a named persona isn't available. Every
seat names its workspace, with the same three choices as j5_spawn_agent. Name the crew for what it is
for and give each seat a short lowercase-hyphen name like code-reviewer. The user reviews the roster
and each seat's resolved provider, model, reasoning, and access in this thread, may remove or add
seats, and approves or declines; you receive the decision and the roster as a message here. Approved
seats run with the runtime the human approves, which may exceed yours. You become the crew's Captain
and may command several crews at once; later requests, stops, and archives name the crew they mean.
Use j5_send_message for member-to-member, member-to-Captain, and Captain-to-Captain coordination,
including findings and direct results; artifacts do not gate these conversations. Reuse
client_request_id to retry safely. This call is itself the human gate, so it works under every
sandbox and approval policy, including approval policy never; never refuse the brief because
approvals are disabled."

Published as non-destructive (`destructiveHint: false`): the call records a pending request and
nothing spawns until a human approves it.

| Input               | Type                                                                                                  | Required | Meaning                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | string                                                                                                | yes      | The Crew's display name                                                                                                                                                                                  |
| `brief`             | string                                                                                                | yes      | What every seat starts on, verbatim                                                                                                                                                                      |
| `seats`             | 1–12 of `{seat, persona?, model_selection?, runtime_mode?, reason, instructions?, steps?, workspace}` | yes      | Seat name, persona id from `j5_list_personas` (none for a custom seat), why, wiring, custom-seat runtime, the playbook step ids the seat owns, and where it works (the `j5_spawn_agent` workspace shape) |
| `playbook`          | string                                                                                                | no       | A playbook name from `j5_playbook_list` in the Captain's workspace; the Crew follows it                                                                                                                  |
| `client_request_id` | string                                                                                                | no       | Supply and reuse to make retries safe                                                                                                                                                                    |

Bounds: `name` and `seat` up to 100 characters, `reason` up to 500, `brief` and `instructions` up
to 8,000.

Result: `proposal_id`, `status` (`open`, `approved`, `declined`),
`crew_instance_id`, and `members` (seat, persona_id, participant_id, thread_id) once spawned. A
proposal that follows a playbook adds `playbook`: `name`, `title`, `unowned_steps` (the Captain's),
and `persona_swaps` (seat, step_id, wanted_persona, seat_persona, and wanted_problem `missing` or
`disabled` when the wanted persona could not staff the step itself).
Semantics: the caller must have a usable home and must not sit in a Crew (R20). Seats are validated
against the library before anything is recorded: unknown or disabled personas, duplicate seat names,
or more than twelve seats refuse with the next step. With `playbook`, the live definition is read
and each claimed step must exist and have one owner; an unknown or invalid playbook, an unknown step,
a doubly claimed step, or `steps` without a playbook refuse the same way. A seat that claims no
steps needs no readable definition, so a Crew whose playbook file is gone can still add one. The
proposal records the playbook's definition path, and the Crew keeps it from approval on; each
member records the step ids it owns, and each seat's first turn lists its steps by live title in a
`<seat_playbook>` block. An open roster proposal waits for the human
gate inline above the Captain's composer (additions wait in the Inbox); approval spawns the approved roster (the human may have edited it) as Peer Agents under the
caller, persona-backed where a seat names one, records the Crew snapshot with each member's reason
(the person approves every seat), and posts
a `<j5_crew_gate>` launch report into the caller's thread once every seat has started or failed to start (or a minute has passed): the roster, what the user changed against the proposal, and per seat `start=started|failed|pending`, with a `seat_failed` line carrying the run's error (`not_started` when the seat's thread exists but its brief never went out) and a `seat_not_created` line for an approved seat whose thread was never created, which is left off the roster. A proposal resolves once: a seat that fails does not stop the others or reopen the gate. Declines post the decline at once.
Every seat names its workspace, with the same three choices as `j5_spawn_agent`, so there is no Captain-aware default (Jackson, 2026-10-03). Each seat's workspace resolves at preview against the Captain's repository, and the approval token binds it, as it binds the Captain's branch and worktree. Every preview also carries the Captain's current branch, the directory its branch picker searches, and its worktrees, for the roster card's editor; the branches themselves are searched live, so no list is capped. A seat the person adds starts in the Captain's checkout. A seat recorded before workspaces were required stays readable but is refused at preview and approval until one is chosen. A new-worktree seat's brief starts once ThreadLaunch has prepared it, as for `j5_spawn_agent`, so the launch report may read `pending` for a seat whose setup outlasts the report's minute, and a failed preparation arrives as that seat's failure.
Human approval is the authority (Bryant, 2026-09-10): seats run with the runtime the person
approved, their persona's policy when no override was chosen, so a read-only Captain may command
writing seats once a person approved them; a seat's permissions never come from its Captain's.
There is no auto-approval: the earlier `runbook_declared` column and `auto_approved` status were
cut before shipping, since nothing wrote them and runbooks do not exist yet.

### `j5_request_crew_member`

**Description (contract):** "Ask the user to add one seat to a crew you command when the work needs
one the roster lacks: seat name, persona id from j5_list_personas (or none for a custom seat with
required instructions and optional model_selection/runtime_mode overrides; an omitted
model_selection inherits yours and an omitted runtime_mode is full-access; saved-persona runtime
changes are made only by the human before approval), a clear reason identifying the concern and
missing expertise or responsibility, its workspace (the same three choices as j5_propose_crew), and
optionally instructions and a brief for the new seat. On a crew that follows a playbook, steps may
claim step ids from j5_playbook_read that no seat owns yet. The user decides from their inbox; you
receive the decision and the updated roster as a message here. Continue the already-approved work
and direct coordination while the addition is pending. Captain-only; a member sends the concern and
needed expertise to its Captain with j5_send_message. Reuse client_request_id to retry safely. Filing
the request is the human gate itself and works under every approval policy, including approval
policy never."

| Input                             | Type           | Required | Meaning                                                                     |
| --------------------------------- | -------------- | -------- | --------------------------------------------------------------------------- |
| `crew_instance_id`                | string         | no       | Required only when the caller commands more than one live Crew              |
| `seat`, `persona`                 | string         | yes      | New seat name and persona id (none for a custom seat)                       |
| `model_selection`, `runtime_mode` | object, string | no       | Custom seats only; omitted, the Captain's model selection and `full-access` |
| `reason`                          | string         | yes      | One line the human reads before approving                                   |
| `brief`                           | string         | no       | The new seat's brief; the Crew's brief when omitted                         |
| `instructions`                    | string         | no       | Seat wiring text, verbatim                                                  |
| `steps`                           | string[]       | no       | Playbook step ids no seat owns yet; only on a Crew that follows a playbook  |
| `workspace`                       | object         | yes      | Where the seat works; the same three choices as `j5_propose_crew`           |
| `client_request_id`               | string         | no       | Supply and reuse to make retries safe                                       |

Result: as `j5_propose_crew`. Semantics: the caller must command the Crew; the seat name must be new;
the cap counts current members plus seats in other open requests for the same Crew. Approval
reserves the seat inside one store transaction (count, cap, step ownership, version bump, and
ordinal decided together under an optimistic version check, so two approvals landing at once cannot
both pass; the second one claiming a taken step is refused and stays open),
then spawns the seat under the Captain and posts the updated roster to the Captain. If the approval
cannot be recorded, the reservation is released and the request stays open; once the seat starts
spawning the request is approved, and a seat that was never created is reported, not retried.

### Handoff artifacts in Crews

There is no Crew-specific artifact verb. A seat whose definition declares an output artifact writes
it with the project `j5_write_artifact` tool to the same handoff artifact every persona writes
(`handoffs/<agent>/<Artifact>-<task>.md`, see the [persona contract](../agent-personas/index.md));
its first turn carries `<seat_obligation>` naming that exact path. The handoff gate checks for the
file when a run ends and reminds the seat once. When a seat's run fails, or completes while the seat owes
no reply, the seat finish notifier posts one platform-composed `<j5_seat_finished>` notice into the
Captain's thread: the run status (completed or failed, with the run's error when it failed), the
seat, its Crew, its participant and thread ids, and the handoff artifact as `written`, `missing`, `unavailable`, or `none
declared` with its path. `missing` means the file was checked and is not there; `unavailable` means
something is at the path that can never be a handoff (a directory, or a link out of the artifacts
directory) and carries the reason. Only a real read failure sends nothing, and the next finish or the
boot sweep retries. A written handoff artifact up
to 4,000 characters rides inline with its size and digest; longer ones name the path for the
project `j5_read_artifact` tool, and one over the artifact read limit is still `written`, named by path. A notice posts the first time a seat finishes and again only when
its facts changed, and a notice that arrives while the Captain's turn runs folds into the one
queued behind it. Interrupted and cancelled runs are not finishes: `j5_stop_crew` interrupts seats so
they can be briefed again, and nothing is reported then. Ids
derive from the run, so a redelivered event cannot post twice. Read-only Codex and Claude personas have `j5_write_artifact` pre-approved for this reason, and `delegate_task` with `task_status` and `task_cancel` beside it, because a Crew member refused `j5_spawn_agent` is sent to provider-native Subagents and a verb the sandbox then rejects is no way out:
handoff artifacts live in application storage, never in the sandboxed workspace. (Withdrawn on 2026-09-14:
the 2026-09-10 `deliver_artifact` verb, its ledger table, and the crew-only `read_artifact` and
`list_artifacts` of that time, which collided with the project artifact toolkit's names.)

### `j5_stop_crew`

**Description (contract):** "Stop a Crew you command the way a user Stop does, seat by seat: each seat's running turn is interrupted now, turns already queued behind it, messages you sent it included, are held until a person resumes its queue (no tool releases them, and a message sent after the stop runs ahead of them), its pull request watches end, and the tasks it delegated stop too. Nothing settles or is retired, and every seat can be messaged again afterwards. Captain-only. Reuse client_request_id to retry safely."

| Input               | Type              | Required | Meaning                                        |
| ------------------- | ----------------- | -------- | ---------------------------------------------- |
| `crew_instance_id`  | string            | yes      | The id from the `<j5_crew_gate>` roster notice |
| `client_request_id` | string, non-empty | no       | Supply and reuse to make retries safe          |

Result: `crew_instance_id` and `members` (seat, participant_id, result: `interrupt_requested`,
`already_idle`, or `archived`). Semantics: the unit form of `j5_stop_agent`. Only the Captain may call
it; anyone else is refused and pointed at asking the Captain; an archived Crew is refused naming
its state. Every seat is stopped through the ordinary single-agent stop, upstream's Stop; an idle seat is
reported as such and its queue is held too; nothing settles, nothing is retired, no Exchange closes, and the seats stay addressable.
The person has the same act as a **Stop crew** control on the Crew's header on the Fleet page and on
the Captain's expander in the sidebar, shown only while a seat is running; it is not a Crew
participant, so no Captain check applies to it (Bryant, 2026-09-14).

### `j5_archive_crew`

**Description (contract):** "Retire a whole Crew you command. Crews archive only as a unit —
members are never retired one by one. A clean archive completes immediately; otherwise the call
refuses with the facts and a confirmation_token. Before retrying with that token, check with the
user. Nothing is destroyed: worktrees, branches, and ledgers stay readable. Reuse
client_request_id to retry safely."

| Input                | Type              | Required | Meaning                                              |
| -------------------- | ----------------- | -------- | ---------------------------------------------------- |
| `crew_instance_id`   | string            | yes      | The id from the `<j5_crew_gate>` roster notice       |
| `confirmation_token` | string            | no       | Token from the refusal; confirms exactly those facts |
| `client_request_id`  | string, non-empty | no       | Supply and reuse to make retries safe                |

Result: `status` (`archived` or `already_archived`), `crew_instance_id`, and `members` (seat,
participant_id, per-member result). Semantics: only the Captain — the participant that launched the
Crew — may archive it (R19); anyone else is refused and pointed at asking the Captain. Facts are
read for every member before anything happens. If any member has an open Exchange or a running
turn, the call refuses with a per-seat list (`members[].open_exchanges`, `members[].running_turn`,
`already_archived`) and a signed `confirmation_token` over exactly those facts. With a matching
token, members retire in seat order through the ordinary single-agent archive with their own
confirmation already satisfied (interrupt, thread archive, participant retirement, loud Exchange
terminations to every waiter), then the Crew record is marked archived. A token stays valid when
the current facts are a subset of the confirmed ones, so a retry after a partial failure finishes
the job; new work on any seat makes it stale and yields a fresh token. Partial failures name the
seats retired so far and the seat that failed; retry with the same `client_request_id` and token.

**Members are never archived one by one (R14):** `t3_thread_organize` refuses archiving an active Crew seat, just as client archive/delete does. Retire the unit through `j5_archive_crew` or Archive crew on the Fleet page. Archiving its Captain retains the crew cascade. A member that finishes with nothing owed is
reported to its Captain; the platform never settles a seat because its run finished, and settlement is not archive. `j5_stop_agent` on a member is still allowed;
stopping retires nothing.

### Crew playbook runs

A Captain runs the playbook its Crew follows with `j5_playbook_start(name, client_request_id,
crew_instance_id)`. The call is refused with `crew_not_linkable` unless the Crew is the caller's,
is live, and follows that playbook. Each landing (start, next, back, reselect) hands the step's live
prompt to the seat that owns it, once per landing, as a `<j5_playbook_step>` notice in the seat's
thread. A step no live seat owns is the Captain's, and no notice is sent for it.

Every step tool on a Crew-linked run returns `delivery`: `{ state, seat, thread_id }`, where `state`
is `delivered` (the seat has the step), `captain` (the Captain does it from `currentStep.prompt`),
or `pending` (the hand-off hasn't finished; nobody should start the step). Only `captain` means
the Captain does it. `j5_playbook_current` reports the same `delivery` without handing off again.
While an earlier hand-off is still pending, `j5_playbook_next`, `j5_playbook_back`, `j5_playbook_reselect`,
and `j5_playbook_complete` refuse with `delivery_pending` and don't move; retry the same call. Nothing
retries a pending hand-off in the background, including after a restart: the Captain's next step
call, or a retry of the same one, finishes it.
`j5_playbook_cancel` always works. The platform never advances on its own: the Captain calls
`j5_playbook_next` after the seat reports back. Archiving the Crew or its Captain cancels its active
run; `j5_stop_crew` doesn't, and unarchiving doesn't restart it.

### Kept upstream tools

- `orchestrator_capabilities` — providers and models (ids, labels, option descriptors) for spawn targeting, plus runtime and interaction-mode facts. It deliberately stays silent about delegation even though `delegate_task` is back on the surface: that tool's own description carries its persona use, and J5 verbs are advertised by their own descriptions.
- `delegate_task`, `task_status`, `task_cancel` — upstream's provider-owned child delegation. J5 re-declares `delegate_task` with its own description, which leads with the optional `persona` (a persona id from an `@persona:ID` mention or the Settings → Personas library) and presents the plain child as the fallback for cross-provider or T3-tracked work rather than the default for any subagent request. With `persona`, the server pins that persona's instructions, model route, reasoning, and runtime policy and refuses `target` and `runtimeMode`; without it, the child is upstream's plain subagent. The child is backing storage under the calling thread, not a Peer Agent; use `j5_spawn_agent` for a participant. Its wait mode is safe where `t3_thread_wait` was not: a child that messages its parent ends its own turn, so the wait returns and the parent reads the message on its next turn (latency, never starvation).
- `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task` — consumed as-is.
- `t3_thread_list`, `t3_thread_read` — consumed as-is; if an upstream description mentions delegation, J5 re-declares that tool with corrected prose.
- `html_preview`, `html_render`, `request_secret`, `preview_dialog`, `preview_hover`, `preview_select`, `preview_drag`, `preview_upload`, `watch_pull_request`, `unwatch_pull_request` — consumed as-is.
- `t3_project_create`, `t3_project_update`, `t3_environment_preferences_update` — consumed as-is. `t3_project_delete` is not on the J5 surface until J5 settles what deleting a project does to the state it keeps for each project ([#552](https://github.com/Jacksondr5/j5code/issues/552)).
- `t3_thread_wait` is **withdrawn** from the J5 surface. Platform notices queue behind a running turn, so a participant that blocks inside its turn waiting on another thread can never receive the notice that thread's finish produces; a Captain that waited on a seat this way starved itself of its own Crew's news (Bryant, 2026-09-14). Whatever a participant is waiting for arrives as a message once it ends its turn.

## Acceptance criteria

1. Every J5 verb's shipped description string is byte-identical to the description in this definition.
2. A `j5_send_message` to a person that is not an ask is refused with an error naming the legal move; an ask to a person without urgency is refused.
3. A further ask to a person opens a new Exchange and inbox item; an ask that names an open Exchange in `regarding` joins it and is shown beneath the original ask.
4. Between agents, a further ask to a peer holding an open Exchange from the caller joins it as a follow-up.
5. A `j5_send_message` to the caller itself is refused with an error naming the caller's own id.
6. `j5_list_participants` marks the caller's row `self`, reports a person's row as unable to receive a plain message and able to be asked, and omits provider Subagents.
7. `j5_spawn_agent` refuses a call that omits provider, model, or reasoning, refuses a choice outside the Role's allowlist with an error naming the Role, and refuses a caller that sits in a Crew with an error naming escalation to its Captain.
8. A spawned agent's first turn contains its own participant id and project.
9. `j5_stop_agent` and `t3_thread_organize` act on one target; neither cascades. `j5_stop_agent` reaches an agent in any project on this server, and refuses a target that runs with broader permission modes than the caller unless the caller is that seat's Captain. A stopped run is never resumed after a server restart, even when restart continuation is enabled.
10. `t3_thread_organize` archives and restores any thread in the environment that upstream's access check lets the caller act on. Archive closes Exchanges through the shared reactor without a confirmation-token exchange or interrupting an existing run; human archive warnings remain.
11. `j5_clear_own_ask` closes only an Exchange the caller opened and records the closure as sender-cleared.
12. Every error from every verb names the actual state and the next command.
13. `j5_list_participants` omits archived agents unless `include_archived` is set, and then marks each one `archived` and unable to receive a message or an ask.
14. Unarchiving an archived agent restores the same participant id, placement and provenance and makes it addressable again; the Exchanges archiving closed stay closed and no cancelled delivery is replayed.
15. Retired (see History).
16. Retired (see History).
17. `j5_list_personas` returns every persona with its availability and route; `j5_propose_crew` and `j5_request_crew_member` file a human gate and refuse unknown, disabled, duplicate, or over-cap seats before anything is recorded; both succeed under every sandbox and approval policy, including Codex approval policy `never`.
18. Approving a proposal spawns exactly once; a second approval finds it resolved; a seat that fails to spawn is reported by name in the launch report and the other seats still start.
19. `j5_archive_crew` is Captain-only, refuses with per-seat facts and a token when any seat has an open Exchange or a running turn, and finishes a partial archive on retry; `t3_thread_organize` refuses an active Crew member, while Captain archive retains the unit cascade.
20. `j5_stop_crew` is Captain-only, stops every seat as a user Stop does and reports each seat as interrupted, already idle, or archived; it settles, retires, and closes nothing, and a non-Captain or an archived Crew is refused naming the next step. The person's Stop crew control does the same through the operate scope.
21. `j5_list_participants` lists a peer server's participants with their project when `server` names it, names every server in the result, and reports an unreadable peer there; `j5_send_message` accepts their ids exactly as local ones.
22. Once a server has a peer, every `j5_list_participants` row names the server the participant lives on and marks this server's as local, and a row on a peer server that polls this one says whether it is available and when it was last available; a server with no peers adds no server field.
23. A `j5_send_message` to a participant on a peer server names that server in its result, and, when that server is offline, says the message is waiting for the recipient and when the server was last available.
24. A message refused by the recipient's server, or cancelled before it was delivered, reaches its sender as a not-delivered notice naming the recipient, its server and the reason; a refused ask's Exchange is dropped, and that one notice says so.
25. `j5_list_participants` lists one project a page at a time: the caller's own unless `project_id` names another, at most 100 rows, with `next_cursor` and `total`; `name_contains` and `settled` narrow it, and the caller's row and the people are kept whatever the filters say.
26. `j5_send_message` lands a message as its `mode` asks: `queue` behind the receiver's turn, `steer` into it, `restart` by interrupting and restarting it; a receiver with no turn to steer or restart takes it as an ordinary message. `steer` and `restart` are refused when the receiver runs with broader permission modes than the sender, and a queued send is not.
27. `j5_send_message` carries attachments to an agent on this server on a plain send, an ask or a reply, and a send the ledger refuses releases the files it claimed.

## History

- 2026-08-29 — contracts adopted: descriptions as part of the contract, the toolsmith rule, single-target stop and archive, the confirmation-token archive ([record](../../worklog/2026-08-29-substrate-session.md)).
- 2026-08-30 — the spawn brief carries the task and the reply expectation; one sentence of brief steering in `spawn_agent` ([record](../../worklog/2026-08-30-spawning-guide-session.md)).
- 2026-08-31 — self-send refused; the `self` row; identity facts in the spawn's first turn; `display_name` on every row; `create_threads` and `t3_thread_start` omitted ([record](../../worklog/2026-08-31-picker-and-self-messaging-rulings.md)).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/2026-09-02-human-addressed-sends-ruling.md)).
- 2026-09-08 — a person receives asks only; the reply form toward a person is retired with the person-originated ask.
- 2026-09-05 — several open asks per person, with explicit follow-ups through `regarding`, replacing the one-ask-per-person refusal of 2026-09-02 (issue #111).
- 2026-09-13 — the `send_message` description is the shipped string, which a test pins byte-for-byte to this definition; the sentence teaching `regarding` joins it when #111 ships, and the stale "or a reply" toward a person is removed from the runtime string.
- 2026-09-05 — a committed stop wins over restart continuation (upstream integration, PR #112).
- 2026-09-12 — archiving is reversible: unarchive restores the same identity without reopening Exchanges; deletion is a separate permanent act for people only; the address book hides archived agents unless asked (PR #132).
- 2026-09-12 — `list_squadrons` and `join_squadron` added for the one case of a native thread with no home (issue #129, PR #131).
- 2026-09-07 — rewritten from a stack of dated contract revisions into current-state contracts; every verb's build state true as of this date (all six verbs shipped; `regarding` and the person follow-up rule are issue #111).
- 2026-09-09 — `list_agents`, `propose_crew`, `request_crew_member`, and `archive_crew`: Crews composed at launch through a human gate ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-10 — human approval is the authority for seat access; proposals and requests pre-approved for Codex under approval policy `never`; `deliver_artifact` added.
- 2026-09-14 — lifecycle verbs stay available to read-only personas by decision (Sentry S-4 closed).
- 2026-09-14 — `deliver_artifact` and the crew-only artifact reads withdrawn in favor of the shared handoff files; Codex pre-approval narrowed to a per-tool list; `archive_agent` refuses Captains of live Crews ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `t3_thread_wait` withdrawn: blocking inside a turn starves a participant of the queued notices it is waiting for ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `stop_crew`: the unit form of stop for the Captain over MCP and for the person as a Stop crew control; interrupts running seats only ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `delegate_task`, `task_status`, and `task_cancel` return to the J5 surface, with a saved-agent `agent` parameter on `delegate_task` replacing the J5-only `invoke_agent` ([review](https://github.com/Jacksondr5/j5code/pull/124#issuecomment-5663559782)).
- 2026-09-15 — machine participants appear in `list_participants` as named senders that receive nothing (issue #74).
- 2026-09-16 — participants homed on peer servers appear in the address book and are addressed like local ones; AC21 ([record](../../worklog/2026-09-16-cross-server-peering-session.md)).
- 2026-09-17 — personas, not agents: `list_agents` becomes `list_personas`, the `agent` parameter on `spawn_agent`, `delegate_task`, and crew seats becomes `persona` (no alias: pre-dogfood, no legacy-compatibility code), crew results carry `persona_id`, and the mention is `@persona:ID`; "agent" keeps meaning a running participant (Bryant; [record](../../worklog/2026-09-16-crew-command-decoupling.md)).
- 2026-09-24 — the `propose_crew` and `request_crew_member` contract strings match the shipped descriptions (custom-seat `model_selection` and `runtime_mode`, direct coordination); the snapshot keeps each member's reason, since the person approves every seat; seat finish notices post on change for completed and failed runs, and `missing` means the file was checked and is not there ([#229](https://github.com/Jacksondr5/j5code/issues/229), [#234](https://github.com/Jacksondr5/j5code/issues/234)).
- 2026-09-24 — the J5 document is named "handoff artifact" to distinguish it from upstream's context handoffs.
- 2026-09-24 — `list_participants` rows carry `squadron_name` beside `squadron_id`, so an agent tells its own Squadron from one on a peer server without any server being named (PR #198).
- 2026-09-25 — a proposal resolves once (`open`, `approved`, `declined`); a seat that fails to spawn is reported in the launch report, not retried (Bryant; [#311](https://github.com/Jacksondr5/j5code/issues/311)).
- 2026-09-26 — a custom seat's omitted `runtime_mode` is `full-access` rather than the Captain's access; the `propose_crew` and `request_crew_member` copies above are resynced with the shipped strings (Jackson; [#326](https://github.com/Jacksondr5/j5code/issues/326)).
- 2026-10-02 — agents see where participants live: `list_participants` rows carry `server` once a peer exists, `send_message` results name a remote recipient's server and its availability, and a refused or cancelled delivery reaches the sender as a not-delivered notice; AC21 rewritten, AC22–AC24 added. Agents still never choose or manage a server ([record](../../worklog/2026-10-02-peering-poll-mode-session.md)).
- 2026-10-03 — `spawn_agent`, `propose_crew` seats and `request_crew_member` require a `workspace`, with no default: the caller's checkout, a new worktree from a required `base_ref` prepared by upstream's ThreadLaunch, or an existing worktree of the project. (Jackson; [#274](https://github.com/Jacksondr5/j5code/issues/274)).
- 2026-10-06 — a peer whose new worktree fails to prepare is left as upstream leaves any failed launch: its thread shows the failure, and it is not retried, retired, or guarded, and its spawner is not told. Upstream reads an unbound thread as the project's checkout, but in practice no turn has landed there, and each guard tried (a turn guard, then waiting for the checkout and retiring the peer) raised a new edge case. The turn guard and the `<j5_spawn_workspace_failed>` notice are removed, and `spawn_agent` returns once the peer is registered (Jackson on [#396](https://github.com/Jacksondr5/j5code/pull/396)).
- 2026-10-07 — Squadrons retired: every thread but a provider Subagent is a participant in its project's ledger, so `list_squadrons` and `join_squadron` are removed and AC15 and AC16 retired; `stop_agent`, `stop_crew` and `archive_crew` take no `squadron_id`; `list_participants` rows and the `spawn_agent` result carry `project_id` and `project_title`; archiving another agent follows upstream's same-project rule alone (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-08 — the advance onto upstream `main`: `stop_agent` and `stop_crew` send upstream's Stop, which also holds the queue, ends pull request watches and stops delegated tasks; `t3_thread_organize` follows upstream's reach across the environment (AC10); ten new upstream tools are kept as-is (Jackson's decisions of that day; [register of divergences](../upstream.md), D2).
- 2026-10-10 — every tool J5 owns gains a `j5_` prefix (`send_message` became `j5_send_message`, and so on for the messaging, agent, Crew, persona, playbook and artifact tools), because agents on Claude reached for the harness's own `SendMessage` instead; the old names are not kept as aliases, and lines above this one use the names of their day (Jackson; [#508](https://github.com/Jacksondr5/j5code/issues/508)).
- 2026-10-11 — `j5_list_participants` lists one project a page at a time, as upstream's listing tools do: `project_id`, `server`, `name_contains`, `settled`, `cursor` and `limit` in, `next_cursor`, `total` and `servers` out. It returned every participant on the server in one answer, 152 rows on the live install (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
- 2026-10-11 — upstream's `t3_project_create`, `t3_project_update` and `t3_environment_preferences_update` join the kept upstream tools (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
- 2026-10-11 — `j5_stop_agent` loses its same-project limit and gains upstream's permission rule, with a Captain stopping its own seat exempt (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
- 2026-10-11 — `j5_send_message` gains `mode` (`queue`, `steer`, `restart`, with upstream's permission rule on the last two) and `attachments`; J5's version of `t3_thread_send_attachments` is no longer registered (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)). Whether `queue` stays the default is revisited in [#538](https://github.com/Jacksondr5/j5code/issues/538).
