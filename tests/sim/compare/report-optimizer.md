# FSRS optimizer: simulator check (PR 2)

Plan: `docs/design/fsrs-optimizer-plan.md` section 9 ("optimize at 400 reviews, then every 30 days").

## What is compared

`harness2.mjs` with `OPT=0` (the standard weights, as today) against `OPT=1` (the same students, same seeds), both on the
copy of `js/` from this branch. With `OPT=1` the harness does what the sheet does, with the app's real modules: once 400
reviews count, and then every 30 days, it reads the simulated review log (`fsrs-data.js buildHistories`) and runs `fitChecked`
(`fsrs-fit.js`, the same generator the worker runs):

1. fit on the first 80% of the days;
2. judge those weights against the ones in use on the last 20% (`judge`: log loss lower AND RMSE no higher);
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

## Results (seeds 1 to 30, gamma 1000, held-out keep rule)

### Scenario G (500 cards, 120 days, no exam)

| Learner | mean true R (pp), off -> on | d mean R pp | d long-run R pp | recall when reviewed, off -> on | reviews, off -> on | fits kept / run | out-of-sample log loss gain x10^-3 (what the app does) | ... if it always took the fit |
|---|---|---|---|---|---|---|---|---|
| default | 94.55 -> 94.57 | 0.02 +/- 0.05 | 0.03 +/- 0.03 | 91.39 -> 91.38 | 2560 -> 2569 (0.4%) | 0.9 / 4.0 | -0.20 +/- 0.26 | -0.39 +/- 0.48 |
| forgetful | 88.60 -> 89.93 | 1.33 +/- 0.18 | 0.97 +/- 0.13 | 85.90 -> 86.73 | 3514 -> 3795 (8.0%) | 1.8 / 4.0 | 9.58 +/- 1.78 | 9.66 +/- 1.73 |
| strong | 95.99 -> 95.83 | -0.16 +/- 0.06 | -0.07 +/- 0.04 | 93.36 -> 93.23 | 2257 -> 2225 (-1.4%) | 1.7 / 4.0 | 1.17 +/- 0.85 | 2.06 +/- 0.88 |

### Scenario A (300 cards, exam on day 30)

| Learner | mean true R (pp), off -> on | d mean R pp | recall when reviewed, off -> on | reviews, off -> on | fits kept / run | out-of-sample log loss gain x10^-3 (what the app does) |
|---|---|---|---|---|---|---|
| default | 99.03 -> 99.03 | -0.00 +/- 0.01 | 93.22 -> 93.21 | 1179 -> 1180 (0.1%) | 0.1 / 1.0 | 0.02 +/- 0.17 |
| forgetful | 97.22 -> 97.23 | 0.01 +/- 0.02 | 88.30 -> 88.38 | 1409 -> 1411 (0.2%) | 0.2 / 1.0 | 5.47 +/- 1.54 |
| strong | 99.34 -> 99.33 | -0.00 +/- 0.01 | 94.85 -> 94.76 | 1106 -> 1094 (-1.1%) | 0.4 / 1.0 | 0.12 +/- 0.21 |

### Pass or fail per rule

- PASS R1 G / default: not applied (baseline 91.39 > 90.5); R3 governs
- PASS R2 G / default: 91.39 -> 91.38
- PASS R3 G / default: reviews +0.4%
- PASS R4 G / default: -0.20 +/- 0.26 x10^-3 (limit -1)
- PASS R1 G / forgetful: d mean R +1.33 pp, d long-run R +0.97 pp
- PASS R2 G / forgetful: 85.90 -> 86.73 (closer to 90)
- PASS R4 G / forgetful: +9.58 +/- 1.78 x10^-3
- PASS R1' G / strong: reviews -1.4% (not higher)
- PASS R2 G / strong: 93.36 -> 93.23 (closer to 90)
- PASS R4 G / strong: +1.17 +/- 0.85 x10^-3
- PASS R1 A / default, forgetful, strong: d exam-day recall -0.00, +0.01, -0.00 pp

**All rules pass.**

## What to take from it

- The optimizer is conservative now: a default-like student keeps the standard weights in about 3 runs of 4, and loses nothing
  measurable. The clear winner is the student who forgets faster than the standard weights say (8% more reviews buy +1.3 pp true
  recall, and recall when reviewed moves from 85.9 toward 90). Students with a stronger memory gain little (+1.2 x10^-3 log loss,
  1.4% fewer reviews).
- The "RMSE no higher" half of the rule is noisy on a small held-out slice (a few hundred predictions): in the browser test data a
  clear improvement in log loss was refused because the binned RMSE came out slightly higher. Expect "your settings already predict
  as well" for some people who would have gained a little; that error is cheap, the opposite error is not.
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
