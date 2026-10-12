---
title: "Fleet page and sidebar"
kind: definition
---

# Fleet page and sidebar

## Problem

The more agents a person runs, the less they can see. Upstream's sidebar is a recency-sorted list of conversations, which serves the agents a person is talking to and hides everything else: an agent spawned by another agent, an agent that stopped an hour ago, an agent waiting on a reply nobody knows it sent. Asking an agent how it is doing does not work either, because agents answer from context rather than measurement ([problems](../problems.md): fleet observability; human attention is scarce). The Fleet page is where the state of every agent the person is not talking to can be read.

## Definition

A person's attention splits across three surfaces, each with one job:

- The **sidebar** holds conversations in motion: the agents the person is actively talking to, sorted by recency the way upstream users expect.
- The **inbox** holds what needs the person: open asks, and nothing else ([inbox](inbox.md)).
- The **Fleet page** holds the health of everything else: every agent, with facts the platform measured, whether or not anyone is talking to it.

**The sidebar** is upstream's sidebar, with its project grouping and its mechanics for snoozing, settling and pinning untouched. Each row names the agent's project as upstream shows it, with the title and a status label. An agent that another agent spawned sits in the expander under its spawner, and at the top level only when pinned. No agent leaves the sidebar because of how it came to exist; a person who asks one agent to spawn most of the agents they talk with still finds them there, under that agent. Which agents a person is expected not to talk to is a question for [Crews](crews.md), not for a filter.

**The Fleet page** is a full-width page in the main view, reached from an entry at the foot of the rail that carries a badge, and from the command palette. It shows **every project of every connected environment on one page**, in three sections that answer three different questions. The sidebar stays as it was; the page does not replace it.

- **Active**, at the top, is one table: what is in motion. Every agent that is running, failed, waiting on a person, idle, or unknown, and every Crew that still has such a seat.
- **Settled**, beneath it and collapsed by default, holds the agents and Crews that upstream's settle mechanic has marked done (upstream settles by hand, by merged PR, or by idle days, and the platform settles nothing on its own). Nothing here is running and nothing needs anyone; it is kept in reach, not in view.
- **Retired**, at the bottom and collapsed by default, lists the Crews that were archived, across every project.

The rows of the Active and Settled tables are **agents**: every agent participant, arranged as the placement tree with siblings in creation order. Each tree's root row names its **project**, and when several environments are merged, the environment beside it; the rows beneath a root belong to the same project, because a placement tree never crosses one. Roots are grouped by upstream's logical project, so the copies of one project on two machines sit together. People are never rows; they appear as counterparties in an agent's asks. Provider-native Subagents never appear; upstream's own panel is their home. Rows keep their positions. A problem marks a row; it never moves one.

