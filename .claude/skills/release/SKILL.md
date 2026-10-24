---
name: release
description: Study Sprint release and merge checklist (sw.js version bump, hash update, test runs, browser-test tips, agent pacing). Use before merging or releasing, when running browser tests, or when planning how many agents to run.
---

## Release steps
- Any change to an app file: bump `APP_VERSION` in `js/app.js` and `CACHE` in `sw.js`, then `node tests/update-sw-hash.mjs`.
- Parallel branches don't bump `sw.js`; do one bump at merge time.
- On a `sw.js` merge conflict, keep the integration branch's copy (`git checkout --ours sw.js` when merging into it), then run `node tests/update-sw-hash.mjs`. Taking a stale branch's copy once lost a security fix.
- Before merging: `npm test` and the full `node tests/browser/run.mjs`.

## Browser tests
- Two `run.mjs` runs from one checkout share `tests/browser/out` and collide; use separate worktrees.
- Kill only your own PIDs.
- `tests/browser/pw.mjs`: `CPU_THROTTLE=4` proves a test isn't flaky; `sheetSettled(page)` for tests that reload right after closing a sheet.
- `e2e-selection` used to time out at its first tap on a busy machine; its phone block now taps again until the card flips.

## Agent pacing
- Early in the weekly usage cycle about 3-5 agents at once, later in the week 6-8.
- When the owner gives usage numbers, stop near them and save everything to GitHub.
