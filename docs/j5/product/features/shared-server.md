---
title: "Shared server"
kind: definition
---

# Shared server

## Problem

As agents do more of the work, the need to share them between people grows. A level-2 support team hands its agents from one shift to the next and wants **no context transfer**. Two developers already relay agent output to each other over chat — one asks their agent, pastes the answer to the other — and would rather stand in front of the same agent together ([problems](../problems.md): Shared server; [use cases](../use-cases.md)).

## Definition

**Shared server** is several people on one server sharing its projects and agents. It is one of three distinct capabilities in the multi-machine, multi-person space, and the only one where no state crosses machines and no server peers with another:

| Capability        | Shape                                                            | Defined in                         |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Cross-device      | one person, several servers; views merge in the client           | [cross-device](../cross-device.md) |
| Federation        | two people's servers exchange messages through the peer registry | [cross-device](../cross-device.md) |
| **Shared server** | **several people on one server, sharing projects and agents**    | this document                      |

Two definitions carry it. [People and access](people-and-access.md) says who a person on a server is, what they reach, what they can do there, and how they got in. [Shared conversations](shared-conversations.md) says what happens once more than one person can write to an agent.

Two constraints are in force on everything built, because retrofitting multiple people onto single-person assumptions is the expensive path this avoids:

- **Nothing may assume exactly one person.** Every person-facing surface — the inbox, the backlog pane, notifications, addressing — is scoped to a person, never to "the user."
- **Every person has a durable person id**, carried on every ledger row and envelope.

## Acceptance criteria

### People

1. No surface, projection or tool assumes exactly one person; each is scoped by person id.
2. Every ledger row and envelope carries the person id of any person it involves.
3. An agent's ask is addressed to one person who can write to its thread, or to everyone who can, and to nothing in between ([Inbox](inbox.md)).

## Scenarios

- **Shift handoff.** The on-shift engineer for L2 Support Rotation goes home; the next engineer opens the same server, sees the same project, the same agents, and the same open asks in their own inbox, and continues without a handover conversation. (AC1, AC3)

## History

- 2026-08-22 — the multi-person invariant and person ids ruled binding now; the capability defined and set apart from cross-device and federation; former R9, R29, and the cross-device position ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R9 → AC2, AC4; R29 → AC1, AC3. The architecture session this capability needs before any build — how several authenticated people attach to one server, attribution and read state in shared surfaces, what "every person" delivery means for the inbox — is that session's agenda, not this definition's.
- 2026-10-07 — Squadrons retired: what several people share on one server is its projects and agents, and the capability is renamed from "Shared Squadrons" to "Shared server" (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-10 — members and guests, grants at two levels, and share links defined; two people in one conversation moved out of the open doors and into [shared conversations](shared-conversations.md) (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)). AC3 now reads "member" where it read "person"; AC5 onward are new. Upstream's permissions were read at `2625327090`: they are per connection and server-wide, with no roles and nothing scoped to a project or thread, so a grant adds only the scope and keeps upstream's names.
- 2026-10-12 — open links added: one view-only link several people can join a thread with, AC26 to AC28, numbered after AC25 so earlier numbers stand (Jackson, 2026-10-11; [#541](https://github.com/Jacksondr5/j5code/issues/541)).
- 2026-10-13 — scenario wording: a View guest sees the composer, read-only, with one sentence, not "no composer" (the UI design of 2026-10-12; awaiting Jackson's read; [#535](https://github.com/Jacksondr5/j5code/issues/535)).
- 2026-10-13 — AC8: a thread grant lets a guest write to the thread it names and read the agents beneath it, not write to them, so that a seat's prompts stay with members (security review of the build; awaiting Jackson's read; [#533](https://github.com/Jacksondr5/j5code/issues/533)).
- 2026-10-14 — AC26: a guest already signed in on the device joins an open link's thread as themselves, rather than being asked for a name that is then refused as taken ([#614](https://github.com/Jacksondr5/j5code/issues/614)).
- 2026-10-17 — cut back to the capability and its two constraints; who reaches what, at which level and through which link, moves to [People and access](people-and-access.md) (Jackson; [record](../../worklog/2026-10-16-people-and-access-session.md)). AC4 → People and access AC1; AC5 → AC8, AC13 to AC15; AC6 → AC8; AC7 → AC11; AC8 → AC9, AC21; AC9 → AC22; AC10 → AC12; AC11 → AC48, AC49; AC12 → AC13, AC21, AC24; AC13 → AC14; AC15 → AC25; AC17 → AC34; AC18 → AC34, AC36; AC19 → AC32; AC20 → AC35; AC21 → AC37; AC22 → AC38; AC23 → AC25; AC24 → AC23 and [Inbox](inbox.md) AC14; AC25 → AC48; AC26 → AC31 to AC33; AC28 → AC31, AC39, AC40. Retired: AC14 (a writer now has terminals, files, git, model and access mode; a Viewer has none), AC16 (a preview tab's saved logins), AC27 (a name a person gave themselves is no longer confirmed). The open door about a person who is a guest reading the Fleet page is closed: a Viewer at server scope sees it.
- 2026-10-17 — AC3: an ask goes to one person who can write to the agent's thread or to everyone who can, which closes the open door on what an ask to everyone means (Jackson; [record](../../worklog/2026-10-16-people-and-access-session.md)).
- 2026-10-17 — the open door on addressing a duty ("the on-call") is closed. A duty is a subset of the people who can answer, and an ask to a subset can stay open where another person who can write cannot close it, which is why an ask goes to one person or to everyone (Jackson).
