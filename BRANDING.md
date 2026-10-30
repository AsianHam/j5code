# J5 Code branding boundary

J5 Code keeps upstream's internal names stable and owns only the identifiers that people,
operating systems, installers, and deep-link dispatchers use. Recheck this inventory after every
upstream pin advance.

## Canonical identity

Fork-owned values live in `scripts/lib/j5-branding.ts`:

| Surface                     | Production                                                                                                                                                        | Development / preview                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Display name                | `J5 Code`                                                                                                                                                         | `J5 Code (Dev)`, `J5 Code (Nightly)`, `J5 Code Preview`                                                     |
| Desktop / mobile app ID     | `codes.jackson.j5code`                                                                                                                                            | `.dev` and `.preview` suffixes                                                                              |
| URL scheme                  | `j5code`                                                                                                                                                          | `j5code-dev`, `j5code-preview`                                                                              |
| Default desktop state       | `~/.j5code/userdata`                                                                                                                                              | `~/.j5code/dev`                                                                                             |
| Default server state        | `~/.j5code/userdata`                                                                                                                                              | `~/.j5code/dev`                                                                                             |
| Desktop App Support         | `j5code`                                                                                                                                                          | `j5code-dev`                                                                                                |
| Linux executable / WM class | `j5code`                                                                                                                                                          | `j5code-dev`                                                                                                |
| Desktop artifact prefix     | `J5-Code-`                                                                                                                                                        | same                                                                                                        |
| CLI command on PATH         | `j5` (`J5_BRANDING.cli.command`; web `CLI_COMMAND` reads it for WelcomeWizard connect/pair/serve and pairing copy; `packageName` is the historical npm name only) | symlink `~/.local/bin/j5` → `<home>/runtime/versions/<v>/j5`; the desktop app's launcher is `<home>/bin/j5` |
| Background service          | `j5code.service` (systemd), `codes.jackson.j5code.service` (launchd)                                                                                              | same                                                                                                        |
| CLI release repository      | `Jacksondr5/j5code`                                                                                                                                               | archives `t3-<v>-<platform>.tar.gz`, `SHA256SUMS`, `install.sh`                                             |

The macOS development launcher adds a checkout-derived suffix to the development bundle ID so
multiple J5 checkouts can coexist. Production remains exactly `codes.jackson.j5code`.

## Pin-advance audit sites

- Home resolution: `apps/server/src/cli/config.ts`, `app.ts`, `pair.ts`, `theme.ts`, `triage.ts`,
  `browser.ts`, `trace.ts`, `cloud/bootService.ts`, `serviceLauncher.ts`,
  `packages/shared/src/devHome.ts`, and `scripts/dev-runner.ts`. Explicit CLI home outranks worktree isolation; worktree dev
  state outranks an ambient home. Pairing must target the same resolved state. The dev runner's
  first-start seed reads `~/.j5code/userdata/statev2.sqlite` and runs only when asked (FORK.md case 83).
- SSH runner homes: `packages/ssh/src/tunnel.ts` uses `~/.j5code` for both release-archive runtimes (under
  `~/.j5code/runtime/versions`) and node-script runners; `~/.t3/ssh-launch` remains transport bookkeeping.
  The device tools' state on a remote simulator host also keeps upstream's path, `~/.t3/device`
  (`apps/server/src/device/sshDeviceScript.ts`).
