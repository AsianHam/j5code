---
title: "Highlights"
kind: definition
---

# Highlights

## Problem

Nothing in a client says what changed after it updates. Release notes reach the person only before an update, only on desktop, and only as a list of changes. A substantial new feature goes unnoticed unless someone reads GitHub.

## Definition

A highlight is a short entry about one substantial feature: a title, a line or two, an optional "Learn more" page on the marketing site, an optional illustration, and the clients it shows on (web, desktop, mobile). It is committed with the feature's own pull request, and whether a feature deserves one is decided in that pull request's review. Release notes are unchanged.

A client keeps its own record of the highlights it has seen. A browser keeps one per address, and the desktop app one per install. A highlight is new to a client until it is dismissed there, so updating several devices shows it on each.

A client that has never finished first run shows nothing. Finishing first run marks every highlight the client ships with as seen, before it records that first run is done, so a new client starts with nothing new. A client that finished first run before highlights existed has no record, and sees every highlight once.

A highlight follows the client's own build. The server it connects to may be older.

Mobile shows no highlights yet. Entries already say which clients they are for, so mobile can have its own set.

## Acceptance criteria

1. While a client has unseen highlights, the sidebar's row of utility buttons has a button beside the update button with a count of them. It is gone otherwise.
2. The button opens a list on click, newest first, headed "New in J5 Code" with the client's version. Each entry can be dismissed on its own, which drops the count. Dismissing the last one removes the button.
3. The command palette's "What's new" opens the same list with every highlight and nothing to dismiss, from any page and with the sidebar collapsed.
4. "Learn more" opens the marketing page in the person's browser.
5. A new client never shows the highlights it shipped with. An existing client shows each new highlight once.
6. Where the sidebar is too narrow for the button, it is hidden until the palette opens the list.

## History

- 2026-10-17 — defined, designed and built; launched with Peering ([#624](https://github.com/Jacksondr5/j5code/issues/624)).
