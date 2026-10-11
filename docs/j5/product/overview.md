---
title: "J5 overview — what J5 adds to T3 Code, and what stays T3 Code's"
kind: definition
---

# J5 overview

J5 Code is T3 Code with a fleet layer on top. T3 Code gives a person a fast, multi-surface GUI for driving coding agents one conversation at a time. J5 lets many agents work at once: talking to each other directly, and organized into Crews under a Captain. Some agents the person talks to directly all day; others work in the background and reach the person only when something needs them. The person's attention is the scarce resource, and J5 exists to spend less of it per unit of work ([problems and goals](problems.md), [fleet vision](fleet-vision.md)).

This page is the map. Read it before changing anything, to know whether you're in J5's domain or upstream's.

## J5's domain

These areas are J5's. Their definitions are the source of truth; build within them under the [principles](principles.md).

| Area                                  | What it is                                                                                                                                     | Definition                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Agent-to-agent communication          | Agents message each other directly. An ask opens an Exchange that the receiver owes a reply to; silence is noticed and surfaced.               | [A2A](a2a/index.md), [agent tools](a2a/agent-tools.md), [upstream substrate](a2a/substrate.md)                                        |
| Inbox                                 | The person's one queue of open asks addressed to them, across every connected environment.                                                     | [Inbox](features/inbox.md)                                                                                                            |
| Agent-to-agent messages in the thread | How A2A traffic renders in a thread: as cards, leaving upstream's conversation rendering untouched.                                            | [Thread A2A rendering](features/thread-a2a-rendering.md)                                                                              |
| Crews and Captains                    | A group of agents launched as a unit from a roster its Captain proposes and the person approves. The Captain is the thread the person watches. | [Crews](features/crews.md)                                                                                                            |
| Personas                              | Reusable, user-authored definitions of a kind of agent: instructions, model routes, runtime policy, declared handoff artifact.                 | [Roles](features/roles.md), [persona contract](agent-personas/index.md)                                                               |
| Spawning Guide                        | The user's own guidance, consulted when spawning, on which provider, model, and brief fit which work.                                          | [Spawning Guide](features/spawning-guide.md)                                                                                          |
| Playbooks                             | User-authored, step-by-step prompts that a persona or a Crew follows, with progress declared by its agents.                                    | [Playbooks](features/playbooks.md)                                                                                                    |
| Memos                                 | Small self-addressed notes an agent keeps through the platform, visible to the person.                                                         | [Memos](features/memos.md)                                                                                                            |
| Artifacts and handoffs                | Server-owned documents agents write for each other and the person, including a persona's versioned handoff.                                    | [glossary](glossary.md), user guide `docs/user/artifacts.md`                                                                          |
| Fleet page and sidebar roster         | Measured status for every agent and Crew: the Fleet page and the sidebar's spawned-children expander.                                          | [Fleet page](features/fleet-page.md)                                                                                                  |
| Shared server and cross-device        | Several people on one server, as members or as guests with grants, and messages crossing between servers. Authority never replicates.          | [Shared server](features/shared-server.md), [shared conversations](features/shared-conversations.md), [cross-device](cross-device.md) |
| Skills                                | A skill catalog and links that make one skill available across providers.                                                                      | user guide `docs/user/skills.md`                                                                                                      |

## Everything else is upstream's

Anything not in the table is T3 Code's product: providers and their adapters, orchestration (threads, turns, runs, runtime requests, checkpoints), the sidebar and composer, settle / snooze / archive of a thread (J5 follows upstream's archive and adds warnings and Crew rules around it), the pull request view, settings, authentication and pairing, remote access and tunnels, the desktop and mobile shells, and persistence.

J5 depends on all of it, and sometimes has to reach into it. How to tell a code integration from a change to upstream's product, and who decides each, is in [J5 and upstream](upstream.md). The short version: integrating J5 code is a matter of process ([`FORK.md`](../../../FORK.md)); changing what upstream's product does is the person's decision, made explicitly and recorded.

## Where the code is

J5's code lives in its own directories: `apps/server/src/j5`, `apps/web/src/j5`, `apps/mobile/src/j5`, `packages/contracts/src/j5`, `packages/client-runtime/src/j5`, and `packages/shared/src/j5`. Folder names follow the areas above (`a2a`, `crew`, `agents`, `playbooks`, `artifacts`, `fleet`, `skills`). J5's server state has its own migration lane, separate from upstream's. Every place J5 code is reached from an upstream-owned file is recorded in `FORK.md`.

## History

- 2026-09-26 — created, as the entry point agents read before changing anything (Jackson, [#327](https://github.com/Jacksondr5/j5code/issues/327)).