- Release archives and installers (FORK.md case 40): `packages/shared/src/cliRelease.ts`
  (`CLI_RELEASE_REPOSITORY`), `scripts/install.sh`, `scripts/install.ps1` (whose GitHub requests
  send the User-Agent `j5-install`, where upstream's send `t3-install`), and
  `scripts/smoke-cli-archive.ts` (scratch `J5CODE_HOME`). Update everything
  (`apps/web/src/components/sidebar/useUpdateEverything.ts`) checks J5's GitHub release through
  `apps/web/src/j5/updates/releasePublished.ts` and says "J5 Code <version> is not released yet";
  `updateEverythingRun.tsx` names the app with `APP_BASE_NAME`.
- One server per home (FORK.md cases 25 and 84): the one-owner messages in `apps/server/src/serverOwnership.ts`,
  `serviceLauncher.ts`, the desktop dialog in `apps/desktop/src/backend/DesktopBackendPool.ts` and
  the WSL refusal in `apps/desktop/src/wsl/DesktopWslBackend.ts` say J5 Code, J5 home and
  `J5CODE_HOME`. The message for a home whose background service predates the lock
  (`OlderBootServiceError`, and the same advice in both desktop dialogs) names `j5` and J5's
  installer where upstream's names `t3` and `npx t3@latest`, and the version it compares with is
  J5's (`J5_FIRST_OWNERSHIP_LOCK_VERSION`).
- Agent systemd units (FORK.md case 25): `apps/server/src/process/agentScope.ts` names the slices
  `app-j5code-agents.slice` and `app-j5code-agents-<hash>.slice` and the scopes
  `j5code-<name>-<id>.scope`, so J5's agents never share a slice with an installed T3 Code's, and
  the cleanup of an agent's leftover units stops `j5code-` scopes.
- Background service and CLI copy (FORK.md case 41): `apps/server/src/cloud/bootService.ts` and
  `cloud/j5/legacyBootService.ts` (service names), and `apps/server/src/cli/update.ts`, `uninstall.ts`,
  `updateProgress.ts`, and `service.ts` (`j5` strings, cgroup `/j5code.service`, `j5.cmd`). The
  recovery steps in `cloud/servicePreflight.ts` name `j5`, the release's `install.sh` on
  `Jacksondr5/j5code` and `~/.local/bin/j5`; `cloud/ConnectReachability.ts` and
  `cloud/CliTokenManager.ts` (with its test) say `j5 connect`; `cli/doctor.ts` names the database
  from before J5's first archive release, 0.0.44, where upstream's says 0.1.0, and "a J5 Code
  version"; and `cli/managedChatGptToken.ts` says to reconnect in J5 Code.
- The command's name where the server looks it up or prints it: `apps/server/src/binCli.ts` (the
  root command and its help path), `cli/invocation.ts` (`isCommandAvailable("j5")` and the
  command it renders), `cli/browser.ts` (`j5 browser setup`), `cloud/CloudLink.ts`
  (`j5 connect link`), and `packages/client-runtime/src/preview/serverBrowserStream.ts`
  (`sudo j5 browser setup`).
- Triage (`j5 triage`): `apps/server/src/cli/triagePrompt.ts` and its byte-identical repo copy
  `.github/triage/PLAYBOOK.md` name J5 Code, clone and search `Jacksondr5/j5code`, refresh the
  playbook from `j5/main`, and file issues there with the `via-triage` template and label
  (`.github/ISSUE_TEMPLATE/via-triage.yml`). They say nothing of `npx`, since J5 publishes no npm
  package. Upstream's copies point at `pingdotgg/t3code` and
  `main`; re-apply after an advance that touches them.
- Security policy: `.github/SECURITY.md` is deleted. Upstream's file sends reports to T3 Tools'
  address, and J5 has no private reporting channel yet. Keep it deleted when an advance changes it.
- Desktop runtime identity and state: `DesktopEnvironment.ts`, `DesktopStatePaths.ts`,
  `DesktopEarlyElectronStartup.ts`, `DesktopAppIdentity.ts`, `DesktopUserData.ts` (profile names;
  never a T3 profile), `wsl/DesktopWslEnvironment.ts` (`~/.j5code/wsl-runtime`), the user-visible
  app name in `permissions/MacPermissionHelper.ts`, and `apps/desktop/src/compileCache.ts` (a
  `j5code` compile-cache directory). `DesktopAppIdentity.ts` sets Electron's app name to the
  display name without its parentheses ("J5 Code", "J5 Code Nightly"), where upstream joins base
  name and stage, which would give "J5 Code Beta".
- Desktop CLI launcher and its Settings install (FORK.md case 57): `DesktopCliShim.ts` (the file name
  `j5` / `j5.cmd`, the `MARKER` line, the exported `J5CODE_HOME`), `DesktopCliCommand.ts` (link
  names and messages), and `apps/web/src/components/settings/CliCommandSettingsRow.tsx` (copy).
  Upstream's files say `t3` and `T3CODE_HOME`; re-apply after an advance that touches them.
