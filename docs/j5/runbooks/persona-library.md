---
title: "Configure an environment's persona library"
kind: runbook
---

# Configure an environment's persona library

Persona files live on the server environment, including when clients connect remotely. Use that environment's active state directory; never point a development server at an installed application's live state.

## Import from a client

Settings → Personas provides one **Import** menu with **Persona file** and **Folder** options on web, desktop, iOS, and Android. Folder selection includes `.yaml` and `.yml` files recursively; a single-file selection imports only that definition. The client uploads selected definition contents to the chosen environment using authenticated orchestration-operate RPCs. Paths are diagnostic labels, never server write destinations.

Imports are copies, stored as one atomically replaced `<stateDir>/imported-agent-personas.json` collection. Imported IDs take precedence over the source library below. The UI first imports with `replaceExisting: false`. Existing IDs produce a typed `AgentPersonaImportConflictError` before any writes, carrying names, IDs, and definition digests. Cancel rejects the entire selection. Each conflict has a replacement toggle. Import selected retries the same files with `replaceExisting: true`, the approved `confirmedConflicts`, and `skippedPersonaIds` for toggled-off agents; the server checks those digests under the mutation permit and requests fresh confirmation for new or changed conflicts. Skipped IDs are excluded before conflict checks and writes, even if their definitions were removed while the dialog was open. They stay skipped across retries. New agents are imported alongside approved replacements; an entirely skipped selection succeeds without writing. Acceptance overwrites local edits only for approved replacements while preserving enabled state and saved task snapshots. The RPC retains explicit replacement without `confirmedConflicts` for existing clients; duplicate IDs within a batch are always rejected. All files are validated before writing. Batches are limited to 50 files and 64 KiB of UTF-8 per file. Other file extensions are ignored; unrelated or malformed JSON/YAML fails the entire selection.

Each imported record has an optional `enabled` flag in the stored collection; absent means enabled for compatibility. Settings exposes this as **On/Off** for every listed agent through `setAgentPersonaEnabled` (orchestration-operate): imported copies toggle their own flag, while folder and bundled ids are written to `<stateDir>/disabled-source-agent-personas.json`. An imported copy overrides its source, so a source id on that list is ignored while a copy exists. Include this file in environment backups with the other library state files. The older `setImportedAgentPersonaEnabled` RPC remains for existing clients. Disabled IDs remain in the catalog with unavailable reason `disabled` and are rejected at new persona launch preparation. Replacing a definition preserves its enabled state. The flag is environment metadata and is excluded from definition snapshots and digests. Toggle, import, and removal writes share the same process-wide permit and atomic file replacement.

The destructive trash action uses the authenticated `removeAgentPersona` RPC for every library entry. It records the ID in `<stateDir>/removed-source-agent-personas.json` before deleting any imported copy and its enabled flag. This order prevents a removed override from exposing its source definition. The original source files and task snapshots are untouched. Removed source and bundled definitions remain in the catalog as `removed` entries with `unavailable`/`removed` availability, and the `restoreSourceAgentPersona` RPC (orchestration-operate) deletes the ID from that file so the definition is listed and launchable again. Imported copies have no restore because their content lived only in the deleted import. Imported copies take precedence over exclusions, so importing the original definition explicitly restores an entry. Include both library state files in environment backups. Removal shares the mutation permit with imports and toggles. Legacy import-only and source-only removal RPCs remain for existing clients; the current UI uses complete library removal.

The **Create persona** dialog submits `createAgentPersona` (orchestration-operate): the server builds a version-1 definition with a declared `Response` artifact, a single allowed authority policy, and the chosen route, rejects IDs already present in the catalog or the removed list, and stores it in the imported collection with the enabled flag on. `readAgentPersona` (orchestration-read) returns the stored definition of any listed agent plus a YAML rendering and file name; the editors load instructions from it on open, and the Duplicate and Export actions use it. The pencil editor saves name, description, instructions, runtime policy, and the primary/fallback model targets through `editImportedAgentPersona` with orchestration-operate authorization. The catalog includes editable model targets and a content digest for imported entries only, never raw instructions. Blocked entries carry `attempts`, one per rejected route, with the target and the typed failure codes (provider unauthenticated, model not advertised, reasoning effort not advertised, runtime policy not enforceable, and so on) so clients can explain the badge. A stale digest or missing imported ID rejects the save. Successful edits increment the definition version, validate the complete definition and 64 KiB limit, preserve its enabled flag and unedited fields, and atomically replace only the imported collection. Changing the runtime policy replaces the allowed-policy list with that policy; leaving it unchanged preserves the existing list. Source files and saved task snapshots are untouched.

