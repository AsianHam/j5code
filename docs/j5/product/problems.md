---
title: "Problems & goals — what hurts, and what the platform is for"
kind: definition
---

# Problems & goals

Captured verbatim-in-spirit from Jackson during the foundations round of the design review (2026-08-22). Companion to `fleet-vision.md`: that document says _how Jackson operates_; this one says _what hurts and what he wants beyond fixing it_. Every design should trace back to one of the two. Principles referenced live in `principles.md`.

## Problems

The problems J5 Code is trying to solve come about from pushing agentic work into the next era: managing a large fleet of agents doing large, long-running work. When we start to do that, new weaknesses in LLMs and current ways of working appear. We want J5 Code to be a platform that solves these problems and provides features that enhance this new way of working.

### Fleet observability

- Its hard to see what agents you arent talking to are doing
  - What is the state of this Crew? How far have they progressed?
  - Did this agent fall over because of an API error/rate limit?
  - When did this agent complete?
  - What is working and what isn't?
- PR management is difficult
  - Who has reviewed? Are the agents working it?
  - Can I merge this?
  - What decisions did the agents make based on the reviews? Do I agree?
- What is this fleet costing me?

### Human attention is scarce and gets lost

- When there's so much work going on, what's needed from the human gets lost. Agents can sit idle waiting on a decision the human doesn't know is needed.
- Questions/blockers agents have for the human have to bubble up through A2A messages until it reaches the human. A big game of telephone. Things get dropped and miscommunicated.
- When there are so many events that can trigger an agent the human is chatting with, their conversation collapses and important details get lost
  - "Lets talk about that later" gets pushed out of context quickly and lost completely. This is linked to a "context as bad memory" problem directly.

### Agent weaknesses

#### No awareness of async events

- Things change underneath agents and there's often nothing to tell them that their context is outdated, or nudge them to continue working
  - A reviewer left a comment on a PR and that needs actioned
  - The state of something in another system changed
  - Another agent they were waiting on to complete something finished. No signal ever reaches the first agent, so they never continue
- Captains don't notice when their Crews complete, stall, die, etc. This usually requires human intervention to restart, and the human usually shows up expecting the work to be done

#### Context as bad memory

- Agents naturally rely on their context to "remember" or check the state of something when they should measure
- Having the agents measure some stuff is very slow and costly
  - "What is the state of your Crew?" requires an interview
  - "Is this incident still open?" can require costly API calls
- Agents are naturally time blind. If they need to know to do something later, you often have to tell them "its later now"
- When you put an agent into a coordinator role, where task switching is common, it forgets the things you needed to talk about later with it. This is linked to a "human attention is scarce and gets lost" problem directly.
  - Having a production incident come in the middle of talking about logging improvements
  - When there are too many Crews providing too many updates during a design session
- Agents that have to execute long Playbooks often forget their instructions when they read them at the very beginning

#### Bad at working in large, unsupervised groups

- Agents often fail to coordinate properly
  - Agent B never replies to A, A sits and waits forever. The coordination failed even though there was communication.
- Agents can veer away from the human's desired end state and the human won't notice

### More work needs more cleanup

- Agents need to be cleaned up, along with their worktrees and artifacts. This problem compounds when you have more agents in large fleets.

### Problems with Traycer/T3

#### Traycer

- Traycer keeps open items in memory and loses the state when the app closes
- Traycer is over-eager about cleaning up worktrees and idle agents, things die before they should

#### T3

- T3 is solely focused on the parent-child agent relationship. No concept of A2A. Thus, it also falls short of managing large fleets. It just has a single 2D list of agents.

## Goals beyond the problems

### Roles defined in platform tooling (item 3)

When you're running a fleet of agents, youll naturally end up with many performing the same type of job, which you'll want to define in a reusable Role. Roles can define a few things:

- `SOUL.md`, `AGENTS.md`, bootstrap instructions, and a prompt
- An allowlist of models and reasoning levels so agents that spawn other agents with Roles choose the right ones
- A customizable set of skills to expose to the agent

Roles make it easy for users and agents to spawn the right kind of agent for the given task. These Role definitions are portable and easily customizable by the user. While this functionality is easily defined in markdown files by the user, adding it into the platform makes it more reliable and provides a better UX.

For example, a user can define a "reviewer" Role that they use to review the code other agents build. They could customize the reviewer to use higher reasoning frontier models, give it access to skills that are geared towards reviewing code, and prompt it to look for certain things.

### Crews

Complex work needs groups of agents with defined Roles — a Builder, a Reviewer, and a Sitter working one PR is the canonical case. A Crew is that group as a first-class thing: spawned as a unit from a user-authored, git-versioned Crew definition — the Roles it contains and how they work together — living entirely inside one project, with membership fixed at spawn. Counterpart references ("escalate CI failures to your Builder") resolve at spawn, so every member knows how to work with the others without the human wiring them together.

Crews are meant to work the task they're assigned with a high degree of independence from the user, working until they hit a defined stopping point or they complete their task. They can always reach out to other agents for help. But, their communication to the user is rarely through direct chat — they reach the human through the inbox and their Captain (`../worklog/2026-08-14-communication-graph-draft.md`, the human-contact spectrum lens's far-end norms) and record deferred items as Memos (`features/memos.md`).

Crews are deliberately disposable: when their task is done, the user or spawner archives them. They archive only as a unit, members are never individually replaced, and recovery from a poisoned Crew is respawning a fresh one from its definition — cheap because the real work lives in durable artifacts (worktree, branch, PR) that survive the agents. Agents can spawn Crews themselves (Captains running Crews without the human in the loop is the point), Captains can archive the Crews they command, and Crew members can't spawn Crews of their own — wanting more hands is an escalation.

