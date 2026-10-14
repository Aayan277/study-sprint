# Quick wins part 1: typed-answer diff, streak freeze and days off, maths (KaTeX)

Written by the planning review against `quick-wins`. Line numbers are approximate. Owner questions are at the end.

## Order and parallel work
- **Order:**
  1. **F3** typed diff (v4.0)
  2. **F1a** streak freeze (v4.1)
  3. **F1b** days off (v4.1, needs approval Q1)
  4. **F2** KaTeX (v4.2)
- **Every commit:**
  - Bump `CACHE` in `sw.js` and run `node tests/update-sw-hash.mjs`.
  - Bump `APP_VERSION` in `js/app.js`.
  - New files go in `CORE`.
  - Update PLAN.md (After v3.0 item 4) and the README.
- **Parallel work:**
  - Coder A does F3, then F2. These two must NOT run in parallel: both edit `play.js` `answer()`, the finish missed list, and `review.js` `submitTyped`, `typedResultHTML` and `typesAnswer`.
  - Coder B does F1a, then F1b.
- **Shared files:**
  - `sw.js` always conflicts: take the higher CACHE + 1 and re-run the hash script.
  - `review.js`: F1 touches only `finish()`.
  - CSS: new sections at the end, 19 streak, 20 maths, 21 answer diff.
  - Also shared: `app.js` (APP_VERSION, `watchMath`), `ui.js` (the snow icon), PLAN.md and the README.

## F3: Typed answers show which letters were wrong (v4.0)

**`js/match.js`**
- `answerChoices(back)` returns `[{ display, key }]`, where `display` is trimmed and `key = normalizeAnswer(display).replace(/ /g,'')`.
- Choice order: the pieces split on `;` and `/`, then each piece without its brackets, then the whole back. De-duplicated by key.
- `acceptedAnswers` and `checkAnswer` keep their behaviour.
- `closestChoice(typed, back)` returns the choice with the smallest `editDistance(squash(normalizeAnswer(typed)), key)`; ties go to the earliest.

**New `js/answer-diff.js`**
- `diffAnswer(typed, target)` returns null when the answer is empty, otherwise:
  ```
  { expected, typed:[{kind:'ok'|'wrong'|'extra'|'ignored',text}], answer:[{kind:'ok'|'wrong'|'missing'|'ignored',text}], counts:{wrong,extra,missing}, tooDifferent }
  ```
- How it works:
  1. Work on code points.
  2. Fold each character (NFKD, strip accents, lower-case).
  3. A character is significant if it matches `/[\p{L}\p{N}]/u`. Everything else is ignored, and so is a leading the/a/an plus its space.
  4. Run Levenshtein with a backtrace over the significant characters only, with the same costs as `editDistance`. On a tie, prefer a substitution.
  5. Map back to the original indexes and merge neighbouring characters of the same kind into segments.
- `tooDifferent` is true when either side is over 300 code points, or `wrong + extra + missing > max(3, 0.6 × significant length of expected)`.
- The diff never contradicts the verdict: case, accents, punctuation and articles are never marked.

**`diffHTML(diff)`**
- Output: an `.adiff` with two `aria-hidden` rows, "You typed" and "Answer". Under them, a summary `<p class="adiff-sum">1 letter wrong · 1 missing</p>` and an `.sr-only` sentence.
- Marks:
  - wrong → `<mark class="d-wrong">`
  - extra → `<del class="d-extra">`
  - missing → `<ins class="d-miss">` in the Answer row, plus a caret `<i class="d-caret">‸</i>` in the typed row
- When `tooDifferent`, show only the plain "You typed X / Answer Y".
- Escape everything.

**UI**
- `review.js`:
  - `submitTyped` stores `R.typed = { value, result, target }`. The target is `plainText(card.back)`; F2 changes it to `answerText`.
  - `typedResultHTML` keeps the verdict line (e2e-format expects "Correct"). It adds the diff when `!result.exact && value.trim()`, inside `.rv-typed`.
- `play.js` `answer()`, for typing with a non-empty answer:
  - Wrong: the diff replaces the `yours` span.
  - Correct but not exact: show the diff and stretch the auto-advance to 1600 ms. Lightning keeps 280 ms and shows no diff for correct answers.
  - Save `entry.typed` and `entry.target`. The finish missed list shows a compact `.adiff.small`.
- CSS section 21:
  - Rows wrap with `overflow-wrap: anywhere`; text is 15px.
  - `.d-wrong`: crimson tint + wavy underline + bold.
  - `.d-extra`: strikethrough + tint.
  - `.d-miss`: green tint + dotted underline.
  - The caret is the accent colour.
  - AA contrast in dark, light and OLED. No sideways scroll at 375px.

