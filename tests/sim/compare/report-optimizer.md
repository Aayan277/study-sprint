# FSRS optimizer: simulator check (PR 2)

Plan: `docs/design/fsrs-optimizer-plan.md` section 9 ("optimize at 400 reviews, then every 30 days").

## What is compared

`harness2.mjs` with `OPT=0` (the standard weights, as today) against `OPT=1` (the same students, same seeds), both on the
copy of `js/` from this branch. With `OPT=1` the harness does what the sheet does, with the app's real modules: once 400
reviews count, and then every 30 days, it reads the simulated review log (`fsrs-data.js buildHistories`) and runs `fitChecked`
(`fsrs-fit.js`, the same generator the worker runs):

1. fit on the first 80% of the days;
2. judge those weights against the ones in use on the last 20% (`judge`: log loss lower AND RMSE not more than 0.01 higher, at least 50 held-out predictions);
3. only if they win, fit again on everything and keep that in `settings.fsrsParams`.

The scheduler then uses them through the real `schedulerOptions` and `srs.rate`. Students have their own true FSRS weights:
`default`, `forgetful` (faster forgetting, steeper curve) and `strong`. Review only (`PLAY_P=0`): game answers are about to stop
writing to the schedule, and it keeps the log clean.

- **G**: 500 cards, 120 days, no exam. The long-run case.
- **A**: 300 cards, exam on day 30. The optimizer unlocks around day 10 to 14, so it has one run before the exam.

Metrics added to the harness: `revR` (the true chance of remembering at the moment a graduated card is answered in Review; the
scheduler's target is 0.90), `optRuns` / `optKept`, and `oos`: at the end of the run, take only the first 80% of the days, run the
whole decision on them (`fitChecked`), and score the weights the app would then use (the fitted ones if kept, else the standard
ones) against the standard weights on the last 20%. "If it always took the fit" is the same without the decision.

## History of this check

**First version (keep rule judged in-sample, gamma 8): 3 of 13 rules failed.**
Default student: weights fitted on the first 80% predicted the last 20% worse than the standard ones (log loss gain
-3.65 +/- 1.53 x10^-3). Strong student: retention -0.72 pp (R1) and no reliable log-loss gain. Forgetful student: clear gain.
The in-sample "keep only if better" rule lets noise through, and gamma 8 was too weak a pull toward the defaults.

**Changes made because of it**

1. **Held-out keep rule** (same owner rule, measured honestly): fit on the first 80% of the user's days, judge the fit against
   the current weights on the last 20%, refit on 100% only if it wins, otherwise keep the current weights. Fewer than 20
   held-out predictions: keep the current weights.
2. **Gamma** (pull toward the default weights) tuned on a separate seed set, **seeds 31 to 60**, scenario G, all three learners,
   with the held-out rule on. Criterion fixed beforehand: the largest sum, over the three learners, of the out-of-sample
   log-loss gain (x10^-3) of what the app does. Results (sum): gamma 8 -> 4.97, 40 -> 7.26, 150 -> 7.41, 400 -> 8.66,
   **1000 -> 11.43**, 3000 -> 10.33. `FIT_DEFAULTS.gamma` is now 1000.
3. The results below are on the **original seeds 1 to 30**, which were not used for tuning.
4. **Changes made after the code review** (see the next section).

## Decisions made after the code review (second round)

The reviewer found no correctness blockers; these were decided afterwards and the simulator was run again with all of them in:

- **RMSE slack.** Keep the new weights only if held-out log loss is lower AND held-out RMSE is not more than 0.01 (absolute) above the
  current weights' RMSE (`RMSE_SLACK`). Reason (the reviewer's small-n evidence): the binned RMSE is noisy on a small held-out slice;
  at about 800 reviews the strict "no higher" rule accepted 22 of 40 simulated gains, and the slack accepts 29 of 40. In the unit test
  with pinned seeds (12 forgetful students of about 800 reviews) the slack accepts 12 and the strict rule 11, and 8 of 12 default-like
  students still keep their weights.
