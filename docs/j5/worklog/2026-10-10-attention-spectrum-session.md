---
title: "Attention spectrum session (2026-10-10)"
kind: record
---

# Attention spectrum session (2026-10-10)

Jackson and an agent worked on what the human-contact spectrum means for the product. The spectrum is a lens in the [principles](../product/principles.md); the session's subject was what it looks like in the interface. This record holds the rulings. They are proposals until the principles and the feature definitions carry them. The session covered one person on one server; several people were set aside.

## What prompted it

The principles describe a spectrum from Foreground agents, which talk with the person in chat often, to Background agents, which reach the person only through the inbox or a Captain. Nothing in the product knows where an agent sits. Jackson's thinking on the principle had changed, and he restated it.

## Rulings: the principle

Jackson's restatement:

- **Every agent is on the spectrum.** It describes how a person interacts with agents, so no agent is outside it.
- **An agent moves along it during its life**, sometimes because the person chose, sometimes in response to an event.
- **The platform makes intelligent choices about where an agent belongs, and gives the person controls.**

Agreed in the session:

- **An agent's place is not a value the platform computes.** It is the result of things that already exist: where the agent sits in the lineage, whether it is settled, snoozed or pinned, whether it is a Crew seat. The spectrum is how those are read. An earlier proposal in the session, to measure a position from how often the person talks to an agent, was dropped.
- **The platform's choices are rule-based, visible and reversible.** Upstream's auto-settle is the model: a stated rule acting on a measured fact, with a result the person can see and undo, and a switch to turn it off. "Intelligent" never means the interface guessing what the person cares about.
- **J5's surfaces mark; they do not move.** When something happens to an agent, its row keeps its place and gains a mark. A list that rearranges while it is read costs the reader their place, and on the Fleet page a row's position says who is running what. Upstream's sidebar sorts by recency and is left as it is.

## Rulings: the bands

The spectrum has three bands, told apart by what reaches the person from the agent.

| Band       | What the person takes in                       | Home                                 |
| ---------- | ---------------------------------------------- | ------------------------------------ |
| Foreground | The agent's words: the conversation is read    | The sidebar and the open thread      |
| Middle     | The agent's signals: facts about it            | The Fleet page's Active table        |
| Background | Nothing, until it reaches out or is looked for | Settled, and tucked into the lineage |

What already moves an agent, as Jackson listed it:

- **Upstream.** Subagents live in the lineage and stay out of the sidebar, and can be opened from there. Settling moves an agent to the background and leaves it retrievable, and auto-settle does that for an agent that is very likely done. Snooze moves an agent out of the way for a set time.
- **J5.** A Crew sits under its Captain, so many agents take little attention. A Playbook gives a signal about an agent without its thread being read. The Fleet page shows facts about agents at a glance.

- **The middle is where J5 adds what upstream lacks.** Upstream has many tools for managing foreground agents and places for background agents to live, and no feature for an agent the person does not want to talk to and still wants a signal from: which Playbook step it is on, how many Exchanges it has open, whether it died.
- **J5 also helps the agent.** It can tell an agent where it sits on the spectrum and manage the tools it has accordingly.

## Rulings: snooze, and what comes first

- **Snooze is not the way into the middle.** The agent proposed reading a snoozed agent as a middle agent, since it leaves the sidebar and stays a row on the Fleet page. Jackson: snooze is upstream's and is left alone. A snoozed agent is meant to disappear for a short while and come back. The person's action sends it to the background, and the platform brings it to the foreground when the time is up.
- **The signals are defined before the middle is.** What sending an agent to the middle means, and when a person wants to, follows from exactly which signals reach the person from an agent there. Whether a person can choose to move an agent into the middle waits on that.

## Rulings: what counts as a signal

A signal can come from three sources: the platform measured it; the agent declared it through a tool and the platform recorded the declaration, as with a Playbook step; or the platform inferred it.

