# Rescue ("back from a break") simulation, B1 (Round 2, Batch 0A)

Tests the catch-up plan (`rescueToday` / `queueFrom` rescue in `js/queue.js`) and "I'm away" review-ahead against simulated students, using the real queue code over the in-memory database (see `README.md` in this folder). Run with `harness2.mjs` (scenarios `Gb` and `Ab`, env `RESCUE`, `PAUSE`, `AWAY`, `CARDS`) and summarised by `summarize2.mjs ... rescue` (`summarize-rescue.mjs`).

## Result in one paragraph

The plan does what it is for: with no daily review limit, the biggest day after a break drops by 56 to 84% (N=3 to 10), and N=5 gives a 67 to 74% cut (rule 1 passes). **Rule 2 fails**: spreading the pile over more days leaves the neglected cards forgotten for longer, so the average recall over the 30 recovery days dips, and it dips more the larger N is. N=3 passes everywhere. N=5 fails in 1 of 27 cells (30-day break, no review limit, forgetful learner: -0.73 points against a limit of -0.5). N=7 fails in 3 and N=10 in 11. Rules 3 and 4 pass (a review limit of 60 already spreads the load, so a plan changes almost nothing; exam decks are exempt, so they are untouched by design). **Rule 5 (away mode) fails**: reviewing ahead before a break lifts recall on the first day back by 1.5 to 3.2 points and cuts the return pile by about 60% when there is no review limit, but a week later recall is lower (R7 -0.3 to -2.5 points) and after a 30-day break the 30-days-back figure is lower too (-0.6 to -0.7 points on average).

**Recommended cap on N: 5, with 3 as the default; do not offer 7 or 10.** The rule as written ("the largest N that passes every cell") gives **3**. I would still allow 5 because it fails in a single learner-cell (and only when there is no review limit and the break was 30 days), while giving a much bigger cut in the worst day (74% against 62%). If you want the rule to the letter, set `RESCUE_MAX_DAYS` in `js/queue.js` to 3 (it is 5 now). I did not test N=4. Away mode should not be sold as improving recall: if it ships, describe it as "makes the day you get back lighter", not "remember more".

## What was run, and where it differs from the plan

- Scenario `Gb`: 1000 cards, 25 new a day, 60 days of study, then a break of 7, 14 or 30 days, then 30 days back; no exam. Scenario `Ab`: 600 cards, exam on day 50, break from day 26 of 7 or 14 days (a 30-day break would end after the exam, so it is not run for `Ab`).
- Learners: `default`, `forgetful`, `strong` (the true-memory models in `harness2.mjs`). Pairs are by seed, so a plan and its baseline see the same student.
- Grid: BREAK {7, 14, 30} x RL {none, 150, 60} x RESCUE {off, 3, 5, 7, 10} x PAUSE {0, 1} x AWAY {off, all}, all in `Gb`; `Ab` with RESCUE 5 and with AWAY. PAUSE only varies where there is a plan.
- **30 seeds per cell, not 60.** The full 60-seed grid is about 29,000 student-runs (about 2 hours with 4 processes), so I used the 30-seed fallback. The run was stopped once by the tool's 30-minute limit after 750 of 1458 jobs; I resumed only the unfinished environments (88 were complete), so nothing was lost or double counted.
- A plan starts on the first day back only where `rescueOffer()` would show the banner (backlog of 30 or more and at least twice a typical day). In this grid that was every seed, because a 1000-card deck always has a big backlog after a break. In a small deck the banner would not show, and the plan would not run.
- Follow-up run, same seeds: the first grid did not record recall on the day back (`Rret`) and could not test `PAUSE` (all 1000 cards are introduced by day 40, so there are no new cards left to pause). The follow-up reran base and AWAY with `Rret`, and a 2000-card deck for the pause test (`CARDS=2000`).
- "Away" means: on the last study day before the break, also review every card that comes due during the break (`aheadQueue`, all of them). I did not run the `AWAY=30` variant (a cap of 30 cards), because the plan's grid lists only `off` and `all`.
- Metrics: `recPeak` / `recP90` are the largest and 90th-percentile number of answers in one day after the break; `recMeanR` is mean true recall over the 30 recovery days (all cards, unintroduced ones count as 0); `R7` / `R14` are mean true recall 7 and 14 days after the return; `R30end` is the same at the end of the 30 days; `recLostDays` is card-days with true recall under 50% among started cards.