- **HOLDOUT_MIN 50** (was 20): fewer than 50 held-out predictions gives no verdict and keeps the current weights. The split cutoff now counts
  only reviews that get a prediction, so the held-out slice really is about 20% of the predictions.
- Also in this round (no effect on the numbers): Cancel is checked again right before saving, a Reset pressed during a run is not
  overwritten, the numbers on the sheet say they come from the newest 20% of reviews, Review sessions start again when weights change
  (also from sync), and the main-thread fallback yields at least every 60 ms on 50,000 reviews.
- Gamma was **not** tuned again for the new rule (1000 stays).

## Pass rule (written before the first run)

Per cell, paired by seed, 30 seeds, 95% intervals (t, n = 30):

- **R1, retention is no worse.** The mean paired change in mean true recall is at least -0.30 pp, in G and in A. In G the same
  holds for the long-run recall (the mean over the last 60 days). (The tolerance used for every earlier simulator report.)
- **R2, on target when reviewed (G only).** `default` student: `revR` ends no more than 0.5 pp further from 0.90 than with the
  standard weights. `forgetful` and `strong`: `revR` ends closer to 0.90 than with the standard weights.
- **R3, workload (G only).** `default` student: total reviews are at most 3% higher.
- **R4, out-of-sample prediction (G only).** `forgetful` and `strong`: the log-loss gain on the last 20% is above 0 with its 95%
  interval. `default`: not worse than -0.001.

## Amendment to R1 (made after the first run, stated openly)

R1 as written punished the intended effect for students whose standard-weight recall is already above target: for them a
personal fit should lengthen intervals, give up some retention that was above 90%, and save reviews. **R1 now applies in G only
where the baseline recall when reviewed is at or below 0.90 + 0.5 pp (90.5%).** Where it is higher, R2 plus "reviews not higher"
stands in for it. In this run: `forgetful` (baseline 85.9) keeps R1; `strong` (93.4) uses R2 and "reviews not higher"; for
`default` (91.4) R1 is not applied and R3 (at most +3% reviews, unchanged) governs, because "reviews not higher" would contradict
R3 for it. R1 in scenario A (exam-day recall) is unchanged for everyone. R3 and R4 are unchanged, but R4 is now measured on what
the app does (held-out rule included), which is what the change to the keep rule is about; the raw-fit number is shown beside it.

## Results (seeds 1 to 30, gamma 1000, held-out keep rule with RMSE slack 0.01 and HOLDOUT_MIN 50)

### Scenario G (500 cards, 120 days, no exam)

| Learner | mean true R (pp), off -> on | d mean R pp | d long-run R pp | recall when reviewed, off -> on | reviews, off -> on | fits kept / run | out-of-sample log loss gain x10^-3 (what the app does) | ... if it always took the fit |
|---|---|---|---|---|---|---|---|---|
| default | 94.55 -> 94.61 | 0.05 +/- 0.05 | 0.04 +/- 0.04 | 91.39 -> 91.40 | 2560 -> 2568 (0.3%) | 1.1 / 4.0 | -0.23 +/- 0.63 | -0.50 +/- 0.76 |
| forgetful | 88.60 -> 89.93 | 1.32 +/- 0.18 | 0.94 +/- 0.11 | 85.90 -> 86.66 | 3514 -> 3803 (8.2%) | 2.1 / 4.0 | 9.31 +/- 1.89 | 9.69 +/- 1.78 |
| strong | 95.99 -> 95.84 | -0.15 +/- 0.05 | -0.09 +/- 0.03 | 93.36 -> 93.32 | 2257 -> 2229 (-1.2%) | 1.5 / 4.0 | 1.47 +/- 1.12 | 2.12 +/- 1.23 |

### Scenario A (300 cards, exam on day 30)

