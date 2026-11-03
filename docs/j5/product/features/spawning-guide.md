---
title: "Spawning Guide"
kind: definition
---

# Spawning Guide

## Problem

Every Peer Agent spawn is an explicit choice of provider, model and, where the model has one, reasoning — the platform never inherits the spawner's setup, because inheriting is wrong more often than right — and an explicit choice needs somewhere to learn from. The prior-art fleet ran on exactly such a guide: it was the operation's main cost instrument, updated mid-program from observed need, and its one recorded failure was silence — a spawner had to pick a tier the guide did not cover, and the retrospective judged the gap itself worth a line. Agents that spawn agents also write briefs, and a bad brief is the most expensive mistake a spawner can make ([problems](../problems.md): what is this fleet costing me; large unsupervised groups).

## Definition

The **Spawning Guide** is a user-authored document consulted at the moment of spawning. The platform ships the mechanism and the facts; the user ships the judgment.

- The guide is markdown that lives with the Role library, under the same rules as a Role: a file, portable and shareable, git optional, edited in the app. One guide per library.
- The platform's layer is factual: the catalog of providers, models and reasoning levels — ids, labels, options, cost tiers where known — is platform truth. The guide never restates the catalog; it assigns it to kinds of work.
- The spawn surface points at the guide: the spawn tool tells a spawner to consult it before choosing. People read it where they read everything else in the library.
- Any example guide the product ships is user-space content, never the product's opinion.

The guide has two sections.

**Selection guidance**: which provider, model and reasoning effort for which kinds of work, and which Role to reach for when one fits. This is the user's cost instrument. Tier guidance earns its place by observed behavior per tier, and a good guide states what it does not cover, so a spawner facing a gap flags it rather than guessing.

**Brief conventions**: what a good first-turn brief contains — including the report-back contract, so the brief itself says what the spawn reports and when. When you spawn, you hear back when your brief says you will; the contract travels in the brief, not in platform law. The spawn tool's only coaching is one sentence reminding the spawner to write it.

Roles compose with the guide rather than replacing it: with a Role, the allowlist constrains the required choice; the guide governs role-less spawns and _which Role to pick_.

## Acceptance criteria

1. The Spawning Guide is a user-authored file in the Role library, editable in the app, with git optional.
2. The spawn tool's description directs the spawner to consult the guide before choosing provider, model and reasoning.
3. The platform provides the provider, model and reasoning catalog as facts; the guide is never the source of that catalog.
4. A spawn without an explicit provider and model, or without reasoning for a model that has a reasoning option, is refused; nothing is inherited from the spawner.
5. Any example guide shipped with the product is marked as user-space content.

## Scenarios

- **A gap in the guide.** A Captain in Billing Migration needs a long-context research helper; the guide's selection table has no row for it and says so under "not covered"; the Captain picks conservatively, says so in its thread, and the user adds a row that evening. (AC2, AC3)
- **Retuning a tier.** The user moves mechanical watch-and-report work to a cheaper tier after observing identical reliability and only more narration; the guide changes; nothing in the product does. (AC1)

## History

- 2026-08-29 — provider, model and reasoning become required on every spawn.
- 2026-08-30 — the guide defined: ownership split, two sections, Roles compose, one sentence of brief steering in the spawn tool; former SP1–SP4 ([record](../../worklog/2026-08-30-spawning-guide-session.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: SP1 → Definition (ownership), AC1–AC3, AC5; SP2 → Definition (two sections); SP3 → Definition (Roles compose), AC4; SP4 → Definition (brief conventions; acknowledgements). The example guide that lived in this document is user-space content and belongs with the example Role library, not in a definition.
- 2026-11-02 — reasoning is required only for a model with a reasoning option ([#704](https://github.com/Jacksondr5/j5code/issues/704)).