## Pre-set pass rules and results

1. RL none, N >= 5: `recPeak` at least 40% lower than base. **Pass** (67% to 74% at N=5, 72% to 84% at N=7 and 10; even N=3 gives 56 to 62%).
2. `recMeanR`, `R14`, `R30end` no worse than base by more than 0.5 points in any cell; `recLostDays` at most +5%. **Fail**, in 15 checks. By N: 3 passes everywhere, 5 fails in 1 of 27 cells, 7 in 3, 10 in 11. `R14` and `R30end` are never meaningfully worse than base for any N (they improve slightly, by up to +0.4 and +0.24 points at N=10), so the cost is entirely the dip while the plan is running; it is gone by day 14.
3. RL 60: no cell worse than -0.3 points. **Pass** (a limit of 60 already spreads the pile, so a plan changes almost nothing: 0 to -0.1 points).
4. Exam day within +-0.2 points. **Pass, but trivially**: exam decks are exempt, so the plan changes nothing (exactly 0). Away mode on an exam deck is within +-0.2 on average but +1.65 points for the forgetful learner at break 14 with RL 60.
5. Away mode: R7 up by at least 0.5 points, reviews up by at most 15%, `R30end` no worse than -0.3 points. **Fail.** Reviews stay within +8%. R7 is lower than baseline in all 18 cells with RL none or 150 and improves (on average) only with RL 60. `R30end` is lower after a 30-day break by 0.6 to 0.7 points on average (up to 0.9 for one learner).

Other things the numbers show:

- A plan trades one huge day for several heavy ones. The 90th-percentile day gets bigger, not smaller (for example 47 to 120 answers at N=5, break 14, no limit): that is the plan working, but the sheet should say "about 120 a day for 5 days".
- With RL 150 or 60 the plan matters much less, because the review limit already caps the day: RL 150 cuts the worst day by 0 to 59% depending on N and the break length (nothing at N=3 after a 30-day break), against 56 to 84% with no limit.
- Pausing new cards: not testable in the main grid (identical numbers with it on and off, since there are no new cards left). In the 2000-card test it lowers the peak day further (368 to 272 at RL none), and it delays about 125 new cards, which is why the all-cards recall figures drop while the plan runs; by 30 days back the difference is zero (`R30end` -0.02). The `lost-days` column in that table is inflated by a quirk of the simulator (Play rounds touch cards that were never introduced, and those stay "lost" while new cards are paused), so do not read it as a cost of pausing.

## Full results (generated by `summarize2.mjs ... rescue`)

### The catch-up plan (Gb: 1000 cards, 60 days of study, a break, 30 days back)

Averages over the 3 learners; deltas are plan minus no plan, in percentage points (pp) of true recall, paired by seed. "Peak" and "P90" are the largest and the 90th-percentile number of answers in a day after the break.

