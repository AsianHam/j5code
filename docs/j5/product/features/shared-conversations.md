---
title: "Shared conversations"
kind: definition
---

# Shared conversations

## Problem

Two people who want the same agent's help relay it to each other: one asks their agent and pastes the answer to the other. Putting both in front of the same agent removes the relay ([problems](../problems.md): Shared server). It also gives the agent a problem it has never had. A conversation has always had one human voice, and an agent given two cannot tell them apart, does not know whose word carries, and has no way to ask one of them something where the other can see.

## Definition

A **shared conversation** is a thread that more than one person can write to: a thread a guest holds a Collaborate grant on ([Shared server](shared-server.md)). A thread only one person can write to is unchanged by anything here.

**The agent is told who is speaking.** The server puts the author's name on each person's message, in the text the agent reads, the way it names the sender of a message from another agent. The name is the one the server holds for the person the connection was paired as, given by the member who brought them in. Nothing the person or their client sends can change it, so a person cannot write as someone else. When a thread first becomes shared, the agent is told, in a system note, who can now write to it, that every person's message carries its author's name from then on, and that the messages before that point came from a member. The note is not a message of its own: it goes at the top of the next message a person sends, so the agent learns it in the turn it first matters.

**Guests work with the agent, and members own the system; the agent is told the difference.** The same note says that members own the server the agent runs on, and that guests take part at a member's invitation: they are there to work with the agent and do not own the system. The agent works with a guest as with anyone on the ordinary work of the thread. It does nothing sensitive at a guest's request unless a member authorized it beforehand, and the note says what sensitive means: deleting or overwriting work, changing settings or access, acting outside the project, or anything hard to undo. The member who shares can say what the guest is there for; that line is part of the note and counts as that authorization for the work it describes. When a guest asks for something sensitive, or for something that conflicts with what a member said, the agent holds off and asks a member in the thread, by name. A member can widen or narrow what a guest may ask at any time by saying so in the thread.

This is guidance the agent is given, not a rule the platform enforces. An agent reads every message as text, and nothing can make it rank one author above another. Members of one server are equals, and a disagreement between them is an ordinary change of mind; a thread has no owner among them.

**Prompts belong to everyone who can write.** An agent raises three kinds of prompt in its thread: a question, a command waiting for approval, and a Crew roster waiting for approval. In a shared conversation any member or guest collaborator can answer one, the first answer settles it, and it then shows who answered. An answer to the agent's question carries the name of the person who gave it. Who approved or declined a command is shown to the people on the thread and is not told to the agent: an approval carries no words to put a name on. A person brought in to work with an agent should not see it held up on a prompt they could have answered, and a person who can tell the agent to do something can approve it doing so. A guest approves or declines a Crew roster as the Captain proposed it, with whatever access its seats have: a member who brings someone in to work with an agent trusts them with what the agent proposes. Changing a seat, and with it how much a seat may do, stays with members. A guest with a View grant sees each prompt as information, with nothing to press. What a Crew asks for after it has launched, another seat or approval for a seat's command, goes to the inbox ([Crews](crews.md)) and so reaches members only.

**The inbox is not used.** An agent in a shared conversation cannot send an ask to a person's inbox: a private question to one person works against a conversation everyone is in. To put something to one person in particular, it writes in the thread and names them.

**A guest queues; a member steers.** A guest's message starts the agent when it is idle and waits behind the current work when it is not. Only a member can interrupt work in progress or stop it. A guest can change or withdraw a message of their own that is still waiting.

**Each person reads their own messages as they always have**, and other people's as cards that carry the author's name and picture. A person's picture is their GitHub profile picture, from a username they enter in their own client.

**A shared conversation is shared whole.** A person added to it reads it from the beginning. Hiding the earlier part would be a promise the platform cannot keep, since a collaborator can ask the agent what was said. A person whose access ends, because a member removed it or because they left, loses the thread, and their messages stay in it under their name.

## Acceptance criteria

### Authors

1. In a thread a guest holds a Collaborate grant on, every message a person sends reaches the agent with its author's name. The name is the one the server recorded for that person when a member brought them in; no message, request or client setting from the person changes it. A person who joined by an open link gave their own name, and a member confirms or changes it before that person is given Collaborate.
2. In a thread only one person can write to, a message reaches the agent as it does without this feature.
3. After a thread gains its first guest collaborator, the next message any person sends to it carries a system note to the agent, at the top of that message and ahead of its author's name. The note names who can now write to the thread, says that every person's message carries its author's name from then on, a member's included, and says that the messages before it came from a member.
4. After a collaborator is added to a thread that is already shared, is removed from it, or leaves it, or the line saying what a guest is there for changes, the next message any person sends to it carries a system note saying so. A note is carried by every message a person sends until one that carries it has reached the agent, so the agent can read it more than once and never reads a person's message without it. If the conversation is rewound to before the note, the next message carries it again.

<!-- Criteria keep their numbers when one is added, so this one follows the last. -->

22. In a shared conversation, a member's message that begins with a slash (its first character that is not whitespace is `/`) reaches the agent exactly as typed, with no author's name and no note, so that a provider's command still works. A guest's message that begins with a slash carries the guest's name like any other, so it reaches the agent as words.

### Standing

5. The note of AC3 states that members own the server and that guests are invited by a member to work with the agent and do not own the system. It tells the agent to work with a guest on the thread's ordinary work as with anyone, and to do nothing sensitive at a guest's request without a member's prior authorization. It says what sensitive means, that what a member said a guest is there for counts as that authorization for the work it describes, and that otherwise the agent holds off and asks a member in the thread, by name.
6. The Share dialog offers an optional line saying what the guest is there for; when filled in, the note carries it. Once set, the line can be changed to other words and cannot be removed.
7. No message from a guest is refused, altered or held by the platform on account of its content.

