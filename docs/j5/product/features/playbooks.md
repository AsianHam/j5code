---
title: "Playbooks"
kind: definition
---

# Playbooks

## Problem

An agent following a long procedure reads it once at the beginning and the later steps decay into the back pages of its context; by step nine it has forgotten what step nine said. A person watching long-running work cannot see progress at a glance — they see a spinner, not a state ([problems](../problems.md): context as bad memory; fleet observability).

## Definition

A **Playbook** is user-authored, step-by-step content for a piece of work, followed by a single Role or by a Crew; either can be spawned and told to follow one. A step may name the Role that should do it. In a Crew each step has one owner, the seat that owns it, and the Captain does any step no seat owns. A single-agent Playbook is the case where the one agent does every step.

**The engine is the platform's; the steps are the user's.** The platform holds the step pointer, keeps instructions fresh, and renders progress. The steps, their content, and the judgment that a step is done belong to the Playbook and the agents following it. This is how a workflow like the PR Group becomes expressible on the platform without being codified into it.

It runs in three moves. **An agent declares when to advance** through a tool call, so "what step are they on" is a cheap, honest, measured fact — asserted by the agent, visibly so, never parsed from output or inferred by the platform. **On each move, the platform delivers the step's instructions to its owner**, fresh in context: the owning seat in a Crew, or the Captain when no seat owns it; this is what defeats read-once-and-forget. **The interface renders progress** from the step pointer: which step each Crew is on, at a glance. Playbook run tools only read prompts and move the calling thread's own run; they never run a step or touch the workspace. So J5 pre-approves them wherever it pre-approves its other tools (Codex and Claude, [divergence D3](../upstream.md)), and every other harness keeps its own approval prompts.

Definitions live in the environment's library, available from every project and worktree on that server, and in folders the environment is configured to read. A project can also keep its own definitions in `.j5/playbooks/`; inside that project they override a library definition with the same name. Saving a definition to the library is a separate writing operation, pre-approved the same way but refused to read-only personas and plan-mode callers. An agent edits a library definition only against the version it read, so it can't overwrite a change it hasn't seen.

Playbooks are linear sequences. The initiative-level view — a plan whose nodes are Crews' Playbook positions — is the same idea one level up, with a recorded position for each run. A Playbook is not a workflow engine: no platform-owned branching, retries or step-level automation. Where a step needs judgment, an agent judges.

## Acceptance criteria

1. A Playbook is a user-authored file the platform reads; it never generates or edits steps.
2. A Role or a Crew can be spawned with a Playbook and told to follow it.
3. An agent advances a Playbook through a tool call with its expected current step; the platform never advances a step on its own.
4. The current step of every agent and Crew following a Playbook is a recorded fact, attributed to the agent that declared it.
5. On each move, the step's owner receives its instructions in its context: the seat that owns the step in a Crew, or the Captain when no seat does.
6. The interface shows which step each Crew and agent is on.
7. A Playbook has no branching, retry, or automation owned by the platform.
8. Live edits preserve the current step by stable ID; removing that ID requires explicit reselection before further movement.
9. Missing or invalid definitions preserve active progress and permit cancellation; completed and cancelled runs do not report actionable definition issues.
10. Back navigation changes the recorded position without undoing work, and retries cannot advance an active run twice.
11. Completing or cancelling a run leaves its participants usable and preserves the run as history.
12. Deleting the owner thread cancels its active run and stops that run from blocking definition deletion. Archiving a single agent's owner thread leaves its run resumable; archiving a Crew or its Captain cancels the Crew's run, and stopping a Crew doesn't.
13. New playbooks are saved to the environment library by default and are available across its projects and worktrees without a promotion step.
14. A project's `.j5/playbooks/` definitions are discovered in that project and override a same-named library definition there; creating one is an explicit choice.
15. Duplicate library names and unavailable sources are visible errors; running procedures retain their original file when discovery changes.
16. Copying a definition between environments creates an independent copy without replacing an existing different definition.
17. An agent can edit a library definition; the edit is refused if the definition changed since the agent read it.

## Scenarios

- **A release Playbook.** The user writes a five-step release Playbook whose steps name the Builder and the Sitter, and launches a Crew in Website Redesign that follows it. The Fleet page shows "Step 2 of 5 · builder". When the Builder reports step 2 done, the Captain advances, and the Sitter's next turn opens with step 3's instructions; an unowned step is the Captain's. (AC2, AC3, AC5, AC6)
- **A Crew from a playbook.** The user asks the agent in a thread for a crew to implement what they discussed, using `@playbook:release` or asking for the release playbook by name. The agent reads the playbook, proposes one seat per persona its steps name (a stand-in for a persona that is turned off), and, once the user approves, starts the playbook as the Crew's Captain. Each step goes to the seat that owns it, and Fleet shows "Step 1 of 4 · planner". (AC2, AC5, AC6)
- **A judgment step.** Step 4 says "decide whether the migration is safe to run"; the platform delivers the instruction and waits — the agent decides, and declares. (AC3, AC7)

- **A live single-agent procedure.** In Billing Migration, the user edits the current prompt while a Role follows the Playbook. The agent retrieves the revised prompt, moves back to inspect earlier work, and explicitly reselects when its step is removed. Deleting its owner thread cancels the run so the user can remove the definition. (AC8–AC12)

## History

- 2026-08-22 — the concept; former R27 ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R27(a) → AC3–AC4; R27(b) → Definition (linear first); R27(c), skills per step → not part of the definition, parked. The questions for the Playbooks design session — the step schema, how a Playbook attaches at spawn, the delivery channel for step advancement, the initiative-level view, what "declared complete" means for a multi-agent step — are that session's, not this definition's.

- 2026-09-29 — a Crew's run is its Captain's: one owner per step with the Captain as fallback, and archiving a Crew or its Captain cancels its run (Definition, AC5, AC12; [review](https://github.com/Jacksondr5/j5code/pull/384#discussion_r4140075782)).
- 2026-09-30 — a Crew can be built from a playbook the user's crew request asks to use, by an `@playbook:` mention or by name, but not one named only in passing (Bryant's ruling (a) on #387): the Captain owns the run (1A), each step names the persona that does it (2A), and the Crew records the playbook it follows (3A). A named persona that is missing, disabled, or blocked gets a stand-in seat (Bryant; #319, #321, #322, #323).
- 2026-09-23 — restored the end-state definition and AC1–AC7 traceability; clarified live edits, agent-declared movement, terminal history, and deleted-owner recovery ([review](https://github.com/Jacksondr5/j5code/pull/248#discussion_r4084815885)).
- 2026-09-29 — which harnesses pre-approve Playbook tools moved here from an edit to upstream's provider docs (Jackson, [#329](https://github.com/Jacksondr5/j5code/pull/329)).
- 2026-10-19 — an environment-wide library and configured folders join workspace discovery, with a project's own definitions winning inside it; independent copies between environments; agents edit library definitions against the version they read (AC13–AC17, [#613](https://github.com/Jacksondr5/j5code/issues/613)).