- Desktop OS integration: `electron-launcher.mjs`, `ElectronProtocol.ts`,
  `DesktopLinuxUrlHandler.ts`, and the server renderer-origin allowlist, `DESKTOP_RENDERER_ORIGINS`
  in `apps/server/src/httpCors.ts`.
- Linux capture: `apps/desktop/src/snapShot/{KdeSnapShot,HyprlandSnapShot,GnomeCaptureSetup,linuxCaptureSession}.ts` and `apps/desktop/gnome-extension/`. The GNOME extension accepts capture requests only from J5's own bus names (`j5code.SnapShot`, `j5code-dev.SnapShot`, from the Linux app id). The rest still use upstream helper directories, desktop/extension identities and bus names, so they can collide with an installed T3 Code. J5 ships no Linux desktop build, so they are not isolated.
- Desktop packaging: `apps/desktop/package.json`, `scripts/build-desktop-artifact.ts` (including
  the generated package's `homepage`, `https://j5.codes`, and the macOS usage strings such as
  `NSLocalNetworkUsageDescription`), and both DMG background SVGs.
- Prompt links (FORK.md case 76): `packages/shared/src/promptLinks.ts` (`APP_SCHEME` and
  `promptLinkDeepLink`'s default scheme are `j5code`, no https origin is J5's hosted app by
  default, and its errors name J5 Code); "Copy prompt link" on web
  (`components/promptLinks/copyPromptLink.ts`) and mobile
  (`features/prompt-links/prompt-link-actions.ts`) copies a `j5code://` link; the prompt-link
  views `NewThreadLinkView.tsx`, `linkedPrompt.ts` and `HostedPromptLinkLanding.tsx` (whose
  download link is `https://j5.codes/download`) name J5 Code.
- App icons: each channel's Icon Composer `text.svg` under `assets/` is a paper boat from the
  marketing site (`BoatSprite.astro`, `PersonaScene.astro`): production the Captain, dev a
  speedboat, nightly the Reviewer's sloop with its searchlight. Each is flattened to plain
  `<path>` elements and fitted around 64,64 inside the 90×75pt box that
  `scripts/export-android-icons.ts` uses (`TEXT`), because that script lifts those paths for
  each channel's Android foreground (`android-icon-foreground-<variant>.png`, wired in
  `apps/mobile/app.config.ts`; upstream shares one foreground). Dev keeps upstream's blueprint,
  with `annotations.svg` redrawn around the speedboat, and nightly keeps upstream's night sky.
  Production adds a `background.svg` layer, the site hero's navy with its sea glow and contour
  lines, which the Android script also renders as `android-icon-background-prod.png` for the
  release adaptive icon. Generated files keep upstream's names (`black-*`, `t3-black-*`).
  `android-icon-mark.png` and `android-notification-icon.png` are flat Captain silhouettes with
  the deck, mast, star and portholes cut out, rendered once from the Captain layer. If upstream
  redraws its icon sources, keep the J5 layers and re-export (`assets/README.md`). Icon
  Composer 27's "macOS pre-Tahoe" export comes out full-bleed, so the three `*-macos-1024.png`
  files are its plain macOS export at design generation 26, scaled to 824×824 at a 100px inset
  over a black drop shadow (alpha 0.3, 8px down, blur sigma 12) that matches upstream's.
- Mobile OS identity and links: `apps/mobile/app.config.ts`, mobile package scripts, `App.tsx`,
  `src/lib/appLinking.ts` (scheme-only `j5code` wake links), pairing QR handling, the Agent Activity
  widget, and the Android subscription-usage widget, whose strings are in
  `src/widgets/SubscriptionUsage.android.tsx` and `app.config.ts`. Its deep link comes from
  `Linking.createURL` in `SubscriptionUsageCoordinator.tsx`, so it follows the app's scheme.
  The mobile header's `components/CompactBrandTitle.tsx` draws `J5Wordmark` and labels itself
  "J5 Code, …" (as do `WorkspaceRootScreen.tsx` and `PullRequestToolbar.android.tsx`), and
  `ThreadFeed.tsx` says "Sent by J5 Code".
