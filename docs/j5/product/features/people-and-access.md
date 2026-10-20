---
title: "People and access"
kind: definition
---

# People and access

## Problem

Sharing agents between people starts with the server knowing who is connected, what each of them can see, and what each of them can do ([problems](../problems.md): Shared server; [use cases](../use-cases.md): L2 support). Upstream's model is a device with permissions over the whole server: it has no person, and no access narrower than everything. Sharing also has to be easy enough to do casually, or people relay agent output to each other instead.

## Definition

**People and access** says who a person on a server is, which of the server's work they reach, what they can do there, and how they got in. [Shared conversations](shared-conversations.md) says what happens once more than one person can write to an agent.

### Principles

These principles govern every decision about people and access, and are cited by name like those in [the principles](../principles.md).

**Sharing is trust, not containment.**

- **Rule:** J5 promises nothing about what a person who can write is able to do. The one promise it enforces is View: a Viewer reads their scope and nothing else. A restriction on a writer that an agent or a terminal can route around is, at most, a control the product does not offer; the server does not enforce it.
- **Stands on:** anyone who can prompt an agent or use a terminal can do anything the server can, including escalating their own access; belief 3.
- **Jurisdiction:** any proposal to restrict what a person who can write may do.
- **Cases:** one write level; names are not confirmed before a person may write; anyone renames themselves.

**Inviting is easy, and access changes in place.**

- **Rule:** bringing someone in takes one link and no setup, and making several links is as easy as making one. What a person reaches grows, shrinks and changes without a new link or pairing again.
- **Stands on:** sharing is how most people will first meet the product; access to a server evolves over time.
- **Jurisdiction:** links, joining, and changes to what a person reaches.
- **Cases:** one kind of link; coverage is live; a level changes without the person pairing by hand.

**For now**, while this feature is new, two more principles break ties. They are expected to go as it matures.

**UX, then simplicity, then security, then edge cases.**

