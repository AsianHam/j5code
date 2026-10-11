---
title: "Inbox"
kind: definition
---

# Inbox

## Problem

When many agents are working, what is needed from the user gets lost. An agent sits idle waiting on a decision the user does not know is needed; a question bubbles up through other agents like a game of telephone and arrives garbled or not at all; a person coming back to the fleet has no way to see what is waiting on them ([problems](../problems.md): human attention is scarce and gets lost).

The inbox is the one place a person looks to find everything that is waiting on them, and the one place where answering actually closes the loop — the person's words reach the agent that asked, unchanged.

## Definition

The **inbox** is a person's queue of open asks addressed to them. It is **person-scoped, not project-scoped**: a person has one inbox across every environment the client connects to, every item wears the project it came from and, when more than one environment is connected, its environment, and no project selection elsewhere in the app hides an item.

The inbox is **pure**. It holds only asks that agents deliberately sent to the person — nothing inferred, no automatically promoted stalls, no plain messages, no platform alerts. Every item blocks a sender, so the count on the bell means exactly "things waiting on me." The purity has a sender-side mirror: an agent can send a person only an ask; a plain message to a person is refused, because if the person must see something then seeing it is the obligation. The person, in turn, never opens an ask through the platform — their channel to any agent is that agent's thread — and their only act on the ledger is the answer that closes an Exchange.

An agent may have several asks open with the same person at once, each its own item. A follow-up to a question the person has not yet answered — sent by the agent with the open Exchange's id — joins that item and is shown beneath the original ask, so the person always reads the whole question.

An item shows who is asking and from which project, the ask's **intent** as its subject line, the body, its **urgency** — the loudest element — and how long it has been open. The list orders by urgency, then age.

A person answers in one of two ways. **Reply in place**: the answer, exactly as written, is the reply that closes the Exchange and reaches the agent, with an envelope that tells the agent the platform closed it. **Go to the agent**: the person opens the asker's thread, reads the context, and replies in ordinary chat; the agent then withdraws its own ask once the conversation resolved it, and the item leaves the inbox honestly.

A replied item recedes to a collapsed **Replied** shelf. An ask whose sender is archived leaves the inbox immediately — the archive dialog was the loud moment, and a confirmed archive means the person wants it gone.

A server puts asks only in the inboxes of its members. A person who is a guest on a server still has their inbox, with the asks from servers of their own; the server they are a guest on adds nothing to it, and its agents reach them in the conversation they share ([shared conversations](shared-conversations.md)).

The inbox is reached from a bell in the rail that carries the count of open items and opens a full page.

The inbox is **not** a backlog (a non-blocking note an agent wants to keep is a Memo), **not** an alerts feed (an agent that fell over is a measured fact for the Fleet page, not an obligation), and **not** project-scoped.

## Acceptance criteria

### Contents

1. The inbox lists every open ask addressed to the person from every project on every connected environment, and nothing else: no plain messages, no inferred items, no promoted stalls, no platform alerts.
2. A plain message from an agent to a person is refused at the tool; the person's row in the address book says it cannot receive one.
3. Several open asks from the same agent to the same person appear as separate items; a follow-up that references an open ask by its Exchange id appears beneath that ask's original text in the same item.
4. The bell's count equals the number of open items.

### The item

5. Each item shows the sender, the sender's project, the intent as its subject line, the body, the urgency, and the time since it was opened; urgency is the most prominent element.
6. Items are ordered by urgency first, then by age, oldest first within an urgency.
7. A collapsed item shows the sender line and the intent; expanding it shows the body and the reply box.

### Answering

8. Replying in place delivers the person's text to the asker exactly as written, closes the Exchange, and tells the agent the platform closed it.
9. "Open thread" navigates to the asker's thread; an ask resolved there stays open until the agent withdraws it, and then leaves the inbox.
10. A replied item moves to the collapsed Replied shelf and is no longer counted.
11. An ask whose sender is archived leaves the inbox immediately, with no terminal row.

### Placement

12. The inbox is not filtered by any project selection in the sidebar; each item names its project, and its environment when more than one is connected; an answer reaches the environment the ask came from.
13. The bell with its count is present in the rail on every page and opens the inbox page.

### Guests

14. A server adds no item to the inbox of a person who is a guest on it, and its agents are not offered that guest as someone who can be asked.

## Scenarios

- **Two questions, one agent.** An agent in Billing Migration asks the user "merge now or after the audit?" (urgency _soon_) and, separately, "may I delete the old branch?" Two items appear, the _soon_ one first. The agent later follows up on the first by name; the follow-up text appears beneath it. The user answers each in place; each agent-side Exchange closes with the exact text; both items move to the Replied shelf. (AC3, AC5, AC6, AC8, AC10)
- **Answering in the thread.** The user opens an asker's thread from its item, discusses the question there, and the agent, satisfied, withdraws its ask; the item leaves the inbox. (AC9)
- **Across projects.** With the sidebar showing only Website Redesign, an ask from an agent in Support Rotation still appears, wearing "Support Rotation". (AC1, AC12)
- **An archived asker.** An agent with an open ask to the user is archived after the dialog's warning; its item is gone from the inbox the moment the archive completes. (AC11)

## History

- 2026-08-29 — designed; former IB1–IB7 ([record](../../worklog/2026-08-29-inbox-session.md)).
- 2026-08-31 — the bell moves to the rail header (Jackson's review of the inbox build).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/2026-09-02-human-addressed-sends-ruling.md)).
- 2026-09-05 — several open asks per agent and person, with follow-ups shown beneath the original (issue #111); the shelf is named "Replied", the one word for a closed Exchange on every surface (glossary).
- 2026-09-12 — the inbox merges every connected environment (PR #125; the merge rules are the cross-device definition's).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: IB1 → Answering, AC8–AC9; IB2 → AC13; IB3–IB4 → AC5–AC6; IB5 → AC10; IB6 → AC11; IB7 → AC12. The "clear-own-ask has no build ticket" note is gone: the verb shipped. The deferred items that lived here (a platform-alerts lane, the asker's current state on items, smaller inbox forms) are backlog candidates, not part of this definition.
- 2026-10-07 — Squadrons retired: an item names the project its sender works in (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-10 — a server adds nothing to a guest's inbox (AC14); an ask in a shared conversation is defined by [shared conversations](shared-conversations.md) (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)).