### Prompts and asks

8. In a shared conversation, a question prompt, an approval prompt and a Crew roster prompt can each be answered by any member and by any guest holding a Collaborate grant on the thread.
9. The first answer settles a prompt for everyone, and the settled prompt shows who answered. An answer to a question carries its author's name to the agent. A Crew roster's Captain is told who approved or declined it. For a command's approval, the people on the thread see who answered and the agent is not told.
10. A guest collaborator can approve or decline a Crew roster as proposed, whatever model and access its seats were proposed with, and cannot remove or add a seat or change a seat's model or access; a member can.
11. A guest holding only a View grant sees each prompt and its outcome, with no control for answering.
12. A Crew's request for a further seat, and a seat's request for approval, reach members through the inbox and are not shown to a guest.
13. In a shared conversation, an agent's ask to a person's inbox is refused, with an error telling it to ask in the thread and name the person; in a thread with no guest collaborator it behaves as the [inbox](inbox.md) defines.

### Queueing and steering

14. A guest's message sent while the agent is working is queued behind the current work; a guest has no way to steer it into the current work.
15. A guest cannot stop or interrupt a run.
16. A guest can edit and remove their own queued messages, and no one else's; a member can edit and remove any queued message.

### Reading

17. A person's own messages render as they do in a thread that is not shared; another person's messages render as cards carrying that person's name and picture.
18. A person's picture is the GitHub profile picture for the username they entered in their client's settings; a person with no username, or a picture that cannot be loaded, shows initials on a coloured circle.
19. The server stores a person's GitHub username and never a picture address; a member who manages access can clear it from the People page.

### History

20. A person added to a thread can read all of it, from its first message.
21. When a person's access to a thread ends, by removal or by their leaving, their messages remain in it under their name.

## Scenarios

- **Two people, one agent.** A member gives a guest Collaborate on a thread in Billing Migration, and writes "reviewing the migration plan with me" in the Share dialog. The agent receives a system note naming the guest, the line the member wrote, and where guests stand. The guest asks the agent a question; it arrives under their name and the agent answers it. On the member's screen the question is a card with the guest's picture; on the guest's it is an ordinary message. (AC1, AC3, AC5, AC6, AC17, AC18)
- **A request beyond the work.** The guest asks the agent to delete the staging database. The agent does not, and writes in the thread that it is holding off and asks the member, by name, whether to go ahead. The member says no and the rule stands. Everything is visible to both. (AC5, AC7)
- **A question for one of them.** The agent needs a decision only the member can make. Its attempt to send the member an ask through the inbox is refused with an error telling it to ask in the thread. It writes the question there, addressed to the member by name. (AC13)
- **A prompt anyone can answer.** The guest asks the agent to run the migration tests, and the agent's access mode requires approval for the command. The prompt appears for both people; the guest approves it, and it now reads as approved by the guest. Later the agent raises a question prompt with two options; the member picks one before the guest does, and the guest sees which was picked and by whom. (AC8, AC9)
- **A Crew.** The guest asks the agent for a Crew to split the work, the agent proposes a roster, and the guest approves it. The guest sees each seat's model and access and cannot change them. (AC8, AC10)
- **The agent is busy.** The guest sends a message while the agent is running tests. It queues. They spot a typo, fix it while it waits, and it reaches the agent when the tests finish. They see no control for stopping the run; the member stops it when asked. (AC14, AC15, AC16)
- **A private thread.** The member's other threads in the project have no guest collaborator. Their messages carry no name, and an agent there asks through the inbox as before. (AC2, AC13)
- **Joining late.** A second guest is given View on the thread a week in. They read it from its first message. (AC20)
- **Watching.** That second guest sees each prompt the agent raises and how it was answered, and no buttons. (AC11)
- **Access removed.** The member removes the first guest's grant. The thread leaves the guest's list, the agent is told they can no longer write, and their earlier messages still carry their name for the member. (AC4, AC21)
- **A guest leaves.** The second guest is finished with the thread and leaves it from their own client. It goes from their list, and the member sees on the People page that the guest no longer has it. (AC4, AC21)

## History

- 2026-10-11 — defined (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)). AC16 is tentative: if a guest managing only their own queued messages proves a mess to build, a guest gets either a member's rights over the queue or none.
- 2026-10-12 — AC1: a name a person gave themselves, joining by an open link, is confirmed or changed by a member before that person is given Collaborate (Jackson, 2026-10-11; [#541](https://github.com/Jacksondr5/j5code/issues/541)).
- 2026-10-13 — AC3, AC4: the agent is told by a note at the top of the next message a person sends after who can write has changed, not at the moment of the change and not in a message of its own. The note says a member's messages carry a name too, and a changed "here for" line is told. "One" note is not promised: every message carries it until one that does has reached the agent, and it is told again after a rewind. AC6: the "here for" line cannot be removed once set (Jackson; [#533](https://github.com/Jacksondr5/j5code/issues/533)).
- 2026-10-13 — AC5: the note no longer says a guest is "not fully trusted". A guest is worked with on ordinary work; sensitive things need a member's prior authorization, which the "here for" line can give. In a live test two models refused a guest's harmless request for want of a member's approval (Jackson).
- 2026-10-13 — AC9: the agent is told who answered a question, on the answer, and a Captain who decided its roster; it is not told who answered a command's approval, which the people on the thread see (Jackson: "The providers dont provide a way for us to give the context, a queued message is terrible UX"). AC10: a guest approves a roster whatever access its seats have (Jackson).
- 2026-10-13 — AC22: a member's message that begins with a slash is sent as typed so that provider commands work; a guest's is sent as words under their name (Jackson).