An agent's **placement** is where it sits in that tree: under its spawner, and at its project's root when no agent in that project spawned it. An agent started from another project, or by an [outside agent](../a2a/index.md#participants), is at the root. Whoever briefs an agent commands it, so the tree shows who is running what. An agent's **provenance** is the recorded fact of how it came to exist — spawned by a named agent, forked from another, or unrecorded — written once and never changed. The named spawner may be an outside agent, which is in no project and is shown by the label it signed in with. Neither restricts who may message whom; the tree carries decisions, never messages.

**Settled is a measurement, not a mood.** An agent is settled when its thread shell says so, the same fact the sidebar and a Crew's state summary read, and only when nothing outranks it: a running turn, a failed last run, or a pending approval or input keeps an agent Active whatever its settle mark says. Idle is not settled: an agent that merely stopped talking stays Active, because silence proves nothing ([principles](../principles.md): never guess). An agent the client cannot read is unknown, and unknown is Active. A Crew is settled as a unit when every seat, and everything placed beneath a seat, is settled. A placement tree is placed by its root and never split: it moves to Settled only when the root and every agent and Crew beneath it are settled, and otherwise stays whole in Active, where a settled root's status cell reads "Settled" so the reader sees why the tree has not moved. A Settled row is still the agent: clicking it opens its thread, and a settled Crew still offers Archive crew, though never Stop crew, since nothing runs.

Each row answers four questions, and the page's job is done when every row answers all four or says plainly that it cannot:

1. **Is it doing anything right now?** Its status, as the runtime reports it.
2. **Is anyone waiting on it, or is it waiting on anyone?** Its open asks, owed and awaited.
3. **When did it last do anything?** Its latest measured event, labeled by what the event was.
4. **Is there a measured problem?** A failed run, a delivery alarm, a run that never started.

Everything on the page is a **measurement**. There is no health score, no "stalled", no reordering by urgency, and no guess: an unknown fact renders as unknown with its reason, because a visible gap beats a plausible fake ([principles](../principles.md): never guess; status is read, never asked). Silence notices are not shown here: with several open asks a notice is ambiguous, and "ended without replying" is a judgment the person makes, so the age of the open ask carries the fact instead. The page states which environment it read and as of when. Clicking a row opens the agent's thread.

The **badge** on the rail entry counts agents with a measured problem across every project the page can read, so the person learns that something is broken somewhere even while the page is closed. It never counts what the inbox bell counts: the bell is where agents tell the person something, the badge is where the platform does, and one fact is counted once.

A retired agent is never a row. The agents placed beneath it keep working and render at their project's root; a Crew's seats retire with their Crew, and what retired is read in the Retired section rather than in the tree.

Cost is a product surface: what a project costs, and what each of its agents contributed, rolls up on this page and nowhere in between ([fleet vision](../fleet-vision.md)).

The Fleet page is **not** the inbox: it never demands a reply. It is **not** a permission or visibility boundary: any agent stays reachable and messageable whatever surface it appears on.

## Acceptance criteria

### The sidebar

1. Retired (see History).
2. A sidebar row shows the agent's project and a relative time on its first line, the title on its second, and the status label with the provider icon on its third; worktree and branch live in the hover tooltip, which also carries a measured status line.
3. No agent thread leaves the sidebar on account of how it was created: an agent-spawned agent appears in the expander under its spawner, and at the top level when pinned. Snooze, settle and pin behave as upstream defines them.

### Entering the page

4. The Fleet page opens from a rail-footer entry and from the command palette, as a full-width page in the main view.
5. The page shows every project of every connected environment at once, in three sections in this order: Active, Settled, Retired. Active is an open table; Settled and Retired are expanders, collapsed by default, and an empty Settled or Retired section is omitted rather than shown empty.
6. The page has no project selection of its own, and the sidebar stays as it was while the page is open.
7. Each tree's root row names its project in a Project column, and when the page merges several environments the environment's label follows the project name on that row; rows beneath a root carry no project cell, since a placement tree lives in one project. Roots are grouped by upstream's logical project, so one project's copies on several environments sit together.

### The rows

8. The rows are every agent participant of the projects read, with no cap on their number; a large fleet is paged or virtualized, never silently truncated.
9. Rows are arranged as the placement tree, siblings in creation order, and are never reordered by activity or by problems.
10. People are never rows; a person appears only as the counterparty on an agent's asks. Provider-native Subagents never appear.
11. A retired agent is not a row; an agent still live beneath it renders at its project's root.
12. Each row shows its provenance as a fact: spawned by which agent, forked, or unrecorded. An outside agent that spawned it is named by its label.
13. Retired (see History).
14. Clicking a row opens the agent's thread.

### The four facts

15. Status shows the runtime's own fact: Working, Waiting, Approval, Input or Failed; "Waiting to start · Nm" takes precedence while a run has been requested and not dispatched; "Idle since ⟨time⟩" appears only when nothing is active and no background work remains.
16. Read and snooze bookkeeping (upstream's Woke and Done) is not a status and does not appear.
17. Silence notices are not shown on the page; the age of an open ask is the visible fact.
18. Open asks show two counts, "Owes N" for open asks the agent must answer and "Awaiting N" for open asks it is waiting on, with a hover list of counterparty, intent and age; a follow-up joined to an open Exchange counts once.
19. Last activity is the latest measured event, labeled by what it was (for example "last turn ended 14:02"); the page never shows a vague "last seen".
20. Any fact the page cannot measure renders as `?` with the reason on hover; the row still renders, and no label is derived from a partial set of facts.

### Problems and the badge

21. A row's measured problems are a failed latest run, a delivery alarm, and a run that has waited past the dispatch threshold; the row lists every one it has.
22. A delivery alarm is shown on the sender's row as "Delivery failed · to ⟨receiver⟩ · ⟨time⟩ · ⟨reason⟩" and stays while the fact is true; it is never inferred repaired ([agent-to-agent communication](../a2a/index.md)).
23. The badge counts agents that have at least one measured problem across every project the page reads; an agent counts once however many problems it has, unknowns never count, and the badge never counts open asks to the person or silence notices.
24. A delivery alarm counts toward the badge only while the Exchange it belongs to is open; an alarm on a plain message is shown on the row and never counted; a failed delivery of a platform-authored notice is neither shown nor counted.

### Freshness and environment

25. The page header names the environment the facts came from and the time as of which they were read; how several environments merge on the page is defined in [cross-device](../cross-device.md).

### Cost

26. The page shows each project's measured cost and what each of its agents contributed.

### Crews

27. A Crew's header offers Stop crew while a seat is running and Archive crew always; Archive crew shows the seats with their running turns and open asks before retiring the Crew as a unit ([Crews](crews.md) AC17, AC21).
28. Retired Crews from every project are listed in the Retired section, collapsed, newest retirement first, one row each naming the Crew, its project, its version, its seat count, and when it retired; a row opens to its Captain, the brief, and the roster snapshot (seat, agent, why it joined, the version it joined at). The Captain is a link to its thread, which holds the Crew's ledger, while that thread is active; an archived Captain is named as such, with where to unarchive it. A retired Crew offers no other action: it comes back only with its Captain, when it retired because the Captain was archived, and nothing about it is inferred ([Crews](crews.md) AC17, AC20).
29. A Crew's expander is collapsed by default in both the Active and the Settled table; its header still carries the Crew's name, seat count, and state summary ([Crews](crews.md) AC22).

### Active and Settled

30. An agent row is Settled exactly when its thread shell reads as settled and nothing outranks that fact: a running or connecting turn, a failed last run, or a pending approval or input places the row in Active whatever its settle mark says. An idle agent that is not marked settled is Active, and an agent whose thread the client cannot read is Active with its facts shown as `?`.
31. A Crew is Settled as a unit only when every seat, and every agent placed beneath a seat, is Settled by AC30; one running, failed, waiting, idle, or unknown seat keeps the whole Crew Active.
32. A placement tree is placed by its root and is never split across sections: it is Settled only when the root and every agent and Crew beneath it are Settled, and otherwise the whole tree stays in Active, where a settled agent's status cell reads "Settled".
33. The Settled table has the same columns as Active, a Settled row opens the agent's thread, and a Settled Crew header offers Archive crew and never Stop crew.

### Placement and provenance

34. An agent's placement equals its spawner at creation and changes only by a person's action; a placement tree lives entirely within one project. An agent whose spawner is in another project, or is an outside agent, is placed at the root.
35. An agent's provenance is recorded at creation and never changes.

## Scenarios

- **Reading the fleet.** The user opens the Fleet page. The Active table lists Billing Migration's coordinator with the two builders it spawned indented beneath it in the order they were created, then Website Redesign's lone reviewer; each root row names its project, and each row shows status, owed and awaited asks, and last activity. Clicking a builder opens its thread. (AC5, AC7, AC8, AC9, AC12, AC14)
- **A settled tree.** The coordinator and both builders were settled when their PR merged: the tree leaves Active whole and appears, still indented, under "Settled (3)", which is collapsed until the user opens it. Clicking the coordinator there opens its thread as before. (AC30, AC32, AC33)
- **Settled, but not finished.** The coordinator was settled by hand while one builder is still working: the whole tree stays in Active, the coordinator's status cell reads "Settled", the builder's reads "Working". When the builder settles too, the tree moves. (AC30, AC32)
- **An idle agent is not a settled one.** A builder ended its turn an hour ago and nobody settled it: it stays in Active reading "Idle since ⟨time⟩"; the page does not decide it is done. (AC15, AC30)
- **A settled Crew.** Every seat of Review Pair is settled: the Crew and its Captain sit in Settled, the Crew's expander is collapsed with "2 seats · 2 settled" on its header, and the header offers Archive crew but no Stop crew. (AC27, AC29, AC31, AC33)
- **A run that never started.** A builder's run has sat undispatched for seven minutes: its status reads "Waiting to start · 7m" and the badge counts it. When the run starts, the status changes and the badge drops. (AC15, AC21, AC23)
- **Owed and awaited.** An agent owes one answer to its coordinator and is waiting on two peers: "Owes 1 · Awaiting 2", with all three listed on hover with their ages. (AC18)
- **An archived coordinator.** A coordinator is archived while two builders it spawned are still working: the archive dialog names both; once it commits the coordinator leaves the page and the builders render at their project's root, still Working. (AC11)
- **A fact that cannot be read.** The placement query fails for one agent: its placement cell shows `?` with the reason on hover, the row renders, and the badge is unchanged. (AC20, AC23)
- **Two problems, one agent.** An agent's latest run failed and it also has a delivery alarm: the badge counts it once and its row lists both. (AC21, AC23)
- **Silence.** A silence notice exists for an agent: nothing on the page changes; its status is whatever the runtime says and the owed ask's age is the visible fact. (AC17)
- **Where is the problem?** The rail badge shows 2. Opening the Fleet page shows both failing agents in the Active table, each root row naming Billing Migration in its Project column; the sidebar is untouched throughout. (AC5, AC6, AC7, AC23)
- **Retired across projects.** Two Crews retired last week, one in each project: "Retired crews (2)" at the foot of the page is collapsed; opened, the newer sits first and each row names its project beside the Crew's name, and opens to the brief and roster snapshot with no action offered. (AC28)
- **As of when.** The header reads "Fleet · work server · as of 14:02:31"; a saved home server's projects do not appear on this page, and the page does not claim they do. When a second environment is connected, its projects appear in the same table and each of their root rows carries the environment's label after the project name. (AC7, AC25)
- **A failed delivery.** An agent's ask to its coordinator fails to deliver: its row shows "Delivery failed · to ⟨coordinator⟩ · 14:02 · ⟨reason⟩" and the badge counts it. The agent clears its ask: the chip stays, and the badge no longer counts it. (AC22, AC24)
- **The user is not a row.** An agent in Support Rotation has an ask out to the user: the user is not a row on the page; the ask appears in that agent's "Awaiting" list with the user as counterparty. (AC10, AC18)

## History

- 2026-08-29 — the three-surface model, the Squadron scope, row language, and the roster as a Fleet page settled; former SB1–SB7 ([record](../../worklog/2026-08-29-sidebar-roster-session.md)).
- 2026-09-04 — the Fleet page specified: one Squadron at a time from its own Squadron list, agents only, the four facts, silence notices omitted, the global badge, delivery alarms, orphans; the sidebar membership-by-provenance rule dropped; former FV1–FV11 ([record](../../worklog/2026-09-04-fleet-visibility-session.md)).
- 2026-09-05 — status vocabulary corrected against the runtime's resolver (same record).
- 2026-09-10 — rewritten into the definition shape and renamed from "Sidebar & roster". Former identifiers: SB1 → Definition; SB2 → AC3; SB3 → AC1; SB4 → AC2; SB5 → dropped (AC3 says the opposite); SB6 → AC4–AC14; SB7 → the inbox definition; FV1 → Definition, AC20; FV2 → AC15–AC17; FV3 → AC18; FV4 → AC19; FV5 → AC21, AC23; FV6 → AC20, AC25; FV7 → AC5–AC13; FV8 → AC3; FV9 → not a product matter (the server reads belong to the build); FV10 → the deferred items are backlog candidates, not part of this definition, except cost, which the fleet vision requires and AC26 carries; FV11 → AC22, AC24; the v0 override DV6 → AC3. The sidebar label's "extended with silence states" clause is not restated: silence facts are defined by agent-to-agent communication, and where they show is that definition's call. Mockup references are gone: mockups are decision aids in a design workspace, not part of the definition.
- 2026-09-22 — a retired agent is never a row: the orphan placeholder the former AC11 described is gone and the agents beneath it render at the root; an archive touches one agent (#254, option A). Bryant read a "Retired" row as a bug, not a placeholder.
- 2026-09-22 — three sections, every Squadron at once (Bryant). The one-Squadron-at-a-time page with its own Squadron list (former AC5–AC7) was never built and is dropped: the built page has always shown every Squadron of every connected environment, and this definition now says so. The per-Squadron sections give way to one Active table with a Squadron column, a collapsed Settled section driven by upstream's settle fact and nothing inferred (AC30–AC33), and one Retired list across Squadrons naming each Crew's Squadron (AC28); Crew expanders start collapsed (AC29). AC8 and AC26 reworded for the whole-fleet page.
- 2026-09-24 — AC28's roster snapshot reads seat, agent, why it joined, and version: the person approves every seat, so the roster records no approver, as in [Crews](crews.md) AC6 and AC20 ([#229](https://github.com/Jacksondr5/j5code/issues/229)).
- 2026-09-25 — a retired Crew comes back with its Captain when it retired because the Captain was archived, so AC28 no longer says it can never be reactivated; the roster snapshot shows why each seat joined, since the roster records no approver (Bryant; [#312](https://github.com/Jacksondr5/j5code/issues/312)).
- 2026-10-07 — Squadrons retired: the page reads every project and groups roots by upstream's logical project, the sidebar is upstream's project sidebar, and every thread but a provider Subagent is a participant, so AC1 (the Squadron scope) and AC13 (the footer for threads without a home) are retired. Placement and provenance moved here from the retired Squadron definition: its AC10, AC12 and AC13 are AC34 and AC35 (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-12 — an outside agent can be a spawner: the agent it starts is placed at its project's root and its provenance names the outside agent by its label; AC12 and AC34 (Jackson, 2026-10-11; [#498](https://github.com/Jacksondr5/j5code/issues/498)).
