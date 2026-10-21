---
title: "Crew teamwork session (2026-10-21)"
kind: record
---

# Crew teamwork session (2026-10-21)

Bryant and an agent (Claude Opus 5.5 in J5 Code) reviewed how Crews work today and what would make them behave more like a team: more dynamic, better at talking within and between Crews, better at using Subagents, and less wiring for the person. Two outside reviews were run on other vendors' models for a wider view: Codex GPT-6.1-Sol and Gemini 4 Argon through Cursor. This record holds what was found and what was agreed. The [Crews](../product/features/crews.md) and [agent-to-agent communication](../product/a2a/index.md) definitions carry the outcome; the work is the "Crews: organic teamwork" milestone.

## What prompted it

Bryant had noticed that some models message their crewmates after every turn while others wait until their task is done, and that some seats end up with more than fourteen items queued, which seemed to confuse them and make them redo work.

## What was found

The review read the Crews and A2A definitions and the server code under `apps/server/src/j5/a2a`, and both outside reviews independently reached the same main findings.

- **The roster a seat knows is frozen at launch.** A seat's first turn carries the roster; an approved addition briefs only the new seat, and the seats already working are never told.
- **Messages name their sender only by id.** The envelope says "from agent:j5:a2a:…", not who that is or how they relate to the receiver.
- **The address book knows nothing about Crews.** No Crew name, seat, Captain mark, or responsibility on a row, so Captains of different Crews find each other by thread title.
- **There is no shared state.** Everything a seat knows about its crewmates' progress arrives as a message.
- **Helpers are invisible.** A seat's finish notice ignores a delegated helper still working, and the Inbox lists approvals for seat threads only, so a helper stopped on an approval sits unseen.
- **Every seat starts at once.** A reviewer or sitter wakes before there is anything for it to do.

Bryant's live data (read-only, every Crew seat on his server; queue depth estimated from run timestamps) showed what drives the queues:

| Model            | Seats | Turns per seat | Deepest queue | Seats past 10 queued |
| ---------------- | ----- | -------------- | ------------- | -------------------- |
| claude-opus-5-5  | 78    | ~14            | 77            | 7                    |
| claude-fable-5-1 | 48    | ~16            | 58            | 10                   |
| gpt-6-sol        | 13    | ~12            | 34            | 3                    |
| gpt-6.1-sol      | 111   | ~6             | 22            | 2                    |
| gpt-6-astra      | 16    | ~8             | 2             | 0                    |

- **Senders differ.** GPT 6 seats sent about three messages per turn, posting updates while they worked; Claude seats sent about one, usually at the end.
- **Receivers differ more.** GPT 6 takes a peer's message into its running turn, so its queue stays short. Every other model runs each queued message as its own turn, and those turns send replies into other queues.
- **It is not one chatty model.** The two deepest queues had mixed senders: Opus, Sonnet, GPT-6-Sol, GPT-6.1-Sol, and Astra.
- **Most traffic is plain sends.** 82% of the messages Crew seats received were plain sends rather than asks or replies (2,786 against 604).

## What was agreed

1. **A busy agent reads waiting messages in one catch-up turn.** This is the structural fix: it works on every provider whatever the senders do. It reuses the pattern the seat-finished notice already uses (upstream's queued-run edit), so it needs no upstream change.
2. **One messaging rule for every model.** Message when blocked, when a teammate must act now, or when done, in one message; progress goes on the notepad. Guidance only, shipped with the catch-up turn.
3. **Envelopes name the sender and the relationship.**
4. **The address book lists Crews, seats, and responsibilities, with a Crew filter.**
5. **Seats are told when someone joins.**
6. **Guidance for retasking a seat and for briefing a helper.**
7. **A Crew notepad.** A plan page the Captain writes and one page per seat, each with one writer and read by everyone. Bryant asked whether the notepad was the real fix for the queues. It is not: it lowers how many messages are sent, but it depends on agents choosing to use it, and asks, replies, hand-offs, and results still have to be messages. The catch-up turn fixes what a pile of messages costs; the notepad makes the pile smaller.
8. **A seat's helpers count as the seat.** The finish notice waits for delegated helpers, their approvals reach the Inbox under the seat, and their runs and cost show on the seat's row.
9. **Seats can start when called.**
10. **A message to the whole Crew** only if it is still needed once 1 and 7 are in. A crew-wide send fans out into more queued messages, so it waits.
11. **Additions take several seats in one request and show inline in the Captain's thread as well as the Inbox.** This reverses Bryant's 2026-09-14 placement of additions on the bell alone: when the person is watching the Captain, they should not have to leave to approve, and a guest who cannot see the Inbox can still answer.

Set aside: making helpers full participants, replacing a single seat, and running playbook steps in parallel. Each would add machinery for something a Captain can already do with a message.

## How decisions are discussed

Bryant asked whether an ADR, PRD, or RFC wiki would help the core team talk through changes like these. The agent recommended against a separate wiki, because the repository already has those three things. A record like this one is the decision log, a definition is the product spec, and a reviewed docs PR that changes the definitions is the request for comment, with threads on each line. A wiki would be a fourth place that nobody reviews and that drifts out of date. The definitions for this session went up as a docs PR to try that out; the question was still open when this was written.
