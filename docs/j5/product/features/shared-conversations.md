---
title: "Shared conversations"
kind: definition
---

# Shared conversations

## Problem

Two people who want the same agent's help relay it to each other: one asks their agent and pastes the answer to the other. Putting both in front of the same agent removes the relay ([problems](../problems.md): Shared server). It also gives the agent a problem it has never had. A conversation has always had one human voice, and an agent given two cannot tell them apart, and its memories, which carry across threads, mix up who said what.

## Definition

A **shared conversation** is a thread that more than one person can write to: one an Owner and a Collaborator can both reach, or two Owners ([People and access](people-and-access.md)). A thread stays a shared conversation once it has been one. On a server several people use, every thread is one from its first message; on a server with one person and an occasional invitation, only the threads and projects that were shared are. A thread only one person has ever been able to write to is unchanged by anything here.

**The agent is told who is speaking.** The server puts the author's name and level on each person's message, at its start, in the text the agent reads, the way it names the sender of a message from another agent. The name is the one the server holds for that person, so a person cannot write as someone else. When a thread becomes shared, the agent is told in a note who can write to it, how to read the author's line, and who wrote the messages before it. The note is not a message of its own: it goes at the top of the next message a person sends, so the agent learns it in the turn it first matters. A message that begins with a slash is a command for the provider, which reads it only from the first character, so for now it goes to the agent exactly as typed, with no line; the person who sent it is still shown to everyone on the thread.

**For now, everyone who can write is trusted alike.** Owners own the server the agent runs on, and Collaborators were invited by an Owner to work with it. The agent treats everyone's requests the same way. When two people ask for things that conflict, it asks in the thread, naming them, and an Owner's word settles it. This is guidance the agent is given, not a rule the platform enforces: an agent reads every message as text.

**Prompts belong to everyone who can write.** An agent raises three kinds of prompt in its thread: a question, a command waiting for approval, and a Crew roster waiting for approval. Anyone who can write to the thread answers one, the first answer settles it, and it then shows who answered. An answer to a question carries its author's name to the agent, and a Crew's Captain is told who decided its roster. Who approved a command is shown to the people on the thread and not told to the agent: an approval carries no words to put a name on. A Viewer sees each prompt with nothing to press.

**An agent asks one person, or everyone here.** In a shared conversation an agent can ask, through the [inbox](inbox.md), any one person who can write to its thread, or **everyone here**: everyone who can write to its thread at the time the ask is read. An ask shows in the thread for everyone on it, and so does its reply. The first reply closes it for everyone. A Crew's later requests, a seat's approval and a request for a further seat, reach everyone who can write to that thread the same way ([Crews](crews.md)).

**Anyone who can write runs the thread.** A Collaborator, like an Owner, sends, queues and steers messages, interrupts and stops work, and changes or withdraws any queued message. When a person can no longer write to a thread, the messages they still have queued there are withdrawn.

**Thread state is shared, for now.** Whether a thread is archived, settled, snoozed or pinned, and whether it has been read, is one value for everyone on the server, as upstream keeps it.

**Each person reads their own messages as they always have**, and other people's in the same bubble on the left, with the author's name. The level the agent is told is not drawn.

**A shared conversation is shared whole.** A person added to it reads it from the beginning. Hiding the earlier part would be a promise the platform cannot keep, since a collaborator can ask the agent what was said. A person whose access ends loses the thread, and their messages stay in it under their name.

### Later

Set aside on purpose, each tracked where it is linked. An item leaves this list when the definition takes it in.

