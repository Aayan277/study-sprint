# Study Sprint: v1 build plan

A mobile-first flashcard app for studying university course material. It combines real spaced repetition (like Anki) with the timed game formats from my kanji game.

**Reference project:** `Aayan277/kanji-sprint` (live at aayan277.github.io/kanji-sprint). Reuse its look, themes, game formats, scoring and progress screens. Open its `index.html` before starting and port what's listed below rather than redesigning from scratch.

## How I want you to work

- Build in the milestones at the bottom, in order. Commit after each one with a clear message, and tell me what to test before moving on.
- Ask me before any decision that's hard to undo (data format changes, deleting features, adding a build step).
- I'm new to coding. Explain changes in plain language, keep the code readable, and add short comments where the logic isn't obvious.
- Keep it a **static site with no build step** so GitHub Pages can serve it directly: plain HTML, CSS and JavaScript ES modules. Load libraries from a CDN with pinned versions.

## Why this app exists (what beats Anki)

1. A much nicer UI that works well on a phone, installable as an app.
2. Timed game formats (Classic, Survival, Lightning, Flash, Hard mode) for cramming before exams.
3. Better stats and progress tracking.
4. Game results feed into the spaced repetition schedule automatically, so I don't have to rate every card by hand.

## Tech

| Piece | Choice |
| --- | --- |
| Hosting | GitHub Pages, from the `main` branch root |
| App shell | PWA: `manifest.webmanifest` plus a service worker (network-first for app files, cache-first for fonts and CDN libraries). Copy the approach from kanji-sprint's `sw.js` |
| Storage | IndexedDB, through a small wrapper in `js/db.js` (or `idb-keyval` from a CDN). Not localStorage, since decks can outgrow it |
| Scheduling | FSRS via the `ts-fsrs` library |
| CSV parsing | Papa Parse |
| Excel import | SheetJS (load it only when someone imports an .xlsx) |
| Fonts and themes | Bricolage Grotesque (headings), DM Sans (text), IBM Plex Mono (numbers). 6 themes (Ink, Blossom, Sage, Cobalt, Neon, Onyx) with light and dark versions. No kanji or Japanese branding |

### Suggested file structure

```
index.html
manifest.webmanifest
sw.js
css/styles.css
js/app.js        screens, navigation, shared state
js/db.js         IndexedDB: decks, cards, card states, review log, settings
js/import.js     paste and file parsing (pure functions, no DOM)
js/srs.js        FSRS wrapper and auto-grading rules
js/review.js     daily review screen
js/play.js       game formats (ported from kanji-sprint)
js/stats.js      stats screen
js/themes.js     theme picker
icons/
tests/import.test.js   run with: node tests/import.test.js
README.md
```

## Data model

- **Deck:** id, name, color, created date, optional course code
- **Card:** id, deckId, front, back, optional tags, created date
- **Card state** (FSRS fields): due, stability, difficulty, reps, lapses, state, last review
- **Review log:** cardId, timestamp, source (`review` or `play`), mode, correct, answer time in ms, rating given
- **Settings:** theme, target retention (default 0.9), new cards per day (default 20), timer defaults

Include **Export backup** and **Import backup** (one JSON file with everything) in Settings, since data only lives on one device.

## Features

### 1. Deck library
- Create, rename, recolor and delete decks. Deleting asks for confirmation inside the page (no browser `confirm()` pop-ups).
- Each deck shows its card count, cards due today, new cards and a small mastery bar.
- Include two optional built-in decks: **JLPT N5 Kanji** and **JLPT N4 Kanji**, taken from kanji-sprint's data. Also include a small sample deck so the app isn't empty on first open.

### 2. Import (the most important screen to get right)

**Ways in:**
- **Paste box** with automatic format detection (rules below).
- **File upload:** .csv, .tsv, .txt, .xlsx.
- **Google Sheets link:** a sheet published to the web as CSV.
- **JSON backup** from this app.

**Preview before saving:** after parsing, show the cards in an editable table. I can swap front and back for all cards, edit any cell, delete rows, choose which column is front or back when there are more than 2, and see possible duplicates flagged. Show which format was detected ("Found 42 cards, separated by ' - '").

