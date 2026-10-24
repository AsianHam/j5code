---
title: "Agent-to-agent messages in the thread view"
kind: definition
---

# Agent-to-agent messages in the thread view

## Problem

The person lives inside agents' threads. Every message an agent receives from another agent, every silence notice, every reply that arrives through the inbox, is delivered as an envelope written _for the agent_ — participant ids, protocol instructions, the mechanics of what is owed. Read raw, a thread becomes a wall of postal regulations in which the actual letters are hard to find, and a notice is indistinguishable from a message ([problems](../problems.md): fleet observability, human attention).

The person should read the letter, not the envelope: who said what to whom, what is still waiting, and what has been answered — in plain words, at a glance. And the person's own words must stay easy to find: when every letter is drawn as large as what the person typed, their own messages scroll out of sight.

## Definition

Every message in the person's place in a thread is shown by **who is speaking**, in five groups. Only the person's own messages sit on the right; everyone else's sit on the left. A person's words are always open. Everything else starts folded to one line, as upstream folds a message from another agent, so the person's own messages stay easy to find.

1. **The person.** Upstream's full bubble on the right, unchanged. A reply the person sent from the inbox carries a caption above it, "You · via Inbox".
2. **Other people.** In a shared conversation, a full bubble on the left with their initials and name. An inbox reply from another person adds "· via Inbox" after the name.
3. **Other participants:** agents, machine participants, outside agents, agents on peer servers, and the agent that spawned this one. On the left, an **identity line** above the row, then upstream's folded row: the first line of the letter and a chevron. Opened, it shows the whole letter with upstream's footer: open the sender's thread, the time, copy.
4. **Platform notices** (not built yet). One muted line on the left, with no bubble and no identity: an icon, a plain summary, the time and a chevron. Opened, the detail hangs under it. J5's notices (a silence, a message not delivered or withdrawn, a Crew decision, a seat's report) and upstream's (a pull-request watch update, a finished delegated task, a continuation after a restart) look the same.
5. **Platform prompts** (not built yet). An outlined pill on the left: an icon, a kind label, the task or step title and a chevron. Opened, the full prompt. It covers upstream's automation runs and idle compaction, a playbook step handed to a Crew seat, and a question raised to a parent.

The identity line is a bot glyph, the sender's name and at most one badge or tag. The **name** is the participant's label, a persona or agent name; without one, the title of the sender's thread; and otherwise "Agent". A spawn brief's line reads "⟨spawner⟩ · brief". The **badge** appears only when the message asks something of the reader, in the inbox's words: **Expects reply** on an ask, in amber, and **Replied** on a reply that closed an Exchange, in quiet green. A plain message and a follow-up carry none, because the platform never asserts a role it did not measure. A sender that is not an agent gets a **tag** instead: **Automation** for a machine participant, **Outside agent** for an MCP sign-in. The line leaves out Crew or Captain context (the seat's name says it), the delivery mode (upstream's steer marker already shows it) and the peer server's name. Badges are the only colored elements. Whether an Exchange is still open is not drawn: the [inbox](inbox.md) tracks waiting.

**The person reads the letter, not the envelope.** No row, folded or open, shows an envelope, a tagged block or a participant id. A folded row's preview is the first non-empty line of the message as the reader should see it: the letter after the envelope is stripped, with markdown left raw as upstream leaves it, a notice's summary, or a prompt's title. A spawn brief's platform context is never shown, and its preview is the first line of the spawner's brief. A message whose envelope the renderer does not recognize falls back to upstream's row: a visible fallback, never a plausible fake. The platform composes nothing; letters render verbatim.

A **sent message** gets no card. In the sender's own thread it is one of the agent's tool calls and renders as upstream renders any tool call; the message itself is shown in the receiver's thread.

One classifier decides the group and the preview for every client, so web and mobile agree. Mobile takes the same five treatments.

This is **not** a change to what agents receive, **not** a summary layer, and **not** an inbox: a badge informs, it never demands; obligations live in the [inbox](inbox.md).

## Acceptance criteria

### Who is speaking

1. Each message in the person's place in a thread is shown in exactly one of the five groups, by who is speaking, and only the person's own messages sit on the right.
2. The person's own message is upstream's bubble; one they sent from the inbox carries "You · via Inbox" above it.
3. Another person's message is a full bubble on the left with their initials and name, and one they sent from the inbox adds "· via Inbox".

### Other participants

4. A message from any other participant sits on the left under an identity line naming the sender and starts folded to the first line of the letter; opened, it shows the whole letter, and its footer opens the sender's thread when this client can open it, on the same server or on a connected peer.
5. The sender's name is the participant's label, else the sender thread's title, else "Agent"; a spawn brief's line reads "⟨spawner⟩ · brief".
6. A received ask shows "Expects reply" and a reply that closed an Exchange shows "Replied"; a plain message and a follow-up show no badge; a machine participant shows the tag "Automation" and an outside agent "Outside agent".
7. Badges are the only colored elements: amber while something waits, quiet green when resolved.

### Platform notices (not built yet)

8. A platform notice, J5's or upstream's, is one muted line on the left with an icon, a plain summary and the time, visibly distinct from any message, and opens to its detail.
9. A silence notice's summary names the counterpart and the age.

### Platform prompts (not built yet)

10. A platform prompt (an automation run, idle compaction, a playbook step for a Crew seat, a question raised to a parent) is an outlined pill on the left with its kind and title, and opens to the full prompt.

### Sent messages

11. A message the agent sent gets no card in its own thread; it renders as upstream renders any tool call.

### Copy and fallbacks

12. No row, folded or open, shows an envelope, a tagged block or a participant id, and a folded row's preview is the first non-empty line the reader should see.
13. A message whose envelope the renderer does not recognize renders as upstream's row.
14. No surface shows Exchange-closure mechanics as reader copy; "Expects reply" and "Replied" are the only Exchange words a reader sees.

### Conversation

15. Everything that is not a message in the person's place (the agent's replies, tool calls, work logs) renders exactly as upstream renders it.

