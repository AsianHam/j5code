---
title: "Build and install J5 Code for macOS"
kind: runbook
---

# Build and install J5 Code for macOS

The local personal-use build below is ad-hoc signed. It has a valid local code signature but no Apple
Developer ID certificate or notarization ticket, so macOS may require a one-time manual approval.
Local builds omit the update feed unless `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`
is configured. GitHub Actions builds use the J5 repository.

## Prerequisites

- Apple Silicon Mac with Xcode Command Line Tools.
- `fnm`, Node from `.nvmrc`, and pnpm `11.10.0`.
- `rustup`; entering the repository selects Rust `1.95.0` from `rust-toolchain.toml` without
  changing the machine's default toolchain.
- A clean J5 checkout on the reviewed `j5/main` pin.

## Build

```sh
fnm install
fnm use
pnpm install --frozen-lockfile
pnpm dist:desktop:dmg:arm64 --adhoc-sign --output-dir release-j5
```

The output is `release-j5/J5-Code-<version>-arm64.dmg` plus the matching ZIP. No certificate,
Apple account, or signing secret is required.

Do not insert a standalone `--` before the build flags. With pnpm `11.10.0`, that separator is
forwarded to this script as a positional argument instead of being removed.

## Verify

Set `dmg_path` to the exact DMG produced by the build, replacing `<version>`, then mount it
read-only at a temporary path and check its identity and signature:

```sh
dmg_path="release-j5/J5-Code-<version>-arm64.dmg"
mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/j5-dmg.XXXXXX")"
hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -readonly
app_path="$mount_dir/J5 Code.app"
plutil -extract CFBundleDisplayName raw "$app_path/Contents/Info.plist"
plutil -extract CFBundleIdentifier raw "$app_path/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign -dv --verbose=4 "$app_path" 2>&1 | grep -F 'Signature=adhoc'
hdiutil detach "$mount_dir"
rmdir "$mount_dir"
```

The expected display name is `J5 Code`, the bundle ID is `codes.jackson.j5code`, and the signature
line is `Signature=adhoc`. These checks inspect the package; they do not launch the application
or verify its interactive behavior.

## Install and first launch

1. Open the verified DMG in Finder and drag **J5 Code** to `/Applications`.
2. In Finder, Control-click **J5 Code**, choose **Open**, then confirm **Open**. This records a
   one-time local Gatekeeper approval for the unnotarized build.
3. If macOS still blocks it, open **System Settings → Privacy & Security**, find the J5 Code notice,
   choose **Open Anyway**, and authenticate when prompted.

Do not disable Gatekeeper globally and do not remove quarantine recursively from `/Applications`.
J5 Code uses `~/.j5code` and J5-specific Application Support paths, so it can remain installed beside
T3 Code.

## GitHub Actions

For a public release:

1. Bump the release versions with `node scripts/update-release-package-versions.ts <version>`. It
   writes the same version into `apps/server`, `apps/desktop`, `apps/web`, and `packages/contracts`
   `package.json`. Commit the change and push it as `j5/release-<version>`.
2. Run `J5 Signed macOS Build` on that branch. Keep the branch at the same commit until publication:
   GitHub restricts release creation with the standard Actions token when the target commit is no
   longer a branch head or tag.
3. After CI and the signed build pass, run `J5 Release` with that build's numeric run ID.
4. After publication, bring the version bump into `j5/main` with a PR so `j5/main` never reports an
   older version than the latest release.
5. In that PR, update the `Released pin:` line in `FORK.md` to the release's version and the
   upstream pin, branch and frozen date it was built on. j5.codes reads that line.

For a preview, to test installs and updates from a branch before it merges:

1. On a branch cut from the work under test, run
   `node scripts/update-release-package-versions.ts <x.y.z>-preview.<yyyymmdd>.<n>`, using the next
   release's `x.y.z`, today's date, and a counter that starts at 1. Commit and push it as
   `j5/preview-<x.y.z>-<n>`. This branch is never merged.
2. Run `J5 Signed macOS Build` on that branch, then `J5 Release` with that build's run ID, as for a
   public release. Keep the branch at that commit until the release is published.
