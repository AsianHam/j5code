---
title: "Multi-player session (2026-10-09)"
kind: record
---

# Multi-player session (2026-10-09)

Jackson and an agent worked through "multi-player": several people interacting with the agents on one server. It has two parts. Share links let a person give someone else access to a server, a project or a thread. Shared conversations are what happens once two people can write to the same agent. This record holds the rulings from that session and from the two days after it. [Shared server](../product/features/shared-server.md) and [shared conversations](../product/features/shared-conversations.md) now carry them, and are the place to read what is current; three rulings below were changed later, and each says so where it stands. Nothing here is built. The build is tracked in [#531](https://github.com/Jacksondr5/j5code/issues/531), [#532](https://github.com/Jacksondr5/j5code/issues/532) and [#533](https://github.com/Jacksondr5/j5code/issues/533), and the [register of divergences](../product/upstream.md) gains its entries with that work.

The session is the first of a set. The others have their own records: the [hosted server](2026-10-10-hosted-server-session.md), [catching up](2026-10-10-catch-up-session.md) on a thread, and the [attention spectrum](2026-10-10-attention-spectrum-session.md).

## What prompted it

Shared server defines several people on one server sharing its projects and agents, and leaves the architecture open: how several authenticated people attach, attribution, and read state. Jackson wants to send someone a link that lets them into a whole server, one project or one thread, at different levels of access, and wants agents to handle a conversation with more than one person in it.

## Where the code stood

Read from the tree at `ff34d7067e`. The counts come from reading the server only; nobody ran it or checked which requests the clients make.

- **Permissions are server-wide.** A pairing link carries a set of upstream permissions, and every request is checked against the session's set. Nothing limits a session to a project or a thread.
- **A session's permissions are fixed when it is created.** No operation was found that changes them afterwards.
- **A session is a device, not a person.** J5 has a table of people holding one row, the local operator. Nothing connects a session to a person.
- **One check sees every WebSocket request.** All 217 request types pass through one permission check that has both the session and the request. HTTP has no equivalent: about 30 handlers each check for themselves.
- **About 14 requests return or stream many threads at once**, such as the sidebar feed. They cannot be allowed or refused whole.
- **About 24 requests name a folder the client supplies**, not a thread: file reads, terminals and git. One reads any file on the machine when given an absolute path.
- **A message from a client is recorded as "from the user"** and nothing more.
- **The preview browser already separates watching from driving.** Watching a tab needs read permission; opening and navigating need a dedicated permission, and the live stream drops input from a viewer who lacks it. Every preview request names its thread. Only web addresses are accepted.
- **Artifacts are files in one folder per project.** Nothing records which thread wrote one.

## Rulings: share links

### What a share can promise

- **Viewing is enforced. Collaborating is a soft boundary.** A person who can view one thread sees nothing else, and the server enforces that. A person who can message an agent can ask it to read any file, run any command or message any other agent, so a collaborate grant tidies their view and does not contain them. The product says so in plain words where a share is made.
- **Usefulness comes first.** J5 is honest about what it cannot enforce and does not cut features to look stricter than it is. Real containment waits on agents that run in a sandbox.

### People and grants

- **A link is made for a named person.** The sharer names them. Whoever opens the link is that person on this server, on every device paired from it. (Corrected below: a link pairs one device.)
- **Access is a list of grants on the server**, not a property of the link. A grant is a person, a project or a thread, and a level. Adding someone to a second thread two days later is a new grant; they need no new link, and their client shows the change.
- **The level lives on each grant.** A person can view a project and collaborate on one thread inside it.
- **Two levels: view and collaborate.** Administering a server stays a whole-server role.
- **A thread grant covers the thread and the agents beneath it**: its spawned agents and its Crew seats, at the same level. Agents outside that tree appear by name on message cards and cannot be opened. Access does not follow a conversation to whatever it has messaged.
- **Nothing else rides along with a grant** unless listed below.

### What each level can do

| Thing                                                | View | Collaborate |
| ---------------------------------------------------- | ---- | ----------- |
| The conversation, including agent-to-agent cards     | Yes  | Yes         |
| Diffs and files the thread's work touched            | Yes  | Yes         |
| Watching the thread's preview browser tabs           | Yes  | Yes         |
| Sending and queueing messages                        | No   | Yes         |
| Steering and stopping the agent                      | No   | No          |
| Answering the agent's questions and approval prompts | No   | Yes         |
| Opening and driving preview browser tabs             | No   | Yes         |
| Changing the thread's model or access mode           | No   | No          |
| Terminal                                             | No   | No          |
| File browser and direct file edits                   | No   | No          |
| Git and pull request actions                         | No   | No          |
| Archive, fork, merge back                            | No   | No          |
| Settings, providers, personas, skills                | No   | No          |

- **Terminals.** Messaging an agent never grants a terminal. Jackson: guest terminal access is not important, and the risk is acute and easy to control.
- **Access mode.** The owner decides how much an agent may do. If a collaborator could switch an agent to full access, that setting would mean nothing.
- **Questions and approvals.** The table's row was agreed with only approvals discussed; the review below rules on question prompts and Crew roster prompts as well. A collaborator can approve a command the owner would have declined. That is accepted, because a collaborator can already ask the agent for anything.
- **Preview browser.** Jackson wanted it kept: it is useful, and reaching services on the server's network is a lesser risk than messaging an agent. A guest's tabs always use a profile with no saved logins, and a guest never takes control of a tab opened in a signed-in profile. Saved logins are the risk that differs in kind, because they reach accounts outside the server.
- **Artifacts** come with a project grant only. A thread guest sees a link to an artifact and cannot open it.

### Sharing and reaching

- **Only a person who can manage access to the server may share.** A guest never shares at any level. Letting any member share is a question for a server with many members.
- **Agents cannot share.** An agent that thinks someone should be brought in asks through the inbox.
- **A link uses the routes the server already has.** J5 opens no tunnel for a share and does not extend upstream's relay to guests. Jackson: it is fair to expect that a person can reach the server they are connecting to.
- **Where a share starts.** A Share action on a thread and on a project, and a People page in Settings listing each person, what they can reach and their devices. A link is produced only when the person is new.

### What a guest sees

- **Inbox.** A guest has none from this server. An agent asks a guest in the conversation (see shared conversations below). An earlier ruling in the session gave guests an inbox of asks addressed to them by name; it was withdrawn.
- **Fleet page.** Not shown to guests at first; to be considered for a second version.
- **Personas and Playbooks.** Not shown. They are only useful to someone who can spawn agents, which a guest cannot.
- **Memos.** Not built. When they are, a guest sees the Memos of agents in threads they can reach.

## How it would be built

This is the sketch the rulings were made against, not a plan. A later read of the code corrected it in four places; see "Checked on 2026-10-10" below.

- **Guest sessions are created without the permissions a guest never has**: terminal, file writes, source control, settings, providers and access management. Upstream's own check then refuses those, and upstream's clients already hide controls the session lacks permission for.
- **A guest session carries "operate" and "drive the preview" from the start**, because a grant can switch those on later and a session's permissions cannot change.
- **J5's filter decides the rest**: which threads, and view or collaborate on each. It is one table at the WebSocket check, giving a decision for every request type, and it refuses a guest any request it has not classified. Typed like upstream's own table, a new request type with no guest decision fails to compile.
- **The costs are outside that table**: filtering the feeds that carry many threads, giving the HTTP handlers one shared guard, and telling the client each thread's level so a view-only thread shows a read-only composer.
- **Rough size**: 5 to 7 upstream-owned files for a guest who views one thread. This is an estimate, and it changes what upstream's pairing and authentication do, so it needs entries in the register of divergences.

## Rulings: shared conversations

- **The server names the author of a message, in the message text**, the way it already names the sender of an agent-to-agent message. It takes the name from the session, so a client cannot forge it.
- **Only on a thread more than one person can write to.** A person's private threads are unchanged. When a thread gains its first collaborator, the agent is told once who can now write and that earlier unlabelled messages came from the owner.
- **Each person sees their own messages as they do today**, and other people's as cards of their own. The cards may resemble agent-to-agent cards; the look is undecided.
- **Profile pictures come from GitHub.** A person enters their github.com username in their own client's settings, and the client tells each server it connects to. The server keeps the username on the person; each viewer's client loads the picture from GitHub. The server stores a username and never a picture address, so a person cannot make other people's clients fetch an address of their choosing. An access manager can clear a username from the People page.
- **Initials on a coloured circle are the fallback**, for a person with no username and when GitHub cannot be reached.
- **A guest can enter someone else's username.** That is accepted: their name is still the one the sharer gave them.

- **Members outrank guests, and the agent is told why.** The note the agent gets when a thread becomes shared says that members own the server it runs on, that guests take part at a member's invitation, and that a guest is not fully trusted unless a member says so. Members decide what a guest may tell the agent to do. The agent works with a guest normally; when a guest's request conflicts with what a member said, or goes well beyond the work in the thread, it holds off and asks a member in the conversation, by name, where the guest can see it.
- **The sharer can say what a guest is here for.** The share dialog has an optional line for it, and the line goes into the note the agent receives. A member can also widen or narrow a guest's standing at any time by saying so in the thread.
- **This is guidance to the agent, not enforcement.** An agent reads every message as text, so the platform cannot make it rank one person over another. Members of one server are equals: a disagreement between them is an ordinary change of mind. There is no per-thread owner.

- **On a thread with a guest collaborator, an agent asks people in the conversation.** Its tool for sending an ask to a person's inbox is refused there, with a message telling it to ask in the thread and name the person it wants. Jackson: a private message to one person is counter-productive when everyone is in the chat, and sending it to several people is a messy thing to build. Everyone sees the question and the answer.
- **What that gives up.** A person who is not watching learns of the question only from the thread's ordinary signals, and nothing tracks an unanswered question the way the inbox does. How a shared thread gets a person's attention is left to the attention spectrum session.
- **Left for the session on several members sharing a server** (first parked for the hosted-server session, which [moved it](2026-10-10-hosted-server-session.md)): what an ask means on a server with several members, where every thread can be written to by all of them. The rule above is scoped to threads with a guest collaborator so that it does not switch the inbox off across such a server.

- **A guest queues; only a member steers or stops.** A guest's message starts the agent when it is idle and queues behind the current work when it is not. A guest can never interrupt work in progress. The cost was raised and accepted: a guest who watches the agent do something wrong cannot stop it and has to reach a member.
- **No presence.** Nothing shows that another person is typing or looking at the thread.

- **Sharing a thread shares all of it.** A newly added person sees the whole conversation from the start, and the share dialog says so before the sharer confirms. Hiding earlier history would be a promise J5 cannot keep for a collaborator, who can ask the agent what was said. A thread holding something that should not be shared is forked, or the shared work starts in a fresh thread.
- **Removing a person's access removes the thread from their view.** Their messages stay in it under their name.

- **A guest can edit and remove their own queued messages, and nobody else's.** Ruled tentatively on 2026-10-10. If it proves a mess to build, the fallback is all or nothing: a guest gets either the same rights over the queue as a member or none.

## Not verified

- Which requests the web and mobile thread views make. The list of what a view guest needs is inferred from the server.
- Whether the WebSocket check can filter a live feed, or only a single reply.
- How a session and a pairing link are stored, and so what it takes to attach a person to one.
- Preview tabs hosted by a desktop app, and the preview's upload and download routes.

## Checked on 2026-10-10

A second read of the code, at `4fe4b6f7df`, took up the list above. It was again a read only; nothing was run. It corrects the sketch in "How it would be built" in four places.

- **A thread view loads over HTTP first.** The sidebar and a thread's conversation each arrive from an HTTP route, and the WebSocket then carries the live changes. Each of those routes checks only that the session may read. So the guard on HTTP routes is the main path for a view guest, not a side cost, and the table at the WebSocket check is half of the filter.
- **The WebSocket check allows or refuses a whole request.** It sees the request's name and contents, so it can refuse a request for a thread the guest has no grant on. It never sees the items of a stream. The feeds that carry many threads, about a dozen, have to be filtered where each is produced.
- **A view guest must not be able to drive a preview tab through the picture stream.** The requests that open and navigate a tab use the dedicated preview permission, as the record says. The live stream and the upload route do not: they accept input from any session that holds "operate", and neither checks which thread the tab belongs to. A guest session that carries "operate" from the start, as sketched, could drive any tab the server hosts. Those routes need J5's guard as well.
- **The size was underestimated.** The filter alone touches about seven upstream-owned files before anything changes in how sessions are stored.

Other findings:

- **A person can be attached to a link without changing upstream's tables.** A link and every session made from it already carry a free-text "subject", copied from one to the other; J5's server-to-server peering uses it the same way.
- **A link pairs one device.** It is used up when opened. A person's second device needs a second link made for the same person, which changes the ruling above that one link serves every device. Ruled the same day: an access manager makes the further link, from the People page. Jackson: without something like upstream's relay, nobody but an access manager could make one.
- **A desktop app can host preview tabs itself**, and the split between watching and driving does not apply to those. A guest's tabs are the server's own, so this is expected not to matter; it was not confirmed.

Still not determined: which J5 reads the mobile client makes for a thread view, and whether upstream's clients hide the controls a session lacks permission for.

## Review of the definitions (2026-10-11)

Jackson reviewed the definitions drafted from this record ([#529](https://github.com/Jacksondr5/j5code/pull/529)). Three things changed what is ruled above.

- **Any member or collaborator answers a prompt.** The table above lets a collaborator answer "the agent's questions and approval prompts"; that row was agreed with only approvals discussed. Jackson first leaned towards switching the question prompt off, because a prompt cannot be directed at one person and the first answer settles it for everyone. The agent then proposed that only members answer prompts, since a guest approving a command lifts the access mode a member chose. Jackson ruled the other way, for consistency: a collaborator who can tell the agent to spawn a Crew can approve it, work a collaborator asked for should not be held up on a command approval, and a collaborator brought in to help can answer questions. So question, approval and Crew roster prompts are all answered by any member or collaborator, first answer settling it. A guest with a View grant sees prompts as information, with no buttons. The inbox ask stays refused in a shared conversation.
- **A guest approves or declines a Crew roster as proposed.** The roster prompt lets the person approving it remove and add seats and change each seat's model and access. A guest cannot do those; a member can. Choosing how much an agent may do stays with members, as it does for a thread's own access mode.
- **A guest can leave what they were granted**, from their own client, so that they manage what their own sidebar shows. Coming back takes a new grant from a member. Leaving a whole grant is enough for now; leaving one thread inside a project the guest holds as a whole is left with the other problems of sharing an agent, for a second version of this feature.
- **A guest's own inbox and Fleet page are unaffected.** They belong to the client, and still show the guest's own servers. The server a person is a guest on adds nothing to them.

Upstream moved while this was being written. At `2625327090` its permissions are still per connection and server-wide, with no roles and nothing scoped to a project or thread. One change there closes a gap found above: the preview's live stream and upload route now check the dedicated preview permission. Neither checks which thread a tab belongs to.
