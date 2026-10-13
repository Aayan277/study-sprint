# Study Sprint v3.1 vs v3.0: does the exam "final pass" reduce learning?

**Verdict: FAIL.** v3.1's mean exam-day true recall is lower than v3.0's by more than 0.5 pp in 27 of 36 exam cells (scenario × learner). The worst is A/forgetful at −1.87 pp. "% of cards ≥ 80%" never drops by more than 1 pp (worst −0.32 pp), so only the first half of the criterion fails. G (non-exam) passes: with Play off the runs are bit-identical, and with Play on the Δ is +0.01 to +0.32 pp. v3.1 does better than v3.0 in C (review limit) and H2 (one subdeck a day), and ties in F1 (random skipped days).

**Cause:** the 95% threshold. Cards predicted ≥ 95% on exam day get no last review. In A/default that is about 110 of 300 cards, and their true recall averages 96.6%. v3.0 reviewed every card on the eve (about 300 reviews), which puts nearly every card at ≈99%. The 5-day window matters much less (see the fix grid).

**Tested fix (not applied to the repo):** a separate final-pass threshold of 0.98 (`FINAL_R`, used only in `planFinalPass` and `examClamp`, so the retention ramp keeps `EXAM_RETENTION` = 0.95) with `FINAL_DAYS` = 3. This passes all 36 cells. The worst is F2/default at −0.44 ± 0.03 pp. Total reviews are −0.2% vs v3.0, and the peak day is about 115 instead of 300 (A/default). A safer alternative is 0.99 / 3: worst −0.18 pp, +5% reviews, peak about 156.

## Method

### Versions and checkouts
- v3.0 = `origin/main` bf240ea, worktree `simcmp/v30`. v3.1 = d2bdf56, worktree `simcmp/v31`. Both are detached and were removed at the end.
- ts-fsrs 5.4.2 is installed in `simcmp/deps` (outside the repo). `loader.mjs` maps the app's CDN URL to it and maps `./db.js` to `memdb.mjs`, an in-memory shim of `getSettings/getDecks/getAll/get/getLogsSince/getCardLogs/saveReview/addLog/putStates/saveCards`.
- `Date.now` is driven by the harness clock. TZ=UTC. The app's `Math.random` (balance tie-breaks) is seeded per run.
- Each process imports one version's `js/` folder, so module instances never mix.

### Real app functions called (per day, per version)
| Step | v3.0 | v3.1 |
|---|---|---|
| Load | `study-data.loadAll()` (real, over memdb) | same (it now also calls `exam.examSchedule(..., settings.easyDays)` internally) |
| Session cards | `study-data.countFor(data, deckIds).cards` | same |
| Queue (mirrors `review.js start()`) | `queue.buildQueue(cards, statesById, newLeft, now, reviewLeft)` | `exam.examSchedule(decks, cards, statesById, now, gainOf, data.exam.caps)` with `gainOf = srs.examGain(st, examStart, now, deckSchedulerOptions(settings, effectiveDeck(...)))`, then `queue.buildQueue(..., exam)` |
| Next card | `queue.takeNext`, `queue.addWaiting` for learning steps due today | same |
| Rating (mirrors `schedFor`) | `srs.rate(id, prev, rating, {...exam.examOptions(sched-settings.deckSchedulerOptions(settings, deck), deck, now), balance: {load: balance.loadByDay(states), easyDays}}, now)` | same call (v3.1 `rate` applies `examClamp`) |
| Leech in Review | `browse-logic.isNewLeech` → `markLeech` (suspend) | `isNewLeechCounted(prev, next, getCardLogs(id), thr)` → `markLeech` |
| Play (40% of days, 20 MC questions, classic 8 s) | v3.0 `renderPlay` data (getAll + `newLimits`), `game.weightedQueue` (lapse-weighted), `autograde.autoRating`, `autograde.scheduleDecision({state, rating, alreadyToday, now, examDeck, newRoom})`, `applies`, `srs.rate`, `isNewLeech` | v3.1 `renderPlay` data (`loadAll`, `exam.caps`), same queue/rating, `scheduleDecision` with cap-adjusted due + `timedOut/limitMs/fmt`, `isNewLeechCounted` and the "not-due miss doesn't count" rule |
| Exam date set (D) | `exam.pullIn(states, {examDate}, now)` → putStates (as in decks.js) | `exam.pullIn(states, {examDate}, now, easyDays)` |

The harness does not reimplement scheduling. Only the DOM glue in review.js and play.js is mirrored, line by line, per version.

### Simulated learner
- **True memory** is a separate ts-fsrs instance with the learner's own weights. Short-term reviews are on and fuzz is off. True R = (1 + f·t/S)^−d with the true decay and fractional days.
  - default = ts-fsrs default w.
  - forgetful: w0–3 ×0.5, w8 −0.5, w11 ×0.7, w20 = 0.4.
  - strong: w0–3 ×1.6, w8 +0.35, w20 = 0.12.