**Tests**
- `tests/answer-diff.test.js`:
  - identical → no marks
  - mitocondria vs mitochondria → missing "h"
  - recieve vs receive
  - an extra letter
  - case, accents (cafe/café), self-esteem vs self esteem, a leading article → no marks
  - "red / scarlet", typed "scarlett" → expected scarlet, 1 extra
  - "scarlet (dark red)", typed "scarlet" → no marks
  - kana; emoji and astral characters not split
  - empty → null
  - too different; over 300 characters
  - escaping; plurals
- `match.test.js`: `answerChoices`.
- `tests/browser/e2e-typed-diff.mjs`:
  - 375 Review: back "mitochondria", typed "mitocondria" → `ins.d-miss` is "h", the sr-only text mentions "missing", `scrollWidth ≤ 375`.
  - Play typing: a typo, a wrong answer, and the missed list.
  - Desktop 1440. No pageerror.

## F1a: Streak freeze, worked out from the log (v4.1); no data format change
- **What counts:** any answer counts toward a day. Days use `dayKey` (the 4am rollover).
- **The walk**, back from today (or from yesterday if today has no answers yet):
  - A studied day adds 1. A rest day (F1b) adds 0 and doesn't break the streak.
  - A missed day is **frozen** when all of these hold:
    - (a) no other day in its week is frozen;
    - (b) the next newer day was studied, was a rest day, or is today, so two missed days in a row are never both frozen;
    - (c) a studied day exists further back in the run. Freezes left pending at the end are dropped.
  - Otherwise the streak breaks.
- A week runs Monday 4am → Monday 4am. Freezes are not banked. Every decision depends only on newer days, so `lazyStreak` stays exact.
- **Sync:** nothing is stored, so all devices agree once their logs merge. **Time zones:** keys follow the device's current time zone (note this in the README).
- **`js/stats-calc.js`:**
  - `weekOf(key)` returns the Monday's key; build it with `new Date(y, m-1, d, 12)`.
  - `streakFromDays(days, now, { rest = EMPTY_SET, freezes = true } = {})` returns:
    ```
    { days, studiedToday, restToday, week:[{time,on,today,frozen,rest}], frozen:[keys newest first], freeze:{ready,usedOn}, span }
    ```
    The walk is capped at 3650 days.
  - `dayStreak` and `lazyStreak` pass the options through. `lazyStreak` stops when `streak.span < days - 1 || days >= 3650`.
  - `streakRuns(perDay, now, opts)` → `{ frozen:Set, longest }`. It replaces the forward run count in `calendarFromDays`, which now takes opts and adds frozen/rest flags to each cell.
  - `streakText(streak)` → `{ line, sub }`. Keep the existing strings that e2e-today and fx depend on.
    - `line`, first match wins:
      - "Kept for today"
      - "Rest day · your streak is safe"
      - "Freeze used yesterday · study today to keep it"
      - "Study today to keep it"
      - "Study today to start one"
    - `sub`: "1 freeze ready this week", or "Freeze used <weekday>", or `''`.
- **`js/study-data.js`:** `loadStreak(history = null, ctx = null)`, where `ctx = { settings, decks }`.
  - `rest = restDaySet(settings)` (empty until F1b).
  - Callers: today.js ~52, sidebar.js ~73, and review.js `finish()` with `{ settings: R.settings }`.
- **UI:**
  - **Today** (~103): keep the `.streak` markup (fx.js reads `.streak.kept b`). Add a `.frz-pill` with `icon('snow')` and the `sub` text.
  - **Sidebar footer:** add ", freeze ready" / ", freeze used Tue" to the aria-label and tooltip. Show a 12px snow icon when a freeze was used in the last 7 days. In the rail, tooltip only.
  - **Stats streak card:**
    - The week dots get `.frz` (snow) and `.rest` (moon), with titles like "Tue 13 Oct, streak freeze used".
    - Add the line "One freeze a week covers a missed day. It doesn't add to the count."
  - **Stats calendar:**
    - Cells get `.frz` (diagonal hatch) and `.rest` (dotted outline). `dayText` adds " · streak freeze".
    - Legend chips. The best streak includes freezes.
  - **Finish screen:** the same markup and text.
  - **`ui.js`:** a `snow` icon (6 spokes, stroke style). **CSS** section 19.
