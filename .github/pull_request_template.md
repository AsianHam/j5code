## Problem

<!-- One or two sentences: what was wrong or missing, and for whom. Link the tracking issue on this repository: "Closes #123". -->

## What changed

<!-- How you fixed it, and why this shape. Keep scope tight: one concern per PR. -->

## UI changes

<!-- If this PR changes UI, include clear before/after screenshots.
     If the change involves motion or interaction, include a short video.
     Delete this section if not applicable. -->

## Live testing

<!-- What was tested on a real server, from the tester's report (see the j5-live-test skill):
     the verdict and the commit tested; what was not exercised live, and why;
     anything a person needs to test by hand, with exact steps.
     Name the report artifact, for example `test-reports/<branch>.md`.
     Delete this section if nothing in the PR can be live-tested. -->

## Upstream impact

<!-- Delete if the PR only touches J5-owned paths (apps/*/src/j5, packages/*/src/j5, docs/j5,
     and the J5-owned files listed in FORK.md, such as AGENTS.md).
     Otherwise list each upstream-owned file you edited and its FORK.md case.
     If the PR changes what upstream's product does, link the human decision
     and the register entry in docs/j5/product/upstream.md. -->

## Checklist

- [ ] One concern: the description has no "also"
- [ ] Tests cover the changed behavior (backend changes ship with focused tests)
- [ ] UI changes: before/after screenshots above, and a video for motion or interaction
- [ ] Live testing: the section above says what ran live and what did not
- [ ] Upstream-owned files: each one is recorded in `FORK.md` (case text and file-table row) in this PR
- [ ] Upstream product: any change to what upstream's product does has a human decision linked above and a register entry in `docs/j5/product/upstream.md`
- [ ] Surfaces: entry points, clients, providers, contracts, reverse states, connection modes (see `AGENTS.md`)
- [ ] Docs: definitions under `docs/j5/product/` and user docs rewritten where this changes them

<!-- End with the model and harness that did the work. -->
