---
title: "How the J5 docs are organized"
kind: process
---

# How the J5 docs are organized

Every document under `docs/j5/` is one of four kinds. The kind decides where the file lives, what its frontmatter says, and — most importantly — whether anything may cite it as the truth about the product.

| Kind           | Directory   | Answers the question                            | Expected lifetime                                                           | May be cited as current truth? |
| -------------- | ----------- | ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| **definition** | `product/`  | What is the product, today, at end state?       | Evergreen — kept true as long as the product exists                         | Yes — the only kind that may   |
| **record**     | `worklog/`  | What happened, and how did a decision get made? | Permanently accurate about its date; never about now                        | No — cite the definition       |
| **runbook**    | `runbooks/` | How do I operate the software?                  | While the software it describes runs; re-verified when the software changes | For operations only            |

`process/` (this directory) holds the rules for working in the repository and is cited for those rules only; a process rule is valid until it is changed.

`user/` holds the user guides for J5's features, written for the people using J5 in the shipped product's voice. They follow the user-docs rules in `AGENTS.md`, carry no frontmatter, and are never cited as a definition.

**Plans, research, and build status don't live here.** They live in GitHub issues and pull requests, which are current where a committed plan goes stale. A merged PR, and the code itself, is the record of what was built.

## Lifetime is the point

The kinds differ most in how long they stay true. A **definition** is the only kind that is maintained to stay true — that is what makes it citable. A **record** is always accurate about the day it describes and never about today, which is why it cannot be a source of truth even though it is never wrong. When you are unsure which kind a document is, ask how long it is expected to stay valid.

## Definitions

A definition says what the product is. It is written in the present tense, as if the feature exists at its end state, and it is **rewritten, never appended**: when the product changes, the sentence that was true changes, and the History section gains one line saying when and why. Narrative of who proposed what, PR numbers, and build status never appear in the body; where today's build falls short of a definition is a GitHub issue.

A definition is the longest-lived kind, so it **never depends on a shorter-lived one**: it cites other definitions and the glossary, and its History lines link records. If a definition needs something an issue or a study says, that thing is defined in the definition.

The Definition section stays at the level of concepts: what the thing is and how it is part of the solution to a problem or goal. Behavior in detail — what refuses what, what is recorded when, what a surface shows — belongs in the acceptance criteria, where it can be checked.

Every feature definition has the same sections, in this order:

1. **Problem** — one paragraph linking the problem or goal in `problems.md` it serves.
2. **Definition** — what it is, and what it is not. It may end with a **Later** list: what is deliberately set aside for a later version, one line each, linking the GitHub issue that tracks it. The list is the one place in a definition's body that links an issue; an item leaves it when the definition takes the item in. A decision that holds only until then is marked in the body with "for now", so that it is not read as the end state.
3. **Acceptance criteria** — one numbered list, grouped under short sub-headings that follow the order of the Definition (for example _Sending_, _Delivery_, _Silence_); the numbering runs through the groups without restarting, so a criterion's number stays unique within the feature. Each criterion is one testable sentence about observable behavior. These are the only numbered items in the docs, and the only things that get referenced by number (see IDs below).
4. **Scenarios** — concrete situations written as user stories or worked examples, each naming the criteria it exercises.
5. **History** — one line per amendment: date, what changed, and a link to the record.

Scenarios use one shared example fleet so a reader recognizes it from doc to doc, and never a real one: projects **Billing Migration**, **Website Redesign**, and **L2 Support Rotation** (a non-development project), each rooted at its own folder; the person is simply **the user**.

Core definitions (`overview.md`, `upstream.md`, `principles.md`, `problems.md`, `glossary.md`, `use-cases.md`, `fleet-vision.md`, `cross-device.md`) keep their own shapes but follow the same rule: rewritten, never appended; cited by name.

**Who edits definitions.** Anyone may propose a change — in a record, an issue, or a PR — but a definition is changed only through a reviewed docs PR that Product has checked against the other definitions and the principles. This is what keeps definitions from contradicting each other: a decision written down in a session is a proposal until the definition carries it.

## Identifiers

There are two kinds of identifier, and both carry the name of the thing they belong to, so a human can read them without a lookup table:

- **An acceptance criterion, numbered within its feature** — written as the feature name plus the number: "Fleet page AC3", "Inbox AC1". It always links to the criterion. Numbers are never reused within a feature; a retired criterion keeps its number and is marked retired in History.
- **A divergence, numbered within the [register of divergences](../product/upstream.md)** — written "divergence D7". A divergence carries a number, unlike principles, because each one is a standing decision that FORK.md, issues, and reviews refer to for years, often long after anyone remembers its title. Numbers are never reused; a retired divergence keeps its number and says so.

Nothing else is numbered:

- **Principles and lenses are cited by name** ("never guess", "the human-contact spectrum"), never by position — positions have changed and will change again.
- **Glossary terms are cited by name**, in Title Case for named product concepts (Crew, Captain, Role, Playbook, Memo, Exchange, Peer Agent, Subagent, Spawning Guide, Fleet page) and lowercase for descriptive words (fleet, agent, participant, inbox, ledger, dashboard).
- **Work items are GitHub issues** ("#28") and nothing else. No document assigns a letter-number to a piece of work.
- **Milestones are GitHub milestones**, cited by name ("Crews").

The letter registers used before 2026-09-05 (D, E, X, R, SC, ST, SB, IB, TA, AR, SP, QS, FV, DV, M, P, J, and the A/B/DQ/SQ ticket series) are retired. Records that use them are left as written; each definition that absorbed a register says so in its History line ("former E1–E7 and SC1–SC4 → AC1–AC11") so an old reference can still be followed.

## Records

A record says what happened: a design session, a review, a retrospective, a priority input, a friction list. Filenames are date-first — `2026-09-04-fleet-visibility-session.md` — so the directory sorts as a timeline. A record is never edited after the fact except to add a pointer to the definition that now holds its outcome. A record never defines anything current: if it contains a decision, the decision's home is the definition it links, and the record is the story of how it got there.

## Runbooks

A runbook tells an operator how to run the software. It may cite definitions for behavior and process docs for repository rules.

## Frontmatter

```yaml
---
title: "…"
kind: definition | record | runbook | process
---
```

## One test per kind

- Is this true of the product at end state? → definition.
- Does this sequence or scope work, or report a study? → a GitHub issue, not a document.
- Did this happen on a date? → record.
- Does this tell an operator what to do? → runbook.