- **Tests:**
  - **`tests/stats.test.js`:**
    - Keep `NOW`. Change on purpose: "streak counts back from today" becomes 4. Add `{ freezes: false }` checks that keep the old meaning.
    - New cases:
      - yesterday missed → frozen
      - two missed in a row → broken
      - two separate misses in the same week → the older one breaks
      - misses in different weeks → both frozen
      - a Sunday + Monday gap → broken
      - nothing studied before the miss → 0 and ready
      - the 4am edges
      - a daylight-saving week (`new Date(2026, 2, 29)`)
      - `lazyStreak` over 200 days matches the full walk
      - calendar `longest` and frozen cells
      - `streakText`
  - **`tests/browser/e2e-streak.mjs`:**
    - Set up: `page.clock.setFixedTime(new Date(2026, 9, 14, 12))`. Build timestamps in the page with `daysAgoStart`. Seed days 2–6.
    - Today shows "5 day streak" and "Freeze used yesterday". At 375: no sideways scroll.
    - Stats: the dot and the calendar cell have `.frz`. The sidebar aria-label at 1440 mentions "freeze".
    - After 1 review: "6 day streak" and "Kept for today". A second miss in the same week breaks it.
  - **Re-check:**
    - e2e-stats ~44 ("streak of 6"; seed a 2-day gap instead)
    - e2e-sidebar, e2e-today, e2e-motion, e2e-polish2, e2e-exam

## F1b: Days off (needs Q1)
- **Data:**
  - A new synced setting, `restDays: { 'YYYY-MM-DD': { on, at } }`. Add it to `DEFAULT_SETTINGS` (`{}`) and `SYNCED_SETTINGS`. Set `MERGED_SETTINGS = ['restDays']` in sync-data.js.
  - `sync-merge.js`:
    - `mergeDayFlags(a, b)`: per day, the larger `at` wins. Drop entries over 400 days old and junk keys or values.
    - `sameDayFlags(a, b)`.
  - `db.js applyRemote`, settings branch (~611), for merged keys:
    - Merge with the local value and put it.
    - `times[key]` becomes `max(old, updated_at)` if the merged value equals the remote one. Otherwise it becomes `Date.now()`, so the union is pushed back once.
    - Count it as applied only if the value changed.
  - `restDaySet(settings)`: a Set of the keys with `on: true`, junk-safe.
- **Rules:** days off go from tomorrow up to +60 days, at most 14 future days. They can be removed (`on: false`, new `at`); past ones are kept.
- **UI:** Today's streak becomes a `.streak-btn` that opens the "Your streak" sheet (`js/streak-sheet.js`, lazy, in CORE). The sheet has:
  - the freeze explanation and the 7-day row;
  - a list of days off with Remove buttons, a date input (min tomorrow, max +60) and Add;
  - "Day off on exam day (Fri 20 Nov)" chips for decks with a future exam (one tap adds a normal day off).

  The Stats streak card gets a "Plan a day off" link.
- **Tests:**
  - Unit, `sync.test.js`: merge union, per-day newest wins, pruning, junk, equality.
  - Unit, `stats.test.js`: rest days bridge, consecutive rest days, a rest day followed by a frozen miss.
  - e2e:
    - the date input rejects today
    - moving the clock forward keeps the streak
    - a backup round trip keeps `restDays`
    - optional: a two-device merge with fake-supabase

## F2: Maths on cards with KaTeX (v4.2)

**New `js/math.js`**
- It is a boot module (imported by import.js and app.js): add a modulepreload line and add it to CORE. It must not load KaTeX on import.
- `KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/'`.
- `splitMath(text)` → `[{type:'text',value}|{type:'math',tex,display,raw}]`:
  - `\$` is a literal `$`.
  - `$$…$$` is display maths, may span lines, and can't be blank.
  - `\[…\]` is display maths; `\(…\)` is inline.
  - `$…$` is inline only when all of these hold:
    - the opening `$` isn't escaped and is followed by a non-space that isn't `$`;
    - the closing `$` is preceded by a non-space and NOT followed by a digit;
    - there's no newline inside;
    - it's at most 1000 characters.
  - So "$5 and $10", "$5,000 to $6,000" and "US$5/$10" are not maths.
  - Candidates containing private-use placeholder characters are not maths.
  - Fast path: if there's no `$` or `\`, return the whole text as one text segment.
- Other helpers:
  - `hasMath`, `replaceMath(text, fn)`, and `maskMath` (same length, maths characters replaced with a placeholder).
  - `texToPlain`: `\frac{a}{b}` → a/b, `\sqrt{x}` → sqrt(x), Greek letters → names, `\cdot` and `\times` → space, `\text` and `\mathrm` → their contents, unknown commands removed, braces dropped.
  - `texToSpeech`: "x squared", "cubed", "to the power n", "sub i", "a over b", "square root of x", "equals", "plus", "minus", "integral", "sum".
  - `wrapMath(value, start, end)`, like `toggleWrap`.
- `loadKatex()`:
  - Memoised. Dynamic-import `katex.mjs` and add the CSS link, waiting for its load.
  - Reset the memo on failure.
  - After the first success, fetch the core woff2 fonts in idle time so the service worker caches them.
- `renderMath(root)`:
  - Finds `.tex:not([data-done])`; if there are none, it loads nothing.
  - Calls `katex.render(tex, span, { displayMode: has .tex-d, throwOnError:false, trust:false, strict:'ignore', output:'htmlAndMathml', maxSize:10, maxExpand:1000 })`.
  - If loading fails: add `tex-raw` and `title="Maths shows after you've been online once"`.