**Auto-detect rules** (pure functions in `js/import.js`):
1. Normalize line endings and trim. Drop empty lines, except where blocks are separated by blank lines (rule 7).
2. Strip list markers from the start of lines: `1.`, `1)`, `-`, `*`, `•`.
3. Try each separator: tab, ` | `, ` - `, ` – `, ` — `, `: `, ` = `, `,`. For each one, score the fraction of lines that split into two non-empty parts at the **first** occurrence. Pick the best score if it's at least 0.7.
4. Use Papa Parse for comma and tab separators so quoted fields work.
5. Detect a header row ("term, definition", "front, back", "question, answer") and skip it.
6. Detect markdown or Notion tables (lines starting with `|`) and skip the `---` row.
7. If no separator wins: if blocks are separated by blank lines, use the first line of each block as the front and the rest as the back. Otherwise, if the line count is even, alternate lines (term, definition, term, definition).
8. Detect bolded terms (`**Term** definition` or `**Term**: definition`).
9. Quizlet's default export is tab between term and definition with a new line between cards, which rule 3 covers. Add a test for it.

Write tests in `tests/import.test.js` covering every rule, including messy real-world cases: definitions containing commas or colons, extra blank lines, mixed bullets and Windows line endings.

**"Make cards with Claude" button:** copies this prompt plus whatever is in the paste box, so I can paste it into a Claude chat and paste the result back.

```
Turn the study material below into flashcards for an exam.
Output ONLY lines in this exact format, one card per line, no header, no numbering:
front | back
Keep the front short: a term, concept, or specific question.
Keep the back under 25 words.
Cover the definitions, distinctions, examples and facts a professor would most likely test. Skip trivia.

Material:
```

### 3. Review (spaced repetition)
- Daily queue of due cards across all decks, or only selected decks, plus up to the new-cards-per-day limit.
- Card view: show the front, tap or press Space to flip, then rate **Again / Hard / Good / Easy**. Show the next interval on each button (for example "Good · 4d"), like Anki.
- Optional typed-answer review: type the back, and it gets auto-graded with the matching rules below.
- Keyboard shortcuts 1–4 for ratings and Space to flip. On phones, big thumb-reachable buttons at the bottom.
- Finishing screen with cards reviewed, accuracy, time spent and tomorrow's due count.

### 4. Play (ported from kanji-sprint)
- **Formats:** Classic (set number of questions), Survival (3 lives, timer shrinks 3% per question with a 2s floor), Lightning (60s total, −3s per wrong answer, clock pauses during feedback).
- **Question types:** Front → pick the back, Back → pick the front, and Typing (type the back).
- **Hard difficulty:** 6 options, smarter distractors (below), −50 per wrong answer, ×1.25 points, no typo forgiveness.
- **Flash:** the prompt disappears after 1.2s, 0.8s or 0.5s, for ×1.2 points.
- Timer slider from 3 to 20s. Typing gets 1.8× the time.
- Same scoring as kanji-sprint: 100 + up to 100 speed bonus, with a streak multiplier up to ×1.5. Grade stamp uses letters (S, A, B, C, D) instead of kanji.
- Best scores per deck, format and difficulty.

**Distractors for any deck:** use other cards' backs from the same deck. Prefer cards with a similar length (within ±50%) and shared tags or shared words. On Hard, rank by text similarity so the traps look plausible. A deck needs at least 4 cards for multiple choice. Otherwise, only offer Typing and Review.

**Typing answer matching:** ignore case, punctuation and leading articles. Allow typos scaled by length: 0 for answers under 5 characters, 1 for 5–9, 2 for 10 or more. Accept any alternate in the back separated by `;` or `/`. Only offer typing for cards whose back is 40 characters or less (or use Back → Front typing instead).

### 5. Auto-grading: game results feed the schedule

| Result | Typing | Multiple choice |
| --- | --- | --- |
| Wrong or timed out | Again | Again |
| Correct, slow (more than 70% of the time used) | Hard | Hard |
| Correct, normal | Good | Good |
| Correct, fast (less than 30% of the time used) | Easy | Good (never Easy, since recognizing is easier than recalling) |