| Learner | mean true R (pp), off -> on | d mean R pp | recall when reviewed, off -> on | reviews, off -> on | fits kept / run | out-of-sample log loss gain x10^-3 (what the app does) |
|---|---|---|---|---|---|---|
| default | 99.03 -> 99.03 | 0.00 +/- 0.00 | 93.22 -> 93.22 | 1179 -> 1179 (0.0%) | 0.0 / 1.0 | -0.21 +/- 0.34 |
| forgetful | 97.22 -> 97.22 | 0.00 +/- 0.00 | 88.30 -> 88.30 | 1409 -> 1409 (0.0%) | 0.0 / 1.0 | 3.79 +/- 1.86 |
| strong | 99.34 -> 99.34 | 0.00 +/- 0.00 | 94.85 -> 94.85 | 1106 -> 1106 (0.0%) | 0.0 / 1.0 | 0.07 +/- 0.56 |

In A the optimizer never keeps a fit: the first run comes about two weeks in, when the last 20% of reviews holds fewer than 50
predictions, so the current weights stay. That is the rule working as designed (nothing to judge on), not a gain.

### Pass or fail per rule

- PASS R1 G / default: not applied (baseline 91.39 > 90.5); R3 governs
- PASS R2 G / default: 91.39 -> 91.40
- PASS R3 G / default: reviews +0.3%
- PASS R4 G / default: -0.23 +/- 0.63 x10^-3 (limit -1)
- PASS R1 G / forgetful: d mean R +1.32 pp, d long-run R +0.94 pp
- PASS R2 G / forgetful: 85.90 -> 86.66 (closer to 90)
- PASS R4 G / forgetful: +9.31 +/- 1.89 x10^-3
- PASS R1' G / strong: reviews -1.2% (not higher)
- PASS R2 G / strong: 93.36 -> 93.32 (closer to 90)
- PASS R4 G / strong: +1.47 +/- 1.12 x10^-3
- PASS R1 A / default, forgetful, strong: d exam-day recall 0.00 pp for all three

**All rules pass.** (Previous round, before the review decisions: forgetful +9.58, strong +1.17, default -0.20 x10^-3; A had a few kept fits and no change in recall.)

## What to take from it

- The optimizer is conservative now: a default-like student keeps the standard weights in about 3 runs of 4, and loses nothing
  measurable. The clear winner is the student who forgets faster than the standard weights say (8% more reviews buy +1.3 pp true
  recall, and recall when reviewed moves from 85.9 toward 90). Students with a stronger memory gain little (+1.2 x10^-3 log loss,
  1.4% fewer reviews).
- The RMSE half of the rule is noisy on a small held-out slice (a few hundred predictions): in the browser test data a clear
  improvement in log loss was refused by the strict rule because the binned RMSE came out slightly higher. The 0.01 slack
  fixes most of that; expect "your settings already predict as well" for some people who would have gained a little. That error is
  cheap, the opposite error is not.
- Gamma 1000 pulls hard toward the defaults. The sweep peaked there (3000 was lower), but 400 to 3000 is fairly flat.
- Not covered: Play answers (PLAY_P above 0), several decks with different relearning steps (the per-deck clipping is unit-tested,
  parity-tested against ts-fsrs and runs in the browser test, but the simulator has one deck), and students whose memory changes
  over time.

## Reproduce

```
cd tests/sim/compare
npm install --no-save --prefix deps ts-fsrs@5.4.2
mkdir -p new && cp -r ../../../js new/js
PLAY_P=0 node run2.mjs opt.jsonl 30 new G,A default,forgetful,strong '[{"OPT":"0","PLAY_P":"0"},{"OPT":"1","PLAY_P":"0"}]'
node summarize-optimizer.mjs opt.jsonl new
# gamma tuning on seeds 31 to 60 (OPT_CONFIG overrides FIT_DEFAULTS):
SEED_FROM=31 PLAY_P=0 node run2.mjs tune.jsonl 60 new G default,forgetful,strong '[{"OPT":"1","PLAY_P":"0","OPT_CONFIG":"{\"gamma\":150}"}]'
```


## Recency weighting (v4.15 work)

