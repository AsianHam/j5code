---
title: "Merging upstream"
kind: process
---

# Merging upstream

How J5 advances to a new upstream T3 Code. FORK.md holds the rules this depends on: the integration-case inventory, temporary patches, the pin log and the advance steps. This page is the checklist that stops an advance from missing something. The agents doing it are capable; use judgment, not ceremony.

## Shape

- **One PR.** The advance and every fork adaptation it forces land together, however large.
- **Advance onto a release tag,** not a branch tip. Upstream's `main` holds V2 now, and `j5/main` descends from it, so an ordinary `git merge` of the tag is expected.
- **Freeze.** Record the fork head, the previous pin and the upstream SHA, and don't move the target mid-merge.
- **If the previous pin is not an ancestor of the candidate,** git's own merge base is wrong. Use the merge-tree fallback in FORK.md ("Advancing").

## Review before building

- **Real content delta:** diff the pin against the candidate and read the diff, not only the commit log. Summarize what upstream added, especially anything touching J5 areas.
- **Literal conflicts**, then the **breaks that merge cleanly**, which cause most defects:
  - **J5-owned code** that imports or calls upstream APIs that changed (typecheck an approximate merge).
  - **New upstream lint rules.** Upstream's rules apply to J5 code too: lint `apps/*/src/j5` and `packages/*/src/j5` against the candidate's rules.
  - **New upstream files** that carry branding or `~/.t3` / `T3CODE_HOME` paths. BRANDING.md only lists files we already know.
  - **New or changed user-visible copy** that says "T3 Code" or a bare "T3" (divergence D25). Run `git grep -nE "T3 Code|\bT3\b" -- apps packages native` on the candidate, rebrand what a person or an agent reads, and leave what BRANDING.md lists as unchanged. Docs keep upstream's wording.
  - **New upstream MCP tools.** Review each one and decide whether agents get it, and check J5's access declarations against upstream's changes to `McpToolAccess` (FORK.md cases 2 and 4).
  - **New ways to archive a thread**, which must run the archive preflight.
  - **Upstream behavior** that crosses a J5 policy, such as resume, Stop, settle, queues or delivery.
  - **Migrations:** run `node scripts/j5/check-upstream-migrations.ts --base <pin> --candidate <candidate>`. For a renumbering or insertion, first check whether upstream ships its own reconcile and use it. It also needs a reviewed manifest, the checker's `--allow-reviewed-bridge`, and a rehearsal on a `VACUUM INTO` copy of real data.
  - **Codex fixtures and generated protocol:** take upstream's files whole.
  - **Muse fixtures:** take upstream's `muse_transcript.ndjson` files, then change "running in T3 Code" to "running in J5 Code" and "T3 Code wakes you" to "J5 Code wakes you" in each, to match J5's runtime instructions (FORK.md, "Advancing").
  - **New upstream workflows and jobs** that need the `pingdotgg/t3code` repository guard.
- **Walk every FORK.md integration case and temporary patch.** For each patch, decide keep, retire (upstream fixed it) or narrow.
- **Walk the [register of divergences](../product/upstream.md).** For each entry, check whether upstream's change makes it unnecessary, harder to carry, or wrong. Bring any change to the maintainer; retiring a divergence is the default when upstream now does the job.
- **Port upstream's edits to the files J5 owns outright** (`AGENTS.md`, the PR template; see FORK.md) and to J5's standing agent instructions, `packages/provider-core/src/j5/orchestrationInstructions.ts` (FORK.md case 8). Keep J5's version and apply what fits. Upstream's changes to its own instruction text show up as a merge conflict in `packages/provider-core/src/server/orchestrationInstructions.ts`, where J5 deleted that text.
- **Rewrite** the [upstream convergence watchlist](../product/upstream-convergence.md) and check the give-back backlog (#276).
- **Bring the decisions to the maintainer.** Default to adopting upstream and adjusting later if it proves bad.

## Build and verify

- Set `J5_UPSTREAM_T3_CODE_VERSION` to the release the pinned code will ship as (FORK.md case 59). For a pin on upstream `main` that is the version its nightlies carry, one patch above upstream's `package.json`, not the `package.json` version.
- Typecheck every package, including the root `scripts` project, to zero errors. Run the full suites for server, web, client-runtime, shared, contracts, mobile and desktop.
- Rehearse migrations through the production startup path (`layerConfig`), including the `statev2.sqlite` copy. Check a second boot and J5 table integrity.
- The release executable embeds its own Node (`SEA_NODE_VERSION` in `apps/server/vite.config.ts`), newer than the `.nvmrc` one tests run on, and the two differ in `node:sqlite`. `J5 Release` runs the database startup tests on the embedded version; run them on it locally too when either version changes (`fnm exec --using <version> … vp test run src/j5/persistence src/persistence` from `apps/server`).
- Rerecord the server shard weights (FORK.md case 65): `node apps/server/scripts/update-test-shard-weights.ts` runs the server suite once, serially, and rewrites `shardWeights.json`. Start it with the live server's variables unset, as for a dev server.
- **Never touch the live install.** Run service tests with `HOME` and `XDG_CONFIG_HOME` pointed at a temp directory, and check that the live units' hashes are unchanged afterwards. `~/.j5code/userdata` is read-only.
- Update FORK.md (cases, patches, pin log), BRANDING.md, the register, the watchlist, and the user migration guide if install or data changes.

## After merge

- Cut the release and migrate machines per the user guide.
- File the follow-up issues the review agreed on.
