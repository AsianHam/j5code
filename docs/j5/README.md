# J5 documentation

Everything about J5 Code — the product built on this fork of T3 Code — lives under `docs/j5/`. Upstream's own documentation (`docs/user/`, `docs/internals/`, `docs/operations/`) is left as upstream wrote it; J5 never edits it.

Every document here is one of four kinds, and the kind tells you how far to trust it: **definitions** describe the product and are kept true; **records** say what happened on a day; **runbooks** tell an operator what to do; **process** docs are the rules for working in this repository. Plans, research, and build status live in GitHub issues and pull requests, not here. The kinds, their lifetimes, the identifier scheme, and the rules for changing a definition are in [how the docs are organized](process/docs.md) — read it before writing anything here.

## Reading order for newcomers

Agents changing the code: read the [J5 overview](product/overview.md) and [J5 and upstream](product/upstream.md) first. Together they say what J5 owns, what stays T3 Code's, and when to stop and ask.

1. [Problems and goals](product/problems.md) — what hurts and what is wanted, in Jackson's voice.
2. [Fleet vision](product/fleet-vision.md) — why this exists: the operating model and the thesis.
3. [Principles](product/principles.md) — the beliefs, lenses and principles that turn the problems into product.
4. [Use cases](product/use-cases.md) — the concrete fleets every feature is tested against.
5. [Glossary](product/glossary.md) — the vocabulary; every name in these docs resolves here.
6. [Agent-to-agent communication](product/a2a/index.md) — the definition everything else stands on.
7. The rest of [`product/features/`](product/features/) — the feature definitions of record.

## Contents

- **`product/`** — definitions: the [overview](product/overview.md) and [J5 and upstream](product/upstream.md), the core documents above, the [A2A trio](product/a2a/) (the communication protocol, the upstream substrate, the agent tool contracts), and [`features/`](product/features/) (inbox, thread rendering, archive flow, Roles, Crews, Memos, Playbooks, Spawning Guide, sidebar and roster, Shared server).
- **`worklog/`** — records, named date-first: design sessions and rulings, the tickets and reviews of the A2A build and the dogfood queue, how the fork was set up, the phase-3 friction list.
- **`runbooks/`** — operating the software: the [dogfood runtime](runbooks/dogfood-runtime.md), [agent migration](runbooks/agent-migration.md), [macOS packaging](runbooks/macos-packaging.md), [machine senders](runbooks/machine-senders.md), [peering](runbooks/peering.md), [the persona library](runbooks/persona-library.md), [mobile distribution](runbooks/mobile-distribution.md).
- **`user/`** — user guides for J5's features ([personas](user/personas.md), [playbooks](user/playbooks.md), [skills](user/skills.md), [artifacts](user/artifacts.md), [agent messages](user/j5-peer-messages.md), [peering](user/j5-peering.md), [migrating to release archives](user/migrating-to-release-archives.md)), linked from the [docs index](../README.md).
- **`process/`** — rules for working in this repository: [how the docs are organized](process/docs.md), [working in the repo](process/working-in-the-repo.md), [merging upstream](process/upstream-merge.md), and [pull requests](process/pull-requests.md). How the fleet is run day to day is the operator's own practice and lives outside the repository.

Cross-references are relative paths and survive within this tree.
