# Migrating a J5 server to release archives (0.0.43 → 0.0.44+)

Run this once on each machine where J5 Code 0.0.43 or earlier was installed from
npm (`@jacksondr5/j5code`). It is written so an agent can follow it step by
step. Stop and ask the owner wherever it says to.

## What changes

- **Install method:** J5 no longer publishes to npm. Each release attaches a
  self-contained server for macOS (Apple silicon) and Linux x64 to its
  [GitHub Release](https://github.com/Jacksondr5/j5code/releases), plus
  `install.sh` and `SHA256SUMS`. The installer links the `j5` command into
  `~/.local/bin`.
- **Service name:** the background service becomes **`j5code.service`**
  (systemd, Linux) and **`codes.jackson.j5code.service`** (launchd, macOS). It
  used to be `t3code.service` / `com.t3tools.t3code.service`, which collided with
  an installed T3 Code for the same OS user. `j5 service install` retires the old
  service for you, but only when its unit names `J5CODE_HOME`.
- **Data:** it stays in `~/.j5code/userdata`. On first start the new version
  copies `state.sqlite` to `statev2.sqlite` and uses the copy from then on. Work
  done after the upgrade exists only in `statev2.sqlite`.
- **Two hops:** releases after 0.0.48 can't upgrade a database that 0.0.43 or
  earlier wrote. They refuse it and tell you to run `j5 update 0.0.48` first. So
  this guide installs 0.0.48, lets it upgrade the database, and then updates to
  the newest release (step 5).
- **Updating from the app:** the app shows **Update server** when its version is
  newer than the server's. That button cannot move an npm-installed server
  (0.0.43 or earlier) to a release archive: the old server only knows how to
  update itself from npm, and J5 stopped publishing there after 0.0.43, so it
  reports a failure. Run the
  steps below on the server machine once instead. After this migration,
  **Update server** and `j5 update` work again.

## Who needs this

| Setup                                               | Action                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J5 running as a background service (Linux, macOS)   | Follow every step below.                                                                                                                                                            |
| J5 started by hand (`j5`, `npx @jacksondr5/j5code`) | Stop it, then do step 3. Start it once with `j5` or `j5 serve` so 0.0.48 upgrades the database, check step 5, stop it, run `j5 update`, and start it again with your usual options. |
| J5 desktop app only (no background service)         | Install the 0.0.48 desktop release and open it once, then install the newest one.                                                                                                   |
| SSH hosts that the desktop app launches             | Nothing. The first connection after the desktop update downloads the new server to `~/.j5code/runtime` on the host.                                                                 |

## 1. Inspect (read-only)

1. Confirm the machine is supported: `uname -sm` must print `Darwin arm64` or
   `Linux x86_64`. Otherwise stop and ask the owner; there is no release archive
   for it.
2. Confirm the existing service is J5's, not T3 Code's:
   - **Linux:** `systemctl --user cat t3code.service` must contain a line
     `Environment=J5CODE_HOME=…`.
   - **macOS:** `~/Library/LaunchAgents/com.t3tools.t3code.service.plist` must
     contain `<key>J5CODE_HOME</key>`.
   - **If the unit mentions `T3CODE_HOME`, or has no `J5CODE_HOME`:** it belongs to
     T3 Code. Leave it alone and stop to ask the owner.
3. Record the home the old unit serves (the `J5CODE_HOME` value). The rest of this
   guide assumes `~/.j5code`; if it is different, pass `--base-dir <that path>` to
   every `j5 service` command below and set `J5CODE_HOME=<that path>` for the
   installer.
4. Record the running version: `cat ~/.j5code/runtime/service-state.json` and
   note `activeVersion`.
5. List customizations. On Linux, `ls ~/.config/systemd/user/t3code.service.d/`
   shows drop-ins (for example the port, host, or `PATH`). On macOS, note any
   keys you added to the plist by hand.
6. Check for a leftover unit that would block the new name:
   `systemctl --user cat j5code.service` (Linux) or
   `ls ~/Library/LaunchAgents/codes.jackson.j5code.service.plist` (macOS). If
   one exists that this guide did not create (for example an old checkout-based
   unit), report it and let the owner decide whether it may be removed.
   `j5 service install` refuses with `foreign-service-present` and leaves such
   a unit untouched until it is gone.
7. **Linux:** check for drop-ins that already exist under the new name:
   `ls ~/.config/systemd/user/j5code.service.d/` and
   `grep -HE '^\s*(Condition|Assert)' ~/.config/systemd/user/j5code.service.d/*.conf`.
   A drop-in with a `Condition…=` or `Assert…=` line (for example
   `ConditionPathExists=!…/service-state.json` left over from an earlier manual
   migration) makes systemd skip starting the new service. Do not delete it
   yourself: report the file and its contents and stop for the owner.
   `j5 service install` refuses with `service-dropin-conditions` while one
   exists. Note every file already in that directory; the rollback below must
   keep them.
8. Check which `j5` your shell runs: `command -v j5`. An npm global install puts
   its own `j5` on `PATH`; note where it is.

## 2. Prepare

- **Timing:** restarting the service interrupts running agent turns, terminals,
  and remote clients. If agents are working, ask the owner before continuing.
- **Back up** into a folder outside the J5 home. Do not copy the live database
  with `cp` while the server runs; use `VACUUM INTO`:

  ```sh
  mkdir -p ~/j5-migration-backup
  node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.HOME+'/.j5code/userdata/state.sqlite',{readOnly:true}).exec(\"VACUUM INTO '\"+process.env.HOME+\"/j5-migration-backup/state.sqlite'\")"
  cp ~/.j5code/runtime/service-state.json ~/j5-migration-backup/
  ```

- **Linux:** also back up the old unit and its drop-ins:

  ```sh
  cp ~/.config/systemd/user/t3code.service ~/j5-migration-backup/
  [ -d ~/.config/systemd/user/t3code.service.d ] && cp -R ~/.config/systemd/user/t3code.service.d ~/j5-migration-backup/
  ```

- **macOS:** `cp ~/Library/LaunchAgents/com.t3tools.t3code.service.plist ~/j5-migration-backup/`

## 3. Install 0.0.48

```sh
curl -fsSL https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh | T3CODE_VERSION=0.0.48 sh
~/.local/bin/j5 --version    # prints "j5 v0.0.48"
```

Install 0.0.48 exactly, not the newest release. A newer release refuses a
database that 0.0.43 or earlier wrote. 0.0.48 upgrades it, and step 5 moves you
to the newest release afterwards.

The installer unpacks the release into `~/.j5code/runtime/versions/<version>/`
and links `~/.local/bin/j5` to it. It never reads `T3CODE_HOME`.

If `command -v j5` (step 1.8) pointed somewhere other than `~/.local/bin/j5`,
remove the npm copy so the new one wins: `npm uninstall -g @jacksondr5/j5code`.
Then `command -v j5` must print `~/.local/bin/j5`. If `~/.local/bin` wasn't on
`PATH`, the installer added it to your shell's startup file: open a new terminal.
For a shell it doesn't recognize, add the directory yourself or use
`~/.local/bin/j5` below.

## 4. Move the service

1. **Linux drop-ins first.** Copy them to the new unit's drop-in directory so the
   new service starts with the same settings:

   ```sh
   mkdir -p ~/.config/systemd/user/j5code.service.d
   cp -n ~/.config/systemd/user/t3code.service.d/*.conf ~/.config/systemd/user/j5code.service.d/
   (cd ~/.config/systemd/user/t3code.service.d && ls *.conf) > ~/j5-migration-backup/copied-drop-ins.txt
   ```

   `cp -n` never overwrites a file that step 1.7 found; if a name collides,
   stop and ask the owner. The list records which files this guide copied so a
   rollback removes only those.

   Open each copied file. Delete any `ExecStart=` override: it points at the old
   npm launcher and would break the new service. Keep settings such as
   `Environment=` lines. On macOS there is no equivalent: `j5 service install`
   generates the plist, so keys you added by hand to the old one are not carried
   over. Report them to the owner.

2. **Install:**

   ```sh
   j5 service install
   ```

   It downloads nothing new (the installer already did), writes
   `j5code.service` / `codes.jackson.j5code.service`, then stops and disables
   the old J5 `t3code.service` (macOS: boots out `com.t3tools.t3code.service`).
   An old service that is not running is fine; any other stop failure (for
   example permission denied or a timeout) ends the install before the new
   service starts, with the old service left running and its state file
   restored. Otherwise it starts the new service and checks that it is actually
   running (`systemctl --user is-active`, or `launchctl print` showing
   `state = running`), waiting a few seconds at most. Only then does it remove
   the old unit file. If the new service does not run, it stops it, restores the
   old service and its state file, and exits with an error. In every failure
   case, read the error and the log it names, then stop and ask the owner.

3. **Linux:** remove the leftover old drop-ins directory (it is in the backup):
   `rm -r ~/.config/systemd/user/t3code.service.d`.
4. **Tooling that writes units:** if Ansible or other configuration management
   creates these files, update it too. Otherwise it restores the old unit.

If `j5 service status` still reports `legacy-service-present` (for example the
old unit was recreated), and step 1 showed the unit is J5's, run
`j5 service install` again.

## 5. Verify

- `j5 service status` shows `installed · j5@<new version>` and no problems.
- **Linux:** `systemctl --user status j5code.service` is active, and
  `systemctl --user cat t3code.service` reports that no such unit exists.
- **macOS:** `launchctl print gui/$(id -u)/codes.jackson.j5code.service`
  succeeds, and `~/Library/LaunchAgents/com.t3tools.t3code.service.plist` is gone.
- `~/.j5code/runtime/service-state.json` shows the new `activeVersion`.
- `~/.j5code/userdata/statev2.sqlite` exists.
- The logs in `~/.j5code/userdata/logs/` show no migration errors. A migration
  failure keeps the server from starting; it does not damage data. Go to
  Rollback.
- Connect from a client and confirm that projects, threads, and agents appear.

Then move to the newest release, now that 0.0.48 has upgraded the database:

```sh
j5 update
```

Check `j5 service status` and the logs once more. If you skipped 0.0.48 and a
newer release reports that it can no longer upgrade this database, run
`j5 update 0.0.48`, let the server start once, and run `j5 update` again.

## 6. Report the upgrade (final step)

Releases after 0.0.48 no longer carry the code that upgrades databases from the
August and September 2026 builds, which is why step 3 installs 0.0.48 first.
This report records which installs have made the move.

After the first successful start on the newest release (step 5 passed), comment on
[Jacksondr5/j5code#275](https://github.com/Jacksondr5/j5code/issues/275) with
the machine or owner name and the version, for example:

```sh
gh issue comment 275 -R Jacksondr5/j5code \
  --body "Upgraded: <machine or owner>, $(j5 --version)"
```

If `gh` isn't available or signed in, give the owner that text to post. An agent
following this guide stops here; step 7 is a separate visit days later.

## 7. Clean up (after a few days of normal use)

Keep the old files until you are sure you will not roll back.

- `~/.j5code/runtime/service-launcher.mjs` (the old launcher).
- Old npm runtimes: directories in `~/.j5code/runtime/versions/` that contain
  `node_modules/@jacksondr5/j5code` and no `j5` or `t3` program at their top
  level (versions 0.0.43 and earlier). Keep every directory that has a `j5` or
  `t3` program.
- `~/j5-migration-backup/` once you no longer need a rollback.
- **Keep** `~/.j5code/userdata/state.sqlite`: it is the database as it was before
  the upgrade.

## Rollback

Rollback returns to the old npm version, which reads `state.sqlite`. Work done
after the upgrade exists only in `statev2.sqlite`, so the old version will not
see it. Never run the old and new services at the same time.

**Linux:**

```sh
systemctl --user disable --now j5code.service
rm -f ~/.config/systemd/user/j5code.service
# Only the drop-ins step 4.1 copied; anything that was already there stays.
[ -f ~/j5-migration-backup/copied-drop-ins.txt ] && while read -r f; do rm -f ~/.config/systemd/user/j5code.service.d/"$f"; done < ~/j5-migration-backup/copied-drop-ins.txt
cp ~/j5-migration-backup/t3code.service ~/.config/systemd/user/
[ -d ~/j5-migration-backup/t3code.service.d ] && cp -R ~/j5-migration-backup/t3code.service.d ~/.config/systemd/user/
cp ~/j5-migration-backup/service-state.json ~/.j5code/runtime/service-state.json
systemctl --user daemon-reload
systemctl --user enable --now t3code.service
```

**macOS:**

```sh
launchctl bootout gui/$(id -u)/codes.jackson.j5code.service
rm -f ~/Library/LaunchAgents/codes.jackson.j5code.service.plist
cp ~/j5-migration-backup/com.t3tools.t3code.service.plist ~/Library/LaunchAgents/
cp ~/j5-migration-backup/service-state.json ~/.j5code/runtime/service-state.json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.t3tools.t3code.service.plist
```

The old service needs its npm runtime in `~/.j5code/runtime/versions/<old version>`
and `~/.j5code/runtime/service-launcher.mjs`, so do not clean up before you are
sure. Restoring `service-state.json` matters: the old launcher cannot read the
state file the new version writes.
