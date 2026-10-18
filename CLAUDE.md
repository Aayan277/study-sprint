# Study Sprint: how to work here

Static flashcard PWA (plain ES modules, no build), optional Supabase sync. Plans, history and the backlog are in `PLAN.md`.

## Owner's preferences
- Explain things in plain language; the owner is new to coding.
- Opus agents plan, review and research; Sonnet agents write code. Use the agents in `.claude/agents`.
- A Code Reviewer check before every merge. Merge without asking once tests and the review pass.
- Pacing: early in the weekly usage cycle about 3-5 agents at once, later in the week 6-8. When the owner gives usage numbers, stop near them and save everything to GitHub.

## Releases
- Any change to an app file: bump `APP_VERSION` and `CACHE` in `sw.js`, then `node tests/update-sw-hash.mjs`.
- Before merging: `npm test` and the full `node tests/browser/run.mjs`.
- Parallel branches don't bump `sw.js`; do one bump at merge time so they don't conflict.

## Tests and processes
- Two `run.mjs` runs from one checkout share `tests/browser/out` and collide; use separate worktrees.
- Never `pkill` by pattern (it has killed other runs and the shell itself); kill only your own PIDs.
- `tests/browser/pw.mjs`: `CPU_THROTTLE=4` to prove a test isn't flaky; `sheetSettled(page)` for tests that reload right after closing a sheet.
- `e2e-selection` once timed out at its first tap on a busy machine; if it repeats, wait for the review screen before tapping.
