---
title: "J5 and upstream — the three zones, and the register of divergences"
kind: definition
---

# J5 and upstream

J5 Code is a fork of T3 Code, and it stays one. Upstream builds the base product and J5 builds a fleet layer on top ([overview](overview.md)). The fork is only affordable if J5 keeps its changes to upstream few, deliberate, and recorded, because every change is carried through every upstream advance. The principle is [upstream owns its product](principles.md#upstream-owns-its-product). Where upstream is building toward J5's own areas is tracked separately, in the [upstream convergence watchlist](upstream-convergence.md).

## The three zones

Every change lands in one of three zones.

1. **J5's domain.** The areas in the [overview](overview.md), built in J5-owned code. J5's definitions and principles govern them.
2. **Code overlap.** J5 code has to be reached from, or placed inside, a file upstream owns, without changing what upstream's product does. This is a matter of process, and [`FORK.md`](../../../FORK.md) is the whole answer: put the J5 code in J5-owned files, keep the upstream edit to a small appended integration case, and record the case in the same PR.
3. **Product overlap.** A change to what upstream's product does, as a user or agent experiences it: overriding or suppressing upstream behavior, giving an upstream concept a different meaning, or extending an upstream area such as a provider adapter so that it serves a J5 feature. This is the person's decision.

The test for zone 3 is behavioral, not about code size. A one-line edit that makes an upstream control disappear is zone 3; a large J5 module reached through a one-line registry entry is zone 2.

## Deciding a product overlap

An agent whose work heads into zone 3 brings the person:

- **what upstream does today**, and why, if upstream says;
- **what J5 would do instead**;
- **the trade-offs**: what the person gains, what it costs to carry through upstream advances, and what breaks if upstream later changes the same area;
- **the alternatives**, which always include following upstream and saying "not supported here".

The default is to follow upstream. Where upstream's product is less capable than a J5 feature wants, the usual answer is that the J5 feature is not supported there, and a general fix is offered back upstream (tracked in the give-back backlog, [#276](https://github.com/Jacksondr5/j5code/issues/276)).

When the person approves a divergence, it is recorded below and its code gets its FORK.md cases. When the person declines, nothing is recorded here; the ruling lives on the issue or PR where it was made.

## The register of divergences

Every place J5 knowingly makes upstream's product behave differently, with the person's decision behind it. FORK.md is the code-level ledger; this is the product-level one. When upstream makes an entry unnecessary or J5 stops needing it, the entry moves to **Retired** at the end, keeping its ID and heading, with a line saying when and why, so references to it keep working. Gaps in J5's mobile app aren't divergences: mobile is catching up to web as its own effort, and what it lacks is recorded there, not here.

Each entry has an ID ("divergence D7"), which never changes and is never reused. Every entry answers the same questions, in the same order:

- **Upstream:** what T3 Code does.
- **J5:** what J5 does instead.
- **Why:** the problem J5 had with upstream's behavior, and why this answer.
- **Consequences:** what it costs, what to check at each upstream advance, and known gaps.
- **Decided:** who decided, when, and where it's recorded.

Letter codes in the Decided lines (SC2, QS1, AR3, and so on) are rulings recorded in `docs/j5/worklog/` or in the dogfood v0 plan (removed on 2026-09-29; it's in git history). Numbered decisions dated 2026-09-24 were made during that day's upstream advance, and decisions dated 2026-10-08 during the advance onto upstream `main`.

### Agents and orchestration

#### D1. Help is a Subagent, a Peer Agent, or a Crew

**Upstream:** the instructions every agent receives point it to `delegate_task` for help from another provider, or from a model its own subagent tool can't run, and to `t3_thread_launch` or `create_threads` to start new threads.

**J5:** agents are told about three shapes of help: a Subagent their own provider runs, a Peer Agent started with `j5_spawn_agent`, and a Crew proposed with `j5_propose_crew`. `delegate_task` is kept for three narrow cases: running a saved persona as a subagent, work on another provider that the person doesn't need to talk to directly, and, as upstream now says, a model the provider's own subagent tool can't run. A review that takes several rounds gets a new `delegate_task` call for each round.

**Why:** upstream's delegated child is "a Peer Agent in a Subagent costume": the person can't talk to it, yet it outlives the agent that started it. That is the awkward middle J5's vocabulary exists to remove. The Crew shape was added after an agent asked to "spawn a crew" made subagents instead, because nothing it had been told mentioned a Crew. Personas later gave `delegate_task` a purpose again: a persona needs a way to run as a subagent.

**Consequences:** upstream's launch and workspace guidance never reaches J5 agents. `j5_spawn_agent` and Crew seats require their own workspace choice instead, with upstream's `existing_worktree` name and shape beside `shared` and `worktree`, and reuse upstream's ThreadLaunch to prepare a new worktree (#274). A spawn may also name upstream's `root`, the project's main checkout, and may join another project or upstream's "No project" project (#519); a Crew seat stays in its Captain's project with the first three choices. J5's text lives in a J5 folder inside upstream's shared provider package, and the constant upstream exports for its own text points at it. So J5's text reaches every harness that reads that constant: Codex, Claude, Cursor, OpenCode, the ACP agents and Pi, and any provider upstream later moves into a package of its own. Every upstream advance ports upstream's prompt changes into it by hand, and a test pins J5's wording. J5 takes upstream's own sections as upstream writes them: secrets, thread links, showing visuals, the browser, schedules, and the two `delegate_task` rules above.

**Decided:** Jackson with Product, 2026-08-24 (ST1–ST5); the Crew shape on 2026-09-17; the persona route in Jackson's review of 2026-09-13, which partly reverses ST5; the sections taken from upstream by Jackson, 2026-10-08; the text's home in the shared package, so that Pi and later provider packages get it, by Jackson, 2026-10-09. Whether `delegate_task` stays at all is under discussion (#336). Recorded in FORK.md case 8 and the saved-agent mentions section.

#### D2. Agents see a fail-closed subset of upstream's MCP tools

**Upstream:** agents can send into another thread, interrupt it, wait on it, launch threads, and create threads in bulk. Every tool declares who may call it. Thread tools reach any thread in the environment, not only the caller's project. An agent outside the app can sign in to the MCP server and use the tools that don't need a calling thread.

**J5:** the raw send, interrupt, wait, launch and bulk-create tools are hidden from agents, with upstream's queue writers and its project delete. Everything else follows upstream: its access model, its reach across the environment (writes included), and its outside-agent sign-in as shipped. J5's own tools declare their access the same way. An outside agent uses J5's tools with an identity in J5's ledger: it lists participants, sends plain messages, stops agents and starts them. The tools that need a thread for something to come back to stay refused to it, each with an error that names what it can do instead. J5 rewrites the few descriptions that would mislead J5 agents, and reviews every new upstream tool at each advance.

**Why:** J5 built its own versions of the hidden tools, integrated with J5's model: `j5_send_message` and Exchanges instead of raw send, `j5_stop_agent` instead of interrupt, and `j5_spawn_agent` and `j5_propose_crew` instead of launch. A raw send is communication the ledger can't see, so a reply that never comes stalls silently. Raw thread creation skips the placement a spawn records. Waiting on another thread blocks the turn that would receive that thread's news. The tools are hidden, not deleted, to keep the fork's edits small. J5 used to hold thread tools to the caller's project as upstream did; upstream dropped that rule and J5 had no reason of its own to keep it.

**Consequences:** upstream's toolkit stays compiled, with part of it unused. A test pins the exact tool list, so a tool upstream adds fails the build until someone reviews it; all ten that arrived on 2026-10-08 were admitted (HTML previews, `request_secret`, five more browser controls and pull-request watches). Each advance also checks J5's access declarations and re-reads upstream's descriptions. An outside agent is a participant in J5's ledger for each sign-in, named by the label its client registered ([agent-to-agent communication](a2a/index.md)). It sends through `j5_send_message`, because upstream's send from an outside client lands as bare text with no sender named, and the receiving agent can't tell it from the person. Nothing can be delivered to it. The level the person approved at sign-in caps everything it does: every send is checked against it, one that asks for no steer or restart included, and so is every stop. The check happens when the call is made. Revoking a sign-in stops new calls, and a message already sent is still delivered. A thread sender is checked only when it steers or restarts, because the person watches a thread and chose its modes. The sign-in level is different. It is a promise the approval page makes about an agent the person does not watch, so J5 holds it on every act. An outside agent reaches this server only; for a peer server it signs in there. It starts agents with `j5_spawn_agent`, in a project it names and at the top level of that project, because upstream's launch records no spawner. The level caps a spawn as well, a persona's policy included. A thread caller's persona spawn has no such ceiling. `delegate_task` and the playbook tools, reads included, are J5's own declarations, and they refuse an outside agent with the same kind of error: it names starting an agent with `j5_spawn_agent` and briefing it. `t3_pending_request_respond` and `t3_thread_configure` act on other threads under upstream's own checks, which settles #345 as "follow upstream". One J5 rule stays on top of upstream's: a Crew seat can't be archived alone (D13). Upstream's project create and update and its environment preferences tool were hidden with no J5 reason on record, probably left from when Squadrons existed; they are admitted as upstream ships them. Project delete stays hidden until J5 settles what deleting a project does to the state it keeps for each project (#552). One admitted tool's description named a tool J5 hides; J5 edits that sentence in place (`t3_worktree_handoff` points at `j5_spawn_agent`).

**Decided:** Jackson, 2026-08-29 (substrate session). Omitting bulk creation was a Director disposition (an agent role), 2026-08-31. Withdrawing `t3_thread_wait` was Bryant's decision, 2026-09-14. `delegate_task` returned after Jackson's review of 2026-09-13. Following upstream's access model, its environment-wide reach and its outside-agent sign-in, and admitting the ten new tools, is Jackson's decision of 2026-10-08. Admitting project create, project update and the environment preferences tool is Jackson's decision of 2026-10-11 (#519). Giving an outside agent a ledger identity, and capping all it does at its sign-in level, is Jackson's decision of 2026-10-11 (#498). Recorded in FORK.md cases 2, 4 and 38.

#### D3. J5's tools are pre-approved on Codex and Claude only

**Upstream:** on Claude, upstream pre-approves all of T3's own MCP tools, except in a read-only sandbox, where only its read-only tools are allowed. Codex refuses every non-read-only MCP tool under approval policy `never`, which is the policy full-access mode sends.

**J5:** on Codex, J5 approves its own coordination tools one at a time, Playbook tools included. On Claude, it adds them to the read-only allowance. On every other harness, the provider may show its own MCP prompt once before the Crew roster card, and a read-only persona there can't propose a Crew.

**Why:** without the Codex approvals, `j5_send_message`, `j5_spawn_agent` and `j5_propose_crew` all fail in full-access mode. The approvals are per tool, never server-wide, so worktree handoff, preview and scheduling keep Codex's own verdict. Making other harnesses skip their native prompt is adapter work, and adapters are upstream's. ACP has no trustworthy server identity in its permission request, and Cursor's SDK doesn't expose MCP approval at all. A read-only persona being blocked from proposing is acceptable, because proposing a Crew is enough of a write.

**Consequences:** every advance must keep the Codex and Claude additions and their exact-list tests. A general fix belongs upstream (#276). Crews AC5 must say the roster card is the only human step on Codex and Claude, not on every harness. Muse Code sits with the other non-priority harnesses: it arrives as upstream ships it and J5 does no work for it. Muse doesn't read a persona's instructions or the Crew-seat rule, and in full-access mode it approves tool calls itself.

**Decided:** Bryant built the approvals, 2026-09-10 to 2026-09-15. Jackson's ruling of 2026-09-26 (#233) kept them and limited them to Codex and Claude; Bryant accepted it by narrowing and merging #301 and closing #233 on 2026-09-29. Muse Code: Jackson, 2026-10-08. Recorded in FORK.md's saved-agent mentions section.

#### D4. Agent deliveries queue behind a running turn unless the sender asks otherwise

**Upstream:** a message sent to a busy thread steers the running turn when it can.

**J5:** a message from one agent to another waits until the receiver's turn ends, unless its sender sets `mode` on `j5_send_message` to `steer` or `restart`, upstream's own choices with upstream's meanings. Upstream's default, `auto`, is not offered. Peer updates to a running Codex GPT 6 turn (Astra, Luna, Sol and their point releases) arrive as steers without being asked to.

**Why:** a peer owns nothing about another agent's turn, and upstream's steering was actively harmful. On Claude, a steer aborts the turn and makes the agent report that "the user doesn't want to take this action", a refusal the human never gave. On Cursor, it destroys the turn. The ruling expected this to fold back into upstream: J5 only changed the default value of upstream's own delivery setting, so that it would collapse if upstream shipped a queue option. The GPT 6 models are built to take messages during work. Without the exception, a 36-minute Astra run worked from stale guidance because its peers' updates waited for the end.

**Consequences:** this changes when a message is admitted, not whether the model reads it. Queueing also removed an accidental way of freeing a stuck start, so a queued run's age became something the Fleet page shows. Each advance checks the outbox and follow-up behavior this depends on. Checked on 2026-10-08 against upstream `main`, it is still needed: upstream still steers whenever it can (Claude with `priority: "now"`, which cancels sibling tool calls), and has no GPT 6-specific or asynchronous delivery. **J5 wants to drop this divergence** and follow upstream's delivery once upstream can deliver a message to a running turn without aborting it (Claude) or restarting it (Cursor), and supports the GPT 6 models' in-work messaging. Since 2026-10-11 the divergence is only the default: a sender can ask for a steer or a restart, with upstream's rule that the receiver may not run with broader permissions than the sender, and what is left is that J5 queues where upstream's `auto` would steer. The default is revisited on or after 2027-01-11, because agents are getting better at being steered and that has to reach the cheaper models first. Upstream's Stop holds a thread's queue. A stopped agent's queued messages wait until a person resumes its queue. Upstream starts a message sent to an idle thread at once, past a held queue, and leaves the held messages waiting; a person sees them above the composer and chooses between Resume and a new message. A sender on J5's delivery path sees none of that, so a J5 delivery to an idle agent with a held queue resumes the queue and joins the back: messages run in the order they were sent, whatever held the queue (a Stop, a restart, a provider failure). Upstream refuses to resume a thread that stopped on a usage limit, so a delivery to one waits unsent and joins the back once the thread continues. A person's own message keeps upstream's behavior (Jackson, 2026-10-12). J5 doesn't guard a steer that races a Stop (D5, retired): a peer steer already in flight when the person presses Stop can occasionally wake a GPT 6 agent, and the person stops it again.

**Decided:** Jackson with Product, 2026-09-03 (QS1); the Astra exception by Jackson, 2026-09-04, widened by him to every Codex GPT 6 model on 2026-10-12; the sender's choice of `steer` or `restart` by Jackson, 2026-10-11 ([#519](https://github.com/Jacksondr5/j5code/issues/519)). Recorded in FORK.md case 26.

#### D6. Native resume starts fresh only when the conversation is gone

**Upstream:** when resuming a provider conversation fails for any reason, it starts a new one, primed with a summary, without telling the person. Other failures to start a turn are retried and then fail the run visibly.

**J5:** a new conversation starts only when the provider reports the old one is gone, and the thread says so visibly. Any other resume failure is a visible error. The one other fresh start is deliberate: when an earlier history delivery to the provider is uncertain, J5 skips resume and starts fresh rather than risk a duplicated or half-applied history.

**Why:** a provider's native history can't be rebuilt from the app's transcript. A silent fresh start hands the agent a stranger's memory without anyone noticing. That happened once, after a Codex schema change, and the transfer recorded no error.

**Consequences:** each adapter has to report "conversation gone" for this to work: Codex and OpenCode do, Claude resumes lazily, and the others never report it. J5 follows upstream's retry-then-fail for every other start failure. This is the one exception: a resume failure that isn't "conversation gone" fails the run at once, with no retry and no fresh start. The rule sits on upstream's own start-failure path, and its two fields live in upstream's `provider-core` package, so it is now an edit to a package as well as to the server. Upstream appears to intend the fresh start, so the change offered back upstream (#276) has to argue for it. If upstream declines, the fallback position is a visible fresh start. Checked on 2026-10-08, it is still needed. **J5 wants to drop this patch** as soon as upstream starts fresh only when the provider reports the conversation is gone, and tells the person when it does; the give-back in #276 argues for exactly that.

**Decided:** Jackson, 2026-09-24 (#8), narrowing an earlier refuse-everything rule from 2026-09-04; kept on 2026-10-08 as the one exception to upstream's start-failure handling. Recorded in FORK.md's temporary patches.

### New threads

#### D12. Multi-model send is refused from a persona draft

**Upstream:** a draft can fan out to several models, each in its own thread.

**J5:** fanning out is refused from a persona draft.

**Why:** a persona pins one model, so fanning it out would run every thread on that same model.

**Consequences:** each advance checks that no fan-out path carries a persona.

**Decided:** 2026-09-24 (#7b), a merge-time decision made to let that day's advance proceed. How fan-out should really work in J5 is open (#338). Recorded in FORK.md case 19.

### Archive and lifecycle

#### D13. Archive warns with measured facts

**Upstream:** archiving asks for confirmation only if the person turned that setting on, and the confirmation is generic.

**J5:** when archiving would strand something, such as open asks, running work or Crews, the web dialog lists it, whatever that setting says. A failed read says "Couldn't check". A Crew seat can't be archived on its own from any door.

**Why:** archiving is where obligations get stranded, and cleanup that happens silently is how a fleet loses track of itself. The platform's job is to put the facts in front of whoever decides. Crews archive as a unit: a member's failure is usually recoverable by messaging it again, and a member that can't be recovered has probably contaminated its crewmates.

**Consequences:** the lone-seat refusal is on the server, so it covers every client, but it lets the archive through if the Crew store can't be read.

**Decided:** Jackson, 2026-08-29 (AR2, AR3); the Crew unit rule, Jackson with Product, 2026-08-21 (R14); the server-side seat refusal from Jackson's review of 2026-09-17. Recorded in FORK.md cases 21, 22 and 37.

#### D14. A Crew follows its Captain

**Upstream:** archive, unarchive, settle and unsettle each touch one thread.

**J5:** archiving or deleting a Captain retires its live Crews. Unarchiving it brings back the Crews that retired with it. Settling it settles its seats, except those upstream's own auto-settle would leave alone: a seat that is pinned, snoozed, working, waiting on the person, or about to start. Unsettling it unsettles the seats that were settled.

**Why:** a Crew without its Captain has no one to report to, and the interface would need a place to show it. Before archive cascaded, sidebar archives of Captains stranded sixteen seats. Settle keeps upstream's meaning: a finished run is not a settled seat, but a settled Captain carries its seats with it.

**Consequences:** a Crew restore that stops partway is repaired by hand, by archiving and unarchiving the Captain again. Unarchiving doesn't bring back interrupted runs or dropped Exchanges. Snooze doesn't cascade. The seat rule is upstream's auto-settle rule, called directly, so it follows upstream as upstream changes it: a seat that is pinned, snoozed, working, waiting on the person, or about to start a turn stays as it is, and a dev server a seat left running no longer keeps it from settling. Two exceptions: a seat that opted out of auto-settle, and a seat an earlier unsettle marked active, are still settled with their Captain, because the person settled the Captain on purpose. Upstream's settle-time project script runs once for each seat that settles. Stopping a Crew sends upstream's Stop to each seat, which holds that seat's queue.

**Decided:** archive and delete follow the Crew unit rule (R14) and were built on 2026-09-15. Jackson ratified the rest on 2026-09-26 (#312). The opt-out exception, the per-seat script and upstream's Stop for Crews are Jackson's decisions of 2026-10-08. Recorded in FORK.md case 21.

#### D30. A message from another participant holds a merged thread open

**Upstream:** a thread whose pull request has merged or closed settles once it is idle, unless a person wrote to it after the merge. A message counts when the thread stores it as written by a person: what they typed, a run of a task they scheduled, and the server's "continue" after a usage limit or an answered question. Messages from another agent, a pull-request watch, an agent's scheduled task or background work don't count. The idle-days rule is separate and counts every message and run.

**J5:** a message another participant sent through a tool counts like a person's. That covers agent-to-agent messages, asks and replies, from this server, a machine participant or a peer server; the brief a Peer Agent or Crew seat starts with; and upstream's own agent sends, which include the continuation prompt an agent leaves itself when it hands its thread off to a worktree. Upstream's wakes keep upstream's treatment: a pull-request watch, an agent's scheduled task, background-work and delegated-completion notices, and a restart continuation don't count. J5's platform notices don't count either: silence and lifecycle notices, the Crew launch report, the playbook step relay, the handoff nudge and the seat-finished report.

**Why:** people's messages are not the only kind that matter in a fleet. A Peer Agent or a Crew seat may never get one. Under upstream's rule such a thread counts as untouched since it was created, so a merged pull request on its branch settles it while other agents are still working with it. It should settle when its overall activity settles.

**Consequences:** a thread that gets an agent message after its merge no longer settles on the merge. It settles on the idle-days rule, or never if that setting is off, as upstream already does for a thread a person wrote to. The sidebar's Working order is unchanged: it still follows the last message a person sent. A Captain's seat-finished reports don't hold it open; a seat's own message to its Captain does.

**Decided:** Jackson, 2026-10-09. Recorded in FORK.md case 62.

### Timeline, composer, and plans

#### D16. Agent-to-agent messages render as cards

**Upstream:** a message delivered from another agent appears as if the person had typed it, with only a raw envelope tag to tell it apart.

**J5:** incoming and outgoing agent messages render as cards, as prominent as a user message, naming the sender and linking to its thread. They stay out of the conversation minimap, and queued rows name their sender.

**Why:** the person is a first-class reader of every agent-to-agent message and should see it in the normal flow without hunting. A first, quieter design made the messages hard to spot, so they were made prominent. The minimap tracks the person's own prompts, and agent messages there were noise.

**Consequences:** the seams in the timeline are small, but each advance checks the row and minimap hooks. Sent-message cards recognize only Codex and Claude tool records; other providers keep generic rendering. Upstream's in-thread find searches the cards' text. Upstream is still building out its own agent-to-agent features (see the [upstream convergence watchlist](upstream-convergence.md)), so its treatment of these messages may change. Check this entry at every upstream advance, and prefer upstream's treatment if it now meets the need.

**Decided:** Jackson, 2026-08-29 (TA1–TA5) and 2026-08-31 (TA6–TA8, including cards for sent messages). The minimap rule is from Jackson's PR #168 (2026-09-16). Sender labels on queued rows came from Jackson's dogfood findings (#42, #62), fixed on 2026-09-04. Recorded in FORK.md cases 7, 14 and 24.

#### D17. Plans are stored as artifacts and exported to `plan.md`

**Upstream:** a plan lives inline in the thread, with a download button.

**J5:** finalized plans are stored as project artifacts, and the latest is exported to `artifacts/plan.md`.

**Why:** plans were easy to lose in chat, couldn't be shared between agents, and a folder in the repository needed Git exclusions and could collide with tracked files.

**Consequences:** each finalized plan overwrites the project's one `plan.md`. The path form is undecided.

**Decided:** Tyler, who owns it, in PR #109 (2026-09-05); Jackson approved it on 2026-09-28. Recorded in FORK.md case 33.

#### D18. `@` offers saved personas first, and persona threads pin their model

**Upstream:** typing `@` in the composer opens a picker for referencing context in the message: files in the workspace and, in V2, other threads. Below the text box, the composer has a row of controls for the thread: the model picker (for example "Claude Opus 5.5"), reasoning effort, access mode (for example "Supervised"), and plan mode.

**J5:** `@` also lists saved personas, first, and picking one runs that persona. In a persona's thread, that whole row of controls is replaced by a chip naming the persona, because the persona fixes its own model, effort, and access, and the server rejects any change.

**Why:** Jackson typed `@scout` expecting a persona and got files (2026-09-13); Bryant made the picker list saved personas (2026-09-14). A persona's route is fixed and enforced by the server, so a thread's model picker would only produce failed sends. No reason is recorded for listing personas ahead of threads.

**Consequences:** the `@` menu and the controls row are edits to upstream's composer, one small addition per client. Each advance checks upstream's mention ordering and its composer controls, and personas route only to Codex and Claude.

**Decided:** the persona picker is Bryant's request (2026-09-08) and fix (2026-09-14). The persona model lock comes from Bryant's persona stack, whose scope was approved on 2026-09-08. The ordering against threads arrived in the 2026-09-24 advance (PR #262). Jackson approved it on 2026-09-28. Recorded in FORK.md's saved-agent mentions section and its PR #75–#86 table.

### Storage, install, and identity

#### D19. J5 never shares on-disk state with T3 Code

**Upstream:** T3 Code keeps its data in `~/.t3`, reads `T3CODE_HOME`, and uses a `.t3` folder in worktrees.

**J5:** it uses `~/.j5code`, `J5CODE_HOME`, and `.j5code`, with no fallback to T3's. J5 has its own desktop profiles and keeps its database in its own home. Its app ID (`codes.jackson.j5code`), URL scheme (`j5code`), CLI command (`j5`), and update URLs are its own.

**Why:** J5 and T3 Code must be able to run side by side on one machine without either reading or damaging the other's data, or taking the other's deep links, updates, or system registrations. Nothing in J5 points at upstream's infrastructure.

**Consequences:** some Linux integrations still collide with an installed T3 Code (#138), and many `T3CODE_*` variable names remain. One exception remains, to be removed: SSH transport still writes `~/.t3/ssh-launch` on remote hosts, kept only for npm-era remote servers that no longer exist (#339). Whether to rename the remaining `T3CODE_*` variables is open (#340).

The separate home is what keeps the two products' databases apart. J5 used to refuse a T3 Code database by its migration history as well; it no longer does, because upstream's own migrator now does the renumbering J5 used to bridge. Pointed at a T3 Code database on purpose, J5 would upgrade it. J5 does refuse its own databases from 0.0.43 or earlier, whose upgrade code is retired, with a message to run `j5 update 0.0.48` first.

One read of a T3 location is left in as upstream ships it: the desktop app looks for T3 Code's V1 desktop profile to carry local storage over. It imports nothing, because it takes only entries stored for the app's own address, which in J5 is `j5code://`.

Each advance checks for new upstream reads of `T3CODE_HOME` or `.t3` paths. The 2026-10-08 advance found them in the browser and trace CLI commands, the desktop launcher and the provider sign-in return links, and changed each to J5's.

**Decided:** Jackson, 2026-08-30 (DQ5, recorded on #33), 2026-09-02 (#68), 2026-09-24 (#1, #4), and 2026-10-08 (the history refusal retired; upstream's legacy local-storage import left in). The identifiers were settled in the fork setup plan (2026-08-15) and confirmed by Jackson on 2026-09-28. Recorded in FORK.md cases 15, 25, 31 and 41, and in `BRANDING.md`.

#### D20. J5 installs from its own release archives

**Upstream:** V2 ships self-contained release archives from upstream's own repository.

**J5:** J5 builds the same kind of archive from `Jacksondr5/j5code`, installs a `j5` command, and runs as `j5code.service` (`codes.jackson.j5code.service` on macOS). It hands over from the npm-era service only when that service is J5's.

**Why:** J5 followed upstream from npm to archives rather than keep npm alone. It publishes from its own repository so it never installs or updates T3 Code, and it renames the service so both can be installed at once.

**Consequences:** only darwin-arm64 and linux-x64 get releases, where upstream ships five platforms, and no reason for that is recorded. Other hosts build from source and get no `j5 update` or service. A real service handover, signing and notarization weren't verified when this shipped. Migration steps are in `docs/user/migrating-to-release-archives.md`. Windows releases are wanted (#341).

**Decided:** Jackson, 2026-09-24 (#3, #3a). Recorded in FORK.md cases 40 and 41.

#### D26. `j5 triage` investigates and files against J5's repository

**Upstream:** `triage` hands a misbehaving install to the person's coding agent with a playbook that clones `pingdotgg/t3code` at the installed version, searches and files issues there, and replaces itself with the copy on upstream's `main` when the two differ.

**J5:** the playbook clones, searches and files on `Jacksondr5/j5code`, refreshes from `j5/main`, and names the product J5 Code.

**Why:** J5's release tags don't exist upstream, so diagnosis ran against the wrong source, and J5-only problems would have been filed in upstream's tracker.

**Consequences:** `triagePrompt.ts`, `.github/triage/PLAYBOOK.md` and the `via-triage` issue template are edited in place, so each upstream advance merges upstream's playbook changes by hand. The repository needs the `via-triage` label. Releases installed before this change keep upstream's playbook.

**Decided:** Jackson, 2026-10-04, PR #446. Recorded in `BRANDING.md`.

#### D27. Usage telemetry reports to J5's PostHog project

**Upstream:** the server sends product usage events to upstream's PostHog project by default, and `T3CODE_TELEMETRY_ENABLED=false` turns them off.

**J5:** the same events, identifier and opt-out, sent to a PostHog project Jackson owns. Dev servers send to a second project of his, so development and test runs are not counted as use. A person can set `J5CODE_TELEMETRY_TAG` to label every event their server sends.

**Why:** J5 servers were reporting their users' usage to T3 Tools, which J5 has no agreement with and whose data Jackson can't see or delete. He wants the usage data himself, and J5's privacy page has to name who receives it.

**Consequences:** one default in `AnalyticsService.ts` differs, so each upstream advance checks the token is still J5's. The dev runner and the tag are two more edits to upstream's files (`FORK.md` case 63). The tag is text the person chooses, so the privacy page names it. Jackson is responsible for the data: the project discards client IP addresses, and J5's privacy page describes what is sent. Releases installed before this change keep reporting to upstream's project. There is no Settings toggle, only the environment variable. Upstream's welcome wizard now tells the person about the data; in J5 that sentence names J5 Code and links J5's privacy page.

**Decided:** Jackson, 2026-10-04; the dev project and the tag on 2026-10-10 ([#513](https://github.com/Jacksondr5/j5code/issues/513)). Recorded in `BRANDING.md`.

#### D21. Pair discovery stays inside a worktree

**Upstream:** `pair` is the CLI command that mints a one-time link for connecting a browser or the mobile app to a running server. When it finds no server in the current worktree, it falls back to the default install.

**J5:** in a linked worktree with no running server, `pair` refuses to fall back.

**Why:** during a dogfood test, an agent ran `pair` in its worktree before its server was up, and the fallback minted a real pairing token against the live install (#70). The isolation work (D19) exists so an isolated environment can never reach shared state by accident. A short bounded retry covers a server that hasn't finished starting (#67).

**Consequences:** the retry can be dropped if upstream gives the CLI a way to tell a server that is starting from one that isn't there. Each advance checks `pair`'s home resolution.

**Decided:** introduced in PR #94 (2026-09-04). Jackson approved it on 2026-09-28, closing the carry-or-drop question FORK.md's 2026-09-06 review left open. Recorded in FORK.md's final upstream-file review ("Pair discovery isolation and activation retry") and its `pair.ts` rows.

#### D25. The product is named J5 Code wherever a person or an agent reads it

**Upstream:** the app, its CLI output, error messages, agent instructions and tool titles say "T3 Code", tool rows and the mobile header show the T3 mark, and new worktree branches start with `t3/`, a prefix the person can change in Settings.

**J5:** all of that says "J5 Code" and shows the J5 mark, and new branches start with `j5code/`. Upstream's prefix setting is kept, with `j5code` as its default, and so is its fallback to a flat name (`j5code-<id>`) when a branch called `j5code` is in the way. Upstream's own services keep their names ("T3 Connect", "T3 Account"), as do protocol identifiers such as the `t3-code` MCP server. Documentation keeps upstream's wording.

**Why:** J5 and T3 Code can be installed side by side, and a person should always be able to tell which one they are looking at. The old name kept reappearing because the branding rules left general copy alone.

**Consequences:** these are literal edits in a few hundred upstream files, so every upstream advance has to rebrand the strings upstream added or changed; the grep is in [Merging upstream](../process/upstream-merge.md) and `BRANDING.md` lists what stays. J5's artifact links and badges use upstream's theme tokens, which upstream's raw-color lint rule requires; a proper assessment of J5's colors is [#499](https://github.com/Jacksondr5/j5code/issues/499). Temporary branches named `t3/…`, `t3-…` or the older `t3code/…` are still recognized.

**Decided:** Jackson, 2026-10-04, PR #445; the branch prefix against upstream's new `t3/`, 2026-10-08. Recorded in `BRANDING.md`.

#### D28. The `j5` command

**Upstream:**

- **The executable.** Each release archive's executable is `t3`, and the `t3` command on `PATH` links to it.
- **Updates.** Only `t3 update` moves that link. An update from the app leaves the command on the old version.
- **`PATH`.** When the link's directory isn't on `PATH`, the installer prints a line for the person to add.
- **Agents.** Agents and terminals inherit the server's `PATH`, which has `t3` only if the person's shell provides it.
- **The desktop app.** It keeps a launcher for its bundled CLI in the T3 home, and its Settings has a "t3 command" row whose Install button links that launcher onto `PATH`. Its agents still have `t3` only if the person's shell provides it.

**J5:**

- **The executable is `j5`.** The command, the file it runs, and the process are all `j5`. Archive file names keep upstream's `t3-<version>-<platform>` names.
- **Existing servers are moved once, by hand.** The rename is launcher protocol 4. A server from before it is refused the update from the app with a message to run `j5 update` on its machine; that command installs the new version and replaces the service's launcher. Each archive carries a `t3` link to `j5` so those servers can run that check and that command.
- **The command follows the service.** When the background service's server starts as the committed version, after an update or any restart, it repoints the installer's `~/.local/bin/j5` at itself.
- **The installer puts it on `PATH`.** When `~/.local/bin` isn't on `PATH`, the installer adds one marked line to the shell's startup file (zsh, bash, or fish) that puts the directory last, and `j5 uninstall` removes it. A profile it can't write gets the printed hint instead, and `J5CODE_NO_MODIFY_PATH` skips the edit.
- **Agents get the server's own `j5`.** A release server keeps `<home>/bin/j5` pointed at itself, and every server that finds a `j5` there puts `<home>/bin` first on the `PATH` its agents and terminals inherit.
- **The desktop app uses upstream's launcher, renamed.** At every launch the packaged app writes a launcher for its bundled CLI to `<home>/bin/j5`, which its server then puts first for its agents. It leaves the person's own `PATH` alone unless they ask: Settings → General → About has upstream's row, titled "j5 command", whose Install button links the launcher into a folder on `PATH` and whose Remove button takes it off again.

**Why:**

- **The name.** J5 shouldn't point at `t3` at all. With the old name, `~/.local/bin/j5` ran a file called `t3` and the server showed up as `t3`, which is confusing next to an installed T3 Code. Archive names stay, because existing servers download updates by those names and people never see them.
- **The one-time step.** An update from the app never replaces the service's launcher, and an old launcher starts every new version as `t3`. Shipping a `t3` link indefinitely would leave the migration unfinished, and removing it later would break those servers. Refusing the update with a clear message moves each server and its launcher across together.
- **Following updates.** On the dogfood box the command ran 0.0.44 while the service ran 0.0.47, so agents called a CLI three versions behind their server (#398). Upstream has the same gap with `t3`; the fix is in the give-back backlog (#276).
- **The installer and `PATH`.** A stock macOS shell doesn't have `~/.local/bin` on `PATH`, so a fresh install's `j5` wasn't found until the person edited their profile (#397). Jackson chose a profile line over linking into `/usr/local/bin`, which needs an admin prompt and a root-owned file the server couldn't repoint.
- **Agents.** An agent that can't find `j5` tends to work around it without saying so. Giving every agent its server's CLI, whatever the person's shell setup, removes that failure. The directory is J5's own and holds only `j5`, so it can go first without shadowing anything, including an installed T3 Code's `t3`.
- **The desktop app.** Agents were the actual problem, and they don't need the person's shell changed. J5 first built its own launcher and a command-palette install for the person's terminal. Upstream then shipped the same two things, so J5 took upstream's and renamed them. That moved the install from the command palette to Settings, and upstream's Install adds no line to a shell startup file.

**Consequences:**

- **One visit per existing server.** Each server on 0.0.47 or earlier needs `j5 update` run on its machine. It keeps running its old version until then.
- **The launcher reads protocol-3 state files.** The old CLI's `j5 update` writes one before starting the new launcher. This is a second line in upstream's `serviceProtocol.ts`.
- **The `t3` link is temporary.** Removing it is tracked in #440. After that, a server still on 0.0.47 or earlier gets a generic install error and needs the installer and `j5 service install`.
- **No downgrade across the rename.** Downgrading below the rename with `j5 update --allow-downgrade` isn't supported.
- **Only the default link is repointed.** The repoint covers only the installer's default link, `~/.local/bin/j5`, and only when it already points into the home's runtime. A link placed elsewhere stays where it is.
- **One `j5` per home for agents.** If two servers share a home, the last one started owns `<home>/bin/j5`.
- **The app no longer replaces a `j5` it did not write.** J5's own launcher overwrote whatever was at `<home>/bin/j5`. Upstream's leaves a file it didn't write. When a release server shares the app's home, its link stays, and the app's agents run the server's `j5`.
- **`j5 uninstall` can leave an app-installed link.** It knows the `~/.local/bin/j5` link; upstream's Install can link into other folders on `PATH`. Settings → Remove takes it off.
- **`j5 service status` asks for a repair after an update from the app.** The service's unit still names the launcher it was installed with, and the now-current `j5` reports that as needing `j5 service install`. That is accurate: running it replaces the launcher, with a restart. An agent that follows the suggestion restarts its own server. Keeping the launcher current is a separate improvement.
- **`j5 uninstall` removes the `PATH` line only with its command.** The installer's link and its line go when the link belongs to the home being uninstalled, so uninstalling another home, such as an agent's scratch home, leaves them.
- **A terminal can still find another `j5` first.** The directory is first for what the server starts directly. A shell that re-reads the person's profile can put their own directories, and a `j5` in them, ahead again.
- **At each advance:** check new upstream code that locates the executable by name, upstream's `SERVICE_LAUNCHER_PROTOCOL` (J5's number must stay above it), and that the startup hook still runs after `prepareTrial`.

**Decided:** Jackson, 2026-10-02 (#403), 2026-10-03 (the protocol bump and the `j5 update` step; #398; #397, including leaving the person's `PATH` alone in the Mac app), 2026-10-04 (#441, in the command palette only) and 2026-10-08 (upstream's launcher and Settings row, renamed, which revises the palette-only ruling). Recorded in FORK.md cases 50 to 53 and 57; cases 54 and 55 are retired.

#### D29. A client refuses a J5 server whose ledger has not been re-keyed

**Upstream:** a client connects to any server that speaks its orchestration protocol version.

**J5:** the same, with one refusal. A J5 server from before the ledger was re-keyed to projects is refused, with upstream's own message: "This client requires a newer server. Update the server on <name> to connect." The client recognizes it by the old ledger capability it reports.

**Why:** the client's Fleet, Inbox and thread cards read a project-keyed ledger. Against a J5 server that has not been updated they would show nothing, with no error. Refusing says what to do.

**Consequences:** a J5 server, the desktop app and the mobile app have to be updated together when this ships. Nothing changes for upstream's own servers: a server with no J5 ledger, plain T3 Code included, connects as it always has, and the J5 views report that source as unsupported. The other direction has no gate, because closing it would mean changing upstream's protocol version number, which would collide at the next advance. An older client still connects to a newer J5 server, and the server tells it that its Fleet, Inbox and Crew requests are not supported there, so it shows them as unsupported and reads nothing. Two things in an older client are not covered. A person on one cannot see or approve a Crew roster until they update, because the proposal does not appear above the composer. And archiving a thread warns that it could not check the thread's open work; the server still refuses to archive a single Crew member, but the older client no longer explains why.

**Decided:** in the plan to retire Squadrons ([#412](https://github.com/Jacksondr5/j5code/issues/412)): a strict version gate for clients, narrowed on 2026-10-08 to J5 servers only. Recorded in FORK.md case 56.

#### D31. A project's repository follows `gh repo set-default`

**Upstream:** a project's repository is the remote named `upstream` when there is one, then `origin`. A fork with both is treated as its parent, so the `#` picker and the pull request view show the parent's pull requests.

**J5:** the remote marked by `gh repo set-default` comes first. A checkout with no mark behaves as upstream's does.

**Why:** J5 Code is itself a fork developed as its own product, so its pull requests live on the fork. Upstream's rule assumes a fork exists to contribute to its parent. `gh repo set-default` is where a person already records which repository their pull requests belong to, and upstream's own pull request creation and lookup read it, so this needs no setting.

**Consequences:** a temporary patch to one upstream file, ported from upstream's open pull request pingdotgg/t3code#14291 (which fixes pingdotgg/t3code#15023). Each advance checks whether it merged, or whether upstream settled fork remotes another way (pingdotgg/t3code#17314). **J5 drops this patch** and follows upstream's rule when either happens, even if the rule differs. Other features still choose a remote by their own rules, as upstream's do.

**Decided:** Jackson, 2026-10-11. Recorded in FORK.md's temporary patches.

#### D32. A server's name can be set with `J5CODE_SERVER_NAME`

**Upstream:** a server names itself after its machine: the host's friendly name, then its hostname, then the folder it was started in. Nothing overrides that, so two servers on one machine report the same name.

**J5:** when `J5CODE_SERVER_NAME` is set and not blank, it is the server's name. Unset or blank, the server names itself as upstream's does.

**Why:** in a two-server peering test on one host both servers were `openclaw`, so neither agents nor people could tell which participant lived on which server. Giving the second server its own hostname namespace was rejected: the process looks like root inside one, which provider CLIs and the browser sandbox may react to. We need agents to be able to reliably test these scenarios.

**Consequences:** one import and one early return in `ServerEnvironmentLabel.ts` (`FORK.md` case 67). The name is read once, when the server starts. Processes a server starts inherit its environment, so a server an agent starts from a named server takes the same name unless the variable is unset or set again. There is no setting or flag, only the environment variable. Upstream has the same clash, so this is a candidate to offer back ([#276](https://github.com/Jacksondr5/j5code/issues/276)).

**Decided:** Jackson, 2026-10-11 ([#545](https://github.com/Jacksondr5/j5code/issues/545)). Recorded in FORK.md case 67.

### Access

#### D33. A guest's connection reaches only what it was granted

**Upstream:** a connection's permissions cover the whole server. A paired device that may read conversations may read every thread and project, and is sent the server's full configuration: its folders, network addresses, provider accounts and settings.

**J5:** a connection paired as a guest is narrowed to its grants. Every HTTP route and WebSocket request is refused unless J5 has listed it, and a listed thread request is checked against the guest's grants. Three answers a client cannot connect without are given in a reduced form. The configuration keeps the server's id, version, name and platform (the last two are what upstream's public descriptor at `/.well-known/t3/environment` already gives anyone who can reach the server), its sign-in descriptor (whose cookie name contains the server's port), and each enabled provider's name and models; it and the lifecycle welcome name nothing else of the host. The sidebar holds only the threads the guest's grants cover, with their projects reduced to an id, a title and the icon a person chose for the project, and each thread's worktree path replaced. A project whose icon is a favicon file shows upstream's default icon to a guest: the client asks for that file by the project's folder, and the link upstream signs for it names the folder in the clear. A guest may ask for the images and files attached to the messages of a thread it was granted, and a tool's images in one, each checked against the server's own record of which thread holds it. A guest who holds a grant on a project may list and read that project's artifacts and is told when they change; a grant on a thread gives none, and no guest can write or delete one. A member's connection gets upstream's answers unchanged; its client asks once per connection whether it is a guest's, and nothing it does waits on the answer.

A guest is brought in with one of upstream's own single-use pairing links, which a member who holds Manage access makes for a named person. The link is marked as a guest's and carries three of upstream's permissions (view, operate tasks, control previews); it cannot carry any other. The session it pairs is recorded as that guest's at the moment it is issued, or is not issued at all, and the link cannot be used as the pairing code that approves an MCP client.

**Why:** [Shared server](features/shared-server.md) lets a person who is not a member see one thread or project. Upstream has no notion of a person or of access below the whole server, so pairing a guest with upstream's permissions would show them everything. Both lists refuse by default so that what upstream adds later is closed to a guest until someone decides otherwise. Requests keyed by a folder the client names are refused outright rather than checked against the thread's checkout.

**Consequences:**

- **Three more upstream files carry the pairing refusal's reason** (`FORK.md` case 70): `contracts/src/environmentHttp.ts`, the server's `auth/http.ts` and web `environments/primary/auth.ts`.
- **Eight upstream files carry a small edit** (`FORK.md` case 69), through every advance: two on the server (`server.ts`, `ws.ts`), one call in each chat view and in the web thread action menu (web `ChatView.tsx` and `hooks/useThreadActionMenu.ts`, mobile `ThreadRouteScreen.tsx`), and three one-line registrations of J5's sharing request (`contracts/src/rpc.ts`, `client-runtime/src/rpc/client.ts`, `client-runtime/package.json`). The rest is J5's own code.
- **Upstream's pairing code carries one edit** (`FORK.md` case 70): where it issues a session from a pairing link, a guest's link goes through J5, and a guest's link is refused as an MCP approval code. Pairing any other device is unchanged. `server.ts` gains one line beside case 69's.
- **A guest's link lasts as long as the member chose**: one hour, a day, seven days (the default) or thirty, where upstream's pairing links last five minutes, because it is sent to another person to open when they can. It is single use, and a member can revoke it before it is used.
- **A guest is told who else is on a thread it was granted** (Jackson, 2026-10-12): the names and levels of the guests who reach that thread, how each reaches it (the thread, a thread above it, or the project), and how many members there are. It is told no one's id, devices, links or other grants, and nothing of a thread it cannot see. A count that moves when that list changes lets a client ask again.
- **A name belongs to one person on a server** (Jackson, 2026-10-13). No one is given a name another person there already has, compared after folding (compatibility-normalised, lower-cased, trimmed, whitespace runs made one), so "jackson", " Jackson " and "JACKSON" are one name; look-alike letters across scripts are not caught. The name is stored and shown as typed. A unique index on the folded name holds it under concurrent writes.
- **A member's client is told when the people it lists change.** J5's change stream (`j5.reads.subscribeChanges`) carries a `sharing` counter that moves when a person, a name, a grant, a device or a share link changes. A guest is refused that stream, and follows the one thread it has open.
- **The owner has a name, and there is one owner.** A member who holds Manage access sets the name of the person the server belongs to. It is stored on the local operator's existing person row, under the same rules as any name, and is what guests and agents know them by; until it is set there is none and none is invented. Every connection that is not a guest's is that one owner today, as it is for the inbox, so a second person paired with an ordinary pairing link is shown under the owner's name; several named members on one server is set aside ([#542](https://github.com/Jacksondr5/j5code/issues/542)). A member's client is told the owner's name, or that there is none, in the answer it already asks for once per connection, at the cost of one read of one row. Bringing a new person in (creating a guest, making a share link or an open link) is refused until the owner has a name; giving more access to someone already there is not. Agents see the name as the `display_name` of the person's row in `j5_list_participants`, which had none before; nothing else about that row, the tool or what agents are told changes. A guest of a thread is told the owner's name as one of the people on it, and nothing else about them.
- **Every person's name is one line of visible characters**, whoever typed it: no control characters, line breaks, invisible or unassigned characters, no square brackets, and no more than two combining marks in a row. A name is shown to everyone on a shared thread and goes on that person's messages to an agent, inside a bracketed line that says who wrote each one, which a bracket in a name could make read as two. Parentheses are allowed.
- **Upstream's Connections settings list a guest's link and a guest's devices among the rest**, under the guest's name. Upstream's own pairing route still makes only ordinary links.
- **A member who opens a guest's link stays a member.** Upstream replaces a browser's session with the one a pairing link pairs, so a member opening a guest's link in a browser where they are signed in would become that guest. J5 refuses that exchange before upstream sees it: the member's session is untouched and the link is not used up, so it still works for the guest. A browser with no session, one whose session is over, and a guest's browser pair as upstream has them. The refusal is upstream's rejected-credential answer with one optional key added to say why, and upstream's web pairing page shows "You are already signed in to this server as a member. This link is for a guest: send it to them rather than opening it." where it would show "Invalid pairing token" (Jackson, 2026-10-12; three upstream files, `FORK.md` case 70). A client from before this ignores the key and shows the old text. A mobile or desktop client pairs through `/oauth/token`, which carries no earlier session, so the server cannot tell there. Pairing a browser that has no session costs nothing more; one that has a session costs one read of J5's record of guest links.
- **A guest's link spent on the MCP consent page is used up as well as refused**, since upstream spends a pairing code before it is checked.
- **Ending a guest's device empties its open connection, from J5's request or from upstream's Connections settings.** Upstream leaves a revoked session's open socket open; J5 cuts a guest's session loose from its guest before upstream ends it, so its open feeds end and its requests find nothing. Ending a member's device costs one extra delete that matches nothing. The same holds when a guest's browser pairs again and upstream replaces its old session: the old one is cut loose first. A session that ends by expiring passes through none of this, as for a member upstream: an expired guest session's open socket reads until it drops.
- **Each advance checks two things**: whether upstream added another place that sends configuration, lifecycle events or sidebar items, and whether every route still signs in through the two functions J5 wraps.
- **Whether a connection may write to a thread is asked of J5.** Upstream's chat view decides it from one server-wide permission. On web and mobile it now asks J5, which gives upstream's answer for a member and, for a guest, also requires a Collaborate level on that thread. The server tells the client that level and keeps it current as grants change. A guest with View gets what upstream shows a connection that lacks "Operate tasks".
- **The web thread action menu asks J5 too**, so a View guest's menu shows rename, archive, delete and the other changing actions disabled, as upstream shows them to a connection without the permission (Jackson, 2026-10-12).
- **Upstream's other controls still read the server-wide permission.** A guest is offered rename by double-clicking the title, fork from a response, mark unread, the terminal toggle, project scripts, new thread, add project and the git and branch controls, and on mobile the thread rows' swipe and menu actions. The server refuses each. Upstream's own background requests (branch lists, the activity report, automations) are still sent and refused. A guest can open the model and access pickers and change its own unsent selection, which reaches nothing.
- **J5's own surfaces go quiet for a guest.** Its inbox, Fleet, Crew and Playbook reads stop once a connection is known to be a guest's; a guest's client may send one first round of them, which the server refuses. J5's Personas and Playbooks pages leave a guest server out.
- **A guest is told each enabled provider's id, kind, display name and models**, and nothing of its sign-in, version, health, paths, usage, skills or commands. Without the list upstream's composer tells a guest to enable a provider in Settings; with it a View guest gets upstream's read-only composer. A custom model's name is whatever a member typed.
- **A guest's sidebar feed never resumes.** The HTTP sidebar snapshot is refused to a guest, whose client falls back to the socket's feed. That feed always starts from a full snapshot, and starts again when the guest's grants change. A guest sees no archived threads.
- **An attachment link outlives its grant by up to an hour.** Upstream's asset links are signed, time-limited and need no sign-in.
- **Not served to a guest:** pages and documents a tool published (`html_render`, MCP Apps), and the preview browser ([#540](https://github.com/Jacksondr5/j5code/issues/540)).
- **The alternatives** were to follow upstream, which means no guests; to run a second server for each guest, which gives up the shared conversation; and to check each request against a deny-list, which fails open when upstream adds a request.

**Decided:** Jackson, 2026-10-09 ([multi-player session](../worklog/2026-10-09-multi-player-session.md)) and 2026-10-11 ([#531](https://github.com/Jacksondr5/j5code/issues/531), [#532](https://github.com/Jacksondr5/j5code/issues/532): folder-keyed requests refused, a reduced configuration, the preview browser set aside). Per-thread levels in the client: Jackson, 2026-10-12 ([#532](https://github.com/Jacksondr5/j5code/issues/532)); reporting a View guest as lacking "Operate tasks" was dropped because it cannot express View on one thread and Collaborate on another. Recorded in FORK.md case 69.

### Awaiting a decision

These already diverge on `j5/main`, but no human ruling is on record. Each landed as an implementer's call inside a merged PR. The person rules on each one; an approved entry moves up into its section, and a rejected one becomes a fix.

#### D22. Agent-spawned threads move under their spawner in the sidebar

**Upstream:** every thread except provider subagents appears in the sidebar.

**J5:** an agent-spawned Peer Agent, Crew seats included, leaves the top level of the sidebar unless pinned, and appears in the expander under the agent that spawned it.

**Why:** once agents spawn agents, a flat list stops telling the truth about what is running (Bryant, #205).

**Consequences:** this differs from the Fleet page definition (AC3: nothing is hidden from the sidebar because of how it was created), though the agent stays one click away in the expander rather than hidden. Jackson set aside the original rule (SB5) on 2026-09-04, because he has the Director spawn most of the agents he talks to. The Crews definition hides only Crew members. Pinning a spawned agent from its own thread brings it back to the top level. An agent spawned into another project has no parent in that project's tree, so it stays at the top level there (#519). So does an agent an outside agent starts, since an outside agent is in no project's tree (#498).

**Status:** reintroduced in PR #149 (Bryant), approved in review on 2026-09-21 without a ruling on this point. Depends on the human-contact spectrum discussion (#336): which agents belong in the sidebar follows from where they sit on that spectrum.

### To be removed

The person ruled against these. They still diverge on `j5/main` until their fix lands, and then move to Retired.

#### D24. Astra model aliases

**Upstream:** no short aliases for `gpt-6-astra`.

**J5:** `astra`, `gpt-6` and `6` resolve to `gpt-6-astra`.

**Why:** to mirror the Fable aliases that existed at the time, which upstream has since removed.

**Consequences:** D4's GPT 6 exception checks the resolved name, so removing the aliases needs checking against it.

**Status:** introduced in PR #101 (2026-09-04), merged on the Director's authority. To be removed in favor of upstream (#342). Recorded in FORK.md case 32.

### Retired

#### D10. Welcome wizard assigns imported conversations a Squadron

J5 added a fourth stage to upstream's welcome wizard that gave each imported folder's conversations a Squadron home (Jackson, 2026-09-17, PR #178). Retired 2026-10-04 in the plan to retire Squadrons ([#412](https://github.com/Jacksondr5/j5code/issues/412)): the wizard has upstream's three stages again. Imported conversations register in their project like every other thread since the ledger re-keyed to projects (2026-10-07).

#### D8. Acting on another agent also requires a shared Squadron

On top of upstream's same-project rule, J5 required a shared Squadron to archive or unarchive another agent and to merge back (Jackson, 2026-09-28). Retired 2026-10-07, when the ledger re-keyed to projects ([#412](https://github.com/Jacksondr5/j5code/issues/412)): a thread's home is its project, so upstream's same-project rule was the only rule. Upstream has since dropped that rule for thread tools, and J5 follows it (D2).

#### D9. A thread's Squadron is created for it

A thread launched without a Squadron registered into its project's Squadron, which the server created when the project had none (Jackson, 2026-10-03). Retired 2026-10-07 ([#412](https://github.com/Jacksondr5/j5code/issues/412)): there are no Squadrons. Every thread except a provider Subagent is a participant in its own project's ledger from the moment it exists, and a server that upgrades registers the threads it already has. A rule the Squadron definition held beside this entry, that the platform never creates an unnamed default container ("no junk drawer"), is reversed by name: J5 accepts upstream's "No project" project as upstream ships it, one per environment for threads started without a project (Jackson, 2026-10-05). It arrives with the next upstream advance and is no divergence.

#### D11. A scheduled task can't start a thread in a project that several Squadrons share

A scheduled run was refused before creating a thread when several Squadrons referenced its project (narrowed to that case on 2026-10-03). Retired 2026-10-07 ([#412](https://github.com/Jacksondr5/j5code/issues/412)): a scheduled task starts a fresh thread as it does upstream.

#### D5. A committed Stop wins over a racing steer

Once a Stop was committed, J5 kept a steer the provider had accepted before it from starting a new turn. It arrived with the 2026-09-17 upstream integration and Jackson kept it on 2026-09-24. Jackson ruled on 2026-09-28 that controlling a thread's turns is upstream's area and this is a race J5 doesn't design for. Removed 2026-10-08 ([#343](https://github.com/Jacksondr5/j5code/issues/343)): J5 runs upstream's code. Upstream's Stop holds the thread's queue, which covers queued messages; a peer steer already in flight to a GPT 6 agent can still wake it (D4).

#### D7. Codex CLI version floor

J5 refused Codex CLIs older than 0.151.0 with a named error, because older CLIs omitted fields the schema required (PR #92, 2026-09-04; approved by Jackson on 2026-09-28). Retired 2026-10-08 (Jackson): J5 follows upstream's provider compatibility table, which warns about a version and doesn't block it. J5 reads that table with the upstream version it is based on, because J5 keeps its own version numbers (FORK.md case 59).

#### D15. Archive Undo is withheld when Crews may retire

J5 hid Undo on an archive that might retire a Captain's Crews, because unarchiving the Captain didn't bring them back (Jackson, 2026-09-24). Retired in [#312](https://github.com/Jacksondr5/j5code/issues/312), when unarchiving a Captain began restoring its Crews (D14): every archive door offers upstream's Undo again. This register listed the entry as live until 2026-10-08.

#### D23. A committed Stop also blocks usage-limit auto-resume

J5 kept a run from resuming after a usage-limit reset when the person had pressed Stop on it first. It was added during the 2026-09-24 advance without its own decision, as an extension of D5. Jackson ruled on 2026-09-28 that it is an edge case J5 doesn't design for. Removed 2026-10-08 ([#343](https://github.com/Jacksondr5/j5code/issues/343)) with D5.

## History

- 2026-09-26 — created: the three zones, the decision protocol, and the register, seeded from FORK.md and the worklog records (Jackson, [#327](https://github.com/Jacksondr5/j5code/issues/327)).
- 2026-10-04 — D25 added: user-visible copy, marks and branch names (PR #445).
- 2026-10-04 — D26 added: `j5 triage` points at J5's repository (PR #446).
- 2026-10-04 — D28 added: the `j5` command (PR #414).
- 2026-10-07 — D8, D9 and D11 retired and D29 added: the ledger re-keyed to projects ([#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-08 — D9 records the accepted reversal of "no junk drawer": upstream's "No project" project is taken as upstream ships it (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-08 — the advance onto upstream `main`: D5, D7 and D23 retired, D15 recorded as retired, D8's retired text corrected, and D1, D2, D3, D4, D6, D14, D19, D25 and D28 rewritten for what upstream now ships (Jackson's decisions of that day).
- 2026-10-09 — D30 added: a message from another participant holds a merged thread open (Jackson).
- 2026-10-09 — D1 rewritten: J5's instruction text lives in upstream's shared provider package and reaches Pi (Jackson).
- 2026-10-11 — D32 added: a server's name can be set with `J5CODE_SERVER_NAME` (Jackson, [#545](https://github.com/Jacksondr5/j5code/issues/545)).
- 2026-10-12 — D4 widened: its exception covers every Codex GPT 6 model, not Astra alone (Jackson, [#569](https://github.com/Jacksondr5/j5code/pull/569)).
- 2026-10-11 — D2: upstream's project create, project update and environment preferences tools are admitted; project delete waits on #552 (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
- 2026-10-11 — D4 narrowed to the default: a sender may ask for a steer or a restart (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)); revisiting the default is [#538](https://github.com/Jacksondr5/j5code/issues/538).
- 2026-10-11 — D22: an agent spawned into another project stays at the top level of the sidebar (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
- 2026-10-12 — D2 and D22: an outside agent starts agents with `j5_spawn_agent`, capped by its sign-in level, and they stay at the top level of the sidebar (Jackson, 2026-10-11; [#498](https://github.com/Jacksondr5/j5code/issues/498)).
- 2026-10-12 — D33 added: a guest's connection reaches only what it was granted (Jackson, [#532](https://github.com/Jacksondr5/j5code/issues/532)).
- 2026-10-12 — D33: the chat view asks J5 whether a connection may write to a thread, so a guest's level is per thread (Jackson, [#532](https://github.com/Jacksondr5/j5code/issues/532)).
- 2026-10-12 — D4: a J5 delivery to an idle agent with a held queue resumes the queue and runs after the held messages (Jackson, [#580](https://github.com/Jacksondr5/j5code/issues/580)).
- 2026-10-12 — D33: a guest is brought in with an upstream pairing link marked as a guest's, tied to its person as the session is issued (Jackson, 2026-10-11; [#535](https://github.com/Jacksondr5/j5code/issues/535)).
- 2026-10-12 — D33: a guest sees a project's chosen icon; the pairing page says why a member's browser was refused a guest's link (Jackson; [#535](https://github.com/Jacksondr5/j5code/issues/535)).
- 2026-10-13 — D33: a name belongs to one person on a server, and the owner has a name (Jackson; [#535](https://github.com/Jacksondr5/j5code/issues/535)).
