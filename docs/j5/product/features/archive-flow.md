---
title: "Archive flow"
kind: definition
---

# Archive flow

## Problem

Archiving an agent is where obligations get stranded: the agent that was owed a reply never learns its counterpart is gone, the person's inbox keeps an ask nobody will ever withdraw, and children placed under the archived agent are left without anyone noticing. More agents mean more cleanup, and cleanup that happens silently is how a fleet loses track of itself ([problems](../problems.md): more work needs more cleanup; large unsupervised groups). Archiving is also a judgment moment — whether to proceed is the person's or Captain's call — and the platform's only honest contribution is to put the facts in front of whoever is deciding.

## Definition

Archiving sets an agent aside, and a person can bring it back. It **never destroys work**: worktrees, branches and pull requests survive, and cleaning them up is a separate act. It is **loud**: every open Exchange the agent holds ends with a notice to the waiter, and every fact that archiving will change is shown before it happens.

Before the dialog appears, the platform reads the facts: the agent's open asks in both directions, and the agents placed beneath it. A fact it could not read is shown as "couldn't check" — never as an empty, reassuring list.

**The dialog appears only when the facts warrant it.** An agent with nothing open and nothing beneath it archives without ceremony. Otherwise the dialog is titled "Archive ⟨agent name⟩?" and shows: the agents beneath it, which keep running; each open ask that will be terminated, as a two-line row mirroring an inbox item — urgency badge first, then "To" or "From" and the counterpart's name, then the time open, then the intent verbatim; the section's count and consequence ("N open asks will be terminated (counterparties are notified)"); a quiet reassurance that the workspace survives; and one destructive-styled confirm. One confirm, no type-to-confirm. Every line is a measured fact; the dialog offers no opinion on whether to proceed.

Afterwards, waiters receive a platform notice that the Exchange ended, the person's inbox items from this agent leave immediately (the dialog was the loud moment), the agent leaves the active sidebar, the Fleet page and the agents' address book, it can no longer be messaged, and its ledger and conversation stay readable forever.

**Unarchiving** is the way back. It restores the same agent — the same participant id, placement and provenance — and makes it addressable again. It does not undo what archiving ended: the Exchanges that closed stay closed, and deliveries that were cancelled are not replayed. An agent may be archived and unarchived any number of times.

**Deleting** is a different act, permanent, and only a person performs it. It removes the agent's membership and placement, offers to clean up the worktree, and leaves the agents beneath it, the historical provenance, and the ledger intact. When Memos exist, the agent's open Memos appear as a third section of the dialog.

The flow is reached from the agent's thread and from its Fleet page row. Crews archive only as a unit, through their own flow.

Archiving is **not** deleting, **not** a way to archive a single Crew member, and **not** a place for platform judgment.

## Acceptance criteria

### Facts

1. Before the dialog, the platform reads the agent's open asks in both directions and its placement subtree; a read that fails is shown as "couldn't check", never as an empty list.

### The dialog

2. An agent with no open Exchanges and no agents beneath it archives immediately, with no dialog.
3. Otherwise the dialog names the agent in its title, lists the agents beneath it, lists every live Crew the agent commands with each seat's running turn and open asks, lists every open ask with its urgency, direction, counterpart, time open, and verbatim intent, states the count of asks that will be terminated, and reassures that the workspace survives.
4. An ask row names its counterpart by display name — an agent's thread title, a person's name with "(inbox)" — and never shows a raw id; an unnamed counterpart reads "Unnamed participant".
5. The dialog has one confirm and no type-to-confirm.

### Aftermath

6. Every waiter on an ended Exchange receives a platform notice rendered as a muted notice line in its thread.
7. The person's inbox items from the archived agent leave immediately, with no terminal row.
8. The archived agent leaves the active sidebar and the Fleet page, is hidden from the agents' address book unless archived agents are asked for, and cannot receive a message or an ask; its ledger and conversation remain readable.
9. No worktree, branch, or pull request is deleted by archiving.

### Boundaries

10. A Crew member cannot be archived individually through this flow; the dialog refuses with the way out. A Captain is never archived alone through it: the dialog lists its live Crews seat by seat, and once the archive commits the platform retires those Crews as units, from this flow or any other door ([Crews](crews.md) AC17).
11. The flow is available from the agent's thread and from its Fleet page row.

### Unarchiving and deleting

12. Unarchiving restores the same participant id, placement and provenance and makes the agent addressable again; the Exchanges that archiving closed stay closed and no cancelled delivery is replayed.
13. Deleting is permanent, is performed only by a person, removes the agent's membership and placement, and leaves the agents beneath it, historical provenance and the ledger intact; it is the only flow that offers worktree cleanup.

## Scenarios

- **A clean archive.** An agent in Website Redesign has finished, holds no open asks, and has nothing beneath it; "Archive" retires it with no dialog. (AC2)
- **A loud archive.** An agent in Billing Migration has an open ask from the Captain (_soon_, "schema target", open 3h) and an ask out to the user, and a helper placed beneath it. The dialog lists the helper, both asks with their rows, "2 open asks will be terminated (counterparties are notified)", the workspace reassurance, and Confirm. On confirm, the Captain's thread shows a muted notice that the Exchange ended, the user's inbox item is gone, and the agent's branch and pull request are untouched. (AC3, AC4, AC6, AC7, AC9)
- **Bringing one back.** The user unarchives the Billing Migration agent a day later: it reappears with the same name, home and place under its spawner, and its peers can message it again; the Captain's earlier ask is still closed and must be re-asked. (AC12)
- **A fact the platform couldn't read.** The placement read fails; the dialog says "couldn't check" for the subtree line and still lists the asks it did read. (AC1)

## History

- 2026-08-21 — archive is loud and never destroys work; Crews archive as units; archiving with open Exchanges warns with count, list and confirmation ([record](../../worklog/2026-08-21-design-review.md); former R1, R14, R15 and the Roles/Crews session's J1–J3).
- 2026-08-29 — the flow designed; former AR1–AR4 ([record](../../worklog/2026-08-29-archive-flow-session.md)).
- 2026-09-01 — ask-row anatomy mirrors the inbox item; former AR5 (Jackson's live review of the archive build).
- 2026-09-12 — archiving becomes reversible; unarchive defined; deletion separated as the permanent act (PR #132); AC12–AC13 added.
- 2026-09-08 — rewritten into the definition shape. Former identifiers: AR1 → AC11; AR2 → AC1; AR3 → AC2–AC5; AR4 → AC6–AC9; AR5 → AC3–AC4; J1–J3 → AC3, AC5. Build sequencing that lived here (the dialog shipping ahead of waiter notices) is history.
- 2026-09-22 — an archive touches one agent: the dialog names the agents beneath it as ones that keep running, not as ones it archives (#254, option A; Bryant).
- 2026-10-07 — Squadrons retired: an agent's project is upstream's and never changes, so unarchiving has no home to restore, and there is no Squadron to archive (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