3. Install it by naming the version; nothing offers a preview on its own:
   - **Fresh server:** use the installer attached to that release, which is the one under test:
     `curl -fsSL https://github.com/Jacksondr5/j5code/releases/download/v<version>/install.sh | T3CODE_VERSION=<version> sh`.
   - **Installed server:** run `j5 update <version>` in a terminal and confirm the prompt.
   - **Desktop app:** install the release's DMG. It replaces the installed app and has no update
     feed, so reinstall a stable DMG to go back; its window title uses the nightly name. While it
     is installed, it offers to update a connected server to its own version, which is how an
     in-app server update is tested. The offer compares `x.y.z` only, so a server already on that
     `x.y.z`, stable or an earlier preview of it, gets no offer: return it to an older stable
     first, or use `j5 update <version>` on its machine.
4. A server on a preview follows previews. Return it to stable with
   `j5 update --channel stable`, adding `--allow-downgrade` if the stable release is older.
5. Delete the preview release, its tag, and the branch once the work has shipped.

A preview is a GitHub pre-release and is never marked latest. The stable installer URL,
`j5 update`, and desktop updates ignore it.

### Nightly

A nightly is `j5/main` as it stands, published for daily use ahead of a stable release. Nothing is
committed for one: the version is stamped into the four manifests during the build.

To publish one, run `J5 Nightly` on `j5/main`. It takes no inputs. It names the build
`<x.y.z>-nightly.<yyyymmdd>.<run>`, where `x.y.z` is the next patch after the version `j5/main`
commits, then runs the signed macOS build and the release for that commit. The result is a GitHub
pre-release, never marked latest, tagged `v<version>`.

If the release job fails, re-run the failed job in that run: it reuses the draft release the first
attempt created. Running `J5 Nightly` again instead gets a new version and leaves that draft, with
its assets, orphaned, so delete the draft release first if you do. GitHub can refuse to let the
workflow tag a commit that is no longer a branch head; if `j5/main` moved during the run and
creating the release keeps failing for that reason, delete any draft and run `J5 Nightly` again on
the new head.

To move a machine to nightlies:

- **Fresh server:**
  `curl -fsSL https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh | T3CODE_CHANNEL=nightly sh`.
- **Installed server:** `j5 update --channel nightly`. A server on a nightly follows nightlies, so
  later a plain `j5 update` takes the next one.
- **Mac app:** **Settings → General → Update track → Nightly**. The app then updates itself to the
  nightly build in place: one install, one profile and one database, as with upstream's.

To return to stable when the stable build knows every migration the nightly ran:

- **Server:** `j5 update --channel stable`, adding `--allow-downgrade` while the newest stable is
  older than the nightly.
- **Mac app:** **Update track → Stable**.