| Break | RL | N | offer fires | peak | peak cut | P90 | Δ recMeanR | Δ R14 | Δ R30end | Δ R7 | lost-days Δ% | reviews Δ% |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | none | 3 | 100% | 299→133 | 56% | 46→50 | -0.07 | +0.03 | +0.02 | +0.07 | -0.5 | -0.2 |
| 7 | none | 5 | 100% | 299→100 | 67% | 46→87 | -0.14 | +0.08 | +0.04 | +0.18 | -1.2 | -0.4 |
| 7 | none | 7 | 100% | 299→84 | 72% | 46→76 | -0.22 | +0.11 | +0.05 | +0.27 | -1.7 | -0.6 |
| 7 | none | 10 | 100% | 299→72 | 76% | 46→66 | -0.36 | +0.17 | +0.07 | -0.69 | -1.6 | -0.9 |
| 7 | 150 | 3 | 100% | 174→132 | 25% | 48→51 | -0.03 | +0.02 | +0.00 | +0.04 | -0.6 | -0.1 |
| 7 | 150 | 5 | 100% | 174→100 | 44% | 48→87 | -0.10 | +0.07 | +0.02 | +0.14 | -1.1 | -0.3 |
| 7 | 150 | 7 | 100% | 174→84 | 53% | 48→76 | -0.19 | +0.10 | +0.03 | +0.24 | -1.7 | -0.5 |
| 7 | 150 | 10 | 100% | 174→72 | 59% | 48→66 | -0.32 | +0.16 | +0.05 | -0.73 | -1.5 | -0.8 |
| 7 | 60 | 3 | 100% | 79→79 | 0% | 73→73 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 7 | 60 | 5 | 100% | 79→79 | 0% | 73→73 | -0.00 | -0.00 | +0.00 | +0.01 | -0.2 | -0.0 |
| 7 | 60 | 7 | 100% | 79→77 | 2% | 73→71 | -0.03 | +0.01 | -0.01 | -0.00 | +1.4 | -0.0 |
| 7 | 60 | 10 | 100% | 79→72 | 9% | 73→67 | -0.10 | +0.05 | -0.00 | -0.38 | +5.2 | -0.1 |
| 14 | none | 3 | 100% | 470→192 | 59% | 47→53 | -0.12 | +0.07 | +0.03 | +0.09 | -0.1 | -0.3 |
| 14 | none | 5 | 100% | 470→135 | 72% | 47→120 | -0.25 | +0.14 | +0.05 | +0.23 | +0.2 | -0.5 |
| 14 | none | 7 | 100% | 470→110 | 77% | 47→100 | -0.39 | +0.21 | +0.06 | +0.36 | -0.3 | -0.8 |
| 14 | none | 10 | 100% | 470→91 | 81% | 47→83 | -0.61 | +0.31 | +0.12 | -1.17 | -0.1 | -1.1 |
| 14 | 150 | 3 | 100% | 181→173 | 4% | 83→85 | -0.01 | +0.00 | -0.00 | +0.01 | +0.3 | -0.0 |
| 14 | 150 | 5 | 100% | 181→135 | 26% | 83→120 | -0.12 | +0.05 | +0.02 | +0.13 | +0.4 | -0.1 |
| 14 | 150 | 7 | 100% | 181→110 | 40% | 83→100 | -0.27 | +0.12 | +0.03 | +0.26 | -0.0 | -0.4 |
| 14 | 150 | 10 | 100% | 181→91 | 51% | 83→83 | -0.49 | +0.22 | +0.09 | -1.27 | +0.2 | -0.7 |
| 14 | 60 | 3 | 100% | 81→81 | 0% | 75→75 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 14 | 60 | 5 | 100% | 81→81 | 0% | 75→75 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 14 | 60 | 7 | 100% | 81→81 | 0% | 75→75 | -0.00 | +0.01 | +0.01 | -0.01 | +0.2 | -0.0 |
| 14 | 60 | 10 | 100% | 81→80 | 1% | 75→74 | -0.06 | +0.05 | -0.01 | -0.22 | +1.2 | +0.0 |
| 30 | none | 3 | 100% | 744→285 | 62% | 50→60 | -0.22 | +0.08 | +0.07 | +0.08 | -2.2 | -0.2 |
| 30 | none | 5 | 100% | 744→192 | 74% | 50→176 | -0.48 | +0.15 | +0.11 | +0.18 | -1.7 | -0.5 |
| 30 | none | 7 | 100% | 744→151 | 80% | 50→141 | -0.74 | +0.27 | +0.14 | +0.36 | -2.6 | -0.7 |
| 30 | none | 10 | 100% | 744→120 | 84% | 50→112 | -1.13 | +0.39 | +0.24 | -2.10 | -3.3 | -1.2 |
| 30 | 150 | 3 | 100% | 189→189 | 0% | 170→170 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 30 | 150 | 5 | 100% | 189→179 | 6% | 170→164 | -0.06 | +0.02 | +0.00 | +0.04 | +0.6 | +0.1 |
| 30 | 150 | 7 | 100% | 189→149 | 22% | 170→140 | -0.29 | +0.13 | +0.05 | +0.07 | -0.2 | +0.1 |
| 30 | 150 | 10 | 100% | 189→120 | 37% | 170→112 | -0.68 | +0.26 | +0.16 | -2.34 | -1.0 | -0.3 |
| 30 | 60 | 3 | 100% | 84→84 | 0% | 78→78 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 30 | 60 | 5 | 100% | 84→84 | 0% | 78→78 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 30 | 60 | 7 | 100% | 84→84 | 0% | 78→78 | +0.00 | +0.00 | +0.00 | +0.00 | +0.0 | +0.0 |
| 30 | 60 | 10 | 100% | 84→84 | 0% | 78→78 | -0.00 | -0.00 | -0.00 | -0.01 | +0.0 | -0.0 |