**Rules so playing doesn't break the schedule:**
- If a card is **due or overdue**, apply the rating to FSRS normally.
- If a card is **not due yet**, only an **Again** changes its schedule. Correct answers get logged for stats but don't push the card further out.
- Apply at most one schedule update per card per day from Play.

### 6. Stats
- **Per-deck mastery grid** like kanji-sprint's, with levels from FSRS: New, Learning, Young (stability under 21 days), Mature (21 days or more). Tap a card to see its history.
- **Retention:** % correct on due reviews over the last 30 days.
- **Charts:** reviews per day (last 30 days) and due-card forecast (next 7 days).
- **Hardest cards:** most lapses, with a "Drill these" button that starts a Play round.
- **Day streak** with a 7-day dot row, same as kanji-sprint.

### 7. Settings
Theme picker, target retention, new cards per day, default timer, export or import backup, reset all data (with an in-page confirmation step).

## Layout
- Mobile-first, with a bottom tab bar: **Review · Play · Decks · Stats**. Settings goes behind a gear icon.
- Reuse kanji-sprint's color tokens and theme system, but with Study Sprint's own branding (lightning-bolt flashcard logo, Latin fonts, no kanji). Use a card component that fits longer text (definitions can be several lines).
- Everything must work at 375px wide with no sideways scrolling.

## Milestones

1. **Scaffold:** file structure, PWA (manifest, service worker, icons), themes, IndexedDB, deck library with create/rename/delete, sample deck. Deploy and check that it installs on my phone.
2. **Import:** paste box with auto-detect, file upload, preview table, Claude prompt button, parser tests passing.
3. **Review:** FSRS scheduling, daily queue, flip-and-rate, typed-answer review.
4. **Play:** port all formats, question types, Hard and Flash from kanji-sprint, adapted for generic decks.
5. **Auto-grading:** connect Play results to FSRS with the rules above.
6. **Stats:** mastery grid, charts, hardest cards, streak.
7. **Polish:** backup export and import, built-in kanji decks, README with screenshots, final mobile pass.

## After v1

Built one at a time, in this order: write a short plan here, get it approved, build it, open a pull request.

1. ✅ **Small wins** (done in v1.1): Play starts on Back → front for decks with long backs (definition-style decks), remembering your own pick per deck; advanced scheduling settings (learning steps, relearning steps, maximum interval with presets, fuzz on/off, reset to defaults). v1.3: steps are typed in a text box (e.g. 1m 10m) with a Reset button each, a hint for the m/h/d letters, and a plain-words list of what each step and button does.
2. **Accounts and syncing between devices** (e.g. Supabase). Ask before starting: data would also be stored on their servers.
3. **Tune FSRS to my own reviews** (fit the 21 parameters to my review history), once there's about a month of daily reviews.
4. **Anki .apkg import.**
5. **Images and audio on cards.**
6. **Sharing decks with friends by link** (needs syncing first).

## Anki features (requested after v1)

Built in 3 parts:
1. ✅ **Card list and actions** (v1.4): browse every card in a deck or all decks; search, filter, sort; edit; add a single card; select several; suspend, bury until tomorrow, delete, move, reset to new, set due date, flags, card info. Suspended and buried cards are left out of Review and Play.
2. ✅ **Review and Play** (v1.5): a ⋯ menu during Review (edit, suspend, bury, flag, delete, card info) and keyboard shortcuts; leeches (cards forgotten 8 times are suspended and tagged automatically). Play gets a Card ⋯ button after each answer.
3. ✅ **Study options** (v1.6): custom study (extra new cards today, review ahead, re-study cards forgotten today) and new cards per day for each deck. Reverse cards were skipped for now (Play already quizzes back → front).

## Parked (not planned for now)

- **One-tap AI card generation through the Claude API.** Needs a small backend to hide the key, and API usage costs money. The "Make cards with Claude" copy-and-paste button covers this for now.
- **AI-made wrong answers for Play:** have Claude also write 2–3 believable wrong answers per card (e.g. "operant conditioning" as a trap for "classical conditioning"), stored with the card and used as multiple-choice options, so definition-style decks get exam-like distractors instead of other cards' unrelated backs. Parked together with the item above.
