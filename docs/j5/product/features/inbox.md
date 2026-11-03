---
title: "Inbox"
kind: definition
---

# Inbox

## Problem

When many agents are working, what is needed from the user gets lost. An agent sits idle waiting on a decision the user does not know is needed; a question bubbles up through other agents like a game of telephone and arrives garbled or not at all; a person coming back to the fleet has no way to see what is waiting on them ([problems](../problems.md): human attention is scarce and gets lost).

The inbox is the one place a person looks to find everything that is waiting on them, and the one place where answering actually closes the loop — the person's words reach the agent that asked, unchanged.

## Definition

The **inbox** is a person's queue of open asks, live Crew-seat provider approvals, and placed agents' pending native questions. It is **person-scoped, not project-scoped**: a person has one inbox across every environment the client connects to, every item wears the project it came from and, when more than one environment is connected, its environment, and no project selection elsewhere in the app hides an item.

The Inbox holds requests the person can act on: agent-addressed Exchanges, live Crew-seat provider approvals, and native questions on J5-spawned Peer Agents and live Crew seats. Native questions are links to the agent's original question form, not Exchanges or another answering form. A pending question counts whether it blocks the agent or the provider lets it continue working. Resolved, expired or cancelled questions leave the list as the server reports the change. A Captain's own native questions and approvals, and Crew roster approvals, stay inline in the thread the person watches. When a Captain needs the person's decision it asks with an Exchange, which is listed here and pinned above its composer, where it can be answered too; answering in either place closes the one ask. Native or delegated Subagents use upstream's parent routing.

A plain message to a person is refused; agents send an ask when a reply is owed. The person never opens an ask through the platform: their channel to an agent is its thread, and their only act on the ledger is the answer that closes an Exchange.

An agent may have several asks open with the same person at once, each its own item. A follow-up to a question the person has not yet answered — sent by the agent with the open Exchange's id — joins that item and is shown beneath the original ask, so the person always reads the whole question.

An item shows who is asking and from which project, the ask's **intent** as its subject line, the body, its **urgency** — the loudest element — and how long it has been open. The list orders by urgency, then age.

A person answers in one of two ways. **Reply in place**: the answer, exactly as written, is the reply that closes the Exchange and reaches the agent, with an envelope that tells the agent the platform closed it. **Go to the agent**: the person opens the asker's thread, reads the context, and replies in ordinary chat; the agent then withdraws its own ask once the conversation resolved it, and the item leaves the inbox honestly.

A replied item recedes to a collapsed **Replied** shelf. An ask whose sender is archived leaves the inbox immediately — the archive dialog was the loud moment, and a confirmed archive means the person wants it gone.

A server puts asks only in the inboxes of people who can write to the asking agent's thread ([people and access](people-and-access.md)). A Viewer, who cannot answer, has no inbox from that server.

**Several people.** Where more than one person can write to an agent's thread, the agent can ask one of them, or **everyone here**: everyone who can write to its thread when the ask is read. An ask to everyone appears in each of their inboxes, marked as for everyone, and is counted on each of their bells. The first reply closes it for all of them, as any reply closes an ask, and for the others it moves to the Replied shelf showing who answered. A reply that arrives after that is refused and changes nothing. A person who had started typing an answer keeps the item in place, with their words, and sees who answered. In a thread only one person can write to, there is no "everyone here": the agent asks that person ([shared conversations](shared-conversations.md)).

**Worktree cleanup.** When archiving a Crew keeps worktrees J5 created for its seats because they hold uncommitted changes or commits that never merged, the archive files one item for all of them, however many seats and worktrees it covered; a worktree whose commits are not on its branch (its seat detached or switched branches) is not offered, because removing it would leave those commits unreachable, and is kept and reported as unverified instead. No agent sent it, it is not an Exchange, and no agent can answer it; it reads "J5" as its sender, is marked FYI, and sits after the asks. Each worktree shows its thread, its branch, its uncommitted files, its commits not on the default branch, and its pull request when it has one, and the item says that removing discards the uncommitted changes and keeps the branch. Nothing is picked at first: the person keeps all, which clears the item and changes nothing, selects the worktrees to remove, or selects all. Each worktree they approve is checked again first, staged changes included; one that changed, is now used by an unarchived thread or an open session, or is already gone is skipped and reported, and a removal that fails is reported with its reason. Only Owners are shown the item and counted for it. The item resolves once, stays in place afterwards showing what was removed, kept, skipped or failed, and then lives on the Answered shelf.

The Inbox is reached from a bell in the rail that counts open asks, seat approvals, native-question links and, for an Owner, worktree cleanups, and opens a full page. The page's count line gives worktree cleanups their own clause, apart from questions. It is available on web, desktop and the mobile app, over local, remote and tunnel connections. On the mobile app the bell sits in the thread list's header and opens a full screen where asks are read and answered in place; for now it shows open asks only, and its count also includes worktree cleanups for an Owner; those, like seat approvals and native-question links, are answered on web and desktop.

The inbox is **not** a backlog (a non-blocking note an agent wants to keep is a Memo), **not** an alerts feed (an agent that fell over is a measured fact for the Fleet page, not an obligation), and **not** project-scoped.

## Acceptance criteria

### Contents

1. The Inbox lists open asks addressed to the person, live Crew-seat provider approvals, worktree cleanup items, and actionable pending native questions from J5-spawned Peer Agents and live Crew seats across connected environments. Native questions open the original thread form and disappear when resolved; they are not answered as Exchanges. No plain messages or inferred stalls are added.
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

