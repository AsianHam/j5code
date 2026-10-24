# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `j5` CLI first ([Install T3 Code](./install.md#command-line)), then
run these commands on the machine that will host T3 Code:

| Task                            | Command                |
| ------------------------------- | ---------------------- |
| Install and start               | `j5 service install`   |
| Inspect status and log location | `j5 service status`    |
| Move to a newer release         | `j5 update`            |
| Restart                         | `j5 service restart`   |
| Stop and remove from startup    | `j5 service uninstall` |

The service is `j5code.service` (systemd user unit) on Linux and
`codes.jackson.j5code.service` (launch agent) on macOS.

Uninstalling the service leaves your projects, threads, and settings intact.
Running `j5 service install` again repairs a service that `j5 service status`
reports as broken.

J5 releases up to 0.0.43 installed the service as `t3code.service` /
`com.t3tools.t3code.service`, the same names an installed T3 Code uses.
`j5 service install` replaces that old service automatically, but only when its
unit names `J5CODE_HOME`; a T3 Code service is never touched. Settings you added
to the old unit, such as systemd drop-ins in `t3code.service.d/`, do not move on
their own; see [Migrating to release archives](../j5/user/migrating-to-release-archives.md).

`j5 update` downloads the newest release on your channel and switches `j5`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `j5 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

Pass an exact version (`j5 update 0.0.44`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `j5 update` ask for confirmation before
installing one.

`j5 uninstall` removes the background service, the `j5` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.j5code/userdata` are kept, along with `service.env`
under J5 home. Pass `--yes` from a script.

## Configure the service environment

Put custom environment variables in `service.env` under the service's J5 home
directory, normally `~/.j5code/service.env`. This file survives service installation
and updates. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `J5CODE_HOME`,
`T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` (including
case variants).

Run `j5 service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `j5 service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default J5 home, `chmod 600 ~/.j5code/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Troubleshooting

Start with `j5 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

`j5 service install` and `j5 service restart` check that the service is running
after they start it. If it is not, they report an error instead of success.
Read the log they name.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `j5 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                                                                                        |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support.                                                            |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status j5code.service`, then use the repair command printed by T3 Code.                                                                                |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `j5 service restart`.                                                                                       |
| `legacy-service-present`                | The old J5 service from 0.0.43 or earlier (`t3code.service` / `com.t3tools.t3code.service`) is still installed. Run `j5 service install`.                                                 |
| `foreign-service-present`               | A `j5code.service` / `codes.jackson.j5code.service` that J5 did not write already exists. Remove or rename it, then run `j5 service install`.                                             |
| `service-dropin-conditions`             | A drop-in in `~/.config/systemd/user/j5code.service.d/` has a `Condition…=` or `Assert…=` line that can make systemd skip the start. Review and remove it, then run `j5 service install`. |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/codes.jackson.j5code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

T3 Code removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `j5 doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

If you upgraded from a version that kept its database in `state.sqlite`, that
file is still kept next to the current one so you can roll back. `j5 doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, that older version starts with no threads or settings.