- The read marker, snooze and pin kept per person rather than per thread ([#629](https://github.com/Jacksondr5/j5code/issues/629)).
- A person's picture beside their messages: the GitHub profile picture for a username they enter in their own client ([#637](https://github.com/Jacksondr5/j5code/issues/637)).
- Seeing who else is reading or typing in a thread, and the rest of the set-aside list ([#542](https://github.com/Jacksondr5/j5code/issues/542)).

## Acceptance criteria

### Authors

1. In a shared conversation, every message a person sends reaches the agent beginning with the line `[Message from <name> (<level>)]`, where the level is owner or collaborator. The name is the one the server holds for that person; nothing the person or their client sends changes it.
2. In a thread only one person has ever been able to write to, a message reaches the agent as it does without this feature.
3. When a thread becomes shared, the next message any person sends to it carries a note to the agent, at the top of that message and ahead of its author's line. The note names who can write and at what level, explains the author's line, the answer's line and that a command carries no line, and names who wrote the messages before it.
4. After someone gains or loses the ability to write to a shared conversation, changes level, or is renamed, the next message any person sends to it carries a note saying so, with who can write now. A note is carried by every message a person sends until one that carries it has reached the agent, so the agent can read it more than once and never reads a person's message without it. If the conversation is rewound to before the note, the next message carries it again.

5. For now, a message whose first character that is not whitespace is `/` reaches the agent exactly as typed, with no author's line and no note, whoever sent it; the timeline still shows who sent it.
6. A thread is a shared conversation from the moment more than one person can write to it, and stays one after that.

### Standing

7. For now, the note of AC3 says that Owners own the server, that Collaborators were invited by an Owner to work with the agent, and that the agent treats everyone's requests the same way; and that when two people's requests conflict, the agent asks in the thread, naming them, and an Owner's word settles it.

8. No message is refused, altered or held by the platform on account of its content, except that only the platform sends the context records of its own kinds.

### Prompts and asks

9. In a shared conversation, a question prompt, an approval prompt and a Crew roster prompt can each be answered by anyone who can write to the thread, including editing a roster's seats and allowing a command for the session.
10. The first answer settles a prompt for everyone, and the settled prompt shows who answered. An answer to a question carries its author's name and level to the agent. A Crew roster's Captain is told who approved or declined it. For a command's approval, the people on the thread see who answered and the agent is not told.

11. A Viewer sees each prompt and its outcome, with its controls shown disabled.
12. A Crew seat's request for approval, and a Captain's request for a further seat, reach the inbox of everyone who can write to that thread, and the first answer settles each.

13. In a shared conversation, an agent can ask one person who can write to its thread, or everyone here; an ask and its reply show in the thread to everyone on it.

### Queueing and steering

14. Anyone who can write to a thread can send, queue and steer messages, interrupt and stop work, and change or withdraw any queued message.

15. When a person can no longer write to a thread, the messages they have queued there are withdrawn, and what was already delivered stays under their name. A message they sent while they could still write, and still on its way when their access ended, may still reach the agent.

### Reading

16. A person's own messages render as they do in a thread that is not shared; another person's message, a command included, renders in the same bubble on the left, with that person's name above it and initials on a coloured circle beside it, and no level.

### History

17. A person added to a thread can read all of it, from its first message.
18. When a person's access to a thread ends, by removal or by their leaving, their messages remain in it under their name.

### Thread state

19. For now, archive, settle, snooze, pin and the read marker are one value per thread, shared by everyone on the server.

## Scenarios

- **Two people, one agent.** The user gives a teammate Collaborator on a thread in Billing Migration. The teammate's first message reaches the agent with a note naming the user (owner) and the teammate (collaborator), saying the earlier messages were the user's, and then `[Message from Priya (collaborator)]`. On the user's screen the message is a card with Priya's name; on hers it is an ordinary message. (AC1, AC3, AC7, AC16, AC6)
- **A team server.** On L2 Support Rotation's server everyone on shift is a Collaborator at server scope. A thread an engineer starts is a shared conversation from its first message, and an agent asked a week later "what did Sam tell you?" can answer, because every message carried its author. (AC1, AC6)
- **A request that conflicts.** Priya asks the agent to drop a migration step; the user said earlier to keep it. The agent asks in the thread, naming both, and the user says to keep it. (AC7)
- **A command.** Priya types `/compact`. It reaches the provider as typed and the conversation is compacted; the timeline shows it as Priya's. (AC5)
- **Everyone here.** A background agent on the L2 server needs a decision and asks everyone here. The ask appears in the inbox of everyone on shift; Sam answers first, and it leaves the others' inboxes showing that Sam answered. (AC13)
- **A Crew, end to end.** Priya asks the agent for a Crew, edits a seat's model on the roster and approves it. A seat later needs a command approved; the request reaches her inbox and the user's, and she approves it. (AC9, AC12)
- **The agent is busy.** The user sees the agent heading the wrong way and stops it; Priya steers it with a correction instead. Either can fix a typo in the other's queued message. (AC14)
- **Watching.** A Viewer on the thread sees each prompt and how it was answered, with the controls disabled. (AC11)
- **Access removed.** The user removes Priya. Her queued message is withdrawn, the agent is told she can no longer write, and her earlier messages still carry her name. (AC4, AC18, AC15)

## History

- 2026-10-11 — defined (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)). AC16 is tentative: if a guest managing only their own queued messages proves a mess to build, a guest gets either a member's rights over the queue or none.
- 2026-10-12 — AC1: a name a person gave themselves, joining by an open link, is confirmed or changed by a member before that person is given Collaborate (Jackson, 2026-10-11; [#541](https://github.com/Jacksondr5/j5code/issues/541)).
- 2026-10-13 — AC3, AC4: the agent is told by a note at the top of the next message a person sends after who can write has changed, not at the moment of the change and not in a message of its own. The note says a member's messages carry a name too, and a changed "here for" line is told. "One" note is not promised: every message carries it until one that does has reached the agent, and it is told again after a rewind. AC6: the "here for" line cannot be removed once set (Jackson; [#533](https://github.com/Jacksondr5/j5code/issues/533)).
- 2026-10-13 — AC5: the note no longer says a guest is "not fully trusted". A guest is worked with on ordinary work; sensitive things need a member's prior authorization, which the "here for" line can give. In a live test two models refused a guest's harmless request for want of a member's approval (Jackson).
- 2026-10-13 — AC9: the agent is told who answered a question, on the answer, and a Captain who decided its roster; it is not told who answered a command's approval, which the people on the thread see (Jackson: "The providers dont provide a way for us to give the context, a queued message is terrible UX"). AC10: a guest approves a roster whatever access its seats have (Jackson).
- 2026-10-13 — AC22: a member's message that begins with a slash is sent as typed so that provider commands work; a guest's is sent as words under their name (Jackson).
- 2026-10-17 — rewritten for the people model (Jackson; [record](../../worklog/2026-10-16-people-and-access-session.md)). A thread is shared whenever more than one person can write to it, and stays so (AC6), so that agents can tell people apart across their memories. The author's line names the level (AC1). Anyone's command goes as typed (AC5). The note trusts everyone who can write alike and an Owner settles a conflict (AC3, AC7). Anyone who can write answers every prompt, edits a roster and allows a command for the session (AC10). Crew requests (AC13) and asks (AC14) go to everyone who can write, with "everyone here" as an address. Anyone who can write steers, stops and changes any queued message (AC15, AC16). Thread state is shared (AC22). Another person's message is drawn as the reader's own bubble on the left, with name and picture and no level (AC17; Jackson, in the design review). Retired, by their former numbers: AC6 (the "here for" line), AC10 (a guest approved a roster only as proposed), AC13 (an inbox ask was refused in a shared conversation), AC14 and AC15 (a guest only queued and could not stop).

- 2026-10-17 — criteria renumbered in order, after the rewrite retired the former AC6, AC10, AC13, AC14 and AC15 (Jackson). Former numbers: AC5 → AC7; AC7 → AC8; AC8 → AC10; AC9 → AC11; AC11 → AC12; AC12 → AC13; AC16 → AC15; AC22 → AC5; AC1 to AC4 and AC17 to AC21 unchanged. The rewrite's own line above uses the new numbers. Code comments that cite the former numbers are rewritten with the rebuild.
- 2026-10-17 — what holds only for now is marked so, and a Later list names what is set aside, with the issue that tracks each (Jackson).
- 2026-10-18 — a person's picture moves to the Later list (Jackson, 2026-10-17, for the build of [#636](https://github.com/Jacksondr5/j5code/issues/636)): AC17 draws initials, and former AC18 and AC19 are retired; former AC20 to AC22 are now AC18 to AC20. A copy of the guest-era History and Scenarios left in by the rewrite is removed.
- 2026-10-18 — AC16: a message sent while its author could still write, and still on its way when their access ended, may still reach the agent; holding every send against every change of access would cost more than it returns, since that person was trusted when they sent it (security review of [#636](https://github.com/Jacksondr5/j5code/issues/636); provisional, for Jackson to confirm).
- 2026-10-18 — the Owners line is dropped; the note names everyone who can write, Owners included (Jackson). Former AC9 is retired, and former AC10 to AC20 are now AC9 to AC19.
