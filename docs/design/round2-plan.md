# Round 2 plan: A1–A6 screen fixes, B1 rescue, B2 mix-ups, B4 scratchpad, B5 steps, B7 leech coach

Written by the planning review against `quick-wins` at b257ca9. Line numbers are approximate. Owner decisions are at the end.

## 0. Rules for every coder
- **Every merged commit:**
  - Bump `CACHE` in `sw.js`. On a conflict, take the higher number + 1, then run `node tests/update-sw-hash.mjs`.
  - New `js/*.js` files go in `CORE`. A modulepreload line goes in `index.html` only if the file joins `app.js`'s static import chain (preload.test.js checks this). Everything else is lazy, via `import()`.
  - `APP_VERSION`: 4.3 A fixes · 4.4 B1 · 4.5 B4 · 4.6 B5 · 4.7 B2 · 4.8 B7.
  - Add PLAN.md "Round 2" entries and README lines.
- **Date-dependent browser tests:** `await page.clock.setFixedTime(new Date(2026, 9, 14, 12))` before `goto`. Build timestamps in the page with `daysAgoStart`. To move to another day, call `setFixedTime` again and reload.
- **Every new e2e test** checks for no `pageerror` and `scrollWidth ≤ 375` at 375px.
- **Batches 1–3 start after quick-wins F2 (KaTeX) is merged**, because the files overlap. Batch 0 can start any time.
- **CSS:** edit existing rules only for your own screens. New rules go in your own new section at the end: 22 counts/decks · 23 review · 24 play · 25 import/editor · 26 settings/stats · 27 rescue · 28 scratchpad/steps · 29 mix-ups · 30 leech coach.
- **Eyebrow labels:** keep them only where they carry information (Today's date, a course code, breadcrumbs, the finish state). Delete PLAY, SETTINGS, IMPORT, BROWSE, LIBRARY, PROGRESS and Review's empty-state REVIEW, each in the batch that owns that file. 1E removes the hiding rule at styles.css:195.

## 1. Batches (files owned)
**Batch 0 (any time):**
- **0A:** the B1 simulator and pure rescue logic.
  - Files: `tests/sim/compare/harness2.mjs`, `summarize2.mjs`, `report-rescue.md`, `js/queue.js`, `tests/queue.test.js`.
  - Plus `loadAll` in `js/study-data.js`, which passes `settings.rescue` through.
- **0B:** pure modules, not yet wired up.
  - `js/steps.js` + test, `js/confusion.js` + test.
  - `js/scratchpad.js` (DOM).
- **0C:** shared pieces.
  - `js/empty-state.js` (`emptyStartHTML({ courseId })` and `wireEmptyStart(el)`, the Today empty-state block moved here). It is a boot module, so add a modulepreload line.
  - `js/finish-extras.js`: `drawFinishExtras(slot, { source, cardIds, leechIds, entries })` calling the stubs `leechPanel()` and `pairsPanel()`. Lazy.

**Batch 1** (after F2 is merged; 5 coders in parallel):

| Coder | Items | Files |
|---|---|---|
| 1A | A2, A4, A6 (empty-deck tick, % rings, empty Decks, Today repeats / ~1 min / exam chips, deck page Exam prep + ⋯ menu) | study-data.js, decks.js, today.js, css §22 + deck-tree block |
| 1B | A1, A6 (Review key hints, top bar, occlusion), collecting answered and leech ids | review.js, occlusion.js (zoom button only), css §23 + key-hint rules |
| 1C | A5, A6 (Play key hint, Play empty state), collecting leeches, results slot | play.js, css §24 |
| 1D | A3, A6 (card editor, Welcome), BROWSE eyebrow | import-screen.js, import.js (`buildCards`), cloze.js (new helper), browse.js (`openAddCard` + header only), card-editor.js, onboarding.js, css §25 + line ~613 |
| 1E | A6 (Settings sections, Stats polish, eyebrow CSS) | app.js (`renderSettings` only), stats.js, stats-calc.js (calendar start), deck-picker.js, css §26 + line 195 |

**Batch 2** (after Batch 1):

| Coder | Items | Files |
|---|---|---|
| 2A | B1 UI | today.js, study-data.js, queue.js, db.js (`DEFAULT_SETTINGS`), sync-data.js (`SYNCED_SETTINGS`), new `rescue-sheet.js`, css §27 |
| 2B | B4, then B5, plus the memory-hook field | review.js, scratchpad.js, steps.js, card-editor.js, browse.js (add/edit forms only), game.js (`questionFor`/`isFrontOnly` only), speech.js, css §28 |
| 2C | B2 (ships compare-sheet.js first) | play.js, game.js (`pickDistractors` only), confusion.js, finish-extras.js (`pairsPanel`), browse.js (`openCardPanel` "Mixed up with" only), db.js (`checkBackup`/`importAll` cleaning), new `compare-sheet.js`, css §29 |
| 2D | B7 (needs compare-sheet.js) | new `leech-coach.js`, finish-extras.js (`leechPanel`), browse.js (initial-filter route arg), app.js (route `#/browse/<filter>`), css §30 |

**Batch 3:**
- B2 capture in typed Review answers (`submitTyped`).
- The bug-hunter's fixes.
- A full regression run, README screenshots and the PLAN entries.

## 2. Part A: fixes to existing screens

### A2 "Due" numbers (1A, first)
**Where the numbers come from now:**
- `countFor` (Review's real queue: limits, one card per note a day, exam pull-ins, learning cards; suspended/buried excluded) feeds Today, the sidebar, Decks tiles and the Options chips.
- The deck page's `summarize` (decks.js:36) is raw.
- `subdeckRows` is raw.
- The desktop tree shows `stats.total`, the card count.
- The Stats forecast is raw.
- The finish screen's "Due tomorrow" is raw, counts today's leftovers, and covers only the studied decks.

**Meaning:** "Due" = how many already-studied cards Review will show you today if you start that deck now, with limits, one card per note a day and exam pull-ins applied. "New" = how many new cards it will introduce today.

**Changes:**
- **study-data.js:** `deckCounts(data, deckIds)` → `{ due, fresh, total, scheduled, heldBySiblings, heldByLimit }`.
  - `scheduled` = the raw reviews + waiting.
  - `dueNoLimit` comes from `queueFrom` with Infinity limits.
  - `heldByLimit = dueNoLimit − due`; `heldBySiblings = scheduled − dueNoLimit`.
- **decks.js:**
  - `renderDeck` loads `loadAll()`. The summary reads "<b>13</b> due today · <b>5</b> new today · 23 cards".
  - When something is held back, add "· 4 wait until tomorrow (one card per note a day / daily limit)".
  - `subdeckRows(kids, depth, today)` uses `countFor`.
  - When a parent's limit is shared, add the note "Daily limits are shared, so subdecks can add up to more than {Course}'s {n}".
  - In dev, a `console.warn` when there are no limits and Σ ≠ the parent.
- **Deck tree:** `.dt-n` = due (hidden at 0, `aria-label` "n due"); the card count goes in `title`.
- **Stats forecast tooltip (1E):** "Scheduled for today (before daily limits)".
- **Finish "Due tomorrow" (1B):** non-new, not hidden, due ≤ `dayEnd(now, 1)`, across the same decks as Keep going.

**Tests:**
- Unit `tests/study-data.test.js`: no limits → parent = own + Σ children; `reviewLimit`; siblings → heldBySiblings; suspended excluded; exam-capped counted.
- `e2e-counts.mjs`:
  - The same number on: Today `.td-counts .due b`, sidebar `.side-due`, the Decks tile, the deck page summary, and the Review counts sum.
  - Subdecks + own = parent.
  - The held-back line with `reviewLimit`.
  - The tree shows due at 1440 with the rail on.

### A1 Review finish screen (1B)
- **After `drawSidebar()`:** `loadAll()` and `rest = countFor(data, todayScope)`, where `todayScope` = `settings.reviewDecks` if it lists existing decks, otherwise all decks.
- **Buttons:**
  - `rest.total > 0` → primary `#keepBtn` "Keep going · N cards", which runs `R = null; startStudy({ deckIds: settings.reviewDecks })` (lazy import from today.js).
  - Otherwise the primary is `#againBtn` "Back to Today".
  - When Keep going shows, `#againBtn` is ghost. "Play a round" stays in `.finish-next`.
- **Links row:** `<p class="fin-links">` with `<a class="link" href="#/decks">Decks</a>` · `<button class="link" id="undoLast">Undo last</button>` (only when `R.undo.length`).
- **Remove the calendar `fn-line`.** "Due tomorrow" is shown once, using the A2 definition.
- **Title:** "Nice work" only when reviewed and nothing is left; otherwise "Session done" or "Session ended".
- **`<div id="finishMore">`** between `.stats4` and `.finish-next`, filled by `import('./finish-extras.js').then(m => m.drawFinishExtras(slot, { source: 'review', cardIds: [...R.answered], leechIds: R.leeches }))`.
- **Tracking:** `R.answered = new Set()` and `R.leeches = []`, both kept in step with undo.
- **Leech toast:** "Leech: suspended. You can fix it at the end of the session."
- **Edge cases:** Custom study and exam prep still mean Today's session for Keep going; an early end; learning cards later today count; the `location.hash` guard while loading.
- **Tests:**
  - `e2e-finish.mjs`:
    - Keep going N equals the sidebar badge at 1440; clicking it opens deck B.
    - Nothing left → `#againBtn.primary`.
    - "Nothing due tomorrow" never appears; `#undoLast` is there.
    - At 375, at most 2 button rows.
  - Update e2e-review, adv, p3, step2, today, firstimpression and leech.

### A3 Import (1D)
- **Deck picker on top:** `.section:not(#preview)` gets `order:1` (CSS ~613).
- **Default deck:** the route arg, otherwise `localStorage['study-sprint-import-deck']` if it still exists, otherwise New deck. Save it after a successful save.
- **Save button:**
  - Empty new-deck name: "Add N cards" plus the hint "Name the new deck above".
  - Named: "Add N cards to “{name}”". `#newName`'s input calls `refreshFlags()`.
  - It never says "new deck".
- **Cloze lines included automatically:**
  - `withClozeLines(text, parse)` in cloze.js (pure) splits cloze from the other lines and merges the rows, with a `clozes` array (null-padded). The label reads e.g. "separated by ' - ', plus 1 cloze note".
  - `buildCards`: cloze rows use `r[0]`/`r[1]` whatever columns are chosen. When every line is cloze, use `parseCloze`.
  - Remove `#clozeBtn`. Add the link "Keep {{c1::…}} lines as plain cards" (`S.noCloze` until the text changes).
  - The markdown-table format wins over auto-cloze.
- **Tests:**
  - Unit: `withClozeLines` (mixed, all, none, padding, label); `buildCards` with cloze rows when frontCol = 2.
  - e2e:
    - `#deckSel` above `#pasteBox` at 375
    - cloze badge, no "Missing a side", saving makes cloze cards
    - the button wording
    - the last deck preselected

### A4 Desktop deck page (1A; reverses the earlier "keep the column" choice)
- **CSS:** `html:not([data-rail="on"]) .deck-tree{display:none}`. With the rail on, the tree stays (it's the only list with names).
- **Remove `.dock-empty`.**
- **Main:** `margin-right: 0` by default, and `var(--panel)` only when `body.has-side`. Escape returns to full width.
- **Unchanged:** nothing below 1200px; no sidebar.js change.
- **Tests (e2e-roundC / desktop / sidebar):**
  - At 1440 with the rail off: the tree is hidden and `.br-list` > 800px wide.
  - A card click opens the side panel and main narrows; Escape restores it.
  - With the rail on, the tree is visible.

### A5 Play results (1C)
- **Order:** head → `.stats4` → `.res-actions` → schedule note → `#resultsMore` → `.missed`.
- **Missed list:** the first 3 are shown, the rest hidden, plus `#showAllMiss` "Show all {n}".
- **"New best" fix:**
  - No previous score → "First score for this setup".
  - When it is a best, `res-grade` shows a small "Grade {letter}" (no "Keep practicing"). The stamp is only for S/A/B.
- **Leeches:** collect `round.leeches`.
- **Tests:**
  - DOM order; 5 misses → 3 shown plus "Show all 5".
  - "First score"; a D best has no "Keep practicing".

### A6 Polish
- **Key hints (1B CSS, 1C):** `.key-line`, `.key-hint` and Play's `.hint.keys` show only under `@media (hover:hover) and (pointer:fine)`.
- **Empty deck (1A):** `stats.total === 0` → `<a class="deck-go add" href="#/import/{id}">+ Add cards</a>`.
- **% rings (1A):** "43<small>%</small>" plus the caption "mastered".
- **Empty Decks/Play/Stats:** use `emptyStartHTML`/`wireEmptyStart`.
- **Card editor (1D):**
  - Add is disabled with a reason line `#acWhy` until it can save.
  - Plain-words cloze help (no raw code). "Same blank as the last one".
  - Done → Close. A consistent `--s-3` gap between fields. A fixed `min-height` on the kind body.
- **Occlusion Review (1B):**
  - `.rv-card .occ` up to `min(70dvh, …)` and full width.
  - Light-mode masks: `color-mix(in oklab, var(--text) 78%, transparent)` with a 1.5px outline (≥ 3:1 contrast).
  - `.occ-head`: normal letter-spacing and `var(--fs-md) var(--f-ui)`.
  - Zoom button: 32px, `inset: 6px`.
- **Phone Review bar (1B):**
  - Undo only when `R.undo.length`.
  - Speak moves into the card corner (`.rv-speak`, with `stopPropagation`).
  - The bar becomes: counts · [Undo] · ⋯ · End.
- **Today (1A):**
  - Remove "N answers today" and `.td-min` on rows.
  - `.exam-add`: `nowrap` with sideways scroll.
- **Deck page (1A):**
  - When the exam is ≤ 14 days away, `#prepBtn` becomes `btn primary small`.
  - Edit / + Subdeck / Export go into a ⋯ menu.
- **Settings (1E):**
  - A sticky `.set-nav` (Appearance · Study · Sync · Your data).
  - Theme and Light/dark move into Appearance.
  - One-sentence descriptions with no history wording.
  - 5 theme tiles across from 1024px.
  - Keep the ids.
- **Stats (1E):**
  - The deck search looks like a box; the Retention fine print goes into an `(i)` `<details>`.
  - The calendar starts at the first month with answers (`calendarFromDays` `from`).
  - The Hardest list shows the occlusion label + a 40px thumbnail.
- **Welcome (1D):** "Create course" wording; `#wlExam.empty` gets a muted colour.

## 3. Part B: new features

### B1 "Back from a break" rescue (0A, then 2A)
**The plan:**
- Stateless: `settings.rescue = { start, days: N, backlog, pauseNew: true, at }`. This is a synced setting (owner question 3).
- A backlog card is in review state (2), not hidden, `due < start`, and its deck has no active exam (exam decks are exempt).
- Day `k = round((dayStart(now) − start)/DAY) + 1`, using `dayKey` arithmetic.
- `allow = max(0, remaining − floor(backlog·(N−k)/N))`. It corrects itself.
- The plan is inactive when `k > N` or `remaining = 0`; Today then clears it.

**queue.js:**
- `rescueToday(rescue, cards, statesById, exemptDeckIds, now)` → `null | { cutoff, allow }`.
- `queueFrom(split, newLimit, reviewLimit, answered, rescue = null)`: after the one-card-per-note rule and before `capReviews`, keep only the first `allow` backlog items. They stay most-overdue first.
- Non-backlog cards are never capped by the plan. `pauseNew` sets the new limit to 0 for non-exam decks.
- `loadAll` computes `data.rescue`; `countFor` passes it.

**Offer (2A):**
- `rescueOffer({ backlog, typicalDaily, lastStudyDay, now })`. It offers when:
  - backlog ≥ 30, and
  - backlog ≥ 2 × typical (the median of the last 14 study days, default 20), and
  - there is no plan and it wasn't dismissed today (localStorage).
- Default N = `clamp(ceil(backlog / max(typical, 20)), 3, 10)`.
- A Today banner, "120 cards piled up. Spread them over [3][5][7][10] days?", with previews like "~24 backlog + ~15 usual a day".
- `rescue-sheet.js`:
  - the "Pause new cards until caught up" switch (on)
  - a warning when `reviewLimit < quota + usual`
  - "Show everything now"
  - the active line "Catch-up plan: day 2 of 5 · 64 left"
- "I'm away until…" in Options → Custom study:
  - a date (tomorrow to +60) with "N come due before you're back"
  - "Review N now" uses `customQueue('ahead', …)`
  - when F1b is in: "Mark these as days off" (≤14) writes `restDays`

**How it fits with the rest:** FSRS is unchanged, the quota sits inside `reviewLimit`, exam decks are exempt, and load balancing is unchanged.

**Simulation (0A), harness2 break scenarios Gb/Ab:**
- **Environment variables:** `RESCUE=N`, `PAUSE=0|1`, `AWAY=all|30`.
- **Metrics:** `recPeak`, `recP90`, `R30end`.
- **Grid:**
  - `BREAK` {7, 14, 30} × `RL` {none, 150, 60} × `RESCUE` {off, 3, 5, 7, 10} × `PAUSE` {0, 1} × `AWAY` {off, all}
  - 3 learners, 60 seeds
  - Ab with `RESCUE` 5
- **Pass rules (set before running):**
  1. With `RL` none and N ≥ 5, `recPeak` is at least 40% lower than base.
  2. `recMeanR`/R14/`R30end` are no worse than base by more than 0.5 points in any cell; `recLostDays` is at most +5%.
  3. With `RL`=60, no cell is worse than −0.3 points.
  4. Exam day within ±0.2 points.
  5. Away mode: R7 improves by ≥ 0.5 points, total reviews rise by ≤ +15%, long-run recall no worse than −0.3 points.
- **If rule 2 fails:** cap the offered N at the largest N that passes.
- Write `report-rescue.md` and a PLAN line.

**Tests:**
- `queue.test.js`:
  - backlog 100, N 5: day 1 allow 20; after 20 done, 0; a skipped day → 40; day 5 everything; after N → null
  - exempt exam; with `reviewLimit`; with siblings; `pauseNew`
  - a daylight-saving span (start `new Date(2026, 9, 24)`)
  - `rescueOffer`
- `sync.test.js`: `rescue` is synced.
- `e2e-rescue.mjs`:
  - 150 overdue 10 days + 10 due; the banner shows; choose 5 → Start = 30 + 10, matching the sidebar
  - the next day → 30 + due; a skipped day → 60
  - exam uncapped
  - "Show everything now" clears it
  - away → Review ahead
  - a backup round trip

### B2 "You mix these up" (0B, then 2C; typed Review capture in Batch 3)
**Data:**
- An optional log field `mixedWith: '<cardId>'`, set when:
  - Play multiple choice picks an option that came from another card, or
  - a wrong typed answer matches another card's back (`checkAnswer` with `{ forgiving: false }`; same round pool or session decks, cap 2000, siblings skipped).
- Not set for time-outs or skips.
- It syncs inside the log rows (no SQL); older versions ignore it.
- `importAll` drops it unless it's a string of 1–200 characters. Undo deletes the row.

**game.js:**
- `pickDistractors(..., { withIds: true })` → `[{ label, id }]`; the default stays labels only.
- `include: [label]` forces a given option.

**play.js:** `G.optIds`, then `entry.mixedWith` → `log.mixedWith`.

**confusion.js:**
- `mixPairs(logs, { cardsById, since, dismissed })` → `[{ a, b, count, last }]`:
  - unordered key `a|b`
  - the same direction within 2 minutes counts once
  - only pairs with count ≥ 2, both cards existing
  - dismissed while `dismissed[key] ≥ count − 1`
- Dismissals are per device, in `localStorage 'study-sprint-mix-dismissed'`.
- `pairsFor(cardIds, pairs)`. The surfaces read the 90-day log.

**Where pairs show:**
- Play results `#resultsMore`: "You mix these up", up to 3.
- Review finish: pairs that involve `R.answered`.
- Card panel: "Often mixed up with: X (3×) · Compare".

**`compare-sheet.js` `openCompare(a, b)`:**
- two columns (stacked under 600px)
- **Drill these:** `drillCards` of the pair + 4 neighbours, with the partner's label always an option, 6 questions
- **Make a comparison card:** "{A} vs {B}: what's the difference?" / "- {A}: …\n- {B}: …"
- **Not confused:** dismiss

**Tests:**
- Unit: confusion counting, debounce, threshold, a deleted card, dismissal and its return, the window. game.js ids and `include`. backup keeps or drops `mixedWith`.
- `e2e-mixups.mjs`:
  - seeded `Math.random`; pick B's back for A twice
  - the results show the pair; Compare; the Drill includes the partner
  - the log row and backup contain it
  - Batch 3: the Review typed capture

### B4 Scratchpad (0B, 2B)
**`mountScratch(card)`** → `{ on, off, clear, destroy }`:
- A `<canvas class="scratch">` over `.rv-card`.
  - Off: `pointer-events: none; touch-action: auto`. On: `pointer-events: auto; touch-action: none`.
- devicePixelRatio scaling, with a `ResizeObserver` that keeps the bitmap.
- Strokes:
  - pointer events + `getCoalescedEvents`
  - width = `base × (0.4 + pressure)` for a pen, 0.5 otherwise
  - quadratic smoothing, colour `--text`
  - eraser = `destination-out` at 16px
- Palm rejection: after a pen is seen, ignore touch for 1 second after the last pen event and while a pen is down. One active `pointerId`.
- Tools (top-right, when on): Pen / Eraser / Clear / Close, 40px each, `aria-pressed`.

**review.js:**
- `#scratchBtn` (pen icon, "Scratchpad (D)"), key D.
- The on/off state is per device (`localStorage 'study-sprint-scratch'`).
- `nextCard` clears; a flip keeps the drawing; leaving destroys it.
- The flip click ignores `.scratch, .scratch-tools`. Space and 1–4 still work. Not in Play.
- Typed mode covers the card only. Hidden while the zoom viewer is open.

**Tests:**
- On → `pointer-events: auto`; a mouse drag → alpha > 0, not flipped.
- Space flips; a rating clears it.
- Off → `none`, and a touch scroll moves the page.
- A pen stroke, then a touch within 1 second → nothing drawn.
- Eraser and Clear. At 375 and 1440.

### B5 Step-by-step problems (0B, 2B)
**Syntax:**
- Lines starting with `Step N:` (or `.` / `)`, case-insensitive), at least 2, numbered consecutively.
- A step continues until the next marker; text before Step 1 is the intro.
- An optional final line `Answer: …`.

**`steps.js`:**
- `parseSteps(back, { mask })` → `null | { intro, steps, final }`. The mask is `maskMath` (so `Step 2:` inside `$$…$$` isn't a split).
- `isStepped`, `finalStep`, `joinSteps`.

**Review:**
- No typing for stepped cards.
- `.steps` with hidden `<li>`s. After the flip, `#stepBtn` "Reveal step 1 of 4" (Space/Enter/→), with "Try step 1 yourself, then reveal".
- Each press reveals one step and focuses it (`aria-live`). "Show all" (A).
- The rating buttons appear once all steps are shown; 1–4 work any time after the flip.
- `R.stepShown` survives redraws. Read aloud reads the revealed steps.

**Play:**
- `isFrontOnly` includes stepped cards.
- front → `answer = finalStep`; typing only if `canType`.

**Editor:**
- Basic gets a switch "Answer in steps": one step field each, + Add step, up/down/delete, and an optional Final answer.
- Saving writes `joinSteps` into `back`. Editing a stepped back opens with the switch on.
- Export: CSV raw; Anki via `toAnkiHTML`.

**Tests:**
- Unit:
  - the marker variants, multi-line steps, intro, `Answer:`
  - one step → null; non-consecutive → null
  - inside `$$`
  - a `join` round trip
  - game final-step answer; CSV raw
- `e2e-steps.mjs`:
  - add with steps → stored back "Step 1: …\nStep 2: …"
  - after flip: 0 visible and no `.rate`; Space ×3 → all and `.rate`
  - A shows all; early 1–4 work
  - Play option = the final step
  - 375 no sideways scroll

### B7 Leech coach (0C, 1B/1C collection, 2D)
- **No interruption mid-session:** the wording changes, and the card is still suspended and tagged as now.
- **`leechPanel(ids)`** at the Review finish and Play results, one row per leech (preview, lapses):
  - **Split:** 2–4 rows, prefilled by splitting the back on `;`, line breaks or bullets. The new cards get the same deck and the tags without `leech`. The original is deleted (confirm) or kept suspended.
  - **Memory hook:** saved to `card.noteExtra`. It shows under the answer in Review for Basic cards too (the review.js ~212 condition is dropped). The Basic editor gets a "Memory hook (optional)" field. The Anki export appends it to Back as an Extra line.
  - **Comparison:** the partner comes from the B2 pairs, or a deck search → `openCompare`.
  - **Edit, Delete, Keep suspended, Fix later.**
- **After Hook or Edit:** unsuspend, remove `leech`, keep the schedule.
- **Fix later list:** the Browse Leeches filter at `#/browse/leech` (the route arg sets the initial filter). An "N leeches to fix" link in the Decks footer and Stats Hardest.
- **Tests (`e2e-leech-coach.mjs`):**
  - threshold 2 → the toast, the session continues
  - the finish panel appears
  - Split → 2 new cards and the original gone
  - Hook → `noteExtra`, unsuspended, shown under the answer
  - Fix later → `#/browse/leech`
  - the Play path

## 4. Bug-hunter fixes
- Each bug goes to the batch that owns its file. A failing test comes first, then the fix, then the CACHE bump.
- A fix that would change the data format becomes an owner question.
- Already noted: the finish "Due tomorrow" (A1/A2), Play's first "New best" (A5), the import "new deck" wording (A3).

## 5. Owner decisions
- **Q1, A4:** hide the deck-tree column while the sidebar is expanded (it stays with the rail), and open the card panel only when a card is picked. Recommended: yes.
- **Q2, A2:** "due" = what Review will show you today, with the held-back count shown separately. Recommended: yes.
- **Q3, B1:** a synced setting `rescue`. Recommended: approve.
- **Q4, B1:** pause new cards during a plan; exam decks are exempt. Recommended: yes.
- **Q5, B2:** the log field `mixedWith`. Recommended: approve.
- **Q6, B5:** the `Step 1:` syntax; existing cards that use it become step-by-step automatically. Recommended: yes.
- **Q7, B7:** the memory hook is stored in `noteExtra` and appended in the Anki export. Recommended: yes.
- **Q8, B7:** a fixed leech keeps its schedule. Recommended: yes.
- **Q9, A1:** Keep going = exactly Today's Start session. Recommended: yes.
- **Q10, B4:** remember the scratchpad's on/off per device; drawings are never saved. Recommended: yes.

## 6. Owner answers (asked 14 Oct)
- Q1 A4: **hide the deck-tree column** while the sidebar is expanded (kept with the rail); editor panel opens only when a card is picked.
- Q3/Q4 B1: **approved as planned** (synced `rescue` setting; new cards pause during a plan; exam decks exempt).
- Q5 B2: **approved** (`mixedWith` log field).
- Q7 B7: **memory hook reuses `noteExtra`** (shown under the answer on Basic cards too; Anki export appends it to Back).
- Q2, Q6, Q8, Q9, Q10: not asked separately; go with the recommendations above unless the owner objects.

## 7. Bug-hunter findings (14 Oct, v4.0). Fix in the owning batch, each with a failing test first.
Scripts and screenshots were in the session scratchpad (`bughunt/fNN.mjs`); they don't survive the session, so the steps are below.
1. **Medium. Double-click creates duplicates.**
   - Where: decks.js deckForm submit (~535) and browse.js `openAddCard` basic/cloze (~592-618).
   - Double-click "Create deck" or "Add card" → 2 decks or 2 cards. Two `requestSubmit` calls on a 2-blank cloze give 4 cards.
   - Fix: an `adding` guard like the occlusion branch.
2. **Medium. Double-tapping Undo loses an entry.**
   - Where: review.js `undo` (~378).
   - Cause: `R.undo.pop()` runs before the `R.busy` check, so 1 review stays logged and can't be undone.
3. **Medium. The typed-answer check is too loose or too strict.**
   - Where: match.js `normalizeAnswer`.
   - Accepted wrongly: か for が, は for ぱ, Hindi कि for की, "C" for "C++", "-1" for "1".
   - Rejected wrongly: 🧠, ❤️ and "+" as answers can never be typed correctly.
   - Cause: the combining-mark strip and `[^\p{L}\p{N}\s]` remove meaningful marks and symbols. Keep the accent folding for Latin only (or compare NFC first); keep symbols when the answer is symbol-only.
4. **Medium/low. `dupKey` makes false duplicates and breaks symbol search.**
   - Where: import.js `dupKey`, used by browse-logic `browseCards`.
   - か/が/は/ば/ぱ → 3 of 5 flagged; कि/की; C++/C#/C.
   - Browse search for "🧠", "+" or "?!" returns everything; "c++" matches 12 of 18.
5. **Low/medium. CSV round trip damage.**
   - Where: import.js ~41, ~182.
   - `cleanLines` runs before Papa: it drops blank lines inside quoted cells, trims, and strips "•" inside cells. The Tags column is ignored on import, though the export sheet says CSV imports back.
   - A front that is just "-", "*" or "•" is eaten by `stripMarker`.
   - Exported cells starting with = + @ aren't neutralised (CSV formula injection in Excel).
6. **Low. Exam sheet double-save throws a pageerror.**
   - Where: exam-sheet.js (no submit guard) → concurrent `renderDeck` → browse.js:127 `addEventListener` on null.
7. **Low. Docked editor Escape at 1440** leaves focus on BODY instead of the card row (ui.js `openSheet` side / card-editor.js).
8. **Low. Re-tapping the Play tab on the results screen does nothing** (app.js route same-hash handling / play.js).
9. **Low. Empty deck says "All caught up".**
   - `#/review/<emptyDeck>` says "All caught up"; a nonexistent deck id is titled "This deck". It should say "No cards yet · Add cards" (overlaps A6).
   - Also: a deck with 0 cards shows a green ✓ on the Decks screen. That is the same problem as A6's "empty deck tick", so fix it there.
10. **Low. A long unbroken parent-deck name** in the deck page header overflows under the docked editor at 1440 (css/decks.js; needs `overflow-wrap`/ellipsis).

Not covered by the hunt:
- real Supabase sync
- .apkg import/export
- Sheets import
- a full Lightning round
- iOS Safari
- SW update flow
- whether removing an exam date should restore earlier due dates (currently it doesn't; owner to decide)

## 8. B1 simulation result (Batch 0A, 30 seeds; full report: tests/sim/compare/report-rescue.md on the batch-0 branch)
- Rule 1 (peak day cut ≥40%): **pass** (56–84% across N=3–10).
- Rule 2 (recall within 0.5 pp): **fails for N≥5** (N=5: 1/27 cells, −0.73 pp after a 30-day break, forgetful learner; N=7: 3 cells; N=10: 11). N=3 passes everywhere.
- Rules 3, 4: pass.
- Rule 5 (away mode): **fails**. Return day is lighter and day-1 recall is +1.5–3.2 pp, but R7 is below baseline in all 18 no-limit/150 cells, and R30end is −0.6 to −0.7 pp after 30 days.
- **Recommendation, following the pre-set rules:** cap the plan at N=3 (`RESCUE_MAX_DAYS = 3`; N=4 untested), and drop "I'm away until…" (or offer it only as plain "review ahead" with no memory claim). Owner to confirm before Batch 2A builds the UI.
- Batch 2 note: review.js calls `buildQueue` directly, so it must pass `data.rescue` (8th argument) or Review ignores the plan.

## 9. Decisions (owner delegated to Claude, 14 Oct: "you decide for now, I'll change it later")
- B1: rescue capped at **N=3** (`RESCUE_MAX_DAYS = 3`), default 3; **no "I'm away until…"**. Away mode failed rule 5.
- Removing an exam date does **not** restore earlier due dates (FSRS recovers on its own; simpler).
- Q2, Q6, Q8, Q9, Q10: as recommended. "Due" = what Review shows today; the `Step N:` syntax; a fixed leech keeps its schedule; Keep going = Today's Start; scratchpad on/off per device.