- Mobile developer tooling: `scripts/mobile-native-client.ts` (development bundle id, the
  prebuilt iOS project/scheme/app name, the built iOS artifact's name and the dev-client deep
  link's scheme), `scripts/mobile-showcase.ts` (production app id, scheme
  and iOS project name), and `.agents/skills/test-t3-mobile/scripts/pair-client.sh` (app id and
  link scheme) read `J5_BRANDING.mobile`; `mobileNativeProjectName` mirrors Expo's prebuild
  naming (`J5 Code Dev` → `J5CodeDev`). The skill's `SKILL.md` documents the same app name and
  state paths as prose, so update it by hand when they change.
- Web fallback identity: `apps/web/src/branding.ts` (including `CLI_COMMAND = "j5"`, the
  release-archive PATH command), `versionSkew.ts` `manualServerUpdateCommand` (`j5 update <version>`),
  the `components/ServerUpdateAction.tsx` success copy, the `components/desktopUpdate.logic.ts`
  release repository (`DEFAULT_DESKTOP_RELEASE_REPOSITORY`, `Jacksondr5/j5code`, which upstream made
  configurable at the 2026-10-24 advance) and its Rosetta messages, the pre-React boot shell in
  `apps/web/index.html`, and the fork-owned `apps/web/src/j5/branding/J5Wordmark.tsx` connected at
  the sidebar's small `SidebarChrome.tsx` seam (it takes an optional `className`, so the brand uses
  upstream's `h-[1cap]` sizing), and the assistant author heading in
  `components/chat/TimelineAssistantRows.tsx`, which reads `APP_BASE_NAME` from `branding.ts`
  instead of upstream's literal "T3 Code", as does the "Sent by" label on a message the app wrote
  itself (`TimelineUserMessageRow.tsx`). `TimelineToolActivityIcon.tsx` draws `J5Wordmark` on
  t3-code MCP tool rows. `branding.ts`'s `DESKTOP_DOWNLOAD_URL` is `https://j5.codes/download`;
  `HostedEmptyState.tsx` builds its `j5 connect` and `j5 pair` commands on `CLI_COMMAND`;
  the boot error page in `apps/web/src/lib/bootError.ts` (with `bootError.test.ts`) names J5 Code
  in its six strings, falls back to `j5 triage`, links `https://j5.codes/download` and files bug
  reports on `Jacksondr5/j5code`; the preview shortcut's "Open J5 Code in the desktop app" toast
  is in `apps/web/src/shortcuts/chatRouteCommands.ts` (in `routes/_chat.tsx` until v0.1.3);
  `settings/SavedEnvironmentRows.tsx` says `j5 connect link`; and
  `pullRequest/PullRequestsPage.tsx` asks to update J5 Code servers.