The platform ships the machinery — define, spawn, render, archive; the Playbook a Crew executes and the Roles it contains are always the user's content. The PR Group is one Crew definition someone wrote, never the product's opinion. (The definition of record is [Crews](features/crews.md).)

### Playbooks

Agents executing a long Playbook can forget later steps — they read it once at the beginning and it decays into the context's back pages. Users have a hard time seeing the progress of a long running agent at a glance. There are a few ways the platform can improve this:

1. An agent declares when to advance via tool call, so "what step are they on" is a cheap, honest, measured progress view
2. On agent-declared advance, the platform delivers the next step's live instructions to every participant in the Playbook — each Role receiving its own instructions for that step, fresh in context. A single-agent Playbook is just the one-participant case.
3. Maybe swap skills per step (parked — unproven)

The user can define detailed Playbooks, targeted at either a single Role or a Crew. Either can be spawned and prompted to follow a given Playbook. As they work, the platform tracks their progress and keeps every participant supplied with its current instructions. Advancement is always agent-declared, never platform-judged (the platform delivers facts, never judgment).

### Shared server

As we start to work more and more with agents, the need to share them between humans grows. Take a level 2 support team for example. When one person goes off shift, another picks up their agents immediately — **no context transfer**. And a tool for developers: people already relay agent output to each other over Slack/Teams (human asks their agent, pastes the answer to the other human); removing chat apps from that loop and **putting both humans in front of the same agent** is powerful.

### Supporting tools: cron + DB for agents (parked)

The monitoring fleet's scraper and incident database (see the working fleet in `fleet-vision.md`) stay outside the platform — too use-case-specific. The generic observation stands: both the PR and monitoring systems needed cron jobs and databases that agents had to laboriously self-provision. Parked with a named trigger: revisit when cross-machine sync or repeated setup pain makes hand-rolled stores actually hurt. Agents are perfectly capable of setting these up themselves today; Memos (`features/memos.md`) are the v1 data primitive.

## Traceability

One row per problem theme / goal; the pointer is where the answer is designed or tracked.

| Problem / goal                          | Answered by                                                                                                                                                                                                                                     | Status                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Fleet observability — agent/Crew state  | Silence notices and the ledger's projections ([agent-to-agent communication](a2a/index.md)); the Playbook step pointer ([Playbooks](features/playbooks.md)); the Fleet page ([Fleet page](features/fleet-page.md)); status is read, never asked | A2A v1 plan; item 4; Playbooks candidate      |
| Fleet observability — PR management     | A PR pane (an idea, not yet defined: #6); playback of the ledger for review-decision audit                                                                                                                                                      | Pane approved, issue #6                       |
| Fleet observability — cost              | Cost rolls up per project on the Fleet page                                                                                                                                                                                                     | Item 4                                        |
| Human attention — lost/telephoned asks  | The [inbox](features/inbox.md) with urgency; posture on the human-contact spectrum                                                                                                                                                              | A2A v1 plan                                   |
| Human attention — drowned conversations | Spectrum posture + delegation to Crews (the human-contact spectrum lens)                                                                                                                                                                        | Principle adopted; manifest posture is item 3 |
| Human attention — "later" lost          | Memos (`features/memos.md`)                                                                                                                                                                                                                     | Design settled; backlog candidate             |
| Async-event blindness                   | Silence notices to waiters ([agent-to-agent communication](a2a/index.md)); machine triggers as work sources (a recorded door)                                                                                                                   | A2A v1 plan                                   |
| Context as bad memory                   | Status-is-read surfaces; [Memos](features/memos.md); step injection ([Playbooks](features/playbooks.md))                                                                                                                                        | Principles adopted; candidates queued         |
| Large, unsupervised groups              | Exchanges with sender-judged completeness; silence measurement; Memo visibility for drift steering; the Fleet page                                                                                                                              | A2A v1 plan; item 4                           |
| More work needs more cleanup            | Archive never destroys work and is loud ([archive flow](features/archive-flow.md)); Crews archive as units and Captains archive what they command ([Crews](features/crews.md)); workspace cleanup tooling deferred                              | Register settled; tooling later               |
| Traycer/T3 inheritances                 | A durable ledger instead of in-memory state; archive that never destroys work instead of over-eager cleanup; A2A and the placement tree instead of a parent-child-only flat list                                                                | A2A v1 plan                                   |
| Roles in platform tooling               | [Roles](features/roles.md): user-authored files the platform reads                                                                                                                                                                              | Item 3 session                                |
| Crews                                   | [Crews](features/crews.md)                                                                                                                                                                                                                      | Register settled; manifest schema is item 3   |
| Playbooks                               | [Playbooks](features/playbooks.md): the platform records progress, the agents decide when to advance, and the steps are the user's                                                                                                              | Backlog candidate                             |
| Shared server                           | [Shared server](features/shared-server.md): the multi-person invariant in force now; an architecture session before any build                                                                                                                   | Backlog candidate                             |
| Agent cron/DB                           | Parked with a named trigger ([Memos](features/memos.md) records it)                                                                                                                                                                             | Parked                                        |
| Monitoring fleet                        | Standing test: "does it work for the monitoring fleet, or only coding fleets?" (`fleet-vision.md` implication 6)                                                                                                                                | Ongoing design lens                           |

## History

- 2026-08-22 — captured in the foundations round of the design review ([record](../worklog/2026-08-21-design-review.md)).
- 2026-09-10 — register identifiers replaced by the definitions that now answer each problem; content unchanged.
- 2026-10-18 — time facts in envelopes dropped from the answers to async-event blindness and context as bad memory ([#29](https://github.com/Jacksondr5/j5code/issues/29)).