That is the case when the stable release was cut from the nightly's commit or a later one. It is
also the case when no nightly you ran migrated the database, which you can check: the server took
no `statev2.pre-migration-*.sqlite` snapshot in `~/.j5code/userdata` while you were on nightlies.
Otherwise the stable build is older than the database, and these steps would leave it running
against migrations it does not know. Use [Going back to an older build](#going-back-to-an-older-build)
instead.

Start with one server and one Mac. A nightly that changes the client-server or peer protocol splits
a mixed fleet until every machine has moved.

### Going back to an older build

The policy is to roll forward: a broken nightly is fixed by the next nightly. This section is for
going back to a build that lacks a migration the newer build ran. An older build starts against a
newer database without complaint and fails later, at query time. So going back to a build from
before a migration needs the database from before that migration too.

The server keeps that database. Before a new version runs any migration it copies the database to
`~/.j5code/userdata/statev2.pre-migration-u<upstream>-j<j5>.sqlite`, named for the newest upstream
and J5 migrations the database had recorded, and keeps the three most recent copies. Everything
written after the copy is lost by restoring it.

The first snapshot a machine takes when it moves off 0.0.48 (`statev2.pre-migration-u055-j029.sqlite`
on a machine that was up to date; the numbers depend on the machine) is the only copy from before
the ledger was re-keyed to projects. The cap deletes it at the third later update that migrates, so
copy it somewhere else if you want to keep it. The older `statev2.pre-j5-031.sqlite` and
`statev2.pre-upstream-renumber.sqlite` files, from earlier builds, are never deleted by the cap;
remove them by hand when you no longer want them.

**A person runs this, from a terminal outside J5 Code. An agent running inside the J5 Code server
being rolled back must not:** step 1 stops that server, which ends the agent partway through and
leaves the database moved aside with nothing in its place. An agent asked to roll back its own
server stops and hands these steps to the person. In an emergency:

1. Stop everything that has the database open: quit the Mac app, and stop the server
   (`systemctl --user stop j5code.service` on Linux,
   `launchctl bootout gui/$(id -u)/codes.jackson.j5code.service` on macOS).
2. Move the newer database aside and copy the snapshot into its place. There can be up to three
   snapshots: `ls -l` shows when each was written, and the one to restore is the one written when
   the build you are leaving first started.

   ```sh
   cd ~/.j5code/userdata
   ls -l statev2.pre-migration-*.sqlite
   snapshot=statev2.pre-migration-u<upstream>-j<j5>.sqlite
   aside=../db-aside-$(date +%Y%m%d-%H%M%S)
   test -f "$snapshot" && mkdir "$aside" &&
     mv statev2.sqlite "$aside"/ &&
     { [ ! -e statev2.sqlite-wal ] || mv statev2.sqlite-wal "$aside"/; } &&
     { [ ! -e statev2.sqlite-shm ] || mv statev2.sqlite-shm "$aside"/; } &&
     cp "$snapshot" statev2.sqlite &&
     echo "Restored $snapshot. The newer database is in $aside."
   ```

   It stops at the first step that fails, and has worked only if it prints the last line. The
   snapshot is copied, not moved, so it is still there to restore again.

3. Install the older build, which starts the server on it: `j5 update <stable> --allow-downgrade`.
   On the Mac, install the stable DMG. Do not open the nightly app to change its Update track: it
   would start on the restored database and migrate it again before it downgrades.

Restore before the older build starts, in that order: an older build must never run against the
newer database. If the nightly starts again first, it copies and migrates again, which costs only
the time to repeat step 2.

## What the workflows do

`J5 Release` publishes one GitHub Release, tagged `v<version>` at the build's commit, containing:

- the signed and notarized Apple Silicon DMG and ZIP, with their blockmaps and the update feed for
  the channel: `latest-mac.yml` for a stable release, `nightly-mac.yml` for a nightly, and none
  for a preview, which no install updates to;
- self-contained CLI archives `t3-<version>-darwin-arm64.tar.gz` (Developer ID signed and notarized)
  and `t3-<version>-linux-x64.tar.gz`, built and smoke-tested in the release run from the same
  commit. The executable embeds a newer Node than the one tests run on, so the run also runs the
  database startup tests on that Node;
- `install.sh` and `SHA256SUMS` over the archives and the installer.

Run by hand with a build's run ID, its resolve job reads the version from the build commit's four
manifests, which must agree. Called by `J5 Nightly`, it is given the commit and the version, stamps
the version before building the CLI archives, and publishes the desktop build made earlier in the
same run. A run by hand publishes only a stable or preview version and refuses a nightly one,
whatever the branch commits: a nightly comes only from `J5 Nightly`, and a call publishes nothing
else. The version must be at least 0.0.44 (0.0.43 and earlier were npm releases). If a release for that
version already exists at a different commit, the run fails: bump the version and build again. If
it is already published from the same commit with `SHA256SUMS` attached, the run does nothing. The
workflow uses GitHub-hosted runners and does not deploy relay or Vercel services.

The install one-liner (`https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh`),
`j5 update`, the background service, and desktop SSH remote launch all download from these releases.
J5 no longer publishes to npm. The CLI executable is `j5`; its workspace name remains `t3` to preserve
upstream task references and Effect service identifiers. The archive's program is `j5`, with a `t3`
link beside it so a server from before the rename can run the update check that tells it to use
`j5 update`.

`J5 Signed macOS Build` builds an Apple Silicon DMG and ZIP on a GitHub-hosted macOS runner,
signs with Developer ID, and notarizes the app. It verifies the mounted app's identity (J5 Code, or
J5 Code (Nightly) for a nightly version), signature, notarization ticket, and Gatekeeper assessment
before uploading artifacts for 30 days. It does not create a GitHub Release. Run by hand it builds
the branch it was started on at the version that branch commits; `J5 Nightly` calls it with a
commit and a version to stamp. The workflow uses the Apple signing secrets and
`APPLE_TEAM_ID` repository variable; it converts the P12 export to a Keychain-compatible format.
Clerk passkey provisioning is only required when Clerk/passkey configuration is supplied.

- `J5 CI` runs formatting, lint, typecheck, and unit-test gates on every PR, and on
  pushes to `j5/main`, `j5/release-<version>`, and `j5/preview-<x.y.z>-<n>`.
- `J5 Weekly Full Build` runs Mondays at 08:23 UTC and on manual dispatch. It runs the full suite,
  full build, produces the ad-hoc signed Apple Silicon DMG/ZIP, verifies the mounted app, and uploads
  the artifacts for 30 days.