- **Rule:** a conflict between these is settled in that order. Simplicity includes maintainability and testability.
- **Stands on:** beliefs 3 and 5; [simple tools at the frontier](../principles.md#simple-tools-at-the-frontier) and [repair beats edge-case machinery](../principles.md#repair-beats-edge-case-machinery).
- **Jurisdiction:** any trade-off in this area.
- **Cases:** artifacts are seen at project scope rather than recorded per thread; a mis-paired device is ended and paired again rather than moved.

**Turn it off or open it up.**

- **Rule:** a feature that cannot be made to work simply for several people is either withheld at the scopes where it is hard, or open to everyone who reaches the scope where it is easy. It does not get a special restricted version.
- **Stands on:** the same as the previous principle.
- **Jurisdiction:** which surfaces each scope shows.
- **Cases:** home scopes; files and terminals are not part of View at any scope.

### Three layers

Access has three layers, and each answers one question.

| Layer                  | Answers               | Owned by                                                   |
| ---------------------- | --------------------- | ---------------------------------------------------------- |
| **Device permissions** | What may a device do? | Upstream: its permissions on each paired device, unchanged |
| **Person**             | Who is this device?   | J5: a person, attached to each device's session            |
| **Reach**              | Where may they do it? | J5: the person's scope and level                           |

Each level maps onto upstream's permissions in one place, so when upstream reshapes them, that mapping changes and the model does not. A device holds exactly the permissions of its person's level, and J5 never hands upstream more than a device holds. Upstream fixes a device's permissions when it pairs, so when a person's level changes, each of their devices is given a new session with the new permissions in place of the old one, and reconnects. Where a person holds different levels at different scopes, their devices hold the highest, and the server holds each scope to the level the person has there.

### People and devices

A **person** has a name, a level at one or more scopes, and devices. Every device paired with the server belongs to exactly one person. A person's id is stable and does not depend on how they signed in.

For now, J5 has no authoritative identity. A person is whoever their link was for: the server takes their word, and nothing proves that the person holding a link is the one it was made for. The person id stays apart from sign-in so that a sign-in can be attached later without changing who anyone is.

The **first owner** is the person the server's own machine belongs to. The desktop app on that machine, and the link a server prints when it starts, pair a device as the first owner.

### Scopes and levels

A person's access is a level at a scope. A **scope** is the server, a project, or a thread. A thread's scope is the thread and the agents beneath it: the Subagents it ran, the Peer Agents placed under it and their Crew seats, at any depth and in any project. It does not include the thread above it, agents it only exchanged messages with, or a fork of it. A scope covers what is in it now: a thread started in a project, an agent spawned beneath a thread, or a project added to the server appears for everyone whose scope covers it.

There are three **levels**:

- **Viewer** reads what their scope shows.
- **Collaborator** does everything a person can do within their scope except configure the server or share it, and, for now, archive or delete a thread: writes to agents, answers their prompts, steers and stops them, edits a Crew's seats, uses terminals, files, git and previews.
- **Owner**, at server scope only, also configures the server and shares it. A server can have several Owners.

A person can hold different levels at different scopes; where two cover the same thing, the higher applies.

### What each scope shows

Upstream is built for one person who sees everything, and each of its surfaces would need its own work to be cut down to a project or a thread, and more again to be made read-only. Making every surface work at every scope and level would be a maintenance burden out of all proportion to its use. So everything a person sees has a **home scope**: the smallest scope it can be cut down to cheaply. A person's scope shows everything whose home scope is at or inside it, and a surface that is hard to narrow is shown only to people whose scope is wide enough.

| Home scope  | What it adds                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thread**  | The conversation and the agents beneath it, its diffs, its preview tabs, the pages its tools published, and the scheduled tasks bound to it |
| **Project** | The project's artifacts, the skills in its workspace, and its other scheduled tasks                                                         |
| **Server**  | The Fleet page, Personas, and the skills installed for the server's providers                                                               |

Playbooks are the server's, and are not cut down to a scope: anyone who can write somewhere uses them, and a run starts only on a thread its person writes to. Only Owners change them.

A Viewer never sees files, terminals, settings, providers or connections, at any scope: files and terminals reach the server's machine and its credentials, not just its work, and the rest configures the server. A person's inbox belongs to the person, not to a scope.

### Settings

Settings configures a server, so it belongs to that server's Owners. Settings and the People page list only the servers where the person is an Owner, with a picker to choose among them, so an Owner of several servers manages them all from one client. For now, someone who is an Owner of no connected server sees only the pages about their own device and, on the People page, their own row, from which they leave, and who reaches each project they reach; and Settings is not divided page by page between the levels: each of upstream's pages would need its own work to be right for every level and scope, so a page is for Owners unless it is one of the few about the device itself.

### Links

A **link** brings a person in. It carries a scope, a level, a lifetime, and whether one person or many may use it, and it can name the person it is for. A link for many is for Viewers only: a link that is forwarded lets in people nobody invited, so writing takes an Owner raising that person. An Owner can copy any link again until it expires or is used up, so a long-lived link for many is sent to more people without making another. Whoever opens it confirms or types their name and is in. A link for one named person is the way to add a person's further device. An Owner whose device holds upstream's Manage access shares from one Share dialog. A thread is shared from the thread itself; a project or the whole server is shared from the People page, which is the one place for both, so no project page carries a sharing section of its own. Nobody else shares, and no agent does.

### Names

A person's name is how people and agents know them, and how a person is found when a device is paired for them. A name belongs to one person on a server. A person changes their own name, and an Owner changes anyone's. A server's first owner gives their name on their first device, before the server is used.

### Leaving and removal

A person leaves a scope they hold from their own client. An Owner removes a person's level at a scope, or the person altogether, which ends their devices. A person's messages stay in the threads they wrote in, under the name they had then. The first owner cannot be removed or lowered: the server's own machine is theirs.

### What it is not

- **Not containment.** Anything that can write reaches the whole machine through its agents and terminals.
- **Not identity.** Nothing proves a person is who their link names.
- **Not isolation.** Every person's agents run with the server's one set of provider and git credentials.

### Later

Set aside on purpose, each tracked where it is linked. An item leaves this list when the definition takes it in.

- Settings worked through page by page for Collaborators and Viewers, and with it archiving and deleting for those who are not Owners ([#630](https://github.com/Jacksondr5/j5code/issues/630)).
- An authoritative identity: a sign-in, such as a company's, that proves who a person is ([#632](https://github.com/Jacksondr5/j5code/issues/632)).
- Sharing on mobile ([#609](https://github.com/Jacksondr5/j5code/issues/609)).
- A Viewer watching a thread's preview tabs ([#540](https://github.com/Jacksondr5/j5code/issues/540)).
- Leaving one thread inside a project or server one holds as a whole, and the rest of the set-aside list ([#542](https://github.com/Jacksondr5/j5code/issues/542)).

## Acceptance criteria

### People and devices

1. Every paired device belongs to exactly one person, and every person's id is stable across restarts and independent of how the device signed in.
2. The desktop app on the server's own machine, and the link the server prints when it starts, pair a device as the first owner.
3. A pairing link made from a device in upstream's Connections settings pairs a device for the person that device belongs to.
4. `j5 pair` refuses to make a link without `--person`; `j5 auth pairing create` without it makes a link for a device the server then asks about, as AC5 says. A name that matches a person makes the link for them, at their levels; a name that matches no one creates that person, and then `--level` is required, with `--project` or `--thread` for a scope narrower than the server. Upstream's `--scope` keeps its meaning: it narrows the device's permissions, within the person's level. The command says which it did.
5. A device whose person the server does not know is asked "What should people and agents on _&lt;server name&gt;_ call you?" before it can use the server, with every person already on the server offered, with their levels, alongside a new name. Choosing a person makes the device theirs; a new name creates a person at server scope, an Owner if the device holds Manage access, a Collaborator if it holds Operate tasks, and a Viewer otherwise.
6. A server's first owner is asked the same question on their first device to connect, before that device can use the server.
7. Devices paired before this definition held belong to the first owner.

### Scopes and levels

8. A person holds a level at the server, at a project, or at a thread; Owner is offered at server scope only.
9. A thread's scope covers the thread and every agent beneath it at any depth, including one in another project, and not the thread above it, an agent it only exchanged messages with, or a fork of it.
10. What a scope covers is decided when it is read: a thread started in a covered project, an agent spawned beneath a covered thread, and a project added to the server appear for each person whose scope covers them, without anyone sharing them.
11. Where two of a person's levels cover the same thread, the higher applies.
12. Changing a person's level or scope changes what their connected devices show and can do without the person pairing by hand.

### What each level can do

13. A Viewer reads what their scope shows and can change nothing; every request from a Viewer for anything outside their scope, or for a change, is refused by the server.
14. A Collaborator can do within their scope everything an Owner can, except configure the server, share it, for now archive or delete a thread, and, at thread scope, start a thread, fork one or merge one back.
15. An Owner configures the server and shares it.
16. Each level's upstream permissions are listed by name in one place, and a device holds exactly its person's highest level's set: a Viewer "View environment"; a Collaborator "View environment", "Operate tasks", "Control previews", "View diagnostics and usage", "View terminals", "Use terminals", "Change source control", "Read files", "Write files" and "View relay"; an Owner every permission upstream lets a client be given. J5 never gives upstream more permissions for a request than its device holds.
17. When a person's level changes, each device paired as them is given a new session holding the new level's permissions in place of the old one, and reconnects once. A lowered level takes effect at once, on open connections too. A device that is offline gets its new session when it next connects, while its old one is within its lifetime; after that it is paired again by hand.
18. A device paired from upstream's Connections settings with permissions chosen there keeps, in any new session, only the chosen permissions its person's level allows.
19. A Collaborator at server scope adds projects; a Collaborator at project scope or wider renames and removes a project; editing a project's scripts follows upstream's permission for environment settings, so only an Owner does it.
20. Installing a skill from a catalog is for Owners; seeing and using skills, Personas and scheduled tasks follows the scope they belong to. Playbooks are the server's: anyone who holds Collaborator at any scope sees them and has an agent run one on a thread they write to, and only an Owner saves, renames, deletes or chooses the folders of one.

### What each scope shows

21. A thread's scope shows its conversation, the agents beneath it, its diffs, its preview tabs, the pages its tools published and the scheduled tasks bound to it. For now, a Viewer sees a thread's preview tabs listed and does not watch them.
22. A project's scope adds every thread in the project, the project's artifacts, the skills in its workspace and its other scheduled tasks; a person whose scope is a thread sees a link to an artifact and cannot open it.
23. The server's scope adds every project, the Fleet page, Personas and the skills installed for the server's providers.
24. A Viewer is shown no files, file contents, terminals, settings, providers or connections at any scope.
25. A person whose scope is narrower than the server is listed only the projects and threads their scope covers, and the server refuses their request for any other, whatever client sent it.
26. Anyone who reaches a thread or a project sees the names and levels of everyone who reaches it; only an Owner sees a person's devices, their links and what they reach elsewhere.

### Settings and the first screen

27. An Owner sees all of Settings for each server they own. Settings lists only the servers where the person is an Owner, with a picker to choose among them. The People page lists them too, and for a server where the person is not an Owner it shows only their own row and, read only, who reaches each project they reach (AC26).
28. For now, someone who is an Owner of no connected server is shown only the Settings pages about their own device, Appearance, Snap-shot and Open-source licenses, and the People page with their own row and the projects they reach on each server. Settings search finds only the pages a person is shown.
29. A Settings page is shown to someone who is not an Owner only if it is one of those listed; any other page, including one upstream adds later, is shown to Owners only.
30. The setup wizard is offered only to an Owner of the server the client opened first, decided by that server's answer. Someone whose scope covers nothing, because they left or lost the last thing they reached, sees "Nothing is shared with you".

### Links

31. One kind of link brings a person in. It carries a scope, a level, a lifetime of an hour, a day, seven days or thirty days (seven unless the Owner says otherwise), whether one person or many may use it, and optionally the name of the person it is for.
32. A link for a named person pairs one device as that person; a link for many gives each person who opens it a name of their own choosing and makes them a person of their own. A device already paired as one person that opens a link named for another is refused, and the link stays usable.
33. Someone already paired on the device that opens a link for many joins as themselves, keeping any higher level they already hold.
34. Only an Owner whose device holds upstream's Manage access shares: a thread from its menu, its header and its details panel, and a project or the server from the People page, each opening the same Share dialog; elsewhere the control follows upstream's convention for a permission the device lacks. No agent can share.
35. Giving a person already on the server more access produces no link; raising anyone to Collaborator or Owner shows the statement of AC37 before it applies.
36. The Share dialog shows everyone who already reaches the thing being shared, with their levels, and lets an Owner change or remove a level held on that thing; someone who reaches it through a wider scope is shown with that scope, and their level is changed only there.
37. Before a link for a person at Collaborator or Owner is made, the Share dialog states that the person can have an agent do anything it can do. The dialog always states that sharing a thread shares its whole history, and that sharing a project shares every thread in it.
38. A link uses a route by which the server is already reachable; making one opens no new route.
39. An Owner can revoke a link before it expires; revoking it or its expiring stops new people joining and removes no one who already joined.
40. A link for many people carries the Viewer level; Collaborator and Owner are offered only on a link for one person.
41. The Share dialog and the People page list the links in force, an unused link for one person under that person, and an Owner can copy any of them again or revoke it until it expires, is revoked or, for a link for one person, is used.
42. The page a link opens names the server, what the link opens and the level, lets the person confirm or type their name, refuses a name someone on the server already has, and shows one state for any link that does not work, whatever the reason.
43. A link for one person opened on a device already paired as that person is refused, and the link stays usable for the device it was made for.

### Names

44. No person is given a name another person on the server already has, compared without case and surrounding or repeated whitespace.
45. A name is one line of visible characters, with no square or angle brackets.
46. A person can change their own name, and an Owner can change anyone's; the agents of every shared conversation the person can write to are told the old and new name.
47. A message keeps the name its author had when they sent it.

### Leaving and removal

48. A person can leave a scope they hold, from their own client: a thread from its menu, a project or the server from their own row on the People page. What it covered goes from their view, and coming back takes a new link or level from an Owner.
49. An Owner can remove a person's level at a scope, or the person altogether; removing a person ends every device paired as them, including connections already open.
50. A device paired with the wrong link is repaired by ending it, from the People page or upstream's Connections settings, and pairing it again with the right one.
51. The first owner cannot be removed or lowered: the People page and the Share dialog offer no level control or removal on them, and a request to do either is refused.

## Scenarios

- **A backup Owner.** The user runs L2 Support Rotation's server and makes a link at server scope, level Owner, for the colleague who covers when they are away. The colleague's laptop pairs as them; they see every project and thread, configure the server, and make links for the next shift. (AC8, AC15, AC16, AC31, AC32, AC34)
- **Showing one thread.** The user shares a thread in Billing Migration with a contractor, as a Viewer. The contractor reads the thread and the two builders beneath it, sees its diffs, and finds the composer read-only. They are offered no files or terminal, and a request their altered client sends for another thread is refused. (AC9, AC13, AC21, AC24)
- **More, in place.** A week later the user makes the contractor a Collaborator on that thread. No link is made. The contractor's client reconnects once with its new permissions; their composer opens, and they can steer and stop the agent. (AC12, AC14, AC17, AC35)
- **The project, as it grows.** A teammate is a Collaborator on Website Redesign. Each new thread anyone starts there appears in their sidebar, and they can open the project's artifacts. (AC10, AC22)
- **A link for the room.** The user makes a seven-day link to a thread, at Viewer, for many people, and posts it in a meeting. Each person who opens it types a name and reads the thread. The next week the user copies the same link from the Share dialog for two more people. (AC31, AC32, AC39, AC40, AC41)
- **A teammate's phone from the terminal.** An Owner runs `j5 pair --person Priya`. Priya is already a Collaborator, so the link is hers; her phone pairs and shows what she reaches. Run as `j5 pair` alone, the command refuses and lists the people. (AC4)
- **A device nobody planned.** A device paired through a route J5 does not know asks "What should people and agents on L2 Support call you?" before anything else. The person picks their own name from the list and carries on. (AC5)
- **A typo.** A Viewer's name was typed as "Prya". She changes it herself, and the agent of a thread she writes to is told. Her earlier messages keep the old name. (AC46, AC47)
- **A step down.** The backup Owner moves teams and the user makes them a Collaborator. Their laptop, open on the Fleet page, reconnects at once and no longer offers settings. (AC16, AC17)
- **Leaving and removal.** A Collaborator finishes with Website Redesign and leaves it. Later the user removes a contractor altogether; the contractor's phone, open on a thread, loses it at once, and their messages stay under their name. (AC48, AC49)

## History

- 2026-10-16 — defined (Jackson): the principles, three layers, scopes and levels, home scopes, one kind of link, devices and the first owner, names, leaving and removal. Absorbs [Shared server](shared-server.md) AC3 to AC35 and the access model that register entry D33 described ([record](../../worklog/2026-10-16-people-and-access-session.md)).
- 2026-10-17 — what holds only for now is marked so, and a Later list names what is set aside, with the issue that tracks each (Jackson).
- 2026-10-18 — someone who is not an Owner sees their own row on the People page, so they can leave a project or the server as AC48 says, and who reaches each project they reach, as AC26 says (AC27, AC28; provisional, for Jackson to confirm; [#636](https://github.com/Jacksondr5/j5code/issues/636)).
- 2026-10-18 — for now a Viewer sees a thread's preview tabs listed, and watching them is set aside (AC21; Jackson's 2026-10-11 deferral of [#540](https://github.com/Jacksondr5/j5code/issues/540); provisional, for Jackson to confirm).
- 2026-10-18 — a bare `j5 auth pairing create` makes a link for a device the server asks about, since upstream's desktop app runs it over SSH; `j5 pair` still refuses (AC4; provisional, for Jackson to confirm; register D36).
- 2026-10-19 — Playbooks are the server's: anyone who can write uses them, Owners change them (Jackson, after [#621](https://github.com/Jacksondr5/j5code/pull/621)).
