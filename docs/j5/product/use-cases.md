---
title: "Use cases — the concrete fleets J5 Code must serve"
kind: definition
---

# Use cases

This is the library behind the use-cases lens in [the principles](principles.md): run every feature through each use case here. A design that only serves one of them is suspect — the platform builds primitives, and a primitive proves itself by serving fleets that look nothing alike. These are the use cases of record today; more will be added as they become real.

Both use cases are live prior art, not aspirations: rough versions of each already run (see [fleet-vision](fleet-vision.md)), which is what makes them useful stress tests — they come with observed failure modes, not imagined ones.

## 1. Agentic software development

One person runs many long-lived agents that build code, open PRs, and carry them to merge. The canonical unit is the **PR Group**: a Crew of three Roles — a Builder who writes and tests the code, a Reviewer who reviews independently and responds to human/agent review comments in the PR thread, and a Sitter who monitors the PR, communicates outside the group, and triages CI. Captains run several such Crews in parallel; the human sets direction, makes the calls that bubble up, and watches a dozen open PRs at a time.

What this use case demands of the platform: Crews spawned from definitions and worked with high independence; A2A Exchanges so groups coordinate without the human relaying; PR visibility measured from GitHub, never recalled by agents; Playbooks so long multi-step flows (build → review → babysit → merge) survive context decay; the inbox for the asks that genuinely need the person; the Fleet page for "why isn't this PR moving."

Characteristic load: mostly Background agents; work enters from humans _and_ from machine events (CI results, review comments); the scarce resource is the human's attention across many parallel work streams. Critically, however, the Captain is usually a Foreground agent that understands the build targets for its Crews, and may coordinate between them and other agents and the person.

## 2. Production monitoring

A fleet that watches production software using observability data (Dynatrace today). Scraping code runs on a schedule, applies heuristics, and flags anomalies worth an AI's attention; a triage agent investigates, discards false positives, and routes real problems; a Director agent serves as the human's point of contact and spawns Incident Commanders per incident; standing Captains run longer-term programs (logging improvement, cost control, cleanup) with their own Crews. The structure is a long-lived organization, not a task execution — Captains and their Crews persist for weeks.

What this use case demands of the platform: durable schedules and machine triggers as first-class work sources (`trigger.fired` roots — no human prompt starts the chain); typed silence and the stall report, because almost every agent is Background and nobody watches their chats; deep hierarchy with attention that aggregates upward; cost visibility (one Captain exists specifically to stay in budget); supporting stores (the scraper, the incident DB) living _outside_ the platform.

This use case is the standing test from the fleet vision: **"does this work for the monitoring fleet, or only for coding fleets?"** Any feature that quietly assumes code, repos, or PRs fails it.

### 2a. L2 support — the shared-server chapter (elevated)

A chapter of the monitoring story that brings enough differentiating requirements to stand on its own: a level-2 support team shares its agents, so when one person goes off shift the next picks them up immediately — **no context transfer**. It also puts **two humans in front of the same agent**: today developers relay agent output to each other over Slack/Teams; putting both people in the same conversation removes the relay entirely.

What it demands beyond monitoring: everything in [Shared server](features/shared-server.md) — the multi-person invariant, person-scoped surfaces, and asks to one person or to everyone who can answer. It is the reason multi-person constraints bind _today_ even though the capability ships later.

## History

- 2026-08-23 — written as the library behind the use-cases lens.
- 2026-09-10 — vocabulary aligned with the glossary (Crews, the Fleet page, person); content unchanged.