- **Signals are measured or declared, never inferred.** Jackson: the Fleet page is left with data-based signals.
- **Where an inference is tempting, the row shows the fact beneath it.** "Stalled" is how long the current command has run plus a guess about whether that is bad; "looping" is how many times in a row a run failed plus the same guess. The fact is shown and the person judges.
- **No model-written judgment or summary on the Fleet page.** A description of what an agent is doing is what the [catch-up](2026-10-10-catch-up-session.md) summary gives, when asked for.
- **"Done" is not a fact the platform can measure.** The facts are that a turn ended, a pull request merged, a Playbook run was completed by the agent, or a person settled the thread. Each is shown as what it is.

## Rulings: how far along an agent is

- **A row shows the Playbook step, and the provider's task list where the agent keeps one.** Both are declared by the agent and already recorded: upstream holds the task list as a `todo_list` with steps, emitted by the Codex, Claude, Cursor and OpenCode adapters. An agent with neither shows nothing for this question.
- **No new tool for an agent to declare a status line.** It is one more thing for every agent to remember, and a line left stale is worse than none.
- Not checked: whether a task list resets at each turn in each adapter. A task count is how much of the agent's own plan is ticked, and is labelled as tasks so it does not read as how much of the work is finished.

## Rulings: what an agent has produced

- **A row shows the facts of the agent's pull request**: open, draft, merged or closed, the state of its checks, the review decision, whether it can merge. Upstream already syncs these for each thread's linked pull requests; the Fleet page does not read them today.
- **A row also shows the size of work not yet in a pull request**, as lines added and removed, which upstream records with each turn's checkpoint.
- **Artifacts are not shown per agent.** The store does not record which thread wrote a file.
- **Failing checks do not count toward the badge.** They are shown on the row. The agent took this to cover a pull request that cannot merge as well, and said so; Jackson did not object. The badge keeps to a failed run, a delivery alarm and a run that never started.

## Rulings: moving into the middle

- **Being in the middle means being followed through the signals above and not through the thread.** The Fleet page shows every agent, so every agent already has its signals there. What separates a middle agent from a foreground one is only that it is not at the top level of the sidebar.
- **No control for sending an agent to the middle, for now.** An agent is there because of how it was started: spawned by another agent, or seated in a Crew. Jackson: it is not clear what such a control should be, and that needs time with a better Fleet page.
- **Considered and not taken**: letting a person place an agent under another agent, which the Fleet page definition implies and which appears not to be built; and a control that removes an agent from the sidebar, which changes upstream's sidebar.

## Rulings: the Fleet page

- **The middle belongs on the Fleet page.** Its definition already gives each row four questions answered from measurements, and the Playbooks definition adds the step.
- **An event on an agent nobody is reading reaches the person through the Fleet page and the badge on its entry.** That is enough. The [Fleet page](../product/features/fleet-page.md) definition already says the badge counts agents with a measured problem.
- **The middle feels unsolved because the Fleet page is half-built**, not because the product is wrong. It does not work quite right, and in many ways it sends no meaningful signal yet. Jackson: that is unfinished work, not a core product problem. The details were left for later.

## Left open: the agent's side

The session stopped here. Jackson: the thinking had drifted from what he knows he wants into what he was considering for the first time.

- **Where an agent learns its place.** The [Roles](../product/features/roles.md) definition gives each Role a posture on the spectrum, set at spawn; it is not built. That treats an agent's place as a fixed property of its Role, which sits badly with the rulings above: the same Role can be started by a person or seated in a Crew, and an agent moves. The agent proposed that the platform tell an agent the facts of its situation when it starts (who started it, whether it is a Crew seat, who its Captain is) and that posture leave the Role. Jackson was not sure. Not ruled.
- **Whether an agent is told again when its place changes**, for example a Crew seat the person starts messaging directly. Not discussed.
- **Managing an agent's tools by its place.** Not discussed.

## Set aside

Several people on one server. Settle, snooze and pin are each one value per thread, shared by everyone, as upstream's read marker is (see the [catch-up session](2026-10-10-catch-up-session.md)). If the spectrum describes how one person relates to an agent, they belong to the person.