- `watchMath()`: a MutationObserver on the body (childList + subtree) that renders added nodes containing `.tex`, plus re-render on `online`. Called once in app.js.

**`js/format.js`**
- `formatHTML(text, { math = 'span' })`: strip stray placeholder characters, replace maths segments with placeholders, run the existing pipeline, then swap them back:
  - `'span'`: `<span class="tex[ tex-d]" data-tex="…">raw</span>`
  - `'raw'`: escaped raw text, for the rich editor
  - `'anki'`: `\(…\)` or `\[…\]`
- Check the cloze `STRAY` range doesn't collide.
- `mathHTML(text, { inline })` escapes and adds maths spans only.
- `plainText` and `hasFormatting` protect maths.
- `answerText(text)`: `plainText` with each maths segment passed through `texToPlain`.

**Call sites**
- **review.js:**
  - The occlusion header and label use `mathHTML`.
  - `typesAnswer` and the `submitTyped` target use `answerText(card.back)`.
  - The `readAloud` cloze regex becomes `/(?<!\\)\[[^\]]*\]/`.
- **play.js:**
  - The prompt uses `mathHTML(q.prompt)`, options use `mathHTML(o, {inline:true})`, and the feedback answer and missed list use `mathHTML`.
  - The typing check is `checkAnswer(choice, answerText(answer), …)`.
- **browse.js** (~108, ~238) and **stats.js** (~276, ~370): `mathHTML(plainText(x), {inline:true})`.
- **card-editor.js:**
  - The rich box uses `formatHTML(v, {math:'raw'})`. A preview div goes under the rich box too, shown when there's maths.
  - A ∑ toolbar button: `wrapMath` on phones; on desktop, `execCommand('insertText', false, '$'+sel+'$')`.
  - A one-line hint.
- **import-screen.js:** rows with maths get a `.pv-math` preview.
- **import.js `splitFirst`:** search for the separator in `maskMath(line)`.
- **speech.js `speakableText`:** `replaceMath(plainText(t), s => texToSpeech(s.tex))`.
- **export.js:** `toAnkiHTML = t => formatHTML(t, {math:'anki'})`. CSV keeps the raw text.
- **anki.js:** after `htmlToMarks`, convert `[$]…[/$]` → `$…$` and `[$$]…[/$$]` → `$$…$$`. `\(…\)` is kept as it is.
- **Cloze and search:** no change.

**Service worker**
- jsdelivr is already cache-first, so KaTeX is cached on first use. It is not preloaded.
- Change: in `install`, before `skipWaiting`, copy the cache-first CDN entries from the old caches into the new one, so CDN copies survive a CACHE bump.

**CSS section 20**
- `.tex-d`: block, `overflow-x: auto`, `max-width: 100%`.
- `.katex`: 1.08em.
- `.tex:not([data-done])`: opacity .75.
- `.tex-raw`: mono with a dotted underline.
- No sideways scroll at 375px.

**Tests**
- `tests/math.test.js`:
  - the price cases, `\$`, multi-line `$$`, `\(\)` and `\[\]`, `$ x$` and `$x $`, unclosed, `$$$$`, nested braces, placeholders
  - `texToPlain`/`texToSpeech` tables; `maskMath`; `wrapMath`
- Additions to existing test files:
  - `format.test.js`: `**$x$**`, stars inside maths, the three modes, `plainText`/`hasFormatting`, `answerText`.
  - `cloze.test.js`: `{{c1::$x^2$}}` → `mark.cloze-ans` contains `span.tex`.
  - `export.test.js`: `\(x\)` in Anki, raw text in CSV.
  - `anki.test.js`: `[$]`.
  - `import.test.js`: "Energy - $E = mc^2$" splits at " - ".
  - `speech.test.js`.
  - `match.test.js`: `answerText('$x^2$')` accepts x^2 and x2.
- `tests/browser/e2e-math.mjs`:
  - front `What is $\frac{a}{b}$?`, back `$$E=mc^2$$`
  - Review at 375: `.katex` and `.katex-display`, no sideways scroll
  - Play `.lbl .katex`; a Browse row
  - the editor ∑ button + preview; the import `.pv-math`
  - aborting the KaTeX route → `.tex-raw` and no pageerror
  - "$5 and $10" → no `.tex`

## Owner questions
- **Q1:** approve the new synced setting `restDays`, merged per day? (F1b only.)
- **Q2:** freezes are automatic and recalculated over all history, so some past and current streaks will go up. OK?
- **Q3:** KaTeX 0.16.47; Pandoc `$` rules; `\$` shows as `$`. OK?
- **Optional:** add "Write maths as LaTeX between $…$." to the "Make cards with Claude" prompt?