## Scenarios

- **An ask arrives.** An agent in Billing Migration receives "which schema version do we target?" from its Captain: on the left, an identity line naming the Captain with an amber "Expects reply" badge, and one folded line, the question. The agent replies; the Captain's thread shows the reply folded under the agent's name with "Replied", and the agent's own thread shows the send as an ordinary tool call. (AC4, AC6, AC11)
- **The user answers from the inbox.** The user replies in the inbox; the agent's thread shows the reply on the right under "You · via Inbox". (AC2)
- **A Peer Agent starts.** A Peer Agent's thread opens with its spawner's brief, folded under "⟨spawner⟩ · brief" to the brief's first line; the platform context is never shown. (AC5, AC12)
- **A peer went quiet** (target). The Captain's turn ended without replying; the agent's thread shows one grey line, "Captain's turn ended without replying · 40m", and nothing that looks like a message. (AC8, AC9)
- **A plain update.** A peer sends a status update with no ask; its identity line has no badge. (AC6)

## History

- 2026-08-29 — the four treatments designed; former TA1–TA5 ([record](../../worklog/2026-08-29-thread-a2a-session.md)).
- 2026-08-31 — three amendments from Jackson's live test of the first build: no envelope expander on parsed cards (the raw fallback stays), no Squadron sub-line, badge copy "Expects reply", clickable sender name. Same day, the prominence session settled card anatomy, states, clamp, alignment, time and linking; former TA6–TA10 ([record](../../worklog/2026-08-31-thread-a2a-prominence-session.md)).
- 2026-09-01 — reader copy uses the "Expects reply" / "Replied" family, never closure mechanics (Jackson's final review of the inbox build).
- 2026-09-05 — "Replied" becomes the one word for a closed Exchange on every surface, replacing "Reply received" on sent cards and "Answered" on the inbox shelf (glossary).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: TA1 → AC1–AC3; TA2 → AC4; TA3 → AC5; TA4, TA8 → AC6, AC8; TA5 → AC13; TA6 → AC7; TA7 → AC9; TA9 → Definition (time); TA10 → AC11–AC12. The v0 rendering of the person's inbox reply as `Via Inbox · ⟨person⟩` (the "You" claim needs a person binding the auth principal does not yet have) is build status and lives in the dogfood plan.
- 2026-10-10 — sent messages no longer get a card (AC6). Upstream's V2 orchestrator sends clients a trimmed tool call, without the message body or the Exchange state the card was drawn from, so the card had not rendered since J5 moved to it; Jackson chose to retire it over exempting sends from the trimming (#522).
- 2026-10-17 — the sender's name links only when this client can open the sender's thread, on its own server or a connected peer; automations, outside agents and people have no thread to open (AC1). The 2026-08-31 clickable name had not been built (#625).
- 2026-10-24 — rewritten from cards to five groups by speaker, after upstream began folding other agents' messages into one-line rows (pingdotgg/t3code#23135); Jackson's design of that day, register D38. Groups 1 to 3 are built; the notices and prompts (AC8 to AC10) wait on [#698](https://github.com/Jacksondr5/j5code/issues/698), and mobile on [#699](https://github.com/Jacksondr5/j5code/issues/699). A follow-up no longer shows a badge. Former identifiers: AC1 → AC4, AC5; AC2 → AC12, AC13; AC3 → AC6; AC4 → AC2, AC3; AC5 → AC8, AC9; AC6 → AC11; AC7 → AC7; AC8 → AC1; AC10 → AC14; AC13 → AC15. Former AC9 (clamped card bodies), AC11 (a reply's quote of its ask) and AC12 (a badge's link to its pair) are dropped with the cards.