Pause new cards on or off gives identical numbers in this grid, because all 1000 cards are already introduced by the break (see the 2000-card test below).

### "I'm away" (review ahead everything that comes due during the break, the day before it starts)

Without a plan. Rret is mean true recall on the first day back, before studying (only where the run recorded it).

| Break | RL | peak | peak cut | Δ Rret | Δ R7 | Δ R14 | Δ R30end | Δ recMeanR | lost-days Δ% | reviews Δ% |
|---|---|---|---|---|---|---|---|---|---|---|
| 7 | none | 299→110 | 65% | +1.55 | -0.28 | -0.10 | -0.01 | -0.11 | -2.3 | +1.0 |
| 7 | 150 | 174→110 | 38% | +1.55 | -0.31 | -0.11 | -0.04 | -0.08 | -2.2 | +1.1 |
| 7 | 60 | 79→94 | -19% | +1.40 | +0.43 | +0.14 | -0.00 | +0.37 | -3.9 | +2.9 |
| 14 | none | 470→183 | 63% | +2.24 | -0.74 | -0.45 | -0.15 | -0.41 | -0.6 | +2.0 |
| 14 | 150 | 181→175 | 5% | +2.24 | -0.84 | -0.54 | -0.18 | -0.29 | -0.4 | +2.4 |
| 14 | 60 | 81→116 | -43% | +2.03 | +1.00 | +0.05 | -0.13 | +0.56 | -1.4 | +5.0 |
| 30 | none | 744→318 | 59% | +3.22 | -1.68 | -1.30 | -0.67 | -1.16 | -0.3 | +3.6 |
| 30 | 150 | 189→253 | -32% | +3.22 | -1.91 | -1.42 | -0.74 | -0.72 | +2.7 | +4.4 |
| 30 | 60 | 84→137 | -64% | +2.84 | +2.30 | +0.12 | -0.60 | +0.83 | -3.8 | +8.0 |

### Exam deck (Ab: break from day 26, exam on day 50). Exam decks are exempt from the plan, so a plan changes nothing there by design.

| Break | RL | what | Δ exam-day recall (pp), mean of 3 learners | worst learner |
|---|---|---|---|---|
| 7 | none | away mode | +0.06 | +0.17 ± 0.12 (forgetful) |
| 7 | none | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |
| 7 | 150 | away mode | +0.12 | +0.26 ± 0.14 (forgetful) |
| 7 | 150 | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |
| 7 | 60 | away mode | -0.07 | +0.24 ± 0.21 (forgetful) |
| 7 | 60 | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |
| 14 | none | away mode | +0.07 | +0.19 ± 0.10 (forgetful) |
| 14 | none | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |
| 14 | 150 | away mode | -0.08 | -0.14 ± 0.03 (default) |
| 14 | 150 | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |
| 14 | 60 | away mode | +0.64 | +1.65 ± 0.22 (forgetful) |
| 14 | 60 | plan N=5 | +0.00 | +0.00 ± 0.00 (default) |

### Does pausing new cards matter? (2000 cards, so new cards are still arriving at the break; break 14, plan N=5)

Note: recMeanR, R14 and R30end average over ALL cards, and a card that has not been introduced yet counts as 0. Pausing delays about 25 new cards a day for N days, so those columns fall by roughly that share of the deck while the plan runs; "lost-days" counts only cards that were started.

| RL | pause | peak | Δ recMeanR | Δ R14 | Δ R30end | lost-days Δ% | reviews Δ% |
|---|---|---|---|---|---|---|---|
| none | off | 999→368 | -0.27 | +0.15 | +0.05 | +0.0 | -0.5 |
| none | on | 999→272 | -3.78 | -5.02 | -0.02 | +42.1 | -2.9 |
| 150 | off | 256→256 | -0.00 | +0.00 | +0.00 | +0.0 | -0.0 |
| 150 | on | 256→242 | -3.23 | -4.87 | -0.05 | +37.7 | -1.3 |

### Pass rules (set before the run)