### Several people

14. A server adds an ask only to the inbox of a person who can write to the asking agent's thread, and its agents are offered as someone to ask only the people who can write to their thread.
15. In a thread more than one person can write to, an agent's address book offers "everyone here", and an ask to it reaches the inbox of everyone who can write to that thread when the ask is read, marked as for everyone. From a thread only one person can write to, "everyone here" is not offered, and an ask to it is refused, naming that person.
16. The first reply to an ask to everyone closes it for all of them, and for the others it moves to the Replied shelf naming who answered; a later reply is refused and changes nothing.
17. An open item a person has typed an answer into stays in place when it closes, with their text and a line saying who answered or that the agent withdrew it, until they clear the text or leave the page.

### Worktree cleanup

18. An archive of a Crew that keeps J5-created worktrees for uncommitted changes or unmerged commits files exactly one item for that archive, however many seats and worktrees; the same archive run again files nothing more, whether the item is open or answered. A Crew that came back with its Captain and is archived again files its own item, and the item still open for the earlier archive goes away when the Crew comes back (an answered one stays on the Answered shelf). The item has no sender, is not an Exchange, reads "J5" with urgency FYI, and counts on the bell.
19. Each worktree in the item shows its thread and branch, the number of its uncommitted files, the number of its commits not on the default branch, and its pull request link when it has one; the item says that removing discards uncommitted changes and keeps the branch. Worktrees with uncommitted work come first, and a list longer than five shows five rows and "Show N more".
20. No worktree is picked at first. The person can keep all, which clears the item and changes nothing, pick worktrees and remove them (Remove selected is disabled while none is picked), or select all (disabled once every worktree is picked). Only an Owner sees it, counts it on the bell and answers it, from the app; no agent tool answers it.
21. Before removing an approved worktree, J5 checks it again and skips and reports it when its commit, its list of changed files, what is in those files or what is staged differs from when the archive kept it, its commits are no longer on its branch (a nested repository or a very long list of changes can't be compared, so it is skipped), another unarchived thread now uses it, its thread was unarchived, or a provider session is open in it. A worktree already removed some other way is skipped without error, and a removal that fails is reported with its reason without stopping the others.
22. The item resolves once: a second answer is refused with "This worktree cleanup was already answered." and the item shows its decided state, and it clears on the person's other devices. Afterwards it stays in place showing each worktree as removed, kept ("Not picked"), skipped (changed since it was filed, another thread uses it, a session is open in it, already gone, or couldn't be checked) or failed (git's own error text), and then moves to the Answered shelf as a one-line count of each. Nothing is offered to retry a skipped or failed worktree.

## Scenarios

- **Two questions, one agent.** An agent in Billing Migration asks the user "merge now or after the audit?" (urgency _soon_) and, separately, "may I delete the old branch?" Two items appear, the _soon_ one first. The agent later follows up on the first by name; the follow-up text appears beneath it. The user answers each in place; each agent-side Exchange closes with the exact text; both items move to the Replied shelf. (AC3, AC5, AC6, AC8, AC10)
- **Answering in the thread.** The user opens an asker's thread from its item, discusses the question there, and the agent, satisfied, withdraws its ask; the item leaves the inbox. (AC9)
- **Across projects.** With the sidebar showing only Website Redesign, an ask from an agent in Support Rotation still appears, wearing "Support Rotation". (AC1, AC12)
- **Everyone here.** On L2 Support Rotation's server, an agent asks everyone here which customer to call back first. The ask is in the inbox of each engineer on shift. One answers; for the others it moves to Replied naming them, and another engineer, halfway through typing, sees the item stay with their words and who answered. (AC15, AC16, AC17)
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
- 2026-10-17 — several people (Jackson; [record](../../worklog/2026-10-16-people-and-access-session.md)): asks go to the people who can write to the asking agent's thread, and Viewers have none (AC14 rewritten from the guest rule); an agent can ask everyone here, the first reply closing it for all (AC15, AC16); an item being answered stays in place when it closes (AC17).
- 2026-10-18 — "everyone here" is offered, and taken, only while more than one person can write to the asking agent's thread; from a thread only one person can write to, the agent asks that person (AC15; Jackson, in the review of [#638](https://github.com/Jacksondr5/j5code/pull/638)).
- 2026-10-27 — a Captain asks the person for a decision with `j5_send_message`: one request, listed in the Inbox and pinned above the Captain's composer, answered in either place (Bryant; [#747](https://github.com/Jacksondr5/j5code/issues/747)). This replaces the 2026-09-26 line that had the Captain ask inline with its own question tool.
- 2026-10-27 — archiving a Crew files one worktree cleanup item for the J5-created worktrees it keeps with unfinished work (AC18–AC22; [#749](https://github.com/Jacksondr5/j5code/issues/749); Crews proposal v2).
- 2026-11-01 — the mobile app has the Inbox: a bell with the open count in the thread list's header, and asks read and answered in place, across every connected server; Crew requests and seat approvals join it with Crews on mobile (Jackson, [#830](https://github.com/Jacksondr5/j5code/issues/830)).
- 2026-11-02 — the cleanup item belongs to one archive of a Crew and goes away when the Crew comes back; it is not offered for commits its branch does not hold; the recheck covers staged content; only Owners are shown and counted it, and the count line names it apart from questions (AC18, AC20, AC21; review of [#749](https://github.com/Jacksondr5/j5code/issues/749)).