## Read server folders directly

By default, the server reads `.yaml` and `.yml` files anywhere under `<stateDir>/personas`, walking subfolders in sorted order and skipping dot-directories such as `.git`. If neither that folder nor explicit configuration exists, it offers the bundled examples. An existing empty folder is an intentionally empty library.

To select other folders, create `<stateDir>/agent-personas.json`:

```json
{
  "folders": ["personas", "/absolute/path/to/team-personas"]
}
```

Relative paths resolve from the state directory. Explicit configuration replaces the default/example catalog. An empty `folders` list disables source definitions; client imports remain available. The server never clones, fetches, pulls, or commits; maintain the folders using an editor and git as desired.

Settings → Personas → **Library sources** edits the same file through `getAgentPersonaLibrarySources` (orchestration-read) and `setAgentPersonaLibraryFolders` (orchestration-operate). The read RPC reports each configured entry with its resolved path, whether it exists, and a count of YAML files in its tree, plus a read-only git summary when `git` is on the server's PATH and the folder is inside a repository: the repository root, whether `git status -- .` shows uncommitted changes under that folder, and how many commits the tracked upstream is ahead (from the last fetch; the server does not fetch). The write RPC deduplicates entries, creates missing folders that resolve inside the state directory, rejects missing folders elsewhere and any non-directory before writing, and replaces the file atomically under the shared mutation permit. The catalog marks every entry's origin as `bundled`, `imported`, or `folder` with its source file path.

Declared handoffs bind to the shared artifacts system (`<stateDir>/artifacts/<project>/`). When a snapshot declares `outputArtifact`, the persona instructions gain a section naming `handoffs/<personaId>/<Artifact>-<first 8 chars of the thread id>.md` and the artifact's checklist; declared `inputArtifacts` point the agent at `j5_list_artifacts` and `j5_read_artifact`. A J5 run-finalization observer (`agentHandoffObserver.ts`, wrapped around the plan-export observer in `server.ts`) checks the project's artifact list after each completed run of a persona thread and writes one row per thread to `j5_agent_handoffs` (J5 migration 12): `written` when the file exists; otherwise `nudged` the first time, with one system message queued into the agent's thread through `ThreadManagementService.sendToThread` (the worker drains the queue inside the J5 auxiliary layer, ids derived from the run so redelivery cannot start a second turn), and `missing` if a later run still ends without the file. `getAgentHandoffs` (orchestration-read) returns rows for the requested thread ids, or the 500 most recent. Read-only personas can make that call because J5 pre-approves `j5_write_artifact` in both adapters, and the pre-approval is not persona-aware: `J5_CLAUDE_MCP_ALLOWED_TOOLS` joins Claude's read-only allowlist under `dontAsk` for every read-only Claude thread, and `j5CodexT3McpServerConfig` sets `mcp_servers.t3-code.tools.j5_write_artifact.approval_mode = approve` for every Codex thread running with approval policy `never`; artifacts live in application storage, so neither widens the workspace sandbox. Platform-spawned threads with deterministic ids hash to an eight-hex task segment instead of the first eight characters. The check does not gate the parent: `RunFinalizationService.finalize` commits the run's completion, and the delegated completion that wakes the parent, before it calls the observer, so a `mode: "wait"` parent has already returned and an async parent's continuation is already queued when the reminder is sent. The reminder starts one follow-up run in the child's own thread; a later run that still ends without the file marks the row `missing`, and no further reminder is ever sent for that task. Clients hold one environment-wide `getAgentHandoffs` query and refetch it when `subscribeHandoffRefreshes` emits after a row write.

