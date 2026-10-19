---
title: "J5 Code iOS distribution"
kind: runbook
---

# J5 Code iOS distribution

J5 Code builds with the Expo project `@jacksondr5/j5-code`
(`bcb6f6ad-b327-449e-a419-e6455595504c`). The production bundle is
`codes.jackson.j5code`, Apple team `46A73QH3S8`, and App Store Connect app
`6809314460`. These are fork-owned destinations, separate from upstream T3 Code.

## Build and submit

Use Node from `.nvmrc`, pnpm `11.10.0`, and EAS CLI `23.2.0`. Install repository
dependencies, then run from `apps/mobile`:

```sh
eas build --platform ios --profile j5-testflight
eas submit --platform ios --profile j5-testflight --id <successful-build-id>
```

The store build includes the share extension and widgets. EAS holds its Apple
distribution certificate and a separate provisioning profile for each target.
Submission uploads the binary to App Store Connect for TestFlight processing;
it does not publish an App Store release. App Store Connect still needs an
internal testing group with the intended account added before TestFlight can
install the build.

`J5 iOS Build` is a manual GitHub workflow on GitHub-hosted Ubuntu. It consumes
the repository secret `J5_EXPO_TOKEN`, belonging to the Expo robot
`j5-github-actions`. Select **submit** to upload a successful build for
TestFlight; otherwise it only builds. The CLI logs report EAS build and
submission links. The workflow becomes dispatchable after it exists on the
repository's default branch. Apple submission credentials must already be
stored in EAS before using its non-interactive submission option.

The inherited Release workflow remains disabled in GitHub. The inherited
mobile preview workflow uses a different secret and is not the J5 build path.
This workflow does not require Blacksmith runners.

## Signing maintenance

All three bundle identifiers belong to app group `group.codes.jackson.j5code`:

| Bundle                         | Additional enabled capabilities                            |
| ------------------------------ | ---------------------------------------------------------- |
| `codes.jackson.j5code`         | Associated Domains, Push Notifications, Sign in with Apple |
| `codes.jackson.j5code.sharing` | None                                                       |
| `codes.jackson.j5code.widgets` | Push Notifications                                         |

Manage signing with `eas credentials --platform ios`. Keep Apple private keys,
distribution private keys, and tokens outside the repository. Adding an
entitlement requires updating the matching Apple identifier and regenerating
its profile before a non-interactive build can succeed.

During initial setup, Apple's API rejected EAS's batch capability update.
Capabilities and app-group assignments were configured in the Developer
portal, then the interactive EAS setup used `EXPO_NO_CAPABILITY_SYNC=1`.
That override is only appropriate after checking the portal assignments; it
does not grant missing entitlements.

If a newly installed Xcode blocks Git with a license prompt, complete Xcode's
first launch. For cloud-only work, `DEVELOPER_DIR=/Library/Developer/CommandLineTools`
can select already-installed Command Line Tools for that command without
changing the machine's global Xcode selection.

## Scope

EAS Update remains disabled. No J5 relay, Clerk, or push delivery service is
configured by this distribution setup. Direct server pairing is the initial
connection path. Mobile feature parity is tracked in J5 issue #40; remote
inbox routing is tracked separately in #105. A signed build is not
evidence that those feature gaps are resolved.

Desktop distribution uses the existing manual `J5 Weekly Full Build` workflow
or the [local macOS packaging procedure](macos-packaging.md).