- **Per-card heterogeneity:** z ~ N(0,1) shifts true difficulty by +1.5z and raises first-sight failure (p = 0.25 + 0.1z). The initial true stability is multiplied by m ~ logN(0, 0.4).
- **Review answers:** recall ~ Bernoulli(true R). A fail is Again. A pass is Hard with p = 0.08 + 0.5(1−R), Easy with p = 0.25·R⁶, otherwise Good. Every answer updates the true state.
- **Play answers:** correct = recalled OR a 25% MC guess. Speed depends on R. 30% of misses are timeouts. True memory updates either way.
- **Randomness:** common random numbers. Per-card, per-day, Play and exam-draw streams are keyed by seed, so v3.0 and v3.1 see the same learner. Differences are paired by seed.
- **Session behaviour:** one study session per day at 09:00, 10 s per answer. Learning steps are handled within the session the way the app does it.

### Scenarios (30 seeds each, × 3 learners, × each version)
- **A:** 300 cards, 20 new/day, exam day 30.
- **A_easy:** A with Sunday = minimum and Saturday = reduced.
- **B10:** exam day 10, 50 new/day (the app's own "N a day to finish" advice).
- **B60:** exam day 60.
- **C:** 1,000 cards, 25 new/day, reviewLimit 120/day, exam day 45.
- **D:** 60 days without an exam, then the exam is set 14 days out, with pullIn.
- **E1:** A plus 100 new cards imported on day 23.
- **E2:** A plus 100 cards imported on day 23 with Anki-like Review history (S 3–90 d, some due after the exam).
- **F1:** 2 random skipped days a week.
- **F2:** days 22–24 skipped (right before the 5-day window).
- **G:** non-exam deck, 500 cards, 120 days.
- **H1:** parent with the exam and 3 subdecks; each subdeck studied in its own session every day.
- **H2:** one subdeck per day, rotating.

### Metrics
- True R at 09:00 on exam morning over every card in the exam deck (unstarted = 0, suspended counted).
- % of cards ≥ 90% and ≥ 80%.
- Exam score = mean of Bernoulli(R) draws.
- Reviews = Review-session answers on graduated cards.
- Last 5 days, max/day, eve.
- **"Left after exam (needed)":** a card in Review state, due after exam start, app-predicted R < 0.95 on exam day, and not reviewed in the final window.
- Leeches suspended.
- 95% CI = t·sd/√30. The Δ columns are paired.

## Results (v3.0 vs v3.1)
| Scenario | Learner | mean exam-day true R v30 | v31 | Δ (paired, pp) | ≥80% v30 | v31 | Δ pp | ≥90% v30 | v31 | score v30 | v31 | reviews v30 | v31 | last 5 d v30 | v31 | max/day v30 | v31 | eve v30 | v31 | left after exam (needed) v31 | leeches v30/v31 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | default | 99.09 ± 0.04 | 97.54 ± 0.04 | -1.55 ± 0.03 | 99.9 ± 0.0 | 99.9 ± 0.1 | -0.01 | 99.3 ± 0.2 | 98.8 ± 0.2 | 99.0 ± 0.2 | 97.5 ± 0.3 | 1130 ± 12 | 999 ± 13 | 399 ± 3 | 235 ± 4 | 300 ± 0 | 57 ± 2 | 300 ± 0 | 57 ± 2 | 0.00 (max 0) | 0.07/0.07 |
| A | forgetful | 96.85 ± 0.21 | 94.98 ± 0.20 | -1.87 ± 0.10 | 97.6 ± 0.4 | 97.2 ± 0.4 | -0.32 | 93.8 ± 0.5 | 93.4 ± 0.5 | 96.6 ± 0.3 | 94.8 ± 0.4 | 1395 ± 23 | 1284 ± 23 | 444 ± 4 | 307 ± 5 | 296 ± 1 | 81 ± 2 | 296 ± 1 | 81 ± 2 | 0.00 (max 0) | 4.33/4.27 |
| A | strong | 99.41 ± 0.03 | 98.23 ± 0.04 | -1.19 ± 0.03 | 100.0 ± 0.0 | 100.0 ± 0.0 | -0.01 | 99.8 ± 0.1 | 99.6 ± 0.1 | 99.4 ± 0.2 | 97.9 ± 0.3 | 1054 ± 11 | 914 ± 11 | 383 ± 3 | 210 ± 3 | 300 ± 0 | 49 ± 1 | 300 ± 0 | 49 ± 1 | 0.00 (max 0) | 0.03/0.03 |
| A_easy | default | 99.10 ± 0.04 | 97.57 ± 0.05 | -1.53 ± 0.04 | 100.0 ± 0.0 | 99.9 ± 0.1 | -0.04 | 99.5 ± 0.2 | 98.9 ± 0.3 | 98.9 ± 0.2 | 97.4 ± 0.4 | 1126 ± 13 | 996 ± 14 | 385 ± 3 | 221 ± 4 | 300 ± 0 | 68 ± 1 | 300 ± 0 | 68 ± 1 | 0.00 (max 0) | 0.13/0.10 |
| A_easy | forgetful | 96.89 ± 0.17 | 95.06 ± 0.16 | -1.84 ± 0.09 | 97.7 ± 0.3 | 97.4 ± 0.3 | -0.32 | 94.0 ± 0.5 | 93.3 ± 0.5 | 96.6 ± 0.4 | 94.6 ± 0.5 | 1394 ± 21 | 1283 ± 22 | 432 ± 5 | 291 ± 6 | 296 ± 1 | 92 ± 2 | 296 ± 1 | 92 ± 2 | 0.00 (max 0) | 4.40/4.23 |
| A_easy | strong | 99.40 ± 0.03 | 98.23 ± 0.04 | -1.17 ± 0.04 | 100.0 ± 0.0 | 100.0 ± 0.0 | 0.00 | 99.7 ± 0.1 | 99.6 ± 0.1 | 99.3 ± 0.2 | 98.1 ± 0.2 | 1052 ± 11 | 911 ± 11 | 372 ± 2 | 198 ± 3 | 300 ± 0 | 59 ± 1 | 300 ± 0 | 59 ± 1 | 0.00 (max 0) | 0.03/0.03 |
| B10 | default | 98.48 ± 0.05 | 97.20 ± 0.06 | -1.27 ± 0.04 | 99.8 ± 0.1 | 99.7 ± 0.1 | -0.08 | 98.4 ± 0.3 | 97.9 ± 0.3 | 98.4 ± 0.3 | 97.1 ± 0.3 | 804 ± 6 | 676 ± 7 | 597 ± 4 | 468 ± 5 | 300 ± 0 | 107 ± 2 | 300 ± 0 | 103 ± 2 | 0.00 (max 0) | 0.00/0.00 |
| B10 | forgetful | 96.19 ± 0.20 | 94.59 ± 0.19 | -1.60 ± 0.06 | 96.1 ± 0.4 | 95.9 ± 0.4 | -0.19 | 89.5 ± 0.8 | 89.8 ± 0.7 | 96.1 ± 0.5 | 94.1 ± 0.5 | 867 ± 9 | 755 ± 10 | 647 ± 6 | 534 ± 7 | 300 ± 0 | 123 ± 2 | 300 ± 0 | 123 ± 2 | 0.00 (max 0) | 0.20/0.20 |
| B10 | strong | 98.98 ± 0.03 | 97.99 ± 0.04 | -0.99 ± 0.03 | 99.9 ± 0.1 | 99.9 ± 0.1 | 0.00 | 99.4 ± 0.2 | 99.2 ± 0.2 | 99.0 ± 0.2 | 98.0 ± 0.3 | 782 ± 5 | 650 ± 5 | 580 ± 4 | 446 ± 4 | 300 ± 0 | 102 ± 2 | 300 ± 0 | 95 ± 1 | 0.00 (max 0) | 0.00/0.00 |
| B60 | default | 99.42 ± 0.03 | 98.17 ± 0.07 | -1.25 ± 0.06 | 99.9 ± 0.0 | 99.9 ± 0.1 | -0.04 | 99.8 ± 0.1 | 99.2 ± 0.2 | 99.4 ± 0.1 | 97.9 ± 0.3 | 1454 ± 18 | 1347 ± 18 | 339 ± 2 | 208 ± 4 | 300 ± 0 | 50 ± 1 | 300 ± 0 | 47 ± 1 | 0.00 (max 0) | 0.17/0.17 |
| B60 | forgetful | 96.29 ± 0.32 | 94.74 ± 0.32 | -1.55 ± 0.10 | 96.5 ± 0.4 | 96.3 ± 0.5 | -0.21 | 95.0 ± 0.5 | 94.2 ± 0.5 | 96.2 ± 0.4 | 94.4 ± 0.5 | 1898 ± 33 | 1831 ± 33 | 360 ± 4 | 249 ± 6 | 290 ± 1 | 64 ± 2 | 290 ± 1 | 62 ± 2 | 0.00 (max 0) | 9.87/9.20 |
| B60 | strong | 99.63 ± 0.02 | 98.70 ± 0.05 | -0.93 ± 0.04 | 100.0 ± 0.0 | 100.0 ± 0.0 | -0.01 | 99.8 ± 0.1 | 99.6 ± 0.2 | 99.6 ± 0.1 | 98.6 ± 0.3 | 1326 ± 15 | 1212 ± 15 | 331 ± 2 | 198 ± 3 | 300 ± 0 | 46 ± 1 | 300 ± 0 | 43 ± 1 | 0.00 (max 0) | 0.13/0.13 |
| C | default | 95.00 ± 0.06 | 96.21 ± 0.07 | 1.21 ± 0.04 | 99.6 ± 0.1 | 99.8 ± 0.0 | 0.18 | 91.5 ± 0.5 | 96.2 ± 0.3 | 95.1 ± 0.3 | 96.3 ± 0.2 | 2925 ± 24 | 3128 ± 19 | 513 ± 6 | 600 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 0.00 (max 0) | 0.60/0.50 |
| C | forgetful | 90.39 ± 0.12 | 91.16 ± 0.16 | 0.76 ± 0.09 | 93.5 ± 0.3 | 94.7 ± 0.3 | 1.21 | 65.0 ± 0.8 | 68.8 ± 1.1 | 90.3 ± 0.3 | 91.0 ± 0.3 | 3643 ± 29 | 3667 ± 26 | 600 ± 1 | 600 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 0.00 (max 0) | 13.57/13.43 |
| C | strong | 96.33 ± 0.04 | 97.53 ± 0.04 | 1.19 ± 0.03 | 99.9 ± 0.0 | 100.0 ± 0.0 | 0.03 | 97.2 ± 0.2 | 99.1 ± 0.2 | 96.3 ± 0.2 | 97.6 ± 0.2 | 2670 ± 17 | 2942 ± 14 | 460 ± 6 | 600 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 120 ± 0 | 0.00 (max 0) | 0.23/0.23 |
| D | default | 99.51 ± 0.04 | 98.28 ± 0.06 | -1.24 ± 0.06 | 99.9 ± 0.1 | 99.8 ± 0.1 | -0.07 | 99.7 ± 0.1 | 99.1 ± 0.2 | 99.5 ± 0.1 | 98.2 ± 0.3 | 1784 ± 18 | 1455 ± 20 | 408 ± 2 | 203 ± 4 | 300 ± 0 | 49 ± 1 | 300 ± 0 | 46 ± 1 | 0.00 (max 0) | 0.27/0.13 |
| D | forgetful | 95.89 ± 0.39 | 94.61 ± 0.37 | -1.28 ± 0.17 | 95.6 ± 0.5 | 96.1 ± 0.5 | 0.46 | 94.2 ± 0.5 | 94.4 ± 0.6 | 95.9 ± 0.5 | 94.5 ± 0.5 | 2261 ± 35 | 1995 ± 38 | 412 ± 4 | 235 ± 5 | 288 ± 1 | 62 ± 2 | 288 ± 1 | 57 ± 2 | 0.00 (max 0) | 12.13/10.30 |
| D | strong | 99.71 ± 0.02 | 98.80 ± 0.05 | -0.91 ± 0.04 | 99.9 ± 0.0 | 99.9 ± 0.1 | -0.02 | 99.8 ± 0.1 | 99.5 ± 0.2 | 99.7 ± 0.1 | 98.8 ± 0.2 | 1641 ± 16 | 1302 ± 18 | 401 ± 1 | 193 ± 4 | 300 ± 0 | 45 ± 1 | 300 ± 0 | 42 ± 1 | 0.00 (max 0) | 0.20/0.10 |
| E1 | default | 98.82 ± 0.05 | 97.32 ± 0.04 | -1.50 ± 0.04 | 99.8 ± 0.1 | 99.8 ± 0.1 | -0.04 | 98.6 ± 0.2 | 98.1 ± 0.2 | 98.8 ± 0.2 | 97.2 ± 0.3 | 1358 ± 12 | 1178 ± 14 | 613 ± 3 | 400 ± 5 | 400 ± 0 | 98 ± 2 | 400 ± 0 | 98 ± 2 | 0.00 (max 0) | 0.07/0.07 |
| E1 | forgetful | 96.54 ± 0.14 | 94.72 ± 0.14 | -1.82 ± 0.08 | 96.9 ± 0.3 | 96.7 ± 0.3 | -0.21 | 92.6 ± 0.5 | 92.4 ± 0.5 | 96.4 ± 0.2 | 94.6 ± 0.4 | 1630 ± 23 | 1478 ± 24 | 665 ± 5 | 486 ± 7 | 396 ± 1 | 128 ± 3 | 396 ± 1 | 128 ± 3 | 0.00 (max 0) | 4.20/4.23 |
| E1 | strong | 99.22 ± 0.03 | 98.06 ± 0.03 | -1.15 ± 0.03 | 99.9 ± 0.0 | 99.9 ± 0.1 | -0.01 | 99.4 ± 0.1 | 99.2 ± 0.2 | 99.1 ± 0.2 | 97.9 ± 0.2 | 1278 ± 11 | 1088 ± 12 | 593 ± 3 | 369 ± 4 | 400 ± 0 | 88 ± 2 | 400 ± 0 | 87 ± 2 | 0.00 (max 0) | 0.03/0.03 |
| E2 | default | 98.52 ± 0.05 | 97.66 ± 0.04 | -0.87 ± 0.05 | 99.9 ± 0.0 | 99.9 ± 0.0 | 0.00 | 97.6 ± 0.3 | 99.0 ± 0.2 | 98.5 ± 0.2 | 97.5 ± 0.2 | 1251 ± 13 | 1112 ± 14 | 491 ± 4 | 319 ± 5 | 358 ± 2 | 79 ± 2 | 358 ± 2 | 79 ± 2 | 0.00 (max 0) | 0.13/0.10 |
| E2 | forgetful | 96.39 ± 0.15 | 95.53 ± 0.13 | -0.86 ± 0.10 | 97.5 ± 0.3 | 97.8 ± 0.2 | 0.29 | 90.1 ± 0.5 | 94.4 ± 0.4 | 96.2 ± 0.3 | 95.3 ± 0.4 | 1520 ± 24 | 1406 ± 24 | 540 ± 6 | 398 ± 7 | 354 ± 2 | 111 ± 3 | 354 ± 2 | 111 ± 3 | 0.00 (max 0) | 4.23/4.27 |
| E2 | strong | 98.95 ± 0.04 | 98.27 ± 0.04 | -0.68 ± 0.04 | 100.0 ± 0.0 | 100.0 ± 0.0 | -0.01 | 99.2 ± 0.1 | 99.6 ± 0.1 | 99.0 ± 0.2 | 98.0 ± 0.2 | 1174 ± 12 | 1026 ± 11 | 475 ± 4 | 293 ± 4 | 358 ± 2 | 69 ± 2 | 358 ± 2 | 69 ± 2 | 0.00 (max 0) | 0.03/0.03 |
| F1 | default | 97.31 ± 0.85 | 96.94 ± 0.34 | -0.37 ± 0.53 | 99.7 ± 0.2 | 99.7 ± 0.2 | -0.01 | 94.3 ± 2.5 | 96.1 ± 1.4 | 97.3 ± 0.9 | 96.9 ± 0.4 | 935 ± 51 | 889 ± 15 | 317 ± 52 | 244 ± 15 | 227 ± 39 | 107 ± 8 | 200 ± 54 | 53 ± 17 | 0.00 (max 0) | 0.07/0.07 |
| F1 | forgetful | 94.12 ± 1.34 | 93.77 ± 0.68 | -0.34 ± 0.69 | 94.6 ± 1.5 | 95.2 ± 1.1 | 0.58 | 81.1 ± 6.1 | 85.6 ± 3.7 | 94.0 ± 1.3 | 93.5 ± 0.7 | 1154 ± 50 | 1116 ± 21 | 370 ± 52 | 312 ± 20 | 231 ± 35 | 127 ± 9 | 198 ± 53 | 71 ± 22 | 0.00 (max 0) | 3.27/3.07 |
| F1 | strong | 98.08 ± 0.66 | 97.82 ± 0.24 | -0.27 ± 0.43 | 99.9 ± 0.1 | 99.9 ± 0.1 | -0.04 | 97.8 ± 1.0 | 98.4 ± 0.7 | 98.0 ± 0.8 | 97.6 ± 0.4 | 872 ± 51 | 823 ± 13 | 299 ± 52 | 222 ± 13 | 225 ± 40 | 99 ± 8 | 200 ± 54 | 47 ± 16 | 0.00 (max 0) | 0.03/0.03 |
| F2 | default | 99.06 ± 0.04 | 97.55 ± 0.05 | -1.52 ± 0.04 | 99.9 ± 0.0 | 99.9 ± 0.1 | -0.06 | 99.2 ± 0.2 | 98.7 ± 0.2 | 98.9 ± 0.2 | 97.4 ± 0.3 | 1120 ± 12 | 979 ± 12 | 464 ± 3 | 317 ± 4 | 300 ± 0 | 120 ± 1 | 300 ± 0 | 56 ± 1 | 0.00 (max 0) | 0.10/0.07 |
| F2 | forgetful | 96.82 ± 0.18 | 95.01 ± 0.18 | -1.81 ± 0.09 | 97.4 ± 0.3 | 97.2 ± 0.3 | -0.27 | 93.6 ± 0.5 | 93.2 ± 0.6 | 96.5 ± 0.3 | 94.6 ± 0.4 | 1368 ± 21 | 1246 ± 22 | 528 ± 5 | 402 ± 7 | 296 ± 1 | 136 ± 2 | 296 ± 1 | 81 ± 2 | 0.00 (max 0) | 3.90/3.97 |
| F2 | strong | 99.40 ± 0.03 | 98.26 ± 0.05 | -1.14 ± 0.04 | 100.0 ± 0.0 | 100.0 ± 0.0 | 0.00 | 99.8 ± 0.1 | 99.7 ± 0.1 | 99.3 ± 0.1 | 97.9 ± 0.3 | 1048 ± 11 | 899 ± 11 | 444 ± 4 | 287 ± 4 | 300 ± 0 | 114 ± 1 | 300 ± 0 | 48 ± 1 | 0.00 (max 0) | 0.03/0.03 |
| G | default | 95.51 ± 0.09 | 95.59 ± 0.08 | 0.08 ± 0.05 | 99.1 ± 0.1 | 99.3 ± 0.1 | 0.17 | 92.6 ± 0.7 | 92.9 ± 0.6 | 95.5 ± 0.3 | 95.5 ± 0.2 | 2623 ± 34 | 2624 ± 33 | – | – | 62 ± 1 | 62 ± 1 | – | – | – | 2.10/1.37 |
| G | forgetful | 89.51 ± 0.29 | 89.82 ± 0.27 | 0.32 ± 0.17 | 93.0 ± 0.4 | 93.4 ± 0.4 | 0.39 | 70.8 ± 0.9 | 70.9 ± 0.8 | 89.2 ± 0.6 | 89.6 ± 0.5 | 3684 ± 58 | 3704 ± 59 | – | – | 81 ± 2 | 81 ± 2 | – | – | – | 24.60/21.93 |
| G | strong | 96.83 ± 0.07 | 96.84 ± 0.07 | 0.01 ± 0.02 | 99.6 ± 0.1 | 99.7 ± 0.1 | 0.07 | 97.3 ± 0.3 | 97.3 ± 0.3 | 96.9 ± 0.2 | 96.8 ± 0.2 | 2285 ± 19 | 2288 ± 19 | – | – | 57 ± 1 | 57 ± 1 | – | – | – | 0.73/0.40 |
| H1 | default | 99.09 ± 0.04 | 97.54 ± 0.04 | -1.55 ± 0.04 | 100.0 ± 0.0 | 99.9 ± 0.1 | -0.03 | 99.4 ± 0.2 | 98.9 ± 0.3 | 98.9 ± 0.2 | 97.4 ± 0.4 | 1125 ± 12 | 993 ± 13 | 399 ± 3 | 235 ± 4 | 300 ± 0 | 58 ± 2 | 300 ± 0 | 58 ± 2 | 0.00 (max 0) | 0.13/0.07 |
| H1 | forgetful | 96.78 ± 0.21 | 95.04 ± 0.21 | -1.74 ± 0.12 | 97.5 ± 0.4 | 97.4 ± 0.3 | -0.11 | 93.7 ± 0.4 | 93.6 ± 0.5 | 96.3 ± 0.4 | 94.7 ± 0.5 | 1393 ± 23 | 1282 ± 24 | 445 ± 4 | 309 ± 5 | 295 ± 1 | 84 ± 2 | 295 ± 1 | 84 ± 2 | 0.00 (max 0) | 4.97/4.63 |
| H1 | strong | 99.42 ± 0.02 | 98.24 ± 0.04 | -1.19 ± 0.03 | 100.0 ± 0.0 | 100.0 ± 0.0 | 0.00 | 99.8 ± 0.1 | 99.7 ± 0.1 | 99.4 ± 0.1 | 98.1 ± 0.3 | 1050 ± 11 | 909 ± 12 | 382 ± 3 | 209 ± 3 | 300 ± 0 | 50 ± 1 | 300 ± 0 | 49 ± 1 | 0.00 (max 0) | 0.03/0.03 |
| H2 | default | 95.61 ± 0.11 | 96.28 ± 0.10 | 0.66 ± 0.08 | 98.9 ± 0.2 | 98.9 ± 0.2 | -0.01 | 87.0 ± 0.7 | 91.8 ± 0.6 | 95.4 ± 0.5 | 95.8 ± 0.4 | 751 ± 8 | 780 ± 8 | 187 ± 3 | 194 ± 3 | 100 ± 0 | 47 ± 1 | 100 ± 0 | 45 ± 2 | 0.00 (max 0) | 0.03/0.00 |
| H2 | forgetful | 90.51 ± 0.31 | 91.60 ± 0.34 | 1.09 ± 0.12 | 88.6 ± 0.9 | 90.0 ± 0.8 | 1.34 | 66.9 ± 1.0 | 75.7 ± 1.1 | 90.1 ± 0.5 | 91.3 ± 0.6 | 921 ± 12 | 948 ± 12 | 230 ± 4 | 240 ± 4 | 99 ± 0 | 58 ± 2 | 99 ± 0 | 57 ± 2 | 0.00 (max 0) | 0.90/0.90 |
| H2 | strong | 96.84 ± 0.09 | 97.45 ± 0.08 | 0.61 ± 0.05 | 99.6 ± 0.1 | 99.7 ± 0.1 | 0.09 | 95.0 ± 0.4 | 96.9 ± 0.4 | 96.3 ± 0.4 | 97.1 ± 0.4 | 707 ± 7 | 735 ± 7 | 177 ± 3 | 184 ± 2 | 100 ± 0 | 44 ± 1 | 100 ± 0 | 42 ± 2 | 0.00 (max 0) | 0.00/0.00 |

Criterion failures:
- A/default: Δ mean R = -1.55 pp < −0.5
- A/forgetful: Δ mean R = -1.87 pp < −0.5
- A/strong: Δ mean R = -1.19 pp < −0.5
- A_easy/default: Δ mean R = -1.53 pp < −0.5
- A_easy/forgetful: Δ mean R = -1.84 pp < −0.5
- A_easy/strong: Δ mean R = -1.17 pp < −0.5
- B10/default: Δ mean R = -1.27 pp < −0.5
- B10/forgetful: Δ mean R = -1.60 pp < −0.5
- B10/strong: Δ mean R = -0.99 pp < −0.5
- B60/default: Δ mean R = -1.25 pp < −0.5
- B60/forgetful: Δ mean R = -1.55 pp < −0.5
- B60/strong: Δ mean R = -0.93 pp < −0.5
- D/default: Δ mean R = -1.24 pp < −0.5
- D/forgetful: Δ mean R = -1.28 pp < −0.5
- D/strong: Δ mean R = -0.91 pp < −0.5
- E1/default: Δ mean R = -1.50 pp < −0.5
- E1/forgetful: Δ mean R = -1.82 pp < −0.5
- E1/strong: Δ mean R = -1.15 pp < −0.5
- E2/default: Δ mean R = -0.87 pp < −0.5
- E2/forgetful: Δ mean R = -0.86 pp < −0.5
- E2/strong: Δ mean R = -0.68 pp < −0.5
- F2/default: Δ mean R = -1.52 pp < −0.5
- F2/forgetful: Δ mean R = -1.81 pp < −0.5
- F2/strong: Δ mean R = -1.14 pp < −0.5
- H1/default: Δ mean R = -1.55 pp < −0.5
- H1/forgetful: Δ mean R = -1.74 pp < −0.5
- H1/strong: Δ mean R = -1.19 pp < −0.5

### G without Play (PLAY_P=0)
| Scenario | Learner | mean exam-day true R v30 | v31 | Δ (paired, pp) | ≥80% v30 | v31 | Δ pp | ≥90% v30 | v31 | score v30 | v31 | reviews v30 | v31 | last 5 d v30 | v31 | max/day v30 | v31 | eve v30 | v31 | left after exam (needed) v31 | leeches v30/v31 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| G | default | 94.54 ± 0.05 | 94.54 ± 0.05 | 0.00 ± 0.00 | 99.6 ± 0.1 | 99.6 ± 0.1 | 0.00 | 92.3 ± 0.3 | 92.3 ± 0.3 | 94.5 ± 0.3 | 94.5 ± 0.3 | 2565 ± 25 | 2565 ± 25 | – | – | 60 ± 1 | 60 ± 1 | – | – | – | 1.90/1.90 |
| G | forgetful | 88.83 ± 0.22 | 88.83 ± 0.22 | 0.00 ± 0.00 | 94.7 ± 0.4 | 94.7 ± 0.4 | 0.00 | 62.4 ± 0.7 | 62.4 ± 0.7 | 89.0 ± 0.5 | 89.0 ± 0.5 | 3476 ± 48 | 3476 ± 48 | – | – | 74 ± 1 | 74 ± 1 | – | – | – | 22.77/22.77 |
| G | strong | 95.98 ± 0.04 | 95.98 ± 0.04 | 0.00 ± 0.00 | 99.8 ± 0.1 | 99.8 ± 0.1 | 0.00 | 98.4 ± 0.2 | 98.4 ± 0.2 | 96.0 ± 0.3 | 96.0 ± 0.3 | 2257 ± 20 | 2257 ± 20 | – | – | 55 ± 1 | 55 ± 1 | – | – | – | 0.53/0.53 |

Criterion failures:
- none

All 90 G runs are bit-identical between v3.0 and v3.1. With Play on, the small positive Δ comes from the new leech rule: Play misses on cards that weren't due no longer count, so fewer cards get suspended (e.g. forgetful 24.6 vs 21.9 suspended).

**"v3.1 never leaves a needed card after the exam":** confirmed. The count is 0 in every run (max 0) in every scenario. A few eve lapses re-graduate with predicted R < 95% and a due date after the exam, but they were reviewed on the eve, and no day is left to put them on. v3.0 left about 33 cards per run after the exam in E2 (imported history is never clamped), yet v3.0 still won E2 on mean recall because it crammed every other card on the eve.

## Why v3.1 is worse (A/default, means over 30 seeds)
| | cards with no review in the last 5 days | their true R | cards reviewed in the window | their true R |
|---|---|---|---|---|
| v3.0 | 0 | – | 300 (all on the eve) | 99.10% |
| v3.1 | 110 | 96.63% | 190 (spread over 5 days) | 98.07% |

The forgetful learner is worse: 90 cards left alone at 92.8% true. The app's default parameters are over-confident for this learner, so a "95% predicted" card is really about 93%.

- **Mechanism 1 (dominant):** the ≥ 95% cut-off. A 95% threshold leaves cards that average about 96–97% (default learner) or about 93% (forgetful), against ~99% for a card reviewed on the eve.
- **Mechanism 2 (minor):** cards reviewed 2–5 days before instead of 1 day before.

The fix grid separates the two. Shrinking the window alone (0.95/W3, 0.95/W2) barely helps (−1.79, −1.69 pp worst). Raising the threshold does most of the work.

Where v3.1 wins:
- **C:** v3.0's eve clamp sends hundreds of cards to the eve, but the 120/day review limit lets only 120 through. The rest are never reviewed. v3.1 spreads them over the window.
- **H2:** studying one subdeck a day misses v3.0's eve for two of the three subdecks. v3.1's shared plan spreads cards over 5 days, so every subdeck gets some.
- **F1:** a randomly skipped eve hurts v3.0 a lot. v3.1 has narrower CIs.

## Tested fixes (applied only to copies of v3.1's js/ in `simcmp/fix_*`, built by `mkfix.sh`)
Each fix adds `FINAL_R` (the final-pass threshold) in `planFinalPass` and `examClamp`, and changes `FINAL_DAYS`. `EXAM_RETENTION` (0.95, the retention ramp) is not changed.
| variant | cells failing | worst Δ mean R (pp) | worst Δ ≥80% (pp) | mean Δ R (pp) | reviews vs v3.0 | max/day (A default) | eve (A default) |
|---|---|---|---|---|---|---|---|
| v31 | 27/36 | -1.87 (A|forgetful) | -0.32 (A|forgetful) | -0.87 | -8.3% | 57 | 57 |
| fix_t95_w3 | 27/36 | -1.79 (A|forgetful) | -0.28 (H1|forgetful) | -0.83 | -8.8% | 64 | 64 |
| fix_t97_w5 | 21/36 | -0.92 (A|forgetful) | -0.24 (A|forgetful) | -0.26 | -2.4% | 80 | 80 |
| fix_t98_w5 | 2/36 | -0.54 (F2|default) | -0.16 (F2|forgetful) | -0.00 | 1.8% | 100 | 100 |
| fix_t99_w5 | 0/36 | -0.26 (D|default) | -0.23 (H1|forgetful) | 0.24 | 8.8% | 145 | 145 |
| fix_t95_w2 | 27/36 | -1.69 (A_easy|forgetful) | -0.40 (H1|forgetful) | -0.82 | -9.6% | 82 | 82 |
| fix_t97_w3 | 18/36 | -0.82 (A|forgetful) | -0.24 (A|forgetful) | -0.21 | -3.5% | 94 | 94 |
| fix_t98_w3 | 0/36 | -0.44 (F2|default) | -0.22 (H1|forgetful) | 0.02 | -0.2% | 115 | 115 |
| fix_t99_w3 | 0/36 | -0.18 (D|default) | -0.19 (H1|forgetful) | 0.23 | 5.2% | 156 | 156 |
| fix_t98_w2 | 0/36 | -0.37 (F2|default) | -0.33 (B10|forgetful) | 0.01 | -1.7% | 143 | 143 |
| fix_t99_w2 | 0/36 | -0.14 (D|default) | -0.30 (H1|forgetful) | 0.18 | 2.4% | 180 | 180 |

"Reviews vs v3.0" is the mean of the per-cell ratios. Max/day and eve are for A/default.

### Recommended: FINAL_R = 0.98, FINAL_DAYS = 3 (passes all 36 cells)

fix_t98_w3: cell | ΔR pp | Δ≥80 pp | reviews | max/day | eve
| A|default | -0.40 | -0.00 | 1116 | 115 | 115 |
| A|forgetful | -0.40 | -0.09 | 1412 | 142 | 142 |
| A|strong | -0.32 | 0.00 | 1027 | 104 | 104 |
| A_easy|default | -0.32 | -0.03 | 1103 | 145 | 145 |
| A_easy|forgetful | -0.33 | -0.12 | 1393 | 166 | 166 |
| A_easy|strong | -0.24 | 0.00 | 1019 | 136 | 136 |
| B10|default | -0.32 | -0.03 | 790 | 174 | 174 |
| B10|strong | -0.26 | 0.00 | 767 | 165 | 165 |
| B10|forgetful | -0.33 | -0.14 | 858 | 192 | 192 |
| B60|default | -0.28 | -0.01 | 1437 | 107 | 107 |
| B60|forgetful | -0.22 | 0.08 | 1917 | 125 | 125 |
| B60|strong | -0.20 | -0.01 | 1299 | 100 | 100 |
| C|default | 0.98 | 0.15 | 3062 | 120 | 120 |
| C|forgetful | 0.56 | 0.84 | 3652 | 120 | 120 |
| C|strong | 0.94 | 0.04 | 2857 | 120 | 120 |
| D|default | -0.34 | 0.03 | 1541 | 99 | 99 |
| D|forgetful | -0.10 | 0.47 | 2080 | 113 | 113 |
| D|strong | -0.27 | 0.01 | 1384 | 93 | 93 |
| E1|default | -0.36 | 0.02 | 1339 | 187 | 187 |
| E1|forgetful | -0.35 | -0.07 | 1644 | 218 | 218 |
| E1|strong | -0.28 | -0.00 | 1246 | 174 | 174 |
| E2|default | 0.21 | 0.01 | 1264 | 153 | 153 |
| E2|forgetful | 0.49 | 0.37 | 1564 | 184 | 184 |
| E2|strong | 0.16 | 0.00 | 1172 | 141 | 141 |
| F1|default | 0.46 | 0.02 | 978 | 149 | 97 |
| F1|forgetful | 0.68 | 0.31 | 1206 | 166 | 114 |
| F1|strong | 0.37 | -0.02 | 908 | 142 | 90 |
| F2|default | -0.44 | -0.01 | 1085 | 113 | 112 |
| F2|forgetful | -0.41 | -0.02 | 1356 | 142 | 142 |
| F2|strong | -0.35 | 0.00 | 1001 | 103 | 101 |
| H1|default | -0.41 | 0.01 | 1112 | 115 | 115 |
| H1|forgetful | -0.41 | -0.22 | 1408 | 143 | 143 |
| H1|strong | -0.32 | 0.00 | 1023 | 104 | 104 |
| H2|default | 1.13 | -0.01 | 821 | 80 | 80 |
| H2|forgetful | 1.57 | 1.30 | 986 | 85 | 85 |
| H2|strong | 0.93 | 0.11 | 776 | 79 | 79 |

- Paired 95% CIs on the tightest cells: F2/default −0.44 ± 0.03, D/default −0.34 ± 0.03, A/forgetful −0.40 ± 0.08 pp. All are above −0.5.
- It needs about the same total reviews as v3.0. The peak day is still 2–3× lower (A: 115 vs 300).
- If more margin is wanted, use FINAL_R = 0.99 / FINAL_DAYS = 3: worst −0.18 pp, +5% reviews, peak about 156.
- Ordering was not the problem: the final pass already puts the weakest cards closest to the exam, and the gain order affects only C, where v3.1 already wins.

**Suggested code change (not applied):** in exam.js, add `export const FINAL_R = 0.98;` and set `FINAL_DAYS = 3`. Use `FINAL_R` in `planFinalPass` (`if (r < FINAL_R)`) and in `examClamp` (`>= FINAL_R`). Keep `EXAM_RETENTION` for the ramp. Also update the "≥95%" wording in the exam.js comments, PLAN.md and the UI copy.

## Caveats
- The true model is FSRS-shaped (with different weights and heterogeneity). A learner whose forgetting isn't FSRS-like could behave differently.
- The exam is scored at 09:00, 24 h after the eve session. That favours eve cramming, which is realistic.
- Play is MC only. Survival short-timer logging was not exercised (classic 8 s timers), so that change has no effect here.
- Workload is counted in reviews. Time per card is not modelled.

## Files
- `harness.mjs`: the simulator.
- `run.mjs`: parallel runner.
- `summarize.mjs`: tables and verdict.
- `fixsum.mjs`: fix grid.
- `mkfix.sh`: builds the fix variants.
- `loader.mjs`, `memdb.mjs`: module loader and in-memory db shim.
- `out/*.json`: raw per-seed results.

Reproduce: `node run.mjs out/main.json 30 v30,v31`, then `node summarize.mjs out/main.json` (needs the worktrees).
