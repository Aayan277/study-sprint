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
| App shell | PWA: `manifest.webmanifest` plus a service worker (app files are served from the saved copy and updated in the background, cache-first for fonts and CDN libraries). Copy the approach from kanji-sprint's `sw.js` |
| Storage | IndexedDB, through a small wrapper in `js/db.js` (or `idb-keyval` from a CDN). Not localStorage, since decks can outgrow it |
| Scheduling | FSRS via the `ts-fsrs` library |
| CSV parsing | Papa Parse |
| Excel import | SheetJS (load it only when someone imports an .xlsx) |
| Fonts and themes | Geist (text) and Geist Mono (numbers). 5 accent themes (Violet, Ocean, Forest, Ember, Rose) with dark and light versions, plus OLED black. No kanji or Japanese branding |

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
| Wrong or timed out | Again | Again (a Survival timeout with under 3 seconds allowed is only logged) |
| Correct, slow (more than 70% of the time used) | Hard | Hard |
| Correct, normal | Good | Good |
| Correct, fast (less than 30% of the time used) | Easy | Good (never Easy, since recognizing is easier than recalling) |

**Rules so playing doesn't break the schedule:**
- If a card is **due or overdue** (including a card the exam's final pass has planned for today), apply the rating to FSRS normally.
- If a card is **not due yet**, only an **Again** changes its schedule: it brings the card back. Correct answers get logged for stats but don't push the card further out. Such a miss is a lapse for FSRS (the schedule and "forgotten N times" stay right) but **does not count toward the leech limit**: only Review answers, Play answers on due cards and imported history do (the review log says which, `reason: 'again'`). Wrong taps in a quick game say little about whether you forgot the card.
- A **Survival timeout while under 3 seconds were allowed** (the timer shrinks to a 2s floor) is only logged, never graded.
- Apply at most one schedule update per card per day from Play.
- **New cards** (never reviewed) are left for Review, with one exception: in a deck whose **exam date** is coming up (its own, or the deck it's inside), a Play answer counts as the card's **first review**: correct uses the table above, wrong is Again. These respect the new-cards-per-day limits (overall, the deck's own, and parent decks' limits). Only new cards really started today count against them, so Play answers that were just logged don't use them up. Over the limit, the card is only logged and starts in Review. The results screen says how many new cards were started and why.

### 6. Stats
- **Per-deck mastery grid** like kanji-sprint's, with levels from FSRS: New, Learning, Young (stability under 21 days), Mature (21 days or more). Tap a card to see its history.
- **Retention:** % correct on due reviews over the last 30 days.
- **Charts:** reviews per day (last 30 days) and due-card forecast (next 7 days).
- **Hardest cards:** most lapses, with a "Review these" button that starts a Review session of those cards (v4.9; it used to start a Play round).
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
2. **Accounts and syncing between devices** (Supabase), approved. In 3 rounds:
   1. ✅ **Data groundwork** (v1.8): every deck, card and schedule records when it last changed (`updatedAt`); each review gets a `uid` shared across devices; deletions leave a marker in a new `deleted` store; study settings note when they changed (`_times`). Version 1 data is upgraded automatically (IndexedDB version 2). Sample and starter decks get fixed ids so they merge instead of doubling. `supabase/setup.sql` (one `sync_items` table with Row Level Security, newest-change-wins and a change counter) and the guide in `docs/sync-setup.md`.
   2. ✅ **Sign in and sync** (v1.9): email + password sign-in in Settings → Sync (Supabase's free plan can't edit email templates, so no codes; "Confirm email" is turned off so no emails are needed); push local changes and pull others' changes, newest change wins, review history merged; syncs on open, a few seconds after changes, when back online, and with Sync now.
   3. ✅ **Polish** (v2.0): Forgot password (Supabase reset email → the app opens with "Set a new password") and Change password; sign out keeping or removing this device's data (warns if changes haven't synced); Delete my synced data (server only); signed in, Reset all data is "Everywhere" (deleted markers for everything) or "Just this device" (sign out and clear), and Restore backup replaces the account too; progress for big first syncs; a warning when sync has failed for 3+ days; new passwords need 8+ characters with a letter and a number (live checklist, Show button; Supabase enforces the same). Tested with three devices against a stand-in Supabase server, including the same card reviewed offline on two devices.
3. **Tune FSRS to my own reviews** (fit the 21 parameters to my review history), once there's about a month of daily reviews.
4. ✅ **Anki .apkg import** (v1.7): old (.anki2/.anki21) and new (.anki21b, compressed) formats; pick a deck; tags kept; cloze → one card per blank; formatting, images and sounds dropped; optional "Bring over my Anki progress": review history is imported (source 'anki') and replayed through FSRS for due dates. Reverse-card history, suspended/buried status and Anki deck options aren't carried over.
5. **Images and audio on cards.**
6. **Sharing decks with friends by link** (needs syncing first).

## Anki features (requested after v1)

Built in 3 parts:
1. ✅ **Card list and actions** (v1.4): browse every card in a deck or all decks; search, filter, sort; edit; add a single card; select several; suspend, bury until tomorrow, delete, move, reset to new, set due date, flags, card info. Suspended and buried cards are left out of Review and Play.
2. ✅ **Review and Play** (v1.5): a ⋯ menu during Review (edit, suspend, bury, flag, delete, card info) and keyboard shortcuts; leeches (cards forgotten 8 times are suspended and tagged automatically). Play gets a Card ⋯ button after each answer.
3. ✅ **Study options** (v1.6): custom study (extra new cards today, review ahead, re-study cards forgotten today) and new cards per day for each deck. Reverse cards were skipped for now (Play already quizzes back → front).

## Next batch (requested after sync)

1. ✅ **Desktop layout** (v2.1): one app that adapts (not a separate version). From 1024px: sidebar instead of bottom tabs, wider pages, decks and Stats in grids, bigger Review card with keyboard hints. From 1200px: a card's panel opens beside the list (click from card to card; Escape closes). Phones unchanged.
2. ✅ **Study calendar** in Stats (v2.2): a year of study days, one column per week, darker = more answers; tap a day to see it; best streak.
3. ✅ **Export a deck** (v2.3) as CSV (Excel-friendly, imports back in) or an Anki deck (.apkg, Anki's widely supported older layout; checked by importing into the real Anki library). Cards only: progress stays in Study Sprint.
4. ✅ **Exam date mode** (v2.4) (full: nothing scheduled past the exam, retention rises near it, Exam prep session, countdown), ✅ **card formatting** (v2.5) (saved as simple marks; B / I / • toolbar on phones, Word-style editing on computers) and ✅ **images on cards** (v2.6) (1 per side, shrunk to 1280px JPEG, synced through Supabase Storage with `supabase/media.sql`, in backups, Anki import (both file formats) and export). All done.

## More from Anki (requested after v2.6)

Five rounds, choices approved ("go"): cloze blanks are linked cards; image occlusion is "hide all, guess one"; cards from the same note don't show on the same day; subdecks (a parent includes its subdecks; its limits cap the group); per-deck settings (default "use my overall settings"); no daily review limit by default; easy days (Normal / Reduced / Minimum per weekday) and load balancing within fuzz; read aloud per deck.

- A. ✅ (v2.7) **Read aloud** (🔊 / R, deck language or auto-detect, auto-read), **card list tools** (Duplicates filter, Find and replace, Tags: rename or remove everywhere), **more stats** (answer buttons, time of day, difficulty).
- B. ✅ (v2.8) **Per-deck settings** (deck.options, deck.reviewPerDay), **daily review limit** (settings.reviewLimit), **easy days** and evening out (settings.easyDays; balance.js picks the least busy day within the fuzz range).
- C. ✅ (v2.9) **Subdecks** (deck.parentId; deck-tree.js). A deck includes its subdecks everywhere (card list, Review, Play, Stats, Export); a parent's limits cap the group; subdecks inherit study options, exam date and read aloud unless they set their own; deleting a parent asks to delete or move up the subdecks; Anki imports can keep their subdecks and Anki exports keep them.
- D. **Cloze cards**.
- E. **Image occlusion**.

## Redesign (v3.0, experiment branch)

Done on the `experiment` branch, in three steps. All of it keeps the no-build-step, no-data-format-change rules (the only new setting keys are `onboarded` and the fold states, which live in localStorage).

1. **Dark and sleek look.** New design tokens (type, spacing, radii, elevation, color roles), five accent themes (Violet, Ocean, Forest, Ember, Rose) in dark and light plus OLED, Geist fonts, fixed rating colors that stay distinct from the brand color, a focus mode (tab bar and header hidden during a round), and contrast fixes.
2. **Today is the home screen.** Daily goal ring, streak and one Start button, a row per course, upcoming exams, and an Options sheet (decks, flip or type, Custom study). The card flips, the finish screen was redone, and emoji became one icon set. Decks was updated to match. The Review setup now lives in Today → Options.
3. **Less to wade through, and a first run.**
   - **First run** (`js/onboarding.js`, route `#/welcome`): on a fresh install with no decks, cards or reviews, a skippable 3-step start (pitch, name your course with optional code and exam date, add cards by paste / file or Anki / sample deck) then a guided review of 3 cards (real reviews, saved). It never shows again once finished or skipped (`onboarded` setting, kept in backups). Existing installs (the old `seeded` flag, or any data) never see it. The sample deck is only added when "Try the sample deck" is picked. Tests skip it with `localStorage 'study-sprint-skip-onboarding' = '1'` (set by `tests/browser/pw.mjs`) or `?skipOnboarding`, which adds the sample deck like before.
   - **JLPT starter decks** are hidden: a small "Starter decks" fold at the bottom of Decks, and Import links to it ("Ready-made decks", `#/decks/starters`).
   - **Stats:** on phones (under 1024px), answer buttons, time of day, difficulty and the mastery grid sit under a "More stats" fold. Computers show everything.
   - **Settings:** the timer default and leech settings are inside "Advanced scheduling" (a Play timer stepper was added there: there was none in Settings before), and Reset all data is behind a "Danger zone" fold at the bottom of Your data. The Danger zone always starts closed (its state is deliberately not remembered). Other fold states are remembered per device.
   - **Card filters** are grouped (Status / Flags / Problems) with `<optgroup>`.
   - **Play quick-start:** deck, the three format tiles and Start fit above the fold at 375x812; question type, Hard, Flash, question count and time are under "Customise" with a one-line summary. The deck defaults to the one with the nearest upcoming exam (until you pick one in that visit), otherwise the last one used.
   - **Play starts new cards in exam decks** (see section 5 above).
     - A subdeck's own past exam date hides its parent's exam for that subdeck (same as Review), and on exam day itself Play still starts new cards.
     - The new-cards-per-day limit is respected (overall, the deck's, and parents'); Play answers that were only logged do not use up slots, in Review and Play alike (`newLimits`).
   - First-run details: going Back never returns to the start (`location.replace`); `#/welcome` goes to Today once finished; "Try the sample deck" does nothing if a `sample` deck already exists; the guided review of the sample is skipped on a device with a sync account; `?skipOnboarding` only works on localhost.
   - **Earlier bug fixes** along the way: focus-mode leaks, a toast hidden by the rating bar, theme preview redraws, a late Review redraw hiding the tab bar, count labels, and the exam test around midnight (study day starts at 4am).
   - **Speed pass and Today follow-ups:** Stats counts answers per day in the database (the whole log is read only when a deck is picked), draws 500 mastery squares at a time, and redraws once after a sync; Today reads 60 days of the log and finds the streak by walking back only as far as it goes (`lazyStreak`, shared with Stats and the finish screen); deck counts come from one sorted pass (`splitCards`); Browse sorts with one `Intl.Collator`; Play samples ~300 candidates for wrong options; `applyRemote` reads a whole page at once; the service worker answers from the saved copy of its own version (bump `CACHE` for a release: it installs every file fresh, together, and reloads once; files are never refreshed one by one, which once mixed versions after an update), `index.html` preloads the boot modules (a test keeps the list in step with `app.js`), and screens other than Today load on demand. Review: the turned-away face is `inert` and focus moves to the answer; Today's Start resumes a same-deck session or asks "Start over?"; exam prep is a normal launch (`kind: 'prep'`); a deck's session lives at `#/review/<deck>`; the time estimate is the median gap between reviews in a session.

Known leftovers: Reset all data still re-adds the sample deck afterwards (as before), and the first-run start does not appear on a second device that is about to sign in (its "Already use Study Sprint?" link goes to Settings).

## After v3.0 (research by three review agents, approved order)

Research covered the scheduling algorithm, competitors (Anki, Quizlet, Knowt, RemNote, Brainscape…) and learning science. Courses: maths/science, bio/diagrams, text-heavy and languages. Not wanted for now: sharing decks. One-tap AI cards: maybe later. Built one round at a time, in this order:

1. ✅ **Smarter exams and fixes (v3.1).** Exam final pass (cards ≥99% on exam day left alone, the rest spread over the last 3 days weakest-closest, worked out when the queue is built; the 300-card simulation went from 300 reviews on the eve to about 156 at most on any day), "N new a day to finish by the exam" on Today, pull-in and Exam prep by recall probability, Play misses on cards not due don't count toward leeches (short Survival timeouts only logged), Anki replay like Anki's own (cram, Forget, cut-off histories, deck options), image-occlusion notes import as picture cards, and Retention counts recall answers only. Left for later from the review: speed relative to the person (B6), MC on due cards only in exam or Hard decks, backlog order by recall (B9).
   - Final pass tuned after a simulation with real forgetting (13 scenarios × 3 learners × 30 seeds): skipping a card's last review at ≥95% predicted lost 1–2 points of exam-day recall against v3.0, so a card is now left alone only at ≥99% (`FINAL_R`) and the pass is spread over the last 3 days; recall stays within 0.2 points of v3.0 in every exam case, total reviews are within about ±10% of v3.0's, and the busiest day is about 156 instead of 300 in the 300-card case.
2. ✅ **Cloze cards (v3.7)**, the old round D. Blanks are linked cards: each card keeps its `front`/`back` (so older versions, backups and sync keep working) plus `noteId`, `cloze` and `noteText`. A note editor with […] buttons. Siblings: one card per note per day. Anki cloze import and export. An opt-in "Link cloze cards" tool for older imports. Built as designed: no new store or SQL, `js/cloze.js`, one sibling a day (Exam prep shows all, Play avoids siblings back to back), removing a blank deletes its card after an in-page confirm, Anki import/export as Cloze notes, paste "Make cloze notes", Browse → Tools → Link cloze cards with a preview. An existing Basic card isn't converted to Cloze by the editor (use the Link tool for old imports).
3. ✅ **Image occlusion (v3.8)**, the old round E. "Hide all, guess one": a picture with boxes over the parts to learn; each group of boxes is one card, and Review hides every box and asks for the highlighted one. Built in two stages (plan: `docs/design/image-occlusion-plan.md`, original design: `docs/design/image-occlusion.md`).
   - Decisions: the picture lives in `card.backImage` only (so media cleanup, sync and Anki export already see it), and 2048px for occlusion pictures (1280px for everything else) so small diagram text stays readable. `occlusion = { n, w, h, header?, masks }` carries the saved size, so the box has the right shape before the picture loads. Masks are fractions of the picture with a label per box (a group's label is its boxes' labels joined). Only rectangles are drawn; ellipses and polygons (from Anki) are imported, stored and rendered. A drag is a box when it moved at least 8 screen px and is at least 0.3% of the picture on each side (no minimum box size). `n` is a card's identity: never renumbered or reused, so editing keeps schedules; people see positions ("part 2 of 5"). Cards of a picture are siblings (one a day in Review, Exam prep shows all, Play uses sibling labels as wrong answers); removing or joining boxes deletes cards and asks first. Anki image-occlusion notes import with their boxes (pixel or fraction coordinates) and export as real Anki Image Occlusion notes (Anki 23.10+).
   - Stage 1: pure helpers and tests (`js/occlusion.js`), media 2048, Anki import and export, backups, sync healing, Review, Play, Browse and a pinch-zoom viewer. Stage 2: the drawing editor (`js/occlusion-editor.js`, its own `<dialog class="occ-ed">`): draw, select, move and resize with one finger or the mouse, pinch/wheel/double-tap zoom (Space or middle-drag pans on a computer), Undo/Redo, Group/Join/Split, Label, Add box, Fit, keyboard shortcuts, an in-page discard question, and a third "Image occlusion" kind in Add card (Choose a picture, drop or paste on a computer) plus "Edit boxes" in a card's editor. Tested with real touch and mouse input (`tests/browser/e2e-occlusion-editor.mjs`). Not done: drawing ellipses and polygons, changing the picture of an existing note (make a new card).
4. **Quick wins (v3.4).** Stats by tag or lecture with "Drill this topic"; KaTeX maths on cards; a streak freeze (one a week) and exam rest days; typed answers show which letters were wrong; optional confidence before the reveal ("sure but wrong" stats); a Pretest button for a new lecture deck; new cards mixed across subdecks; a study plan as a calendar file (.ics).
   - ✅ **F3: Typed answers show which letters were wrong (v4.0).** Review and Play mark wrong, extra and missing letters (`js/answer-diff.js`, `answerChoices`/`closestChoice` in `js/match.js`), compared with the nearest allowed answer, with a summary and a screen-reader sentence; Play's missed list keeps the marks. Plan: `docs/design/quick-wins-plan.md`.
   - ✅ **F1a: Streak freeze (v4.1).** Worked out from the review log, so nothing new is stored and every device agrees once its logs merge. One missed day a week is covered automatically: it keeps the streak alive but does not add to the count. A missed day is covered when no other day in its Monday-to-Monday week (4am rollover) is, the next newer day was studied, was a day off or is today (two missed days in a row are never both covered), and a studied day exists further back (a freeze with nothing before it is dropped). Freezes are not banked, and (v4.2.1) the freeze stays on the earliest missed day of the week, so a decision looks at newer days and up to 6 older days of the week and `lazyStreak` keeps a 7-day margin. Owner approved (Q2): freezes are recalculated over all history, so past and current streaks and the best streak can go up. Day names follow the device's current time zone. Shown on Today (a freeze pill under the streak), the sidebar footer, the Stats streak card (snowflake dot) and calendar (hatched cell), and the Review finish screen. Code: `streakFromDays`, `streakRuns`, `streakText` and `weekOf` in `js/stats-calc.js`, the `snow` icon in `js/ui.js`, section 22 of styles.css. Tests: `tests/stats.test.js`, `tests/browser/e2e-streak.mjs`.
   - ✅ **F1b: Days off (v4.1).** Plan a day off for an exam week or a trip: it never breaks the streak and adds nothing to it. A new synced setting `restDays` (`{ 'YYYY-MM-DD': { on, at } }`), merged per day (the later decision wins; entries over 400 days old and junk are dropped; `mergeDayFlags` in `js/sync-merge.js`, `MERGED_SETTINGS` in `js/sync-data.js`, `applyRemote` in `js/db.js`), approved by the owner (Q1). Days off start tomorrow, up to 60 days ahead, at most 14 in the future at once, and can be removed (past ones are kept). Today's streak is a button that opens the "Your streak" sheet (`js/streak-sheet.js`, loaded when first used): the freeze explained, the last 7 days, the planned days with Remove, a date box, and "Day off on exam day" chips for courses with an exam. The Stats streak card has a "Plan a day off" link.
   - ✅ **v4.2.1 review fixes.** Everything in `docs/design/quick-wins-review.md`: the weekly freeze stays on the earliest missed day (owner decision); no "freeze ready" note after a freeze yesterday; merged `restDays` stamped past the server's time and junk day flags cleaned (`sync-merge.js`); days off decided on or after their day are ignored; Greek final sigma; `answerChoices` = `acceptedAnswers`, `closestChoice` prefers an accepting answer; grapheme-safe diffs; one corrected line in Review (a "Closest answer" row only for alternates, no diff box when too different) and no repeated answer in Play; accessible week dots and streak button; the streak reads only timestamps; `maxlength` 500 on typed answers; `normalizeAnswer`, `dupKey` and Browse search keep non-Latin marks and symbol-only text; `RESCUE_MAX_DAYS = 3`. A backup restore replaces this device's `restDays`, but syncing merges them with the account's.
   - ✅ **F2: Maths on cards with KaTeX (v4.2).** Write `$x^2$` (inline) or `$$...$$` (own line; `\(..\)` and `\[..\]` too) and KaTeX 0.16.47 draws it in Review, Play, Browse, Stats, the editors and the import preview. Owner approved (Q3): Pandoc `$` rules (so `$5 and $10` is text) and `\$` shows as `$`. `js/math.js` finds the maths and loads KaTeX from the CDN only when a card first shows it (the service worker keeps it, and now copies cached CDN files into each new cache, so a CACHE bump doesn't lose them); offline on the first visit the raw text shows (`.tex-raw`) and is drawn when the phone is back online. `formatHTML` lifts formulas out first (so `*` inside them is never italics) and has `math` modes `span`, `raw` (rich editor) and `anki`; `mathHTML` for plain lists; `answerText` gives the typed target (`x^2`, `a/b`) for Review, Play and the typed diff. Editor: a ∑ button and a preview. Anki: `[$]..[/$]` becomes `$..$` on import, `\(..\)` on export. Long display maths scrolls in its own box. The Claude prompt is unchanged. Tests: `tests/math.test.js`, additions to format/cloze/export/anki/import/speech/match tests, `tests/browser/e2e-math.mjs`.
   - ✅ **v4.2.2 KaTeX review fixes.** Everything in `docs/design/katex-review.md`: an import map gives katex.mjs, ts-fsrs, fflate, fzstd and SheetJS SHA-384 integrity (the stylesheet has `integrity` + `crossorigin`, the `?again=N` retry is gone, with a fetch, hash check and blob import fallback); the service worker's `keepLibraries` only carries over good, still-pinned copies from the newest old cache, and matches jsdelivr ignoring `?search`; a formula KaTeX rejects shows as raw text; typed answers accept the words, the text as written, or Greek letters as letters; cloze blanks and comma-separated import ignore what is inside formulas; Anki `[$]` becomes `\(..\)`; private-use characters survive the rich editor; a render cache and idle chunks for long lists; tidier scrolling formulas, speech, size classes, the desktop sum button and the one-line typed diff. Tests: `tests/{math,format,cloze,import,anki,match,sw,integrity}.test.js`, `tests/browser/e2e-math2.mjs`, `e2e-sw.mjs`.
5. **My own algorithm.** Check every change with the scheduling simulator first (`tests/sim/compare/README.md`). Tune FSRS to my reviews (fsrs-rs WASM, @open-spaced-repetition/binding, on a separate page, at about 400+ reviews, kept only if it predicts better); an exam-day forecast ("you'll remember ~78%; do 25 a day for 90%"); predicted vs actual recall chart; workload forecast.
6. **Exam practice (v3.6).** Test mode (mock exam, mixed question types, score by tag, Drill missed); lecture PDFs into the "Make cards with Claude" prompt (pdf.js); reverse cards.

Later: audio cards, the "these look like notes" paste banner, one-tap AI cards (Supabase Edge Function, about $3 a semester), sharing decks.

## Algorithm follow-ups (v3.5, tested in simulation first)

Simulated with the app's real code, three learner types, 48+ scenarios, 60 seeds each:
- ✅ **Play speed judged against your own pace:** after 50 right answers per mode, Hard if over 2.2× your usual time for that much text, Easy (typing only) if under 0.5×; before that, the old 30% / 70% of the timer. Rating accuracy 67% → 80%, worst retention cell −0.11 points, workload neutral.
- ✅ **Multiple choice on a due card counts at most as Hard** (recognition is easier than recall): no scenario worse, +2–3% reviews, and later recall after a Play-counted review rose from 73% to 78%.
- ❌ **Backlog after a break ordered by lowest recall:** no benefit with a normal limit, and worse with a tight daily limit (−0.9 to −1.5 points), so the order stays most-overdue first.

## Polish pass (after v3.1, approved from the Polish Preview)

Four design reviews (visual, layout, motion, first impression) and before/after renders; the owner picked by number. New switches go in a new **Settings → Appearance** section (this device only), on by default.

1. ✅ **Visual fixes (A1–A6) (v3.2):** one font for Start and no mono in prose, solid tab bar and header; calm deck label on cards, readable long answers (setting: card text **Auto** / Center / Left, Auto = long answers left), framed pictures; exams in amber (red only inside 3 days), Again in crimson so Ember's accent stands alone; one deck-page stripe and one empty state; Stats charts use their height, solid bars, calmer hardest list; one content width on desktop. Also check Today's time estimate (a render showed ~1 min per card): fixed, only same-session answers under 45 s apart count, from Review's own recent log rows (Play and imported Anki history are ignored).
2. ✅ **Layout (B1–B7) (v3.3):** a short card action sheet in Review and Play (Edit, Flag, Bury, Suspend, More; More is the full panel, Edit is a short editor) and Save returns to the same card with a toast; one sheet frame everywhere (title and × top-right, sticky footer with the main button on the right, a grab bar that really swipes closed); a 2px Review progress bar (done ÷ done + left, relearning included, outside the redrawn part) and an icon Undo; Decks that scale (search, sort Due / Exam / A–Z, subdecks folded and remembered per device, small round play buttons, tiles that keep their height; setting "Compact deck list", on by default, off brings the old list back); exam date in 3 taps (Today chips and the deck page, saved through the same code as Edit deck so pull-in and validation run); a per-course Stats header (readiness ring from the exam.js recall helpers, exam badge, seen and mature counts, Exam prep, Mastery on top) with a reusable searchable deck-tree picker (setting "Exam readiness in Stats", on by default); and from 1200px a 3-column Decks page (deck tree, the deck, the card editor docked on the right). Both settings are this-device-only, like the theme. B8 stays on the Later list.
3. ✅ **Motion (C1–C5) (v3.4):** rating feedback afterimage (setting); goal ring fill and completion; finish count-up, streak flame, confetti at most once a day; Play combo flames and grade stamp; tab transitions and sheet springs (setting "Smooth transitions"). Reduced motion always wins. Built in `js/fx.js` plus section 16 of styles.css; the Settings switches are "Rating feedback" and "Smooth transitions" (this device only). Ratings never wait for an effect (measured about 4.5 ms before and 5 ms after, key to next card). The browser tests now run with reduced motion on by default (tests/browser/pw.mjs); e2e-motion.mjs turns it back on to test the effects.
4. ✅ **First impression (D1–D6) (v3.6):** the welcome screen is a landing page (a mini card with the Again/Hard/Good/Easy gaps, a sharper headline, three points, "Try it: 30 seconds", two columns with a phone mock from 1024px); the sample deck matches the promise (sample cards come first and are labelled honestly, the done screen shows when each card comes back and offers "Add your <course> cards", an empty course on Today shows "+ Add cards" instead of a green tick, Skip lands on an empty Today with Paste notes, Try sample cards and How it works, which re-opens the welcome at `#/welcome/again`); a violet icon set (SVG favicon, maskable, monochrome, Apple touch icon, all saved offline); Open Graph and Twitter tags with an absolute og:image and a canonical link; an install card on Today after the first finished Review session (`js/install.js`: Install / Not now on Android and desktop, Add to Home Screen steps on iPhone Safari, hidden when installed, dismissal remembered per device) and an Install app row in Settings; a richer manifest (no portrait lock, shortcuts, screenshots, categories, display_override); and a README with a hero picture, a comparison table, six headline features and fresh screenshots made by `tests/browser/readme-shots.mjs`. The files-hash in sw.js now covers `icons/` too.
5. ✅ **Desktop sidebar (v3.9):** from 1024px the tab bar is a richer sidebar (option 6 of the sidebar design round; phones are unchanged). A quiet "+ Add cards" under the logo (the gear moved to the footer), a Today count (the same number as Start) and an amber/red exam dot on Decks, a folding "Decks" list (top-level decks with colour stripe, due count and an exam pill within 14 days, scrolling inside with a fade, "+ New deck" at the end), and a footer with the 30px goal ring and streak, sync status, Settings with the version, a light/dark toggle and a collapse toggle. Collapsed it is a 72px icon rail (counts become dots, decks become colour dots with exam rings and tooltips), remembered per device and set from the head script so there is no flash. 248px wide from 1280px, 232px from 1024px.
   Built in `js/sidebar.js` (refreshed on start, after rounds, deck edits and applied syncs, reusing Today's data) and section 18 of styles.css; `toggleMode()` is in themes.js. Tested by `tests/browser/e2e-sidebar.mjs` (including AA contrast for every accent in dark, light and OLED).

Later: audio cards, the "these look like notes" paste banner, one-tap AI cards (Supabase Edge Function, about $3 a semester), sharing decks.

## Algorithm follow-ups (v3.5, tested in simulation first)

Simulated with the app's real code, three learner types, 48+ scenarios, 60 seeds each:
- ✅ **Play speed judged against your own pace:** after 50 right answers per mode, Hard if over 2.2× your usual time for that much text, Easy (typing only) if under 0.5×; before that, the old 30% / 70% of the timer. Rating accuracy 67% → 80%, worst retention cell −0.11 points, workload neutral.
- ✅ **Multiple choice on a due card counts at most as Hard** (recognition is easier than recall): no scenario worse, +2–3% reviews, and later recall after a Play-counted review rose from 73% to 78%.
- ❌ **Backlog after a break ordered by lowest recall:** no benefit with a normal limit, and worse with a tight daily limit (−0.9 to −1.5 points), so the order stays most-overdue first.

## Polish pass (after v3.1, approved from the Polish Preview)

Four design reviews (visual, layout, motion, first impression) and before/after renders; the owner picked by number. New switches go in a new **Settings → Appearance** section (this device only), on by default.

1. ✅ **Visual fixes (A1–A6) (v3.2):** one font for Start and no mono in prose, solid tab bar and header; calm deck label on cards, readable long answers (setting: card text **Auto** / Center / Left, Auto = long answers left), framed pictures; exams in amber (red only inside 3 days), Again in crimson so Ember's accent stands alone; one deck-page stripe and one empty state; Stats charts use their height, solid bars, calmer hardest list; one content width on desktop. Also check Today's time estimate (a render showed ~1 min per card): fixed, only same-session answers under 45 s apart count, from Review's own recent log rows (Play and imported Anki history are ignored).
2. ✅ **Layout (B1–B7) (v3.3):** a short card action sheet in Review and Play (Edit, Flag, Bury, Suspend, More; More is the full panel, Edit is a short editor) and Save returns to the same card with a toast; one sheet frame everywhere (title and × top-right, sticky footer with the main button on the right, a grab bar that really swipes closed); a 2px Review progress bar (done ÷ done + left, relearning included, outside the redrawn part) and an icon Undo; Decks that scale (search, sort Due / Exam / A–Z, subdecks folded and remembered per device, small round play buttons, tiles that keep their height; setting "Compact deck list", on by default, off brings the old list back); exam date in 3 taps (Today chips and the deck page, saved through the same code as Edit deck so pull-in and validation run); a per-course Stats header (readiness ring from the exam.js recall helpers, exam badge, seen and mature counts, Exam prep, Mastery on top) with a reusable searchable deck-tree picker (setting "Exam readiness in Stats", on by default); and from 1200px a 3-column Decks page (deck tree, the deck, the card editor docked on the right). Both settings are this-device-only, like the theme. B8 stays on the Later list.
3. ✅ **Motion (C1–C5) (v3.4):** rating feedback afterimage (setting); goal ring fill and completion; finish count-up, streak flame, confetti at most once a day; Play combo flames and grade stamp; tab transitions and sheet springs (setting "Smooth transitions"). Reduced motion always wins. Built in `js/fx.js` plus section 16 of styles.css; the Settings switches are "Rating feedback" and "Smooth transitions" (this device only). Ratings never wait for an effect (measured about 4.5 ms before and 5 ms after, key to next card). The browser tests now run with reduced motion on by default (tests/browser/pw.mjs); e2e-motion.mjs turns it back on to test the effects.
4. ✅ **First impression (D1–D6) (v3.6):** the welcome screen is a landing page (a mini card with the Again/Hard/Good/Easy gaps, a sharper headline, three points, "Try it: 30 seconds", two columns with a phone mock from 1024px); the sample deck matches the promise (sample cards come first and are labelled honestly, the done screen shows when each card comes back and offers "Add your <course> cards", an empty course on Today shows "+ Add cards" instead of a green tick, Skip lands on an empty Today with Paste notes, Try sample cards and How it works, which re-opens the welcome at `#/welcome/again`); a violet icon set (SVG favicon, maskable, monochrome, Apple touch icon, all saved offline); Open Graph and Twitter tags with an absolute og:image and a canonical link; an install card on Today after the first finished Review session (`js/install.js`: Install / Not now on Android and desktop, Add to Home Screen steps on iPhone Safari, hidden when installed, dismissal remembered per device) and an Install app row in Settings; a richer manifest (no portrait lock, shortcuts, screenshots, categories, display_override); and a README with a hero picture, a comparison table, six headline features and fresh screenshots made by `tests/browser/readme-shots.mjs`. The files-hash in sw.js now covers `icons/` too.
5. ✅ **Desktop sidebar (v3.9):** from 1024px the tab bar is a richer sidebar (option 6 of the sidebar design round; phones are unchanged). A quiet "+ Add cards" under the logo (the gear moved to the footer), a Today count (the same number as Start) and an amber/red exam dot on Decks, a folding "Decks" list (top-level decks with colour stripe, due count and an exam pill within 14 days, scrolling inside with a fade, "+ New deck" at the end), and a footer with the 30px goal ring and streak, sync status, Settings with the version, a light/dark toggle and a collapse toggle. Collapsed it is a 72px icon rail (counts become dots, decks become colour dots with exam rings and tooltips), remembered per device and set from the head script so there is no flash. 248px wide from 1280px, 232px from 1024px.
   Built in `js/sidebar.js` (`drawSidebar()`: runs on start, after Review/Play rounds and deck edits, and on sync events that applied changes; Today hands over the data it already loaded, so there are no extra log reads; route changes only move `aria-current`), `toggleMode()` in `js/themes.js` (Auto becomes an explicit light or dark), the sidebar frame in index.html and section 18 of styles.css. The keyboard order follows the visual order (the sidebar comes before the page in the document on desktop). The deck page keeps its own deck-tree column. `tests/browser/e2e-sidebar.mjs` covers it, including AA contrast for all five accents in dark, light and OLED.

Later: "These look like notes" paste banner (B8), with the one-tap AI cards.

## Round 2 (in progress, plan in `docs/design/round2-plan.md`)

- **Batch 0A, rescue logic (B1), no UI yet:** `rescueToday`, `rescueBacklog`, `rescueOffer` and the `rescue` parameter of `queueFrom`/`buildQueue` in `js/queue.js`; `loadAll` computes `data.rescue` from `settings.rescue` and `countFor` passes it on (the `rescue` setting itself, its sync and the Today banner are Batch 2; Review still has to pass `data.rescue` to `buildQueue`). Simulated first (`tests/sim/compare/report-rescue.md`, 30 seeds): the plan cuts the worst day after a break by 56 to 84% but costs a little recall while it runs, so rule 2 failed at larger N; the offered N is capped at 5 (`RESCUE_MAX_DAYS`; the rule to the letter gives 3). "I'm away" review-ahead failed its rule (recall on the first day back +1.5 to +3.2 points, but lower a week later), so describe it as lighter, not better.
- **Batch 2A, "Back from a break" (B1 UI):** Today offers a catch-up plan when 30+ cards are overdue and at least twice your usual day (`rescueState` in `js/study-data.js` reads your usual from the median of your last 14 study days, 20 until there are 3): "150 overdue cards piled up. Spread them over [2 days][3 days]?" with the per-day load; the plan is capped at 3 days (`RESCUE_MAX_DAYS`, owner decision in round2-plan section 9), so the chips are 2 and 3. "Spread them out" opens `js/rescue-sheet.js` (lazy): the "Pause new cards until caught up" switch (on by default; exam decks keep theirs), a warning when `reviewLimit` is lower than the day's share plus your usual, and for a running plan "Show everything now". A running plan shows "Catch-up plan: day 2 of 3 · 64 left" with Details. The plan is the synced setting `rescue` (newest wins; `DEFAULT_SETTINGS.rescue = null`, `SYNCED_SETTINGS`, validated by `checkBackup`/`validRescue`); Today clears a finished plan (loadAll never writes) and "Not today" is remembered for the day in localStorage (`study-sprint-rescue-dismissed`). `review.js` passes `data.rescue` to `buildQueue`, so Review matches Start and the sidebar. No "I'm away until..." (it failed the simulation). Tests: `tests/browser/e2e-rescue.mjs`, `rescueState` in `study-data.test.js`, `rescue` in `sync.test.js` and `backup.test.js`.
- **Batch 0B, pure modules not yet wired in:** `js/steps.js` (B5, `Step N:` parsing with a maths mask), `js/confusion.js` (B2, mix-up pairs from `mixedWith` log rows), `js/scratchpad.js` (B4, pen/finger drawing over a Review card).
- **Batch 1A, counts and decks (A2, A4, A6):** "Due" is one number everywhere: `deckCounts` in `js/study-data.js` (`countFor` adds `cards`) gives due / fresh / total plus `scheduled`, `heldBySiblings` and `heldByLimit`. The deck page reads "13 due today · 5 new today · 23 cards", says what waits until tomorrow, and notes shared limits; its subdeck rows and the deck tree (`.dt-n` = due, card count in the tooltip) use the same numbers. With the sidebar open the deck-tree column is hidden (it stays beside the icon rail) and the `.dock-empty` placeholder is gone. Empty deck: "+ Add cards" instead of a tick; the ring says "43% mastered"; the empty Decks screen is `emptyStartHTML`; Today lost "N answers today" and the per-row "~1 min", and its exam chips scroll sideways; the deck page's Exam prep is the main button within 14 days and Edit / Add subdeck / Export live in a ⋯ menu. Fixed: double-click Create deck (#1), exam sheet double save (#6), a long parent-deck name overflowing at 1440 (#10). Tests: `tests/browser/e2e-counts.mjs`, `e2e-bugs1a.mjs`, `tests/study-data.test.js`; `tests/sw.test.js` now reads the cache name from `sw.js`.
- **Batch 1D, Import (A3), card editor and Welcome polish (A6), bug fixes (v4.3 work):** the Import deck picker is on top and starts on the deck of the last import (`study-sprint-import-deck`); the save button names the deck ("Add N cards to “name”", a hint when a new deck has no name) and never says "new deck"; lines with `{{c1::…}}` are included automatically through `withClozeLines` in `js/cloze.js` (no `#clozeBtn`; the link "Keep {{c1::…}} lines as plain cards" turns it off until the text changes); `buildCards` reads cloze rows from columns 0 and 1; IMPORT and BROWSE eyebrows removed. Card editor: Add is disabled with a reason line (`#acWhy`), plain-words cloze help, Done became Close, one `--s-3` gap and a fixed minimum body height. Welcome: "Create course", a muted empty exam date. Bugs: #1 double-click Add makes one card (an `adding` guard in `openAddCard`); #5 CSV round trip (quote-aware lines before `cleanLines`, the Tags column is imported, a lone `-` `*` `•` front is kept, export puts a `'` before `= + - @` and import strips it); #7 Escape on the docked editor returns the focus to the card row (`closeSheet` in `js/ui.js`). Tests: `tests/cloze-lines.test.js`, `tests/csv-roundtrip.test.js`, `tests/browser/e2e-round2-1d.mjs`.
- **Batch 1B, Review (A1, A6):** the finish screen has "Keep going · N cards" (exactly Today's Start scope), a links row (Decks, Undo last), the "Nice work / Session done / Session ended" titles, a `#finishMore` slot filled by `drawFinishExtras`, and "Due tomorrow" computed once over the same decks. `R.answered`/`R.leeches` follow Undo. Leech toast: "Leech: suspended. You can fix it at the end of the session." The Review bar shows Undo only when there is something to undo and Speak sits in the card corner; key hints show only with a mouse; occlusion Review has a bigger picture, dark covers in light mode (≥3:1) and a 32px zoom button. Fixed: double-tapping Undo lost an entry; `#/review/<empty deck>` says "No cards yet" and a missing deck says "Deck not found". Tests: `tests/browser/e2e-finish.mjs`.
- **Batch 1E, Settings and Stats polish (A6):** Settings is four sections (Appearance, Study, Sync, Your data) with a sticky jump row (`.set-nav`); Theme, Light or dark and OLED moved into Appearance; the descriptions are one sentence with no history wording; 5 theme tiles in a row from 1024px. Stats: the deck search is a box with a search icon, the Retention fine print is behind an (i) `<details>`, the calendar starts at the first month with answers (`calendarFromDays` option `from`, `firstAnswerTime`), the Hardest list shows an occlusion card's label and a 40px picture thumbnail, the forecast tooltip says "Scheduled for today (before daily limits)", and empty Stats uses `emptyStartHTML`. The hiding rule for the DECKS/STATS/IMPORT eyebrows is gone, and so are the SETTINGS and PROGRESS eyebrows (LIBRARY is 1A's). Test: `tests/browser/e2e-round2-1e.mjs`.
- **Batch 1C, Play results and polish (A5, A6, bug 8):** the results order is head, stats, actions, schedule note, `#resultsMore` (filled by `drawFinishExtras` with the leeches the round caught, `round.leeches`), then Missed (first 3, "Show all n"). A first score says "First score for this setup"; a best shows "Grade X" instead of the label; C and D get a quiet stamp. Play's key hint shows only with a mouse, the PLAY eyebrow is gone, the empty screen uses `emptyStartHTML`. Re-tapping the Play tab on Play re-renders it (app.js `wireGear`). Tests: `e2e-play-results.mjs`.
- **Batch 2C, "You mix these up" (B2):** the log field `mixedWith` (owner-approved) is set by Play when a multiple-choice pick came from another card (`G.optIds`, from `pickDistractors(..., { withIds: true })`) or a wrong typed answer is exactly another card's answer (`checkTyped` with `forgiving: false`, same round pool, first 2000 cards, siblings skipped); never for time-outs or skips. `pickDistractors` also takes `include: [label]`, which forces an option in. `importAll` drops `mixedWith` unless it is a string of 1 to 200 characters (`cleanMixedWith` in `js/db.js`); `checkBackup` ignores it. `js/compare-sheet.js` (lazy) has `openCompare(a, b)` and `loadPairs()`: two columns (stacked under 600px), Drill these (`drillCards(ids, { mix, total: 6 })`: the pair plus 4 look-alikes from `neighbours` in `confusion.js`, the partner's answer always an option), Make a comparison card ("A vs B: what's the difference?", opened for editing) and Not confused (`study-sprint-mix-dismissed`, this device). `pairsPanel` in `js/finish-extras.js` shows up to 3 pairs (the panel fills in a moment after the leech panel because it reads the 90-day log; `drawFinishExtras` now returns a promise); the card panel says "Often mixed up with: X (3×) · Compare". Note: the 2-minute debounce counts one direction once, so a pair needs both directions or two sessions apart (the e2e picks A's answer for B and B's for A). Typed Review capture is Batch 3. Tests: `tests/confusion.test.js`, `game.test.js`, `backup.test.js`, `finish-extras.test.js`, `tests/browser/e2e-mixups.mjs`.

- **Batch 2B, scratchpad, steps and memory hook (B4, B5, B7; v4.6):** Review has a pen button `#scratchBtn` (key D) wiring `mountScratch` over the card: on or off kept per device (`study-sprint-scratch`), cleared on the next card, kept through a flip and an edit redraw, destroyed on leaving Review, hidden while the zoom viewer is open, and the flip click ignores `.scratch` and `.scratch-tools`. Step cards (`parseSteps` with `maskMath`) have no typing; after the flip `#stepBtn` reveals step N of M (Space/Enter/→, focus on the step, `aria-live`), A shows all, the ratings come after the last step and 1–4 work early; Read aloud uses `stepsSpeech`. Play: `isFrontOnly` includes stepped cards and `questionFor` front asks for `finalStep`. The Basic editor has "Answer in steps" (step fields, + Add step, reorder, delete, Final answer; saves `joinSteps`) and a "Memory hook (optional)" field stored in `noteExtra`, shown under the answer on Basic cards and appended to Back in the Anki export. Tests: `e2e-scratchpad.mjs`, `e2e-steps.mjs`, additions to `game`, `export` and `speech` tests.
- **Batch 2D, leech coach (B7; v4.8):** the Review finish and Play results show **Cards you keep forgetting** (`leechPanel` in `js/finish-extras.js` now loads `js/leech-coach.js`, pure helpers in `js/leech-logic.js`): one row per leech (front/back, "Forgotten N×") with **Memory hook** (saved to `noteExtra`, shown under the answer), **Split** (2 to 4 rows prefilled from the back on `;`, line breaks and bullets; the original is deleted after an in-page confirm, or kept suspended), **Comparison** (the partner from the mix-up pairs, else a search, then `openCompare`), **Edit**, and **Delete**, **Keep suspended**, **Fix later**. Hook and Edit unsuspend, drop the `leech` tag and keep the schedule (owner decision Q8). Cards that no longer exist are skipped. The leech toast is unchanged. `#/browse/leech` opens All cards on the Leeches filter (the route argument sets the initial filter in `mountBrowser`); Decks (footer) and Stats (Hardest cards) link to it with "N cards to fix". Tests: `tests/browser/e2e-leech-coach.mjs`, `tests/leech-coach.test.js`.
- **v4.8.1 review fixes** (`docs/design/batch2-review.md`, all items of the 2A–2C review and the leech coach review): a finished catch-up plan is cleared with the plan's own time and not while the first sync runs; the day's allowance is never below an equal split of what is left; "Show everything now" also dismisses the banner; step text must read back as the same steps (the intro is a visible field); a mouse click on the pen or a tool no longer takes focus; a pen landing after a palm takes over; Play's typed mix-up check uses an index built once per round; leech coach: Split guarded against double taps, hidden on cloze/note/occlusion cards, keeps the back picture and hook, defaults to keeping the original; focus handling, comparison closes the row, Edit no longer tags cloze siblings. Tests: `tests/review-fixes.test.js`, additions to `queue`, `study-data` and the rescue, steps, scratchpad, mixups and leech-coach e2e files.
- **v4.9, "the game is secondary" (owner request: reviewing decks is the main feature, Play is a little fun thing):** (1) The Today goal ring counts to a fixed **daily goal**, the synced setting `dailyGoal` (default 20, owner-approved; `DEFAULT_SETTINGS`, `SYNCED_SETTINGS`, `checkBackup`/`validDailyGoal` accept an integer 1 to 500; Settings > Study has a "Daily goal" stepper). The ring reads answers today / `goalFor(settings, answered, left)` in `js/study-data.js` = `max(dailyGoal, answered + still to do)`, used by both Today and the sidebar footer, so it is never 0/0, extra study counts and it never reads 25/20; it shows the green check only once the goal is met and nothing is left. (2) A Play round starts only from the Play page: removed Today's "Play a round" (All done now shows "All done for today", the next due time and a quiet "Custom study" link), the Review finish "Play a round" box (the streak stays in `.finish-next`), Stats Hardest "Drill these" and the Compare sheet's "Drill these". Both became **"Review these"**: a new Custom study kind `ids` (`pickedQueue` in `js/queue.js`, `customQueue(..., ids)`, `launchStudy({ kind: 'ids', cardIds })`, session label "Review these"). `drillCards` and its pending-drill state are gone from `js/play.js`; "Drill missed" on Play results stays. (3) Play has **no "All decks"**: one deck (and its subdecks) per game, chosen by `pickPlayDeck` in `js/exam.js`: nearest exam, else the saved deck, else the first deck with cards; a saved `all` (or a deleted deck) is migrated to a real deck and saved. Tests: `tests/browser/e2e-v49.mjs` (ring, Settings stepper, no Play links, Play picker, screenshots at 375 and 1440, dark and light), `goalFor` in `study-data.test.js`, `pickPlayDeck` in `exam.test.js`, `pickedQueue` in `queue.test.js`, `dailyGoal` in `backup.test.js`; changed expectations (with comments) in `e2e-today`, `e2e-finish`, `e2e-stats`, `e2e-mixups`, `e2e-motion`, `e2e-browse`.

## Parked (not planned for now)

- **One-tap AI card generation through the Claude API.** Needs a small backend to hide the key, and API usage costs money. The "Make cards with Claude" copy-and-paste button covers this for now.
- **AI-made wrong answers for Play:** have Claude also write 2–3 believable wrong answers per card (e.g. "operant conditioning" as a trap for "classical conditioning"), stored with the card and used as multiple-choice options, so definition-style decks get exam-like distractors instead of other cards' unrelated backs. Parked together with the item above.
