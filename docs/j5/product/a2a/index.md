---
title: "Agent-to-agent communication"
kind: definition
---

# Agent-to-agent communication

## Problem

Single agents can get more done than ever before, but there are still limits. Context spent on building pushes important conversation with the user out of the window. Independent reviewers bring a fresh perspective. Frontier models waste usage on simple tasks that could be completed by cheaper ones. There is great value in letting agents talk to one another and coordinate work.

However, this must be done at the platform level. LLMs are not reliable and have their limits:

- Many A2A communication systems rely on polling or outside event triggers. The platform knows what is happening and can ensure timely delivery.
- Agents fall over all the time, the platform can notify the calling agent or user when that happens.
- When a user spawns many agents, they won't always pay attention to them all. Having a way for the agent to get in touch with the user beyond a "done" or "question" notification is needed.

Agent-to-agent communication is J5's answer: a way for agents and people to talk to each other that is **durable** (nothing is lost when a process ends), **measured** (the platform records what actually happened rather than trusting what an agent says happened), and **legible** (a person can see who is waiting on whom, for what, and since when).

## Definition

Agent-to-agent communication has four layers. Each one exists to make a specific failure impossible to hide.

### Transport

J5 carries a message by using upstream's thread injection: the message becomes text in the receiver's conversation. Formatted with the right metadata so the agents and users can understand it.

### The ledger

Every project has a **communication ledger**: an append-only record of everything that happens in communication — every message sent, every delivery outcome, every Exchange opened and closed, every silence notice, every participant joining or leaving.

The ledger is the source of truth. Nothing in it is ever edited or deleted, and every message in it is delivered. The ledger survives restarts, so a question asked before the server went down is still open when it comes back.

### The Exchange

An **Exchange** is one open question between two participants. It begins when one participant asks the other something, it stays open for as long as the other has not answered, and it ends with the answer. The platform tracks Exchanges so that _waiting_ is visible and attributable: at any moment the platform can say who owes whom an answer, about what, and for how long. This is the fact the inbox, the Fleet page and the silence notices are all built on.

An Exchange is never called a thread. A thread is a whole conversation; an Exchange is a single question that travels through conversations.

### Projections

A **projection** is a view the platform builds from the ledger — the inbox, the facts on the Fleet page, the communication graph, the playback of any earlier moment. Nothing is ever entered into a view directly. If a view is wrong, it is thrown away and rebuilt from the ledger, and it comes back the same. This is what lets the ledger be the only thing that needs to be trusted.

## How an Exchange works

There are three kinds of message.

- A **plain message** carries information and creates no obligation. Agents send these to each other freely.
- An **ask** opens an Exchange: the receiver now owes a reply. An ask carries a one-line **intent** that says what is being asked, so the question is legible wherever it is listed without opening the conversation. An ask to a person also carries an **urgency**, which says how soon the answer is needed.
- A **reply** names the Exchange it answers and closes it.

**Between agents**, one Exchange is open per pair of participants at a time. If the same agent asks the same peer again while the first question is still open, the second ask joins the open Exchange as a follow-up rather than opening a second one, so a chatty pair does not manufacture a pile of separate obligations. One reply closes the Exchange and everything that joined it.

**To a person**, an agent may hold several open asks at once, because distinct questions deserve distinct inbox items. A follow-up to a question the person has not yet answered is explicit: the agent references the open Exchange by its id — the id it received when it asked, and which every envelope on that Exchange carries — and the follow-up joins that Exchange and is shown beneath the original ask, so the person always sees the whole question.

**Closing** is mechanical. An Exchange closes when the reply arrives, when the sender withdraws its own ask, or when the receiver is retired. Whether the reply was _complete_ is not the platform's judgment: a sender who is not satisfied opens a new Exchange about the earlier one, and the platform never decides that on its behalf.

## Participants

A participant is anything that takes part over the ledger: an agent, a person, or a machine participant. Every thread that is not a provider-native Subagent is an agent participant in the ledger of its project, from the moment the thread exists. A thread's project is fixed when upstream creates the thread, so a participant never moves between ledgers. People are global — one person id, known across every project on the server — and nothing anywhere may assume there is exactly one of them. Provider-native Subagents are never participants.

