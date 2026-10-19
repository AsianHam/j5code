# J5 Code

Steer fleets of agents, not just a few chats.

J5 Code is a tracking fork of [T3 Code](https://t3.codes). Everything T3 Code does, J5 Code does: six agent harnesses on your own subscriptions, desktop, web and mobile clients, remote control over your tailnet, a checkpoint on every turn, and the one-button PR. J5 adds a layer above it for running agents in groups:

- **Agent-to-agent messaging.** Agents message each other to get work done, through the same platform that manages them.
- **Personas.** Pick the right model for the job, give it a personality, and share it with your team.
- **Playbooks.** Keep agents on track during long-running work, and see how the work is going at a glance.
- **Crews.** Spawn a group of agents with a single goal and talk to its Captain.
- **Inbox.** Agents send you messages when they need you; reply from one place.
- **Fleet page.** See what all your agents are doing, including the stalled and stuck ones.

It is early software, in daily use by its author. Expect rough edges. It is free and MIT licensed, like T3 Code, and it installs alongside T3 Code without sharing its app, data, or server. [FORK.md](./FORK.md) explains how the fork stays in sync with upstream.

More at [j5.codes](https://j5.codes). Want normal T3 Code? It is excellent: [t3.codes](https://t3.codes).

## Installation

J5 Code drives the coding agents already set up on your machine. Install and sign in to at least one before you start a thread:

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Enable it in Settings, then use **Install Antigravity** and **Sign in with Google**.         |

### Command line

A self-contained server for macOS (Apple silicon) and Linux x64. No Node.js or npm is needed:

```bash
curl -fsSL https://j5.codes/install.sh | sh
```

Then run `j5` to start the server and open the web app. `j5 service install` keeps it running in the background, `j5 update` moves to a newer release, and `j5 --help` has the full reference. Data lives in `~/.j5code` (override with `J5CODE_HOME`).

Intel Macs, Linux on ARM, and Windows have no build yet. The [install guide](./docs/user/install.md#other-platforms) covers running a server from source there.

### Desktop app

Download the macOS (Apple silicon) app from [j5.codes/download](https://j5.codes/download) or [GitHub Releases](https://github.com/Jacksondr5/j5code/releases). It is the only desktop build today. `winget`, Homebrew, and AUR packages named T3 Code install upstream T3 Code, not J5 Code.

### Mobile app

There is no public J5 Code mobile app yet. iOS builds go to TestFlight testers; the [mobile README](./apps/mobile/README.md) covers building your own.

## Documentation

For using J5 Code:

- [Install and first run](./docs/user/install.md)
- [Working with threads](./docs/user/thread-sidebar.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Running as a background service](./docs/user/background-service.md)
- [Updating](./docs/user/updating.md)
- [Personas](./docs/j5/user/personas.md), [playbooks](./docs/j5/user/playbooks.md), and [messages between agents](./docs/j5/user/j5-peer-messages.md)
- [Everything else](./docs/user), one page per feature

These guides are mostly upstream's and say "T3 Code"; they apply to J5 Code unless they say otherwise.

For understanding J5:

- [J5 documentation](./docs/j5/README.md): where everything is, and a reading order
- [Overview](./docs/j5/product/overview.md): what J5 adds to T3 Code
- [Glossary](./docs/j5/product/glossary.md): Crew, Captain, Exchange, and the rest
- [Feature definitions](./docs/j5/product/features): each feature, with acceptance criteria
- [J5 and upstream](./docs/j5/product/upstream.md): where J5 differs from T3 Code, and why

Found a bug or want a feature? [Open an issue](https://github.com/Jacksondr5/j5code/issues/new/choose).

## Local development

### Install `vp`

J5 Code uses Vite+, so you need its global `vp` command-line tool and Node 24.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```bash
irm https://vite.plus/ps1 | iex
```

See the [Vite+ getting started guide](https://viteplus.dev/guide/) for more.

### Run it

```bash
vp i
vp run dev
```

Open the pairing URL the dev runner prints; the bare origin does not sign in a new browser. `vp run dev:desktop` starts the Electron client instead. The [development guide](./docs/operations/development.md) has the rest: flags, ports, state directories, and sharing a dev server.

### Before you change anything

- [AGENTS.md](./AGENTS.md): how the repository works and what to watch for. Coding agents load it automatically.
- [Working in the repo](./docs/j5/process/working-in-the-repo.md) and [pull requests](./docs/j5/process/pull-requests.md).
- [FORK.md](./FORK.md): which files are upstream's, and how J5 edits them.
- [CONTRIBUTING.md](./CONTRIBUTING.md).
