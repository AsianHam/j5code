# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The progress bar above the
chat box shows the current stage and whether the run is active, completed, or
cancelled. A checked stage means the agent moved past it, not that its work was
verified.

Open **Settings → Personas** to manage playbooks. Playbooks in the environment
library are available across all projects and worktrees on its environment. Choose
**Create playbook** to work with Playbook Author, or **Import YAML** to add a finished
definition without a project. A project chosen for an authoring or playbook
conversation only determines where that conversation opens.

On web and desktop, import a YAML file from your device or paste its contents. On
mobile, paste the YAML. Names use lowercase letters, digits, and hyphens, so
`Release Plan.yaml` becomes `release-plan.yaml`. Imports never replace a different
existing definition: choose another name instead. **Export YAML** downloads the
definition on web and desktop and shares it from mobile.

The library can read additional folders on the environment's machine. Add a source
folder through the library's actions menu. Removing a source stops reading it
without deleting its files. Folder definitions are read-only in the app: edit the
source file, or copy it into the managed library. Refresh after changing files
outside the app. Duplicate names across sources show an error until a copy is
renamed or a source is removed.

A project can also keep playbooks in its own `.j5/playbooks/` folder, committed with
its code. They are available only in that project and its worktrees, and override a
library playbook with the same name there. To see them in Settings, pick the project
in the **Project** menu above the list. **Copy to library** makes one available
everywhere.

**Copy to environment** saves an independent copy on another connected environment.
For ongoing sharing between machines, keep `personas/` and `playbooks/` in a git
repository and configure each environment to read its local clone's matching folder.
Commit, push, and pull with your usual git tools, then refresh the library. Creating a
playbook does not automatically publish it to other environments.

Runs keep the exact file they started with. Removing a source does not redirect a
running procedure. Changes to that file's contents still apply live. Complete or
cancel active runs before deleting their managed definition; completed run history
remains.

On web and desktop, open **Fleet** and use its **Playbook runs** section to follow
runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs.
Unavailable environments keep their last received progress marked as stale.

Ask your agent to create or change a playbook. It saves to the environment library
unless you ask for a project-only playbook, which it writes to `.j5/playbooks/` in that
project. The playbook's name uses lowercase letters, digits, and hyphens, such as
`release-review`. The `title` is what you see in the app. For example, import this
definition as `review`, or save it as `.j5/playbooks/review.yaml`:

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
