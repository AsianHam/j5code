---
title: "People and access session (2026-10-16)"
kind: record
---

# People and access session (2026-10-16)

Jackson and an agent stepped back from the share links and shared conversations build to write the product definitions it should have had, starting with the people model. The session ran over 2026-10-16 and 2026-10-17. Its outcome is [People and access](../product/features/people-and-access.md), together with the cut-back [Shared server](../product/features/shared-server.md) and register entries D33 and D36 in [J5 and upstream](../product/upstream.md). Those are the place to read what is current; this record is how the session got there.

## What prompted it

The build of [multi-player](2026-10-09-multi-player-session.md) sharing was mostly done. Jackson's view: "we made great progress here, but really plowed ahead and may have thrashed a little on some key decisions." The thrash was in the Collaborate cases: how far Collaborate reaches, how the agent is told who is speaking, and the inbox. He asked for definitions in two areas. The first is how several people with different permissions work with agents. The second is the sharing model, widened to every kind of invitation. This session took the second area, because the first rests on it.

## What was found

These findings come from reading the code at this branch and upstream's issues and pull requests. Nothing was run.

- **Upstream's model is devices, not people.**
  - A paired device holds a set of permissions over the whole server. Sixteen of them can be granted, behind three presets: Read only, Standard and Administrative.
  - There are no roles. Upstream had owner and client roles until June 2026 (pingdotgg/t3code#2858).
  - Projects are "organizational boundaries, not filesystem sandboxes".
  - A session's "subject" is a credential-kind label. Upstream says it carries no authority.
- **Upstream is not heading towards several people.** An RFC for multi-user servers was closed as not planned on 2026-09-17 (pingdotgg/t3code#12278). The triage said T3 Code "is single-tenant" and that remote access is "your machine, your agents". The September split of the permissions (pingdotgg/t3code#9785 to #9791) gave no use case: each PR names the coupling of permissions as the problem in itself. The one use case argued in writing is outside agents over MCP, which deliberately does not use the permission list.
- **The re-pairing pain has a cause.**
  - Stored credentials were not widened when the permissions split.
  - A device can only grant what it holds.
  - `pair` defaults to Standard, which lacks Manage access, and each `--scope` flag replaces the whole default set.
  - Older mobile clients came out with four permissions even after re-pairing (pingdotgg/t3code#16804; fix open in #17341).
- **T3 Connect proves one thing.** The requester is the server's single linked account. The server stores one account and mints an ordinary Standard session with no user id on it: "A relay token is never an environment login." J5 ships Connect switched off.
- **A session's permissions are in its signed token.** Upstream checks the token, not the stored row (`SessionStore.ts`), so they cannot be changed after pairing.
- **A WebSocket's permissions are fixed when it opens.** At J5's pin a revoked session's socket stays open, which upstream fixed in pingdotgg/t3code#17370.

## Rulings

### Principles

Jackson, in his words:

- "We aren't trying to provide security. With multi-player, the user is giving someone access to terminals and AI on their server. We cannot keep them from doing anything bad with that level of access. It is a complete non-goal." Privilege escalation through a terminal or an agent is accepted. On restrictions that are easily defeated: "If we keep people from minting new pairing URLs in the UI but they can just use the terminal or AI to mint one, is there a point in trying to prevent it beyond not showing the button?"
- "We want to make sharing and inviting people into a user's work very easy. This is a great way to get people to use the product. Generating and using multiple invite links needs to be super easy." Access "will evolve over time and we need to support that seamlessly."
- "Right now this feature is very MVP… Priorities should be UX > Simplicity/Maintainability/Testability > Security > Edge cases." That may mean disabling a feature, or making something broadly available that we would rather restrict. On 2026-10-17 he asked that the tie-breaker and "turn it off or open it up" be stated as holding only while the feature is new.

### The model

- **Three layers:**
  - what a device may do (upstream's permissions);
  - who the device is (J5's person);
  - where they may do it (J5's reach).

  Jackson: "this data model makes sense." The people model is its own definition.

- **View stays an enforced boundary**, because showing someone one thing and nothing else is what makes sharing casual.
- **Scopes are Server, Project and Thread.** There is a server-wide View. A scope covers what is in it now. The thread tree rules stand: what is beneath a thread is included, and the thread above it, agents beside it and forks are excluded.
- **Home scopes.** Jackson saw value in a guest seeing most things, "Things just get hard when you try to scope it down to a thread", so each surface sits at the smallest scope it can be cut to:
  - project scope adds artifacts;
  - server scope adds the Fleet page, Personas, Playbooks, Skills and scheduled tasks;
  - files and terminals are not part of View at any scope, since upstream reads any path on the machine (option A).
- **One write level.** "I think one write level is correct." It covers everything within the scope except configuring or sharing the server.
- **Levels are Viewer, Collaborator and Owner.** Jackson: "a member is really just Server + Collaborator, and thus doesnt need a special name." Owner is at server scope only, and a server can have several: "Any team in a company is going to need a backup Owner, and those people would be the ones responsible for handing out tokens."

### Links, sharing and devices

- **One place to manage sharing, shown where it is convenient.** The Share dialog's shape waits on a review with the designer.
- **One kind of link.** Name confirmation before writing goes.
- **A link for many people is Viewer only.** "One kind of link" had let one carry Collaborator without anyone deciding it. Jackson caught it while reviewing the designs, and ruled that writing takes an Owner raising that person, since a forwarded link lets in people nobody invited.
- **An Owner can copy a link again** until it expires, is revoked or is used. Jackson: "It's bad UX to have a long lasting link meant for multiple people to just have to keep regenerating it when you want to send it more people." J5 keeps the token rather than only its hash, which it can do because a link is J5's own token.
- **Sharing follows upstream's Manage access.** Jackson: "a one time UX hit to save maintainability over the long run." There is no notice explaining it, "since itll also show to people who can never get that level of access."
- **Guests don't invite others or manage their own devices.**
- **Authoritative identity is shelved.** A person is whoever their link was for.
- **Who a device belongs to:**
  - the startup link and the desktop app → the first owner;
  - a Connections link → its maker;
  - `j5 pair` always names a person. Jackson: "leaving open the bare case makes maintainability harder outside of the upstream sync, which is where we want it least."
- **A device the server can't place says who it is** before use. Jackson: "the 'what should people call you' should be the UX for creating person records when the server already has you paired but doesnt know who you are."
- **The first owner must answer too, with the server's name in the prompt.** Jackson: "the UX friction might be better agent UX. It makes it more likely the agents will know who the primary user is."
- **Names.** Anyone renames themselves, Owners rename anyone, names stay unique, and the author line's tag becomes the level.

### Permissions follow the level

The agent first proposed pairing every device with full permissions and having J5 narrow them on each request, so that changes of level would be instant. Jackson rejected it on two counts. First: "Yes writers can hack the system if they want, but that doesn't mean our permission system should fail open like that." Second: "How its implemented today in a feature we just shipped shouldnt influence the design." He asked for automatic re-pairing to be explored instead.

The outcome is that a device holds exactly its person's level's permissions. When the level changes, J5 revokes each of the person's sessions, and the device renews on J5's own route, proving itself with the old token. Jackson accepted the brief reconnect that comes with it. A device paired narrow from Connections stays narrow.

### What each level and scope gets

Jackson asked whether every cell of levels and scopes had been decided; only the rules had. Working through the cells:

- **Scheduled tasks** belong to the thread they are bound to, or else their project ("Cant scheduled tasks be set at the thread level?"). **Playbooks** are files in a project's repository and belong to the project. **Personas** belong to the server. **Skills** belong to where they are installed, and installing one from a catalog is for Owners.
- **At thread scope a Collaborator cannot fork**, since a fork falls outside the thread's scope, and cannot start a thread. A project's **scripts** follow upstream's permission for environment settings, so only Owners edit them.
- **Owner and Collaborator stay apart** after upstream merged the Standard and Administrative permission sets into one (pingdotgg/t3code#20432, 2026-10-17). Jackson: "In a multiplayer world where we accept the fact that some of our RBAC can be circumvented, I think it still makes sense for us to have the split between owner and collaborator." Each level's permissions are listed by name.
- **Settings is an MVP.** A code check found that making each Settings page right for every level and scope meant fixing missing permission checks in upstream's own pages and handling each page under J5's narrowing. Jackson chose the MVP: Owners get all of Settings, everyone else only the pages about their own device, from a list of pages shown. Settings leaves out servers the person does not own, since upstream disables a setting row unless every listed server allows the change. A later version goes through Settings page by page.
- **People needs a server picker.** Jackson: "I need to be able to manage people across multiple servers from the same client."
- **For now, someone who is not an Owner does not archive or delete threads**, since unarchiving lives only in Settings (Jackson: "I'm fine with this for MVP").
- **The setup wizard is for Owners.** Upstream decides it in the client, from the primary server's workspace. Today J5 turns it off with a flag saved in the browser by a share link. Jackson pointed out that nobody joins with nothing shared ("The real issue would be the viewer losing access to their last thing, right?"), and accepted deciding it from the server's answer instead.

- **Who sees whom.** Anyone sees the names and levels of the people who reach what they are looking at; only Owners see devices, links and what someone reaches elsewhere (Jackson agreed).
- **The first owner cannot be removed or lowered**, since the server's own machine, its startup link and its desktop app are theirs (Jackson agreed).

### The sharing UI

Jackson reviewed the sharing UI with the design agent; its decisions are in the project artifact `share-links-ui-design.md`. One changed the model's wording: a project or the whole server is shared from the People page and nowhere else. Jackson: "it should go on the people page as well, rather than a third place. In fact, it should probably be folded into the server section, with people just showing either access to a project or the whole server." The rest became criteria. The Share dialog lists people who reach a thing through a wider scope, with that scope. Raising someone to write shows the same warning as a link. Unused links are listed and can be copied again. The join page refuses a link for one person on a device already paired, whether the device belongs to someone else or to that same person.

## Working with agents together

The second area was taken on 2026-10-17. Its outcome is in [Shared conversations](../product/features/shared-conversations.md), [Inbox](../product/features/inbox.md) and [Crews](../product/features/crews.md).

### When a conversation is shared

The agent proposed that a thread become shared only when a second person writes to it. Jackson rejected that, because memories link agents across threads: "An agent saving a memory from Alice's single player thread and bringing it into a thread with Bob doesn't make sense. The agent needs to be able to tell people apart." He also said that a late "that was Alice the whole time" gets lost in compaction. He described three kinds of server: exclusively single player, mostly single player with occasional invites, and multiplayer. Of the last: "cases where there are multiple people with broad write access (shared projects and servers) are cases where the agent will most of the time be in that multi-player state, and it should always know who is talking to it." So a thread is shared whenever more than one person can write to it, and it stays shared.

### What the agent is told

- **Slash commands.** Commands are read from the first character, so an author's line in front turns them into words. Some are caught by upstream before the provider sees them, such as `/logout` and `/compact` on an empty thread. Others pass to the provider, and only skills safely take an author's line at the end. Jackson: "Given how narrow the space for putting the label in is looking, I'm tempted to just drop it from all slash commands." Anyone's command goes as typed. The `/logout` path skips "Manage providers", which was filed in #276.
- **Standing.** The guidance on sensitive work, and the "here for" line, had caused false refusals in live tests. Jackson: "it's simpler to lean on 'you invited them, trust them'." He approved a note that trusts everyone who can write alike, with an Owner's word settling a conflict. #595 is adopted: every agent is told the server's Owners.

### Prompts, the inbox, thread state and Crews

- **Prompts.** These are unchanged, except that a Collaborator also edits roster seats and allows a command for the session.
- **The inbox.** Refusing inbox asks in a shared conversation would have switched the inbox off on multiplayer servers. Jackson proposed a shared mailbox instead: "a 'message everyone' option for the agent… get a reply from anyone", with the first reply closing the ask. "Everyone" is everyone who can write to the asking thread, and not a subset, "because that means that an agent could send an ask to that subset and its held as an open ask that another writer not in that subset cant possibly close". An agent can still ask one person, since another writer can have the agent withdraw it. On a reply race he asked for "an intentional decision here and not complicate the build too much": the first reply wins, and later ones are refused. An item the person had started answering stays in place with their words when it closes.
- **Thread state.** Archive, settle, snooze, pin and the read marker stay shared, as upstream keeps them. Jackson: "We have to go A for MVP, but this is probably the first thing to come back and fix" (#629).
- **Crews.** Anyone who can write to a Captain's thread reaches its seats, and gets the Crew's later requests in their inbox. That ends the #534 stall.
- **Queueing and steering.** Anyone who can write steers, stops, and changes any queued message.

## After this session

Left for later, each with its own issue:

- per-person attention state, starting with the read marker (#629);
- Settings page by page for Collaborators and Viewers (#630);
- mobile (#609);
- the upstream give-backs (#276).

All the documentation changes land in one PR or stack, merged at once.