Newer reviews now count more in the **training loss** (`recencyWeight` / `withRecency` in `js/fsrs-fit.js`; `FIT_DEFAULTS.recency = true`).
The keep rule, the held-out check and every number shown to the person still score every review equally.

- **Curve:** `weight(x) = floor + (1 - floor) * x^3`, `x` = the review's place in time among all reviews that get a prediction
  (0 oldest, 1 newest); same-day reviews share a place; the loss is a weighted mean (divided by the sum of the weights).
  fsrs-rs uses floor 0.25.
- **Floor chosen on the tuning seeds 31 to 60** (scenario G, three learners, held-out rule on), by the criterion fixed beforehand
  (largest sum over the three learners of the out-of-sample log-loss gain, x10^-3), as for gamma. Sum: no recency 11.00,
  **floor 0.25 (fsrs-rs) 9.27**, **floor 0.5 11.32**. The simulator's students never change, so recency can only cost them; the fsrs-rs
  floor cost 1.7 and 0.5 cost nothing, so `RECENCY_FLOOR = 0.5` (oldest review 0.5, middle 0.56, newest 1).
  Real learners drift, which this simulator cannot show: the benefit (about 0.5 to 1% log loss in the benchmark) needs real data (roadmap step 1).
- With the fsrs-rs floor 0.25 on the original seeds 1 to 30, **R4 for the `strong` learner failed** (0.97 +/- 1.41, interval includes 0); that is what led to the tuning above.
- Baseline check: `OPT_CONFIG={"recency":false}` on seeds 1 to 30 reproduces the table above exactly (strong 1.47 +/- 1.12).

### Results with recency (floor 0.5), seeds 1 to 30 (same pass rule, unchanged)

| Learner (G) | mean true R (pp), off -> on | d mean R pp | recall when reviewed, off -> on | reviews, off -> on | fits kept / run | out-of-sample log loss gain x10^-3 | if it always took the fit |
|---|---|---|---|---|---|---|---|
| default | 94.55 -> 94.61 | 0.06 +/- 0.05 | 91.39 -> 91.40 | 2560 -> 2570 (0.4%) | 0.9 / 4.0 | -0.46 +/- 0.95 | -0.60 +/- 0.98 |
| forgetful | 88.60 -> 89.95 | 1.35 +/- 0.18 | 85.90 -> 86.69 | 3514 -> 3816 (8.6%) | 2.0 / 4.0 | 9.77 +/- 1.93 | 10.12 +/- 1.80 |
| strong | 95.99 -> 95.83 | -0.16 +/- 0.06 | 93.36 -> 93.31 | 2257 -> 2227 (-1.3%) | 1.5 / 4.0 | 1.54 +/- 1.21 | 2.13 +/- 1.31 |

Scenario A (exam on day 30): d exam-day recall 0.00 pp for all three learners (the optimizer keeps no fit before the exam, as before).

- PASS R1 G / default (not applied, baseline 91.39 > 90.5; R3 governs)
- PASS R2 G / default: 91.39 -> 91.40
- PASS R3 G / default: reviews +0.4%
- PASS R4 G / default: -0.46 +/- 0.95 (limit -1)
- PASS R1 G / forgetful: d mean R +1.35 pp, d long-run R +0.99 pp
- PASS R2 G / forgetful: 85.90 -> 86.69 (closer to 90)
- PASS R4 G / forgetful: +9.77 +/- 1.93
- PASS R1' G / strong: reviews -1.3% (not higher)
- PASS R2 G / strong: 93.36 -> 93.31 (closer to 90)
- PASS R4 G / strong: +1.54 +/- 1.21
- PASS R1 A / default, forgetful, strong: 0.00 pp

**All rules pass.**

```
# recency tuning on seeds 31 to 60 (recencyFloor 0.25 / 0.5, or "recency":false):
SEED_FROM=31 node run2.mjs tune.jsonl 60 new G default,forgetful,strong '[{"OPT":"1","PLAY_P":"0","OPT_CONFIG":"{\"recency\":true,\"recencyFloor\":0.5}"}]'
```