- Rule 1, peak day at least 40% lower (RL none, N >= 5): pass
- Rule 2, recovery recall within -0.5 pp and lost days within +5% (RL none and 150): **FAIL** in 15 check(s)
- Rule 3, RL 60: no cell worse than -0.3 pp: pass
- Rule 4, exam day within +-0.2 pp: pass
- Rule 5, away mode: R7 +0.5 pp, reviews <= +15%, R30end >= -0.3 pp: **FAIL** in 25 check(s)

Rule 2 failures:
- break 7, RL none, N=10, forgetful: recMeanR -0.61 pp
- break 7, RL 150, N=10, forgetful: recMeanR -0.51 pp
- break 7, RL 60, N=10, strong: recLostDays +13.6%
- break 14, RL none, N=10, default: recMeanR -0.50 pp
- break 14, RL none, N=7, forgetful: recMeanR -0.63 pp
- break 14, RL none, N=10, forgetful: recMeanR -0.99 pp
- break 14, RL 150, N=10, forgetful: recMeanR -0.75 pp
- break 30, RL none, N=7, default: recMeanR -0.61 pp
- break 30, RL none, N=10, default: recMeanR -0.96 pp
- break 30, RL none, N=5, forgetful: recMeanR -0.73 pp
- break 30, RL none, N=7, forgetful: recMeanR -1.15 pp
- break 30, RL none, N=10, forgetful: recMeanR -1.75 pp
- break 30, RL none, N=10, strong: recMeanR -0.69 pp
- break 30, RL 150, N=10, default: recMeanR -0.61 pp
- break 30, RL 150, N=10, forgetful: recMeanR -0.96 pp

Rule 5 failures:
- break 7, RL none, default: R7 -0.27 pp (needs +0.5)
- break 7, RL none, forgetful: R7 -0.36 pp (needs +0.5)
- break 7, RL none, strong: R7 -0.20 pp (needs +0.5)
- break 7, RL 150, default: R7 -0.28 pp (needs +0.5)
- break 7, RL 150, forgetful: R7 -0.44 pp (needs +0.5)
- break 7, RL 150, strong: R7 -0.21 pp (needs +0.5)
- break 7, RL 60, default: R7 -0.23 pp (needs +0.5)
- break 7, RL 60, strong: R7 -0.32 pp (needs +0.5)
- break 14, RL none, default: R7 -0.72 pp (needs +0.5)
- break 14, RL none, forgetful: R7 -0.94 pp (needs +0.5)
- break 14, RL none, strong: R7 -0.55 pp (needs +0.5)
- break 14, RL 150, default: R7 -0.78 pp (needs +0.5)
- break 14, RL 150, forgetful: R7 -1.13 pp (needs +0.5)
- break 14, RL 150, strong: R7 -0.59 pp (needs +0.5)
- break 14, RL 60, default: R7 +0.47 pp (needs +0.5)
- break 14, RL 60, strong: R7 -0.19 pp (needs +0.5)
- break 30, RL none, default: R7 -1.68 pp (needs +0.5), R30end -0.63 pp
- break 30, RL none, forgetful: R7 -2.03 pp (needs +0.5), R30end -0.82 pp
- break 30, RL none, strong: R7 -1.35 pp (needs +0.5), R30end -0.57 pp
- break 30, RL 150, default: R7 -1.82 pp (needs +0.5), R30end -0.70 pp
- break 30, RL 150, forgetful: R7 -2.50 pp (needs +0.5), R30end -0.90 pp
- break 30, RL 150, strong: R7 -1.43 pp (needs +0.5), R30end -0.62 pp
- break 30, RL 60, default: R30end -0.80 pp
- break 30, RL 60, forgetful: R30end -0.31 pp
- break 30, RL 60, strong: R30end -0.69 pp

### Which N pass rules 1 to 4 everywhere

- N=3: passes
- N=5: fails rule 2 in 1 of 27 cells (3 breaks x RL none/150/60 x 3 learners)
- N=7: fails rule 2 in 3 of 27 cells (3 breaks x RL none/150/60 x 3 learners)
- N=10: fails rule 2 in 11 of 27 cells (3 breaks x RL none/150/60 x 3 learners)

Worst recMeanR cell: break 30, RL none, N=10, forgetful: -1.75 pp.