- Shared client copy: `packages/client-runtime` has no branding import, so its user-visible
  strings stay product-neutral instead of naming T3 Code: `connection/compatibility.ts` ("Update the
  server on …"), `connection/outdatedHostUpdate.ts`, `relay/errorPresentation.ts`, and
  `state/pullRequestDiffHttp.ts` ("quit and reopen the app").
- User-visible copy and marks (2026-10-04): every string a person or an agent reads names the
  product "J5 Code" (bare "T3" becomes "J5"), across web, desktop, mobile, the server's CLI and
  error messages, agent instructions and MCP tool titles, native capture helpers, and the
  provider packages (`packages/provider-core`, `provider-pi`, `provider-muse`, `provider-cursor`
  and `provider-opencode`, including the Cursor Keychain message in `accountUsage.ts` and
  OpenCode's server-URL hint in `settings.ts`) and the source-control packages (GitCafe's
  "from J5 Code", and the Forgejo sign-in hint in
  `packages/source-control-forgejo/src/server/ForgejoPullRequestProvider.ts`). Server copy upstream added since the last pin includes `j5 doctor`
  (`cli/doctor.ts`, `persistence/DatabaseMaintenance.ts`), the restart work-log rows
  (`orchestration-v2/RestartContinuation.ts`), the note an agent reads after a restart cut its
  background work (`RestartBackgroundNote.ts`), and in Settings "Open pull requests in J5 Code"
  (`IntegrationsSettings.tsx`, `settingsSearch.ts`, `SettingsPanels.logic.ts`), `scopedSettings.ts`
  and the `j5 connect link` hint in `ConnectionsSettings.tsx`. The 2026-10-24 advance added the
  database error messages in `orchestration-v2/UserFacingErrors.ts`, the in-app browser's
  messages and AppArmor comment (`j5 browser setup`) in `preview/PreviewBrowserHost.ts`, and
  Claude's notice that it "could not confirm Claude bypass permissions", which says J5 in
  `orchestration-v2/Adapters/ClaudeAdapterV2.ts`. Agent-visible MCP
  tool descriptions and errors say "J5 thread", and `request_secret`'s delivery description in
  `packages/contracts/src/orchestratorMcp.ts` says "a J5 tool". Since v0.1.3 the preview tools'
  shared descriptions are in `packages/contracts/src/previewAutomation.ts`; it names no product,
  and its one J5 edit is FORK.md case 74's profile wording, not branding. `THREAD_READ_OBJECT` in
  `apps/web/src/components/chat/MessagesTimeline.logic.ts` (`" a J5 thread"`) must keep matching
  the label in `packages/shared/src/t3McpToolPresentation.ts`.
  The compact mark on t3-code MCP tool rows and the mobile header is `J5Wordmark`
  (`apps/web/src/j5/branding/`, `apps/mobile/src/j5/branding/`). These are literal edits in upstream
  files, so after an advance run
  `git grep -nE "T3 Code|\bT3\b" -- apps packages native` and rebrand new hits that are
  not listed under the unchanged internals below.
- Branch names: `WORKTREE_BRANCH_PREFIX` in `packages/shared/src/git.ts` and the
  `branchNamePrefix` default in `packages/contracts/src/settings.ts` are `j5code`, where upstream's
  are now `t3`, and fork pull requests check out as `j5code/pr-<n>/…` (`GitManager.ts`,
  `BitbucketApi.ts`). Upstream's flat fallback gives `j5code-<hash>` when a branch named `j5code`
  blocks the namespace. The temporary-branch matcher accepts `j5code`, upstream's `t3/<hash>` and
  `t3-<hash>`, and the legacy `t3code` forms, so worktrees created before the rename can be renamed.
- Sign-in return links: `packages/shared/src/providerAuthReturnUrl.ts` and `codexAuthHandoff.ts`
  use the `J5_BRANDING` desktop schemes where upstream hard-codes `t3code` and `t3code-dev`.
  J5 has no hosted client, so upstream's `https://app.t3.codes` return origin is dropped. The
  Codex sign-in pages (`apps/server/src/provider/CodexAuthCallbackPage.ts`, `CodexAuthCallback.ts`,
  `packages/shared/src/codexAuthCallback.ts`) name J5 Code, and the `agent_name_hint` sent in
  ChatGPT sign-in (`CodexChatGptAuth.ts`) is "J5 Code": ChatGPT may show it to the person, so it
  is a branding matter (Jackson's 2026-10-09 ruling).
- Privacy: `PRIVACY_POLICY_URL` in `apps/web/src/legalLinks.ts` is `https://j5.codes/privacy-policy`,
  and the welcome wizard's telemetry sentence names J5 Code (`WelcomeWizard.tsx`).
- Things J5 writes into a person's repository or folders: the stack-rebase committer in
  `apps/server/src/pullRequest/githubStackRebase.ts` ("J5 Code" `<noreply@j5.codes>`, confirmed by the
  maintainer) and the readme
  line in `apps/server/src/project/ManagedProjectFolders.ts` ("Created in J5 Code").
- New upstream files: the list above names only known sites. On every advance, also grep the files
  upstream added since the old pin for `t3code`, `T3 Code`, `.t3`, `T3CODE_HOME`, `pingdotgg`,
  `t3.codes/install`, and `npx t3`, then rebrand identity sites and user-visible copy, and leave the
  deliberate internals below unchanged.

## Deliberately unchanged upstream internals

- The `T3CODE_*` environment variables other than the base-directory override, which is `J5CODE_HOME`. An ambient `T3CODE_HOME` is ignored, and a linked worktree's dev state lives in `<worktree>/.j5code`, so J5 never shares state with an installed T3 Code (FORK.md case 25).
- Internal workspace/package names such as `@t3tools/*`, `t3`, and upstream lint rule names. The
  release archive keeps its `t3-<version>-<platform>` file name (its executable is `j5`, FORK.md
  case 50); the installer's other environment names (`T3CODE_CHANNEL`, `T3CODE_VERSION`,
  `T3CODE_INSTALL_BIN_DIR`, `T3CODE_RELEASE_BASE_URL`), `T3CODE_CLI_PATH`, the
  `T3_BOOT_SERVICE_UNIT` key, and the `__service-launcher` subcommand stay upstream's.
- Database schema names, storage keys, internal CLI flags, and code identifiers, including the
  `"t3code"` message attribution value (`packages/client-runtime/src/userMessage.ts`), the
  `application/x-t3code-*` drag types, the desktop's `--t3code-preview-passkey-bridge` argument and
  `t3codeWebAuthn` field, and the `app.t3.context-fragment` clipboard type.
- The GitHub and GitCafe API `user-agent: t3code` headers.
- Documentation, including `docs/user/`: it keeps upstream's "T3 Code" wording, which marks what
  is upstream's and what is J5's for the agents that read it. Facts that J5 changes (paths, names,
  defaults, the `j5` command) are still corrected there, in `t3-connect-troubleshooting.md` too
  since upstream added it at the 2026-10-24 advance, until
  [#494](https://github.com/Jacksondr5/j5code/issues/494) settles whether J5 edits upstream's user docs.
- "T3 Connect" and "T3 Account": upstream's hosted relay and sign-in, named as upstream names
  them wherever they appear, along with `infra/relay` and the mobile legal links to `t3.codes`.
- The `t3-code` MCP server key, its `T3 Code` MCP server `name` (`McpHttpServer.ts`), the Codex
  client info ("T3 Code", `CODEX_CLIENT_NAME` in `apps/server/src/provider/CodexProvider.ts`),
  and the Muse client info (`t3_code` / "T3 Code", `packages/provider-muse`): protocol identity
  that tool names, aliases (`t3McpToolPresentation.ts`) and recorded provider fixtures depend on.
- Telemetry service names (`t3code-server`, `t3code-desktop`, `t3code-mobile`).
- Strings inside native modules under `apps/mobile/modules/` (for example "T3 Code" in the
  composer editor's Kotlin). J5 adds no native code (FORK.md, mobile seams), so they are left
  as upstream's.
- Linux packaging metadata, which J5 doesn't build: the `.deb` identity strings in
  `scripts/build-desktop-artifact.ts` (maintainer, description, `/usr/share/doc/t3code`) and
  `apps/desktop/resources/linux/com.t3tools.t3code.metainfo.xml`.
- Upstream's `thread` command (`apps/server/src/cli/thread.ts`), which J5 does not register (FORK.md
  case 82), so its copy is never shown.
- Upstream's leftovers J5 has no use for: `resolveServerInstallation` in `cli/invocation.ts` still
  looks for an npm-global `t3` package, which never matches a J5 install; the AppArmor profile
  path keeps its `t3-` name (`preview/PreviewBrowserHost.ts`); and
  `apps/desktop/src/app/DesktopLegacyLocalStorage.ts` names T3 Code's V1 profile folders
  (FORK.md case 25).
- `apps/web/src/components/settings/MobileAppSettingsRow.tsx` still holds T3 Code's App Store and
  Google Play links; J5 hides the row (FORK.md case 77).
- Upstream's npm launcher, which J5 doesn't publish (`scripts/npm-launcher/`,
  `scripts/build-npm-launcher.ts`), and its Play Store APK mirror (`.github/scripts/mirror-play-apk.cjs`).
- The SSH tunnel's "Remote T3 server" message in `packages/ssh/src/tunnel.ts`, which belongs to the
  remote launch path that still uses `~/.t3/ssh-launch` (#339).
- `t3.json`, its schema URL, the `refs/t3code/*` hidden refs, upstream's `README.md`,
  `packaging/aur`, the Linux capture helper identities, the iOS widget's `T3Mark` image
  asset, and developer scripts under `scripts/` and `apps/server/scripts/`.

## Cloud and update posture

- Desktop publishing is configured only when `T3CODE_DESKTOP_UPDATE_REPOSITORY` or
  `GITHUB_REPOSITORY` is supplied; the fork does not hard-code an upstream update repository.
- Mobile Expo updates are disabled until Jackson configures J5-owned update infrastructure.
- Mobile builds use the J5-owned Expo project `@jacksondr5/j5-code`, defined in
  `scripts/lib/j5-branding.ts`; `apps/mobile/app.config.ts` takes its owner from there, where
  upstream's names `pingdotgg`. `apps/mobile/eas.json` targets Apple team `46A73QH3S8`
  and App Store Connect app `6809314460`; preserve these fork destinations during pin advances.
  See [iOS distribution](docs/j5/runbooks/mobile-distribution.md).
- Clerk and relay remain optional and use the upstream `T3CODE_*` / `EXPO_PUBLIC_*`
  configuration names. No J5 relay or sign-in endpoints are provisioned by the build setup.
- Product usage telemetry reports to J5's own PostHog project (US region): the default
  `T3CODE_POSTHOG_KEY` in `apps/server/src/telemetry/AnalyticsService.ts` is J5's project token,
  not upstream's, and the default `T3CODE_POSTHOG_HOST` is PostHog's US host, `https://us.i.posthog.com`,
  where upstream's is its own relay, `https://ingest.t3.codes` (FORK.md case 86; a test pins it). Events,
  identifiers and the `T3CODE_TELEMETRY_ENABLED=false` opt-out are upstream's, unchanged. J5's release
  workflows stamp each build's `T3CODE_TELEMETRY_CHANNEL`, which upstream's set only in its own
  repository. Keep J5's token and host when an upstream advance touches those defaults.
  Dev servers started by `scripts/dev-runner.ts` send nothing unless started with
  `T3CODE_TELEMETRY_ENABLED=true` (upstream's default since v0.1.3), and then report to a second
  project, "J5 Code Dev" (`scripts/lib/j5-dev-telemetry.ts`).

## 2026-09-06 verification boundary

The pin advance rechecked identity/configuration with focused tests and exercised web/server
home isolation in disposable state. Subsequently, the [weekly full build](https://github.com/Jacksondr5/j5code/actions/runs/34064485547)
at source `f8ba1a653f986835d3e5d0584648cc686f16ceb6` built the Apple Silicon desktop
artifact, mounted its DMG read-only, and verified `J5 Code`, `codes.jackson.j5code`, and its
strict ad-hoc signature. That proves packaged identity and signing at that source, not desktop
interaction or packaged-app execution. Mobile native builds/interaction and second-machine,
relay or tunnel acceptance were not performed in this advance. The older native check below
is historical evidence.

## 2026-08-15 empirical isolation check

Installed T3 Code (Alpha) and J5 Code (Dev) ran concurrently on macOS:

| App             | Bundle ID                         | Runtime state    | App Support                  |
| --------------- | --------------------------------- | ---------------- | ---------------------------- |
| T3 Code (Alpha) | `com.t3tools.t3code`              | `~/.t3/userdata` | `t3code` / `T3 Code (Alpha)` |
| J5 Code (Dev)   | `codes.jackson.j5code.dev.j5code` | `~/.j5code/dev`  | `j5code-dev`                 |

The J5 backend logged `~/.j5code/dev/logs`, created `~/.j5code/dev/state.sqlite`, registered the
`j5code-dev` renderer scheme, and listened on its test-only port while T3 remained on its existing
paths. The generated J5 test state was moved intact to `/tmp/j5code-t3-verify.ZuaG9H` after shutdown.
