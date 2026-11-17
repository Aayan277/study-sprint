# Study Sprint: plan

The current state and what's next. Keep this file short: history goes in [CHANGELOG.md](CHANGELOG.md), ideas and the backend backlog in [docs/backlog.md](docs/backlog.md), and the original v1 spec, round plans and old handoffs in [docs/plan-history.md](docs/plan-history.md).

## How I want you to work

- Ask me before any decision that's hard to undo (data format changes, deleting features, adding a build step).
- I'm new to coding. Explain changes in plain language, keep the code readable, and add short comments where the logic isn't obvious.
- Keep it a **static site with no build step** so GitHub Pages can serve it directly: plain HTML, CSS and JavaScript ES modules, with libraries from a CDN at pinned versions.
- When something is done, tell me what to test.
- Each release adds a line to the top of CHANGELOG.md (the same words as its `js/whats-new.js` entry).
- Day-to-day rules are in `CLAUDE.md` and the `release` skill (`.claude/skills/release`).

## Where things stand (v4.67)

- Live at https://aayan277.github.io/study-sprint/ (GitHub Pages, `main` branch root). Code is all rights reserved (`LICENSE`).
- Flashcards with FSRS scheduling (FSRS-6 is the default and the fallback), Anki/CSV/Excel/PDF import, Play games, Practice test, exam planning, stats, optional sync (Supabase).
- Two styles: Original (`css/styles.css`) and Clinical (`css/clinical.css`), each light and dark.
- Own model: Settings → Study → Advanced scheduling → Own model → Load model file. It only takes over once it is better at the 99% level (`js/own-verdict.js`). Model files are never committed.

## Next

1. **4.68 (in progress):** simpler Anki import (one summary line plus "Change"), Anki import offline once installed, "Add exam date" as one button, and two small Decks-search fixes (screen-reader count, `tag:` searches). Also update the "PLAN.md" comments in `js/match.js`, `js/autograde.js` and `js/mock-exam-store.js` to point to `docs/plan-history.md` / `CHANGELOG.md`.
2. Clinical on a computer: all pages on one left edge.
3. A Practice button on each deck page (Test, Game or Exam prep).
4. "Recently deleted" for 30 days (needs care with sync).
5. Owner decisions waiting: Clinical deck page order (Review before Exam prep?), Welcome screen headline and taglines, the Play button on deck cards.

## Waiting on the owner

- A contact email and the account setup (anti-spam check, sync server, email sending): `docs/owner-launch-checklist.md` and `docs/sync-setup.md`.
- Checks on a real phone.
- Optional: a custom domain name.
