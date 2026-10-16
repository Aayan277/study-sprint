# Round 2 Batch 2A–2C review (a030c41..3755ca7)
Nothing blocking; the merges are verified correct. Fix all of these after 2D (leech coach) merges, each with a test.

## Should fix
1. **The rescue auto-clear race** (today.js:57-58, db.js:409).
   - A stale device, or a fresh sign-in before cards arrive, sees the plan as "finished" and writes `null` with `Date.now()`, which wipes a newer plan on every device.
   - Fix: clear with the plan's own time (`setSetting(key, value, { at })` → `times.rescue = saved.at ?? 0`, so any newer plan wins), and skip the clear while the first sync is running.
   - Test: a two-device race.
2. **An exam added mid-plan starves the other decks** (queue.js:107-110): `backlog` is fixed but `remaining` drops when a deck becomes exempt.
   - Fix: `allow = max(formula, ceil(remaining / (N-k+1)))`, and update the one unit expectation (after the day's 50 are done, allow becomes `ceil(100/3)`).
   - Test: 90+60 overdue, exam on X on day 1 → Y gets ~20 a day.
3. **"Show everything now" brings the banner straight back** (rescue-sheet.js:57-61). Also set the `study-sprint-rescue-dismissed` key for today. Add an e2e check that the banner stays hidden.
4. **Step text that doesn't round-trip** (card-editor.js:190-197). A step line "Answer: …" or a final answer with "Step 3: …" saves but no longer parses as steps.
   - In `stepsProblem`, check `parseSteps(readBack(p), { mask: maskMath })?.steps.length === stepValues(p).length`; otherwise show "A line inside a step can't start with 'Step N:' or 'Answer:'."
5. **Space after mouse-clicking the pen or a tool** presses that button instead of flipping (review.js:941, ui.js:254). Call `preventDefault` on `pointerdown` for `#scratchBtn` and `.scratch-tools` buttons (so they never take focus), or refocus `#flash`. e2e: mouse click, then Space flips.
6. **A palm landing first blocks the pen** (scratchpad.js:87-89). On pen `pointerdown` while the active pointer is a touch: release the touch, restore a bitmap snapshot taken at the touch's down, and make the pen active.
7. **The typed mix-up scan blocks the main thread** (play.js:463-472: up to 2000 cards per wrong answer, ~100–200 ms on a phone). At round `start()`, build a Map from normalized exact target → card id, filtering siblings at lookup.

## Nits
- **study-data.js:53 `hasReviewLimit`:** add `|| !!data.rescue` (per-deck rows can each show up to `allow`).
- **rescue-sheet.js:52:** recompute the backlog at Start (Today may have been open past 4am).
- **Deck summary:** when `pauseNew` holds new cards, add "new cards paused (catch-up plan)".
- **compare-sheet.js:52-57:** "Make a comparison card" should open the add-card form prefilled, not save a placeholder first (cancel leaves junk; a double tap makes two).
- **browse.js:59:** `onDismiss` should remove the "Often mixed up with" line.
- **review.js:982:** drop `aria-live` on the steps (keep the focus move); move focus to `.steps-final` when it's shown.
- **card-editor.js:180:** show the step intro as an "Intro (optional)" field instead of a hidden `data-intro`.
- **scratchpad.js:75-80:** read the stroke colour once at `pointerdown`, not per point.
- **`.rv-card.scratching`:** add `-webkit-user-select:none; -webkit-touch-callout:none`.
- **app.js:685 `wipeThisDevice`:** also clear the `study-sprint-mix-dismissed` and `study-sprint-rescue-dismissed` keys.
- **Decision (Claude, delegated):** keep the 2-day chip. A shorter plan is closer to "no plan", which the simulation showed is memory-safe; 3 is the default.