`j5_write_artifact` on a `handoffs/` path (any agent, not only saved ones) goes through `ArtifactWorkspace.writeVersioned`; every other path keeps upstream's overwrite. The file is rendered from the versions it holds: a first-line marker `<!-- j5-artifact-versions: <path>; N@<ISO> ... -->` listing every kept version, an H1 (the newest body's first heading, or the artifact name from the file name), a version count line, then one `## Version N · <ISO timestamp>` section per version, newest first and the newest marked `· current`. The parser treats a line as a boundary only when it equals the heading rendered for a marker entry, located bottom-up, so a body may quote an earlier heading or end with `---` without being misparsed; a file whose marker and headings no longer agree is adopted whole as version 1, as is a file without the marker. An identical rewrite is a no-op, and the oldest versions drop when the rendering would exceed the 5 MB artifact limit. The `j5_write_artifact` description and the orchestration instructions tell the model that handoff paths append.

`getAgentPersonaUsage` (orchestration-read) aggregates persona history from the existing orchestration projections at request time: threads whose payload carries an `agentPersonaAssignment` (deleted threads excluded, archived included), their runs by status with the mean duration of completed runs, per-turn provider token reports summed per agent, and the pinned driver/model routes with thread counts. Nothing is persisted; the queries read `payload_json` through SQLite's `json_extract` on the projection tables, so they cost a scan of those tables per Settings open and should not be polled.

Each YAML file in the folder tree contains one definition; subfolders are only for organisation and carry no meaning. YAML uses version 1.2; duplicate keys, multiple documents, custom tags, and aliases are rejected. JSON definition files are ignored in source folders and rejected on import; only the internal import store, configuration, and snapshots remain JSON. For example, `agent.yaml`:

```yaml
id: team-researcher
version: 1
displayName: Team Researcher
description: Collects evidence for the team.
acceptedInput: A question and relevant repository evidence
inputArtifacts: []
outputArtifact: ContextBrief
authority:
  defaultPolicy: read-only
  allowedPolicies: [read-only]
modelRoute:
  - driver: codex
    model: gpt-5.6-terra
    reasoningEffort: high
  - driver: claudeAgent
    model: claude-opus-5
    reasoningEffort: high
instructions: |-
  # Identity
  You collect evidence for the team.

  # Operating principles
  Cite sources and distinguish observations from inference.
```

Choose exact models and reasoning values advertised by the environment. A route may name any provider driver, but a persona activates only on a provider that can enforce its runtime policy. `read-only` and `critic-review` run on Codex and Claude, `workspace-write` and `critic-fix` on Codex only, and `full-access` on every provider, since it needs no sandbox. A route to a provider that cannot enforce the policy shows as Blocked. `diagnostic` and `publish-only` are blocked pending the required operation boundaries.

Copy and customize the starter files in `apps/server/src/j5/agents/examples/` when working from the repository. Source folders may be shared through git. The source format is identical for starter and custom personas. The file limit is 64 KiB, with 32,768 characters available for instructions. Declare custom handoff names in an optional `artifacts` array before referencing them in `inputArtifacts` or `outputArtifact`.

Reopen Settings → Personas to read the updated catalog, or launch a new persona through the existing orchestrator contract. The server reads files on each catalog request and new activation; a restart is unnecessary. Empty libraries display an empty state. Missing configured folders, malformed files, undefined artifact references, or duplicate ids fail the library read and prevent new persona launches. Fix the indicated source and retry.

Changing the configuration or a source file does not modify running tasks. Every new assignment records a content digest and has an immutable definition snapshot under `<stateDir>/agent-persona-snapshots`. Back up and restore that directory alongside the event database. A missing or corrupt snapshot blocks reuse rather than silently substituting current instructions. Do not prune snapshots while tasks or their forks may reference them. Ordinary non-persona tasks are unaffected by library errors.

Direct human persona selection is available from the composer; in-app git commit, push, and pull remain out of scope by design (the app surfaces status only and opens the folder in an editor).
