---
title: "Dogfood runtime: self-hosted J5 Code server and clients"
kind: runbook
---

# Dogfood runtime: self-hosted J5 Code server and clients

How Jackson's solo dogfood (phase 3 of dogfood v0) actually runs: one
source-built J5 Code server on a Linux box, reached over Tailscale, with the browser as the client.
This document is self-contained on purpose — dogfood agents have no access to the design sessions
that produced it. Decisions and their load-bearing reasons are recorded inline.

Pin-advance note (2026-09-06): restart and Codex-version guidance below reflects the selected
upstream integration. This advance did not execute these Linux deployment procedures or verify
second-machine/relay/tunnel behavior; the deployment instructions retain their earlier environment
assumptions. See [FORK.md](../../../FORK.md#verification-and-review-at-the-recorded-source) for the
exact source and verification limits.

## Shape and rationale

- **One server.** A project and its ledger live entirely on one server by design, so the dogfood
  fleet is single-server. The Linux box is that server.
- **The browser is the dogfood client.** The server serves its own web bundle, built from the same
  commit as the server itself (`apps/server/src/config.ts` resolves `dist/client`, the HTTP
  catch-all serves it with SPA fallback). A browser pointed at the server therefore has zero
  client/server version skew, and updating the server updates the UI atomically — reload the tab.
  The packaged desktop app is deliberately **not** the dogfood client: its UI is frozen at package
  time, and there is no client/server version handshake anywhere in the protocol. Under skew, a new
  variant in the orchestration event unions kills the affected subscription fiber silently, and a
  non-additive `ServerConfig` change prevents connecting at all. The browser path makes that entire
  class of failure unreachable.
- **Updates are manual, from source, at moments Jackson chooses.** Merges land on `j5/main` daily;
  an auto-deploy would restart the server — cancelling in-flight agent turns — at times nobody
  chose, on commits nobody watched boot. "Get latest and restart" via one script is the whole
  mechanism. No tagged checkpoints, no artifact pipeline.
- **Every update snapshots the database first.** Both migration lanes (upstream's and J5's) are
  forward-only with no downgrade guard — an older server binary starts silently against a
  newer-migrated database and fails later at query time. The only reliable rollback is
  previous-commit + restored snapshot, so the snapshot is not optional. A second server on the
  same home is refused (it exits with code 78), so an old and a new binary can't run on one home
  at once.
- **Restarts interrupt active turns.** The environment's **Continue threads after restarts**
  setting is on by default, so upstream recovery may dispatch “Continue where you left off.” for
  eligible interrupted work after an update, crash or machine restart, Crew seats and Peer Agents
  included. It stops after three automatic continuations of a thread in a row, and skips a thread
  that waits on the person. Upstream does not continue a run the person stopped. This does not guarantee every
  interrupted task will resume or complete. A2A deliveries remain in their durable queue and
  resume delivery on boot with idempotent retries. Prefer updating when the fleet is quiet.
- **Native provider history is never silently replaced.** If a provider thread with a native
  reference cannot resume, its turn fails with the recorded cause; only a future explicit
  fall-back act may request a digest re-prime.
- **Managed like the box's other services.** The box already runs upstream T3 as an
  Ansible-reconciled per-user systemd service with an exact-version pin. J5 mirrors that template —
  dedicated service user, per-user unit, Ansible owns reconciliation — with one difference: the
  "pinned version" is a git checkout of `j5/main` instead of an npm package, because upstream's
  npm-based service updater cannot track a git branch.

## Deployment parameters

Defaults used throughout this document. All are adjustable; keep Ansible and this table in
agreement.

| Parameter        | Value                                   | Notes                                                        |
| ---------------- | --------------------------------------- | ------------------------------------------------------------ |
| Service user     | `j5dev`                                 | Non-sudo, lingering enabled, mirrors `t3dev`                 |
| Checkout         | `/home/j5dev/j5code`                    | Deploy-only clone of `j5/main`; never edited in place        |
| Development      | `/home/j5dev/src/j5code`                | Separate clone for agent work and development worktrees      |
| State dir        | `/home/j5dev/.j5code`                   | Set explicitly — see warning below                           |
| Listener         | `127.0.0.1:5773`                        | Loopback only; the existing T3 service keeps `3773`          |
| Tailnet exposure | Tailscale Serve HTTPS 8444 → 5773       | Applied by root via Ansible, not by the unit; 443/8443 taken |
| Unit             | `~/.config/systemd/user/j5code.service` | Journald logging (`journalctl --user -u j5code`)             |

> **Belt-and-braces state-dir check.** The J5 server now defaults to `~/.j5code`, separate from
> the real T3 install at `~/.t3`. The unit and commands below still set `J5CODE_HOME=$HOME/.j5code`
> explicitly so the intended location remains visible and safe if an older binary, wrapper, or
> future launch path bypasses the built-in default.

## One-time box setup

As `j5dev` (Ansible reconciles all of this):

1. **Toolchain.** `git`, `gh`, `sqlite3`, `build-essential`, `python3`, `fnm`, and via fnm the Node
   version in the checkout's `.nvmrc` (currently 24.22.0). Install the pnpm version from the repo's
   `packageManager` field under that
   Node; the server's Node distribution has no Corepack executable. Rust is **not** required —
   it is only used for desktop packaging. J5 sets no Codex CLI minimum of its own: Settings →
   Providers warns when the installed version is outside the range upstream's compatibility
   table supports, and does not block it. The C/C++ toolchain and Python
   support native dependency builds; `gh` supports repository and pull-request work.
2. **Checkout and first build.**

   ```sh
   git clone --branch j5/main https://github.com/Jacksondr5/j5code.git ~/j5code
   cd ~/j5code
   fnm install
   package_manager="$(fnm exec --using "$(cat .nvmrc)" node -p 'require("./package.json").packageManager.split("+")[0]')"
   fnm exec --using "$(cat .nvmrc)" npm install --global "$package_manager"
   fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
   fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build
   ```

   The `t3` build task builds the web bundle first and copies it into
   `apps/server/dist/client` — that copy is what makes the served UI version-matched. If the build
   ever warns `Web dist not found — skipping client bundle`, the server will answer HTTP 503
   instead of serving the app; rebuild rather than start it.

   Keep agent work in a second clone so edits, branch switches, and development builds cannot
   replace the running server's files:

   ```sh
   mkdir -p ~/src
   git clone --branch j5/main https://github.com/Jacksondr5/j5code.git ~/src/j5code
   git -C ~/src/j5code remote add upstream https://github.com/pingdotgg/t3code.git
   ```

   Add `~/src/j5code` as the J5 development project. Other initiatives get their
   own clones under `~/src`. Development servers use their worktrees' isolated homes.

3. **Unit.** `~/.config/systemd/user/j5code.service`:

   ```ini
   [Unit]
   Description=J5 Code dogfood server (source checkout)

   [Service]
   Type=simple
   WorkingDirectory=%h/j5code
   Environment=J5CODE_HOME=%h/.j5code
   ExecStart=/usr/bin/env bash -lc 'exec node apps/server/dist/bin.mjs serve --port 5773 --host 127.0.0.1'
   SuccessExitStatus=130
   Restart=always
   RestartSec=5
   KillMode=mixed
   OOMPolicy=continue

   [Install]
   WantedBy=default.target
   ```

   Ansible configures `.profile` to read the deployment checkout's `.nvmrc` on each login and
   prepend that fnm Node installation's `bin` directory to PATH. The login shell therefore
   resolves the updated pin after a deployment, then `exec` makes Node systemd's main process
   so SIGTERM reaches the server for graceful shutdown. Verify the executable behind the unit's
   `MainPID` after startup. The server exits 130 after signal-driven shutdown reconciliation;
   `SuccessExitStatus=130` treats that normal shutdown as successful in systemd.
   `serve` runs headless: no browser launch, no auto-bootstrap of a project from the working
   directory.

   The unit deliberately does **not** use the server's built-in `--tailscale-serve` flags: applying
   Serve config requires root or the machine's single Tailscale operator slot, and `j5dev` stays
   fully unprivileged. Tailnet exposure is a root-owned step instead (below).

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now j5code.service
   loginctl enable-linger j5dev   # once, if not already lingering
   ```

4. **Nightly snapshot timer.** `~/.config/systemd/user/j5code-snapshot.service` and `.timer`:

   ```ini
   # j5code-snapshot.service
   [Unit]
   Description=Nightly J5 Code dogfood database snapshot

   [Service]
   Type=oneshot
   ExecStart=%h/j5code/scripts/j5/dogfood-snapshot.sh nightly
   ```

   ```ini
   # j5code-snapshot.timer
   [Unit]
   Description=Run the J5 Code dogfood snapshot nightly

   [Timer]
   OnCalendar=daily
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now j5code-snapshot.timer
   ```

5. **Tailnet exposure (as root, not `j5dev`).** One Serve mapping on the node's existing
   tailscaled, alongside the T3 mapping — Serve config is a per-port map, so both coexist on one
   instance:

   ```sh
   ufw allow in on tailscale0 to any port 8444 proto tcp
   tailscale serve --bg --https=8444 http://127.0.0.1:5773
   ```

   In practice the homelab Ansible playbook owns this (with drift guards that refuse Serve entries
   outside the sanctioned T3 + J5 set); the commands above are what it converges to.

   **Tailnet policy is a separate prerequisite.** Add a grant from Jackson's identity to the
   server's tag for TCP 8444, retaining the existing T3 grant for 8443 and SSH access. Add policy
   tests accepting 8443 and 8444 while denying direct backend ports 3773 and 5773. The server
   remains bound to loopback; only its HTTPS proxy should be reachable remotely. Verify HTTPS
   from a second tailnet device: working Serve configuration and a successful request on the
   server itself do not prove that tailnet policy admits the client.

6. **Pairing.** Headless serve prints pairing details after startup — read them with
   `journalctl --user -u j5code -e`. The startup token carries every permission, and its link uses the
   loopback origin. For a fresh client token, which carries the same permissions, with the private
   HTTPS origin already included, run:

   ```sh
   cd ~/j5code
   J5CODE_HOME=$HOME/.j5code fnm exec --using "$(cat .nvmrc)" \
     node apps/server/dist/bin.mjs auth pairing create \
     --base-url 'https://<box-tailnet-name>:8444' --ttl 1h --json
   ```

   Substitute the actual tailnet hostname, then open the returned pairing URL on the client
   before the token expires. If using a startup admin link instead, replace only its loopback
   origin with the private HTTPS origin, preserving `/pair#token=...`. Do not run `pair --tailscale`
   as `j5dev`; Ansible owns the Serve mapping. Token issuance alone does not verify client access.

7. **Provider CLIs and accounts.** Ansible installs pinned Codex and Claude CLIs into the
   user-owned npm prefix `~/.local` and puts `~/.local/bin` first on the service account's PATH.
   This stable prefix keeps provider commands available when the checkout's Node pin changes.
   Node and pnpm remain pinned per checkout, with pnpm installed under the selected fnm Node.
   Claude Fable 5.1 requires
   Claude CLI **≥ 2.1.257**. Authenticate as `j5dev`, the same account that runs provider turns;
   a login under `t3dev` or the SSH administrator does not authenticate J5's providers.

   ```sh
   codex --version
   claude --version
   codex login
   claude auth login
   codex login status
   claude auth status
   ```

   Complete the CLI login instructions from an interactive SSH session. Keep their credentials
   in `j5dev`'s own home; do not symlink T3's provider state. Check provider readiness in J5 and
   complete one real turn with each provider before treating the environment as ready for work.
   Codex 0.153.3 with GPT-6 Astra and Claude 2.1.261 with Fable 5.1 completed real J5 turns on the
   remote host. Restart the J5 service after updating a provider CLI: persistent provider
   subprocesses keep using the old executable until restarted. Prefer a quiet fleet because
   that restart cancels active turns.

8. **Git and GitHub identity.** Configure the intended commit identity and authenticate GitHub
   manually as `j5dev` before agents push branches or create pull requests:

   ```sh
   git config --global user.name '<your commit name>'
   git config --global user.email '<your commit email>'
   gh auth login
   gh auth setup-git
   gh auth status
   ```

   Use repository-local git configuration instead if initiatives need different commit identities.

## Connecting the client

Open the full private HTTPS pairing link above in a browser on any tailnet device; the browser
stores the session at `https://<box-tailnet-name>:8444`. For an app-like feel, install
the tab as a PWA/app shortcut — it is still the server-served, always-version-matched bundle.

After a server update, reload the tab. If the session is ever rejected after an update, re-pair
with a fresh token from `auth pairing create` above.

The ad-hoc-signed macOS desktop app (see [macos-packaging.md](macos-packaging.md)) remains a
packaging capability, not the dogfood client. If it is ever pointed at this server as a saved
remote environment, expect a persistent version-mismatch banner and the skew hazards described
under "Shape and rationale". Re-enabling its update feed is a known, config-only option
(`T3CODE_DESKTOP_UPDATE_REPOSITORY` at package time) deliberately not exercised for dogfood.

## Updating the server

When ready to pick up merged work — preferably while the fleet is quiet:

```sh
cd ~/j5code
./scripts/j5/dogfood-update.sh
```

The script, in order: prints the current commit (the rollback target), snapshots the database via
`VACUUM INTO` (safe while the server runs), fast-forwards `j5/main`, installs that commit's Node
and pnpm versions, reinstalls dependencies with the frozen lockfile, rebuilds server + web bundle,
restarts the unit, and waits until the server answers on the loopback port. Build happens before
restart, so downtime is the restart itself. Readiness gets 30 probes, each with a one-second
connection timeout and two-second total request timeout, separated by one-second delays. The
check fails after about 90 seconds at most, rather than hanging on a stalled response.

What happens after restart depends on the environment's **Continue threads after restarts**
setting. It is on by default, so eligible work can receive the automatic continuation described
above; check whether recovery already started a turn before sending another prompt. With it off,
interrupted tasks need an explicit continuation prompt. Queued A2A deliveries drain on boot.

## Rollback

For when an update leaves the server broken or misbehaving. Deliberately manual — it should be
rare, and each step is a decision point.

```sh
systemctl --user stop j5code.service
cd ~/j5code
git checkout <previous-commit>        # printed by the update script; also in the snapshot dir name
fnm install "$(cat .nvmrc)"
package_manager="$(fnm exec --using "$(cat .nvmrc)" node -p 'require("./package.json").packageManager.split("+")[0]')"
fnm exec --using "$(cat .nvmrc)" npm install --global "$package_manager"
fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build
db=statev2.sqlite   # the file name inside the snapshot directory: statev2.sqlite or state.sqlite
rm -f ~/.j5code/userdata/$db ~/.j5code/userdata/$db-wal ~/.j5code/userdata/$db-shm
cp ~/.j5code/db-snapshots/<pre-update-snapshot>/$db ~/.j5code/userdata/$db
systemctl --user start j5code.service
```

Restoring the snapshot is required whenever the bad version ran migrations, and safe otherwise —
when in doubt, restore.

The server keeps its database in `userdata/statev2.sqlite`. The first start of a V2 build copies
`state.sqlite` to `statev2.sqlite` and never touches `state.sqlite` again, so the snapshot names
whichever file was live. Rolling back to a build from before that copy is one-way: the old build
reads `state.sqlite` and cannot see anything written to `statev2.sqlite`. Stop the service first,
restore `state.sqlite` if the pre-update snapshot is named that, and move `statev2.sqlite` (with its
`-wal`/`-shm`) aside rather than deleting it; an existing `statev2.sqlite` always wins, so leaving it
in place would hide the old build's writes from the next V2 start. Never run an old and a new
server against the two files at once. Ledger writes made between the snapshot and the rollback are lost; that is
the accepted cost, which is why updates happen at quiet moments. If the bad version never actually
started (build failure), skip the restore and just rebuild at the previous commit.

### Restoring the automatic pre-migration snapshot

Before a new version runs any migration, upstream's or J5's, the server copies the database to
`userdata/statev2.pre-migration-u<upstream>-j<j5>.sqlite`, where the two three-digit numbers are
the newest upstream and J5 ledger migrations the database had recorded, and logs the path, the size
and how long it took (a few seconds for a 2 GB database). It does this on its own at startup,
whether or not the update script ran, and only when a migration is pending. If the copy fails (a
full disk, for instance) the server refuses to start and nothing migrates; free space and start it
again.

To go back to the state before those migrations. A person runs this, from a terminal outside J5
Code; an agent running inside the server being rolled back must not, because the first step stops
that server and ends the agent partway through. There can be up to three snapshots: `ls -l` shows
when each was written, and the one to restore is the one written when the version you are leaving
first started.

```sh
systemctl --user stop j5code.service              # 1. stop the server
cd ~/.j5code/userdata
ls -l statev2.pre-migration-*.sqlite
snapshot=statev2.pre-migration-u<upstream>-j<j5>.sqlite
aside=../db-aside-$(date +%Y%m%d-%H%M%S)
# 2. move the newer database aside and copy the snapshot into its place
test -f "$snapshot" && mkdir "$aside" &&
  mv statev2.sqlite "$aside"/ &&
  { [ ! -e statev2.sqlite-wal ] || mv statev2.sqlite-wal "$aside"/; } &&
  { [ ! -e statev2.sqlite-shm ] || mv statev2.sqlite-shm "$aside"/; } &&
  cp "$snapshot" statev2.sqlite &&
  echo "Restored $snapshot. The newer database is in $aside."
cd ~/j5code && git checkout <previous-commit>     # 3. run the previous version
# rebuild as in the rollback steps above, then:
systemctl --user start j5code.service
```

Step 2 stops at the first command that fails, and has worked only if it prints its last line; do
not go on to step 3 otherwise. The snapshot is copied, not moved, so it is still there to restore
again. Run the previous version, not the new one: the new one would take a fresh snapshot and
migrate again. Everything written after the snapshot is lost, as with any restore.

Each snapshot is a full copy of the database. The server keeps the three most recent and deletes
older ones when it writes a new one. Snapshots named `statev2.pre-j5-*.sqlite` or
`statev2.pre-upstream-renumber.sqlite` come from earlier versions and are never deleted: remove
them by hand. A file ending in `.partial` or `.partial-journal` is a copy that was killed partway;
the server deletes those, once an hour old, the next time it writes a snapshot.

### A project shared by several Squadrons

The migration that retires Squadrons moves each Squadron's ledger to the project that Squadron
referenced. It cannot do
that when two Squadrons referenced the same project, so the server refuses to start and logs the
project and the Squadrons by name:

```text
Cannot retire Squadrons: project "<title>" (<project id>) is shared by Squadrons "<name>" (<squadron id>) and "<name>" (<squadron id>). Nothing was changed.
```

Nothing was changed: the database is as it was before the start. The app has had no way to create
this state since Create Squadron was removed, so it is rare. To repair it, one of the Squadrons has
to go, and only the previous version can remove one:

1. **Run the previous version.** Check out and build the commit before this update, as in
   [Rollback](#rollback), and start the service. No restore is needed. The snapshot the failed start
   wrote (`statev2.pre-migration-*.sqlite`) can stay; the next start replaces it.
2. **Choose the Squadron to remove.** Its agents keep their threads and conversations, but its
   agent-to-agent history (messages, Exchanges, Inbox items) is deleted with it.
3. **Archive that Squadron's agents and Crews** in the app. The delete below refuses while any is
   still live, and says which.
4. **Delete the Squadron** on the server host:

   ```sh
   TOKEN=$(j5 auth session issue --ttl 10m --token-only)
   curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:5773/api/j5/squadrons/$(jq -rn --arg id '<squadron id>' '$id|@uri')/delete"
   ```

   The id has a colon in it, which is why it is encoded. A `{"deleted":true,...}` reply means it is
   gone.

5. **Update again.** The migration now runs.

To check for this before updating, read-only:

```sql
SELECT project_id, COUNT(*) AS squadrons
FROM j5_a2a_squadron_project_reference GROUP BY project_id HAVING COUNT(*) > 1;
```

No rows means the migration will not refuse for this reason.

## Backups

Interim story until the client-pulled backup design lands: the nightly snapshot timer plus the
pre-update snapshots, both under `~/.j5code/db-snapshots/` with a retention cap enforced by the
snapshot script. Snapshots cover the live database only (`statev2.sqlite`, or `state.sqlite`
before the first V2 start) — `secrets/` and `settings.json` change
rarely; copy them by hand after changing them. Off-box copies follow whatever backup regime the
box already has; the snapshot directory is the thing to include in it.