A **machine participant** is a registered non-agent sender — a scheduled scraper, a watchdog, a shell script — and is how machine events enter the fleet as first-class work sources. Like an agent it belongs to one project, which never changes; it has a server-unique name and, unlike an agent, no thread. It sends plain messages only, and nothing can be delivered to it, so no Exchange is ever open with it and no silence is measured about it. It acts only through a token bound to its own participant id; nothing else can send as it.

Every participant can message every other participant that can receive: an agent receives from anyone, a person receives only asks, and a machine participant receives nothing. No project, no placement in a tree and no Role restricts who may talk to whom; the hierarchy carries decisions, never messages, and a Captain commands its Crews by briefing them, never by routing their messages. An agent cannot message itself. A participant may live on a peer server; the sender addresses it by the same id, the address book names the server it lives on, and the platform carries the message across as defined in [cross-device](../cross-device.md). The platform states identity facts wherever it speaks: the envelope names the sender, the address book marks the caller's own row, and a spawned agent's first turn tells it who it is.

## Delivery

Delivery is **log-first**: the ledger row is the act, and delivery is an attempt recorded against it. A successful attempt is a **delivery receipt**; a failed one is retried; a failure past the retry limit is a **delivery alarm** — a visible fact attributed to the sender, never a silent loss, and never assumed repaired because time passed or a later message got through. "Was it delivered" and "was it answered" are independent facts. When the receiver lives on a peer server, the attempt crosses to that server, which records its own received row before delivering. Across servers the receipt means the peer server accepted the message; delivering it into the thread is that server's own delivery, which retries and alarms there, attributed to the sender. Failure to reach a peer server the sender's server sends to directly retries and alarms on the sender's server; a message for a peer server that polls is stored until it polls, and its acknowledgement is the receipt. A message the peer server refuses, or one cancelled before it was delivered, is reported to its sender in a not-delivered notice. "Peer" in this definition means another agent; another server is a **peer server**, defined in [cross-device](../cross-device.md).

Two policies govern what happens when a message reaches an agent whose turn is running, and they are independent of each other.

The **agent-side policy** is J5's default: a message from an agent **queues** behind the running turn and starts when it ends. **Steering** injects it into the running turn, and **restarting** interrupts the turn and restarts it with the message. Both are upstream's own choices for a send into a thread, and a sending agent may ask for either on `j5_send_message`, under upstream's rule that the receiver may not run with broader permissions than the sender (Jackson, 2026-10-11, [#519](https://github.com/Jacksondr5/j5code/issues/519)). An agent that does not ask gets the queue: upstream's own default steers whenever it can, which aborts a running turn on some providers ([divergence D4](../upstream.md)). Unasked, one provider's turns are steered: a peer's message to an already-running Codex GPT 6 turn (Astra, Luna, Sol and their point releases) is delivered into the turn as an ordinary envelope, because the GPT 6 models are built to take messages during work. What the agent does with it is the agent's judgment, exactly as with any other message; the platform adds no guidance about whose instructions win. Platform notices always queue.

A queued message costs its receiver a whole turn, so a stream of small updates becomes a stream of turns. When a sender's message will wait behind the receiver's running turn, the platform tells the sender at once, with the measured backlog, and advises one message in place of many. It advises; it never refuses or holds a send.

