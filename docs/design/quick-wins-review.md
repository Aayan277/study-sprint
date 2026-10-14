# Review findings: typed diff (v4.0) + streak freeze/days off (v4.1)

Opus review of 348d7f0 and 8071772 (merged at 373e955). Nothing blocking. Fix all of these after F2 (KaTeX) is merged; each fix gets a test.

## Owner decision (14 Oct)
- **The freeze stays on the first missed day.** The week's freeze goes to the EARLIEST coverable missed day in that week, not the newest. So with Tue frozen and a 9-day streak, missing Thu ends the streak (0, "Study today to start one").
  - Implementation: in stats-calc.js `walk`, look up to 6 extra days back within the week before committing a freeze; keep `lazyStreak` exact by adding a 7-day margin.
  - Tests: the moving-freeze case and its text.

## Should fix
1. **stats-calc.js ~140:** when `frozen[0] === yesterday`, `sub` must not say "1 freeze ready this week". Missing today would break the streak anyway. Use `''` or "No freeze for today". Add a test.
2. **db.js ~623 and setSetting ~389:** a merged `restDays` stamped with `Date.now()` can lose against another device whose clock is ahead (the server ignores older `updated_at`, and `pushedUntil` then skips it forever).
   - In `applyRemote`, stamp `Math.max(Date.now(), row.updated_at + 1)`.
   - In `setSetting`, for MERGED_SETTINGS, stamp `Math.max(Date.now(), (times[key]||0) + 1)`.
3. **sync-merge.js ~93 `cleanDayFlags`:**
   - Require `Number.isSafeInteger(at) && at > 0 && at <= now + DAY`. Today `at: 1e308` makes a day off unremovable.
   - Drop keys later than today + MAX_AHEAD_DAYS + 2, and cap the number of future entries.
   - Add tests.
4. **stats-calc.js `restDaySet` ~45:** ignore entries whose `at >= dayStart(key)`. A day off decided on or after the day itself arrives only via sync, backup or devtools.
5. **Greek final sigma:**
   - answer-diff.js `fold` (~15) lowercases one character at a time, while `normalizeAnswer` lowercases the whole string, so ς and σ disagree. Add `.replace(/ς/g,'σ')` in both.
   - When the answer is wrong and there are no marks, render no empty `.adiff-sum` and no stray "." in the sr text.
6. **match.js ~75:**
   - `answerChoices` must use exactly the same set as `acceptedAnswers`; it currently misses `clean(raw)`.
   - `closestChoice` prefers a choice that actually accepts the answer (`editDistance <= allowedTypos`).
   - Add a fuzz/property test: an exact answer has no marks; an answer accepted with a typo has marks within its typo budget.
7. **answer-diff.js `prepare` ~18 and caret ~73:** split by grapheme clusters (`Intl.Segmenter`, falling back to `Array.from`), so decomposed accents stay inside marks.
8. **answer-diff.js `joined` ~116:** use `Array.from(str)`, not `.split('')`. Astral characters are broken today.
9. **UX: the answer is shown twice.**
   - Review: one corrected line (what was typed, with wrong letters marked, extra letters struck through and missing letters inserted inline). Show a second "Closest answer" row only when the diff target is an alternate, not the whole back. When too different, keep "Not quite. You typed X" with no diff box.
   - Add `diffHTML({ answerRow:false })` and drop "The answer is" from the sr text in that case.
   - Play: drop the `<b>answer</b>` when a diff is shown.
10. **ui.js ~84 week dots:** `role="list"`/`listitem` with sr-only text per day ("Tue 13 Oct: streak freeze used"). The sheet's legend must not be aria-hidden.
11. **stats-calc.js ~148 `lazyStreak` performance:** read only timestamps (`getAllKeys` on the timestamp index), or cache the per-day keys keyed on the newest log time + restDays + today's key. Today it reads ~300k rows on every Today/sidebar render at 3 years × 100 answers a day.

## Nits
- The DST test should run under an explicit TZ (spawn node with `TZ=Europe/London`).
- Missing tests for items 1–3 above.
- play.js ~627 computes `diffAgainstBack` twice.
- Add a `maxlength` (e.g. 500) on `pInput`/`typeIn`.
- 'cat' vs 'dog' (nothing shared) → show the plain texts, not every letter marked.
- The sr text for wrong letters should say "you typed i e, the answer has e i".
- streak-sheet.js ~74: the exam chip shouldn't use `aria-pressed` (it becomes a "Day off planned" label). Give `#streakBtn` an sr-only ", details".
- Document that a backup restore merges `restDays` rather than replacing them.
- CSS section order (21 before 19) is cosmetic.

## Separate (also in the bug list, round2-plan §7 item 3)
- match.js `normalizeAnswer` ~16 should strip only U+0300–036F and keep other `\p{M}`, so はん ≠ ぱん and कताब ≠ किताब.
