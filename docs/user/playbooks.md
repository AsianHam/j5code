# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The progress bar above the
chat box shows the current stage and whether the run is active, completed, or
cancelled. A checked stage means the agent moved past it, not that its work was
verified.

Open **Settings → Personas → Playbooks** and select a project or thread worktree to see
its definitions and steps. Playbook Author runs on Codex in the selected workspace. It helps shape the steps,
writes the YAML, and checks the definition without starting a run. You can
customize the persona in Settings → Personas. Invalid definitions remain visible
with their errors.

On web and desktop, **Import YAML** copies a `.yaml` or `.yml` definition into the selected workspace.
The picker browses the workspace environment's filesystem, one file at a time. The file is
saved under a valid playbook name, so `Release Plan.yaml` becomes `release-plan.yaml`.
Importing a file with an existing name asks before replacing it. Changes also apply to runs
using that definition. An active run must be completed or cancelled before its
definition can be deleted; completed run history remains.

**Export YAML** downloads `<name>.yaml` on web and desktop and shares the YAML from mobile.
Web and desktop can import it back into another workspace or environment.

On web and desktop, open **Fleet** and use its **Playbook runs** section to follow
runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs.
Unavailable environments keep their last received progress marked as stale.

Ask your agent to create a playbook, or save a YAML file in your thread's workspace
under `.j5/playbooks/`. The file name is the playbook's name: lowercase letters, digits,
and hyphens, such as `release-review`. The `title` is what you see in the app. A file
with any other name is listed as invalid with a suggested rename. For example,
`.j5/playbooks/review.yaml`:

```yaml
title: Review a change
description: Understand, inspect, and report on a change.
steps:
  - id: understand
    title: Understand
    prompt: Read the change and identify its intended behavior.
  - id: inspect
    title: Inspect
    prompt: Check correctness and run focused checks where useful.
  - id: report
    title: Report
    persona: reviewer
    prompt: Summarize confirmed findings and remaining uncertainty.
```

A step can name the persona that should do it with `persona:`, using a persona id
from Settings → Personas. A step without one is done by whoever runs the playbook.
A persona that is missing or turned off shows as a warning in Settings and does not
stop the playbook from starting.

Type `/playbook ` to choose a registered playbook, then send the command to start it.
Send `/playbook review` to start directly, or `/playbook` to ask what is available.
Text after the name stays part of your message, as in
`/playbook review, then summarize the risks`. You can also ask directly: “Start
playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

Type `@playbook:` anywhere in a message to pick a playbook by name. On its own, the
mention asks the agent to start that playbook in the thread. Invalid playbooks appear in the
list with their error.

You can edit prompts and reorder steps while the run is active. The next retrieval
uses the latest file. Keep step IDs stable: if you remove the current step, ask the
agent to select an available step explicitly. A missing or invalid file leaves
progress unchanged; restore the file or ask the agent to cancel the run.

Ask the agent to go back when you want to revisit a phase. Going back changes its
position, not your files or previous work. Progress survives context compaction and
provider restarts. Expand the playbook above the chat box to see its stages or
select an earlier run. The stage list checks off stages before the current one,
and checks every stage when the playbook completes. Going back reopens stages
from that position onward. The counter shows completed stages.

Each run belongs to one thread. Deleting that thread cancels its active run, so
you can remove the playbook file. Archiving a thread leaves its run available when
you return to it.

## With a Crew

A Crew can follow a playbook. Its Captain starts the playbook in its own thread, and
each step goes to the seat that owns it. The Captain moves to the next step after that
seat reports back. Steps no seat owns are the Captain's. Going back or reselecting a
step hands it to its owner again. Fleet shows each Crew's current step and who has it,
or "handing off" while a step is on its way to a seat. Archiving the Crew or its
Captain cancels the run; stopping the Crew doesn't.

To have a crew built from a playbook, ask the crew to use it, with `@playbook:` or by name:

> ok, lets create a crew to implement what we have discussed. Please use @playbook:release for this work.

The agent becomes the Captain, reads the playbook, and proposes one seat per persona the
steps name. A persona that's missing, turned off, or can't run gets a stand-in seat, flagged
on the card.
You approve the roster, and the Captain runs the playbook. This applies only when you ask
the crew to use a playbook; one mentioned in passing starts an ordinary crew.