The **person-side policy** is upstream's: whether the person's own send steers or queues, the shortcuts for choosing, and how the composer and the queued rows present a steer follow upstream on every client (documented in upstream's `docs/user/composer.md`). J5 adds nothing to the person's steer.

## The person as a participant

A person takes part in the same protocol as an agent, with two differences that follow from being a person.

Delivery is the **inbox**, not a conversation. An ask to a person lands in their inbox, gathered across every project on the server. The person's answer, exactly as written, is the reply that closes the Exchange and reaches the asker — no relay, no summary. A person receives only asks; a plain message to a person is refused, because a plain message carries nothing the sender's own thread does not already show, and if the person must see something then seeing it _is_ the obligation. The person never opens an ask through the platform: their channel to an agent is that agent's thread, which they can open at any time, and their only act on the ledger is the answer that closes an Exchange.

Silence is **never measured about a person**. A person has no turn that ends. How long their open asks have waited is a fact the inbox and the Fleet page show; nothing nags.

## Silence

**Silence is measured; replies are asserted.** When an agent's turn ends without a reply it owed, the platform — never the agent — records a **silence notice**: the measured facts of what happened, not a conclusion about why. The facts are the turn that ended and how, whether the delivery was ever processed, every open outbound Exchange the agent holds, and any error or stop.

The platform names five kinds of silence: the turn ended without the owed reply; the turn errored; the agent was stopped, which tells the waiter not to retry; the agent is itself waiting on a person, and whether that person has seen the ask; and the agent is blocked on a peer, naming the peer. A notice informs the waiter. It never closes the Exchange, and it never claims to know whether the agent forgot or is waiting on something first — that is the waiter's judgment to make with the facts in hand.

## Envelopes

Every delivered message is wrapped in an **envelope**: the platform's wrapper that tells the receiving agent who sent this and from which project — and, for a sender on a peer server, which server — what it now owes and how to discharge it, and the measured time. A machine participant's envelope says that the sender is automated and cannot receive a reply, so the agent acts on the message directly and takes any question to a person or a peer. Envelope wording is versioned configuration rendered from one place, so the channels never drift, and it is written in plain words for an agent reading it in the middle of its work. People reading the app see the letter, not the envelope.

## Vocabulary this definition owns

message, ask, reply, plain message, Exchange, intent, urgency, obligation, envelope, communication ledger, projection, delivery receipt, delivery alarm, silence notice, queue, steer and restart, machine participant. The [glossary](../glossary.md) points here for each of them. Provenance and placement are organization, not communication, and are defined with the [Fleet page](../features/fleet-page.md).

## Acceptance criteria

### The ledger

1. Every message an agent or person sends through the platform is recorded in the ledger of the sender's project before the sender's call returns.
2. Nothing in a ledger is ever edited or deleted, and every recorded message is delivered; a server restart loses nothing.
3. A message between participants in different projects appears in both projects' ledgers with a shared correlation id, and a crash between the two writes leaves the sender's row visible rather than losing the message.
4. Every projection can be rebuilt from the ledger to an identical result, and a mutated projection row fails the equivalence check.

### Exchanges

5. An ask opens an Exchange between its sender and receiver, carries a one-line intent, and carries an urgency when the receiver is a person.
6. While an Exchange is open between two agents, a further ask from the same sender to the same receiver joins it as a follow-up rather than opening a second Exchange.
7. An agent may hold several open Exchanges with the same person at once, each shown as its own inbox item.
8. A follow-up to an open ask to a person references that Exchange by its id, joins it, and is shown beneath the original ask in the inbox.
9. One reply naming the Exchange closes it, together with every follow-up that joined it; the sender may withdraw its own ask; the receiver's retirement closes it with a notice to the sender; nothing else closes it.
10. A message from an agent to itself is refused with an error naming the caller's own id.
11. No project, placement, or Role restricts which participants may message each other.

### Delivery

12. Every delivery attempt is recorded; a delivery that fails past the retry limit is shown as an alarm attributed to the sender and is never marked repaired by time passing or by a different message succeeding.
13. A message to an agent whose turn is running is queued and delivered when the turn ends, unless its sender asked for a steer or a restart, or it is a peer message into a running Codex GPT 6 turn, which is delivered into the turn as an ordinary envelope with nothing added.
14. How the person's steer is offered, labeled and sent — in the composer and on a queued row, including whether a send steers or queues by default — follows upstream. An agent's steer or restart is asked for on `j5_send_message` and is defined with that tool ([agent tools](agent-tools.md)).
15. Platform notices are always queued, never steered.

### The person

16. An agent-to-person send that is not an ask is refused with an error naming the legal move; a person cannot open an ask through the platform.
17. An ask to a person appears in that person's inbox regardless of which project it came from.
18. A person's answer to an ask is delivered to the asker exactly as written, as the reply that closes the Exchange.
19. No silence notice is ever written about a person.

### Silence

20. When an agent's turn ends without a reply it owed, the platform records a silence notice holding the measured facts and delivers it to the waiter.
21. A silence notice never closes an Exchange.

### Envelopes

22. Every delivered message carries an envelope naming the sender, the sender's project by its id with its title beside it, the sender's server when it is a peer server, what is owed, and the measured time.
23. The answer a person gives in the inbox reaches the agent wrapped in an envelope that says the Exchange is closed and no further reply is owed.

### Machine participants

24. A machine participant is registered in exactly one project under a server-unique name, its id is `machine:` followed by that name, and registering the same name again returns the existing participant rather than a second one.
25. A machine participant sends plain messages only, through the same command path and replay rules as an agent's send; a send from an unregistered machine is refused with an error naming the registration command.
26. A message addressed to a machine participant is refused with an error naming the legal move, and the address book lists every machine participant as unable to receive a message or open an Exchange.
27. A machine participant's message is delivered wrapped in an envelope that names the sender as automated and states that no reply can reach it; the thread view attributes the card to the machine's name and marks it as automation.
28. A machine participant acts only through a token whose scope is `a2a:send` and whose subject is its own participant id; a token with any other subject, or without that scope, is refused.

### Sending to a busy agent

29. A send to an agent whose turn is running, and which will not take the message into that turn, returns a notice stating how many messages are waiting for it, how many of them the caller sent, and that each will run as its own turn; a send to an idle agent or to a running Codex GPT 6 turn returns no notice, and no send is refused because of the backlog.

## Scenarios

- **An ask and its answer.** An agent in Billing Migration asks its Captain "which schema version do we target?" with intent "schema target". The Captain's turn ends without replying; the platform records a silence notice and delivers it to the asker, whose next turn sees that the Captain's turn ended without replying. The Captain's next turn replies; the Exchange closes; the asker sees the answer. (AC5, AC9, AC20, AC21)
- **Two questions for the user.** The same agent asks the user "merge now or after the audit?" with urgency _soon_, and separately "may I delete the old branch?". Both appear as inbox items. The agent then learns something relevant to the first question and follows up on it by name; the follow-up appears under that item. The user answers each; each Exchange closes with the exact text delivered to the agent. (AC5, AC7, AC8, AC18)
- **A busy receiver.** An agent in Website Redesign sends a plain message to a peer whose turn is running a long shell command. The message queues; the peer's turn finishes normally; the message starts its next turn. The user, watching the peer, chooses to steer instead — the control says "Steer now" on this provider — and their text is injected into the running turn. (AC13, AC14)
- **A failed delivery.** An agent asks a peer that has been archived. The delivery fails, the alarm is attributed to the asker and shown on its Fleet page row; the asker withdraws its ask; the alarm remains a fact but no longer counts as a problem. (AC9, AC12)
- **Across projects.** An agent in Billing Migration asks an agent in Support Rotation for an incident's status; both projects' ledgers carry the Exchange under one correlation id, and the Fleet page shows it as an open ask on both agents' rows. The same holds when the Support Rotation agent lives on a peer server; the address book names that server, and the asker addresses the agent by id all the same. (AC3)
- **A scraper wakes an agent.** The observability scraper of L2 Support Rotation, registered as the machine participant `machine:watchdog`, runs on a schedule and sends "canary 42" to the triage agent from a shell script with a client request id. The agent's thread shows a card from watchdog marked as automation; the agent acts on it and cannot reply to the watchdog. The script retries with the same id after a network blip and gets the original receipt back; nothing is delivered twice. (AC24, AC25, AC26, AC27)

## History

- 2026-08-14 — the communication graph drafted; former open questions 1–4 ([record](../../worklog/2026-08-14-communication-graph-draft.md)).
- 2026-08-16 — design settled; former D1–D10, this file's earlier form.
- 2026-08-21 — design review: former R3 (closure is mechanical, completeness is the sender's judgment), R4 (notices are measured facts; labels are read-time policy), R10 (a follow-up may name an earlier Exchange), R22 (Captains are never routers), R25 (time facts in envelopes) ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-08-24 — Subagent and Peer Agent distinguished; `delegate_task` excluded, so former D1's delegation edges no longer exist ([record](../../worklog/2026-08-24-spawn-terminology-session.md)).
- 2026-08-31 — self-send refused; identity facts stated by the platform ([record](../../worklog/2026-08-31-picker-and-self-messaging-rulings.md)).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/2026-09-02-human-addressed-sends-ruling.md)).
- 2026-09-03 — agent deliveries queue; only the person steers; former QS1–QS4 ([record](../../worklog/2026-09-03-queue-vs-steer-ruling.md)). 2026-09-05 — the person-side default returns to upstream's (steer on send, an explicit queue shortcut) with the upstream integration (PR #112); the agent-side queue policy, the Astra exception and the truthful-steer guard stand, and the two policies are recorded as independent.
- 2026-09-04 — the Codex Astra exception ([record](../../worklog/2026-09-04-astra-peer-delivery.md)); 2026-09-08 — a person never opens an ask through the platform; their only ledger act is the closing answer (the 2026-08-14 design's person-as-sender is dropped; the unused person-origin envelope channel goes with it, issue #119). Same day, the delivery guidance that path appended ("continue the unfinished task… change course only when the user's instructions require it") is removed: an agent told by a peer that it should change course should not wait for a user who may never come; the model's behavior is observed instead (issue filed).
- 2026-10-12 — the Codex Astra exception covers every Codex GPT 6 model: Luna and Sol take messages during work as Astra does (Jackson, [#569](https://github.com/Jacksondr5/j5code/pull/569)).
- 2026-09-05 — rewritten into the definition shape; 2026-09-07 — provenance and placement moved to the Squadron definition (they are organization, not communication). One change of substance: an agent may hold several open asks to a person, with explicit follow-ups shown in the inbox — reversing the one-ask-per-person rule of 2026-09-02 (issue #111). Former identifiers: D1 → Participants (delegation half retired); D2 → Participants; D3, D8 → The ledger, AC3; D4 → AC5; D5 → Delivery, AC1; D6 → Silence, AC20; D7 → the A2A plan; D9 → The Exchange; D10 → the Squadron definition (placement and provenance), with its obligation half being the Exchange; R3 → How an Exchange works, AC9; R4 → Silence; R21 → the Squadron definition; R22 → Participants; R25 → Envelopes, AC22; QS1–QS4 → Delivery, AC13–AC15.
- 2026-09-15 — machine participants: registered non-agent senders with an immutable Squadron home and no thread, plain sends only, never receive, token-bound identity through the `a2a:send` scope; AC24–AC28 and the scraper scenario (issue #74).
- 2026-09-24 — the truthful-steer layer is retired with the upstream V2 advance: the person's steer and queue presentation follows upstream's as-is, and AC14 keeps only the rule that a person alone steers; remaining steer UX gaps are tracked in the upstream give-back backlog (issue #276).
- 2026-09-16 — a receiver's Squadron may live on a peer server; addressing, envelopes and delivery facts are unchanged, and peering itself is defined in cross-device ([record](../../worklog/2026-09-16-cross-server-peering-session.md)).
- 2026-10-02 — a receiver on a peer server is no longer hidden: the address book names its server, the envelope of a message from a peer server names that server (AC22), and a message to a peer server that polls is stored until it polls; refused and cancelled deliveries reach the sender as not-delivered notices. Peering itself, and poll mode, are defined in cross-device ([record](../../worklog/2026-10-02-peering-poll-mode-session.md)).
- 2026-10-03 — a sender whose message will wait behind a busy receiver is told the measured backlog when it sends; AC29 (issue #424). Merging queued messages and refusing past a limit were rejected; receivers on peer servers are issue #425.
- 2026-10-07 — Squadrons retired: a thread's home is its project, which upstream fixes when the thread is created, and the ledger is keyed by project (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-11 — a sending agent may ask for a steer or a restart; the queue stays the default and the GPT 6 exception stands. AC13 and AC14 rewritten: AC14 no longer says only a person steers (Jackson, [#519](https://github.com/Jacksondr5/j5code/issues/519)).
