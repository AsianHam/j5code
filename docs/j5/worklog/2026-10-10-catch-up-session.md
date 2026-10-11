---
title: "Catch-up session (2026-10-10)"
kind: record
---

# Catch-up session (2026-10-10)

Jackson and an agent worked through a "what happened since I last looked" feature for a thread. This record holds the rulings. They are proposals until a definition carries them, and the change to upstream's read marker needs an entry in the [register of divergences](../product/upstream.md) when it is built. Nothing here is built.

## What prompted it

A lot can happen in a thread between two looks at it. Agents messaging each other make it worse, because they produce traffic no person asked for. Several people on one thread make it worse again: each person has missed a different stretch.

## Where the code stood

Read from the tree at `ff34d7067e`.

- **Upstream keeps one read marker per thread**, on the server: when the thread was last opened. Its own comment says the value is shared across every device connected to the server, so that one person's devices agree.
- **That marker drives the sidebar.** A thread shows "Completed" when its latest run finished after the marker. "Mark unread" rewinds the marker, and clearing a thread's "Woke" state moves it forward.
- **Nothing says what happened**, only that something did.
- **The helper that writes thread titles and commit messages knows four fixed jobs.** It has no general "write text from this" job, and each provider implements the four separately.

## Rulings: the pointers

- **Two pointers per person per thread.** One is the read marker: opened up to here. The other is J5's: caught up to here.
- **The caught-up pointer moves in two ways**: when the person sends a message in the thread, and when they are given a summary. Sending a message shows the person knew the state of things at that point.
- **Catching up is a button in the thread.** It is offered when there is activity after the person's caught-up pointer. It asks nothing of a person who does not press it. It stays hidden when only a little has arrived; how little is left to trying it.
- **Being given a summary moves both pointers.** The read marker has in any case moved, because the person is in the thread.

## Rulings: the read marker

- **The read marker becomes one per person.** Jackson: it is bad if a person's "last read" is moved by someone else. With one marker for everyone, one person opening a thread clears its "Completed" state for the others, and one person marking it unread marks it unread for all.
- **This changes what upstream's product does**, and is a divergence. A person's own devices still agree with each other, which is what upstream's marker is for. A server with one person behaves as upstream's does.
- **It is done on the server.** The server puts each person's own value into the thread list it already sends, and takes the "visited" and "mark unread" commands for that person. The clients are not changed, so every client, including an older one and mobile, gets it, and a person's devices keep agreeing through the feed that already keeps them in step. Not sized.
- **Considered and not taken**: following upstream and accepting the shared marker; and giving guests no read state at all, which is cheap and leaves collaborators with no unread signal and a server with several members unsolved.

## Rulings: the summary

- **A small, cheap model writes it**, separate from the thread's agent. It reads the stretch the person missed and starts from facts the server has measured, so the summary rests on events and not on an agent's memory.
- **Not the thread's own agent.** That would spend a turn of an expensive model, add the question and answer to the agent's conversation, wait for the agent to be idle, and get an answer from memory.
- **Which model is a setting of its own**, beside the ones upstream has for the text helper and for writing commits and pull requests.
- **The cost is in upstream's code.** The text helper needs a fifth job, in its service and in each provider's implementation, about eight upstream-owned files, and the setting is in upstream's settings. Not sized, and a candidate to offer upstream.

- **A summary covers the thread the person is in**, and no other. That conversation already holds every message its agent exchanged with other agents, so a Captain's summary covers what its seats reported. Reading every thread beneath it would be many times the text, and would paper over a seat that did something and never reported it.
- **The measured state of each agent beneath the thread is among the starting facts**: working, idle, finished, waiting on a reply. A Captain's summary can say what its seats are doing without reading their threads.
- **It starts from the person's last message in the thread.** Jackson's rule. The caught-up pointer decides whether the button is offered; the person's last message decides where the summary begins, so a summary stands on its own even when an earlier one covered part of the same stretch.
- **It leads with what is new since the person last caught up**, and is briefer about the part an earlier summary covered. The model is given the whole stretch with the caught-up point marked; no earlier summary is stored.
- **A person who has never written in the thread** gets a summary from their caught-up pointer, or from the start of the thread when they have none. That is a view guest, and anyone looking at an agent another agent started.
- **A summary is private to the person who asked.** It is not added to the conversation, the agent does not see it, and other people on the thread do not see it.
- **A guest can ask for one**, for a thread they can see. It spends the server owner's model budget, which was noted and accepted.
