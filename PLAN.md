# Study Sprint: plan

The current state and what's next. Keep this file short: history goes in [CHANGELOG.md](CHANGELOG.md), ideas and the backend backlog in [docs/backlog.md](docs/backlog.md), and the original v1 spec, round plans and old handoffs in [docs/plan-history.md](docs/plan-history.md).

## How I want you to work

- Ask me before any decision that's hard to undo (data format changes, deleting features, adding a build step).
- I'm new to coding. Explain changes in plain language, keep the code readable, and add short comments where the logic isn't obvious.
- Keep it a **static site with no build step** so GitHub Pages can serve it directly: plain HTML, CSS and JavaScript ES modules, with libraries from a CDN at pinned versions.
- When something is done, tell me what to test.
- Each release adds a line to the top of CHANGELOG.md (the same words as its `js/whats-new.js` entry).
- Day-to-day rules are in `CLAUDE.md` and the `release` skill (`.claude/skills/release`).

## Where things stand (v4.70)

- Live at https://aayan277.github.io/study-sprint/ (GitHub Pages, `main` branch root). Code is all rights reserved (`LICENSE`).
- Flashcards with FSRS scheduling (FSRS-6 is the default and the fallback), Anki/CSV/Excel/PDF import, Play games, Practice test, exam planning, stats, optional sync (Supabase).
- Two styles: Original (`css/styles.css`) and Clinical (`css/clinical.css`), each light and dark.
- Own model: Settings → Study → Advanced scheduling → Own model → Load model file. It only takes over once it is better at the 99% level (`js/own-verdict.js`). Model files are never committed.

## Next

1. Clinical on a computer: all pages on one left edge.
2. A Practice button on each deck page (Test, Game or Exam prep).
3. "Recently deleted" for 30 days (needs care with sync).
4. Owner decisions waiting: Clinical deck page order (Review before Exam prep?), Welcome screen headline and taglines, the Play button on deck cards.

## Handoff (2026-11-17, after v4.68)

**Unfinished, nothing half-built:** every branch with work on it is merged; the only open work is the Next list above.
- Two browser tests fail now and then when several runs share a busy machine and pass when run alone: `e2e-anki-update` (the update toast) and `e2e-uipolish` (a navigation wait). `e2e-clinical` once logged "Cannot set properties of null (setting 'innerHTML')" in the wide 1920 light scene; it never reproduced and the 4.68 review found no new code that could cause it. If it comes back, log `e.stack` in that test's `watch()`.
- Small review notes left for later: `shouldSaveAnkiLibraries` (js/anki-read.js) and the inline check in js/app.js must stay the same; in the exam sheet the date default comes from the first deck and doesn't follow the Deck dropdown.
- About 140 old branches are on GitHub, most already merged. Delete them only after the owner says "yes, delete the merged branches".
- `claude/own-model` holds the training scripts. It is never merged into main.

**The Own model file:** `own-real-A6.own` (77 KB), trained on the FSRS research dataset, whose licence forbids redistributing it. It must never be committed to this repo (`*.own` is in `.gitignore`).
- Copies: the owner's own download, and the private repo `Aayan277/study-sprint-private` once the owner has created it and uploaded the file there. The training session ("Own model training C") also had a copy, but cloud machines get reset, so don't rely on it.
- **In the app:** Settings → Study → Advanced scheduling → Own model → Load model file, then pick the file.
- **In a new Claude session:** ask Claude to add the private repo with `add_repo` (owner Aayan277, repo study-sprint-private), clone it to `~/own-model-private`, and read the file from there. Never copy it into this repo, a commit, a PR or a doc. The training data lives in `~/fsrs-data` only while a session needs it; it is downloaded again with the owner's Hugging Face access and is never stored in any repo.

## Waiting on the owner

- A contact email and the account setup (anti-spam check, sync server, email sending): `docs/owner-launch-checklist.md` and `docs/sync-setup.md`.
- Checks on a real phone.
- Optional: a custom domain name.
- Create the private repo `study-sprint-private` and upload `own-real-A6.own` to it (see the handoff above).
