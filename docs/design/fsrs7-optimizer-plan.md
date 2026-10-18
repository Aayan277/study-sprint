# FSRS-7 optimizer: implementation plan (for later)

**Status: planned, not started.** Start once ts-fsrs 6.0 is out of beta. Why it is worth building: `docs/design/fsrs-realdata.md` (tuned FSRS-7 beats the app's tuned FSRS-6 by about 2.6% on long reviews, wins for 72% of people; FSRS-7 with default weights loses to it).

Written 18 Oct 2026 against fsrs-rs commit b6e6990 (the one inside `@open-spaced-repetition/binding` 0.6.0-beta.6). If the binding has moved on when this starts, re-check section 0 against the new commit first.

## Summary
- **Gradients:** reverse mode (one tape per card), not dual numbers. Measured in Node: FSRS-7 forward 1.2 µs per row; FSRS-6 dual pass (17 derivatives) 2.1 µs per row. Carrying 34 derivatives through about 90 operations per FSRS-7 step would cost about 12 µs per row per epoch (a 700k-review phone fit would take over 8 minutes). A tape costs about 2–2.5 µs per row per epoch. fsrs-rs itself moved to reverse mode.
- **Objective:** copy fsrs-rs b6e6990.
  - Train all 34 weights, w0–w3 included (with short-term on, fsrs-rs doesn't freeze them).
  - Every review after a card's first is in the loss, same-day ones included.
  - Loss = sum of weighted log losses, recency weight `0.0667 + 0.9333·(k/N)^11.25`.
  - L2 pull towards the start weights: `0.3333·γ·Σ((w−w_init)/σ)²`, γ = 1, scaled by B/N per batch.
  - Adam β1 0.7, β2 0.98, lr 0.0118, cosine annealing to 0, 9 epochs, batches of at most 512 predictions.
  - `clipWeights7` after every step (same as fsrs-rs `clip_fsrs7_parameters`).
  - Pretraining only for w0–w3; w23–w30 stay at the defaults. No refine step.
- **Storage:** a new synced setting `fsrsParams7` with `version: 'fsrs-7'` (as `docs/design/fsrs7-plan.md` §3.6 planned). Today nothing sets `opts.w7`: `schedulerOptions` never adds it, `personalW20` returns `W7_DEFAULT`, `prepare7` replays with the defaults.

## 0. Facts the design rests on

### fsrs-rs at b6e6990

**training.rs and training_v7.rs**
- Defaults: 9 epochs, batch 512, seed 2023, lr 0.0118, max_seq_len 1024, γ = 1. No schedule penalties.
- Trains on every item (a card's history up to one review), no outlier filter: every review except a card's first is predicted, same-day ones included. Gaps are fractional days, `delta_t.max(0)`. Prefixes longer than 1024 reviews are dropped.
- Fewer than 8 items: defaults. Fewer than 64 items, or every item having exactly one long-term review: pretrained weights, no training.
- Recency weight in item order: `x = idx/n`, `0.0667 + 0.9333·x^11.25`.
- Batches (`build_windowed_batches`): cards sorted by (length, card_id), packed greedily up to 512 predictions; batch order shuffled each epoch.
- Batch gradient: Σ `weight·∂BCE` plus `2·(w−init)/σ² · 0.3333·γ · B/N` (B = predictions in the batch, N = all items, init = weights after pretraining, σ = `PARAMS_STDDEV`; 9999 for w0–w3, so effectively unpenalised).
- `HostAdam`: β1 0.70, β2 0.98, ε 1e-8, bias-corrected; `clip_fsrs7_parameters` after every step.
- `CosineAnnealingLR`: η_min 0, T = batches × epochs, `lr_k = lr0·(1+cos(πk/T))/2`.
- At the end `smooth_initial_stabilities_fsrs7` on w0–w3: clamp to [1e-4, 100], then a running maximum.

**analytic_v7.rs (training forward pass)**
- Same as `js/fsrs7-model.js` without the 8-decimal rounding.
- BCE clamped to [1e-5, 1−1e-5].
- Ties: `min(last_s, fail)` keeps `last_s`; `max(pls, success)` keeps `pls`; on a lapse `min(newFast, 0.8·newSlow)` keeps `newFast`. A clamp has zero gradient outside its range.

**parameter_initialization_fsrs7.rs (pretraining)**
- Samples: items with exactly one review with `delta_t >= 1`: (first rating, gap bucket `floor(max(dt,1))`, label). A card contributes one copy of its first long-term outcome per prediction from that review up to its second long-term review (same-day relearns after a lapse repeat it).
- Grouped by (rating, bucket) into mean recall and count, smoothed `(mean·count + avgRecall)/(count+1)` (avgRecall = mean label over all items).
- Ternary search on s in [1e-4, 100] while `hi−lo > f64::EPSILON`, at most 1000 iterations; result `(hi+lo)/2`.
- Loss `loss_with_curve` with default w23–w30 and the same s for both traces: `r1 = (1+f1·t/s)^-w23`, `f1 = w25^(-1/w23) − 1`; `r2 = (1+f2·t/s)^-w24`, `f2 = w26^(-1/w24) − 1`; mixing `w27·s^-w29` and `w28·s^w30`; prediction clamped to [1e-4, 0.9999]; log loss × count; plus `|s − default_s0|/16`.
- Monotone fix over pairs (1,2), (2,3), (3,4), (1,3), (2,4), (1,4) in that order: if the smaller rating has the larger s, the one with more samples wins and the other takes its value.
- Fill: no rating → NotEnoughData. One rating → scale the defaults by its factor, sort, clamp. Otherwise fill missing ratings in log space from anchors {1: −8.09, 2: −3.83, 3: −2.5, 4: −1.0}, clamp to [1e-4, 100], running maximum.

**Other**
- Bounds and defaults at b6e6990 equal `W7_BOUNDS` and `W7_DEFAULT`.
- Harness quirk: `tests/realdata/rs-weights.mjs` passes items card by card and no `cardIds`, so the existing `fsrs7_rs` reference uses recency by card order, not time order.

### Speed (Node, desktop)
| Measurement | Value |
|---|---|
| FSRS-7 forward pass | 1.2 µs per row |
| FSRS-6 dual-number gradient pass | 2.1 µs per row |
| Current FSRS-6 app fit, biggest user (776k rows) | 25.7 s |

### Real-data baselines (300 users, held-out long-term log loss, per-user mean)
| Model | full | first1000 (143 users) |
|---|---|---|
| fsrs6_app | 0.3972 | 0.3289 |
| fsrs7_default | 0.4077 | 0.3281 |
| fsrs7_rs | 0.3868 | 0.3114 |

## 1. Training objective
- **Reviews:** every scored review i ≥ 1 (real reviews and Anki history, same-day and later-day). Replayed Play rows move the state but are never predicted. Gap = `tFrac[i]`. Train only the first 1024 reviews of a card.
- **Loss:** `J(w) = Σ q_i·BCE(r_i, y_i) + 0.3333·γ·Σ((w_j − w_init_j)/σ_j)²`, BCE clamped to [1e-5, 1−1e-5], y = rating > 1, σ = `PARAMS_STDDEV` verbatim, γ = 1 (`config.gamma`). Per batch: `g = Σ_B q_i ∂BCE_i + (|B|/N)·0.3333·γ·2(w−w_init)/σ²`; non-finite components become 0. A sum, not a mean, so the penalty-to-data balance equals fsrs-rs.
- **Recency:** `q = 0.0667 + 0.9333·(k/N)^11.25`, k = rank among all N trainable predictions (before the 1024 truncation). `config.recencyOrder`: `'time'` (default; absolute time, then card, then review index — fsrs-rs's documented intent) or `'card'` (what the existing `fsrs7_rs` reference used). The real-data gate picks.
- **Start and anchor:** `W7_DEFAULT` with pretrained w0–w3 (never the user's current weights).
- **Constraints:** `clipWeights7` after every Adam step; at the end smooth w0–w3, round to 6 decimals, clip again.
- **Adam:** `m = 0.7m + 0.3g`, `v = 0.98v + 0.02g²`, bias-corrected, ε 1e-8; `lr_k = 0.0118·(1+cos(πk/T))/2`, T = batches × 9; `mulberry32(seed)`, default 2023; Fisher–Yates shuffle of batch order each epoch.
- **Batches:** built once: trainable cards sorted by (trainable length, card index), packed greedily to ≤ 512 predictions; a longer card is its own batch. Same loss as item mode, each card replayed once (O(L) not O(L²)).
- **Early exits:** N < 8 → defaults; no review with tFrac ≥ 1 → `not-enough`; N < 64 or all predictions in the pretraining set → pretrained weights, no Adam. The app keeps `MIN_REVIEWS` = 400.
- **No refine step.** First knob to try only if the gate fails at first1000.

## 2. Gradients: reverse mode, one tape per card
- **Tape:** module-level typed arrays grown from 2^17 nodes: `V`, `ADJ` (Float64Array), parents `A`, `B` (Int32Array, −1 none), partials `DA`, `DB` (Float64Array). Nodes 0–33 are the weights.
- **Ops** return node ids: `add`, `sub`, `mul`, `div`, `pow(x,y)`; with a constant `addc`, `mulc`, `csub`, `cdiv`, `powc`, `cpow`; `exp`, `ln`, `neg`; `clamp` (a constant leaf outside the range = zero gradient); `minTieA`/`maxTieA` (branch by value, tie rules above). Constants get no nodes.
- **Per card:** `top = 34`; replay the smooth model (no rounding); the fast-trace recall in the fast update reuses the curve's `r1` node. At each prediction p: `ADJ[p] += q·(y ? −1/p : 1/(1−p))` (0 outside the clamp). Then one backward sweep:

  ```js
  for (k = top - 1; k >= 34; k--) {
    g = ADJ[k];
    if (g) { ADJ[A[k]] += DA[k] * g; if (B[k] >= 0) ADJ[B[k]] += DB[k] * g; }
  }
  ```

  then `grad[j] += ADJ[j]; ADJ[j] = 0` for j < 34. About 100 nodes per review; with the 1024 cap at most about 110k nodes (5 MB).
- **Cost:** expect 2–2.5 µs per row per epoch (budget ≤ 4). `fitChecked7` ≈ 1.8 fits ≈ 40 µs per row desktop (FSRS-6 app fit today ≈ 33).

  | Collection | Desktop | Phone (3–4× slower) |
  |---|---|---|
  | 100k rows | 4 s | 12–16 s |
  | 300k rows | 12 s | 40–50 s |
  | 700k rows | 28 s | 100–120 s |

- **Caps (app only, in `fitChecked7`):** `MAX_TRAIN_ROWS = 300000`. Over the cap: keep every card with a prediction in the newest 25% by recency rank, sample the rest with a seeded rate p, multiply their q by 1/p. Main-thread fallback (no Worker): 100000. `TIME_LIMIT7_MS = 240000` (FSRS-6 keeps 120000). The keep-rule evaluation always uses every held-out card. The harness model `fsrs7_js` runs uncapped.
- **Rejected:** forward duals with 34 derivatives (about 6× slower); finite differences (35 passes per batch, noisy at kinks); a hand-written adjoint (error-prone).

## 3. Files and functions
- **js/fsrs-data.js** (backward compatible): `buildHistories` also returns per card `tFrac: Float64Array` (`max(0, ts_i − ts_{i−1}) / 86400000`, 0 first; the gaps `srs7.js replayRows` uses) and `seq: Float64Array` (timestamp ms, the ordering key). Nothing else changes.
- **js/fsrs-fit.js** (FSRS-6 unchanged): `splitHistories` head slice also slices `tFrac` and `seq` when present.
- **js/fsrs7-fit.js** (new, no network):
  - `FIT7_DEFAULTS = { epochs: 9, batchSize: 512, lr: 0.0118, gamma: 1, seed: 2023, maxSeqLen: 1024, minReviews: 400, recencyOrder: 'time', maxTrainRows: Infinity }`, `PARAMS_STDDEV7`, `L2_WEIGHT7 = 0.3333`, `ADAM7 = { b1: 0.7, b2: 0.98, eps: 1e-8 }`, a comment pinning fsrs-rs b6e6990.
  - The tape; smooth curve/update/init built from tape ops.
  - `lossAndGrad7(cards, w, { wt, upto })` → `{ loss, wsum, count, grad: Float64Array(34) }`.
  - `evaluate7(cards, w)` → `{ all, long, same }` each `{ logLoss, rmse, n, recalled }`, walking `fsrs7-model.js` (rounded, as the app schedules) with `tFrac`; `long` = `deltas > 0`; clamp 1e-6, 20 bins. `evaluate7Smooth` for tests.
  - `recency7`, `withRecency7(cards, order)`; `pretrainStarts7`, `fillStarts7`, `smoothStarts7`; `buildBatches7`, `adamStep7`; `function* fit7(input)` (yields progress per batch; returns `not-enough` or `{ status: 'trained', fitted, w, reviews, cards, longTerm }`); `runFit7`.
  - Keep rule: `isBetter7(b, a) = a.all.logLoss < b.all.logLoss && a.long.logLoss <= b.long.logLoss + 0.002 && a.all.rmse <= b.all.rmse + RMSE_SLACK` (counts same-day reviews, with a long-term guard); `judge7`; `function* fitChecked7(input)` with the same structure, phases and progress split as `fitChecked`, plus the caps.
- **js/fsrs-optimize-worker.js:** add `fit7: fitChecked7` to `JOBS`.
- **js/optimize-sheet.js:** `runFit(input, { job })`; when `usesFsrs7(settings)`, start from `cleanFsrsParams7(settings.fsrsParams7)?.w || W7_DEFAULT`, caps by Worker/no Worker, `TIME_LIMIT7_MS`, re-judge with `judge7` on the sync re-check, save `fsrsParams7 = { w: clipWeights7(res.w), at, reviews, cards, logLoss, rmse, version: 'fsrs-7' }`, show "The 34 numbers (FSRS-7)".
- **js/sched-settings.js:** `FSRS7_PARAMS_VERSION`, `FSRS7_W_COUNT = 34`, `cleanFsrsParams7`, `personalW7`; `schedulerOptions` adds `w7` under version 7; `deckSchedulerOptions` passes `fsrsParams7`; `personalW20` returns `{ w20, w7 }`; `personalRow(..., { seven })` wording.
- **js/db.js:** `DEFAULT_SETTINGS.fsrsParams7 = null`; clean in `getSettings`; `setSetting` bumps `scheduleChanges`; `restoredSettings` cleans it; `applyRemote` sets `schedules`.
- **js/sync-data.js:** `SYNCED_SETTINGS += 'fsrsParams7'`; `acceptSetting` cleans it (older apps ignore unknown keys).
- **js/srs7.js:** export `weightsOf`; `prepare7` clears `rebuilt` when the weights change; `review.js` and `play.js` pass `personalW7(settings)`.
- **js/app.js:** the FSRS-7 settings row uses `personalRow(settings.fsrsParams7, …, { seven: true })`; "Reset to default" under FSRS-7 writes `fsrsParams7 = { w: null, at, version: 'fsrs-7' }`; the health check stays FSRS-6 only (say so in the row).
- **tests/realdata/:** `toHistories` adds `seq`, `truncate` slices it; `run.mjs` models `fsrs7_js` (`fit7` on head) and `fsrs7_app` (`fitChecked7` on head, cap 300000), `--variants`, `--models`; `rs-weights.mjs --variant time` (items sorted by time, `cardIds` passed, key `fsrs7_time`); `summarize.mjs` pairs for the new models; new `gate7.mjs` (PASS/FAIL per gate, refuses `+dirty` stamps); new `pretrain-parity.mjs` (dev only, needs `FSRS_BINDING_DIR`).
- **Other:** add `js/fsrs7-fit.js` to the `sw.js` precache list; update `docs/design/fsrs7-plan.md` §3 and `tests/realdata/README.md`.

## 4. Tests and gates

### Unit tests (`npm test`, new `tests/fsrs7-fit.test.js`)
1. Forward parity on 300 random histories vs `fsrs7-model.js`: |Δr| ≤ 1e-6; `evaluate7Smooth` vs `lossAndGrad7.loss` ≤ 1e-9 relative.
2. Gradient check, all 34 weights, central differences, 5 datasets away from bounds and ties: relative error ≤ 1e-5 where |g| > 1e-6.
3. Kinks: clamped weights and untaken min/max branches get the right zero or branch derivative.
4. `evaluate7` equals `tests/realdata/lib.mjs eval7` to 1e-12.
5. Recency: x = [0, .25, .5, .75] gives `0.0667 + 0.9333·x^11.25`; time vs card order and tie-breaks.
6. Pretraining (fsrs-rs's own tests): `smooth([4,3,2,1]) = [4,4,4,4]`; `smooth([0, 5e-5, 0.001, 200]) = [1e-4, 1e-4, 0.001, 100]`; single-rating scaling; anchor fill; pairwise fix by counts; duplicates from same-day relearns; none present → null.
7. Determinism: same data and seed → identical weights.
8. Bounds and order hold with extreme data.
9. Synthetic recovery: 5 seeds from a perturbed W7; held-out log loss beats the defaults, within truth + 0.003.
10. Early exits (N < 8, N < 64, under 400 reviews).
11. Replayed rows never predicted.
12. Keep rule (mirrors the FSRS-6 tests, incl. `HOLDOUT_MIN`, refit on everything, progress only goes up).
13. Cap: deterministic, keeps recent cards, Σq within 5%.

Additions: `fsrs-data.test.js` (`tFrac`/`seq`, DST crossings, `deltas` unchanged); `fsrs-fit.test.js` (FSRS-6 output deep-equals before the change); settings/sync tests for `fsrsParams7`; `prepare7` cache clearing; optimize-sheet saves `fsrsParams7` and leaves `fsrsParams`; browser `e2e-optimize7.mjs` (incl. a 100k-row log under `CPU_THROTTLE=4` within the time limit).

### Real-data gates
`node tests/realdata/run.mjs --out ~/fsrs-data/results/results-js7.jsonl`, then summarize and `gate7.mjs`, on a clean commit. Held-out log loss, per-user mean, paired 95% bootstrap CI, users with ≥ 30 held-out reviews.
- **G1 parity:** `fsrs7_js` vs the fsrs-rs reference trained in the same recency order. full and first1000: long-term mean diff ≤ +0.002 with CI lower ≤ 0; same-day ≤ +0.003 with CI lower ≤ 0; full RMSE (long) ≤ +0.003.
- **G2 beats FSRS-6:** `fsrs7_js` vs `fsrs6_app` mean < 0 and CI upper < 0 in full and first1000 (expected about −0.010 and −0.017); `fsrs7_app` vs `fsrs6_app` the same in full, mean ≤ 0 in first1000.
- **G3 never worse than default:** `fsrs7_app` vs `fsrs7_default` mean ≤ 0 in all scenarios; ≤ 5% of users worse by more than 0.01.
- **G4 speed:** ≤ 4 µs per row per epoch; the 776k-row user's capped `fitChecked7` ≤ 40 s on desktop; the throttled browser test.
- **G5 cap harmless:** 20 largest users, capped vs uncapped mean diff ≤ +0.001.
- Pick the recency order with the lower held-out loss that passes G1. Only after G1 and G2 pass may γ be swept over {1, 3, 10} at first1000.
- Pretraining parity (dev only): fsrs-rs returns pretrained weights below 64 items, so compare w0–w3 on 20–60-item slices; relative error ≤ 1e-3.

## 5. Risks
1. Reference recency order differs (handled by the `'time'`/`'card'` switch and like-for-like G1).
2. f32 vs f64, RNG, windowed batching: absorbed by G1 tolerances.
3. Overfitting small collections (11.25 recency, weak L2): keep rule, first1000 gate, optional γ sweep.
4. Flaky gradient checks at kinks: test points away from them, kinks tested separately.
5. Phone time and memory: caps, 240 s limit, 1024 truncation, tape bound.
6. Stale rebuilt memories after new weights: weights-key check in `prepare7`.
7. Mixed app versions: old apps ignore `fsrsParams7`.
8. Same-day reviews in the keep rule: long-term guard, tune with `fsrs7_app` results.
9. Hidden FSRS-6 changes: deep-equal snapshot test.
10. fsrs-rs drift: pin b6e6990; re-run pretrain parity on every binding bump.

## 6. Order of work
1. Harness: `seq`, `rs-weights --variant time`, re-run, summarize/gate7 scaffolding. No app change.
2. Histories: `tFrac`/`seq` in `buildHistories`, `splitHistories` slicing, FSRS-6 snapshot test.
3. Gradient core: tape, smooth model, `lossAndGrad7`, `evaluate7`; parity and gradient-check tests.
4. Fit: pretraining, recency, batches, Adam, `fit7`; determinism, bounds, synthetic tests; pretrain-parity script.
5. Gate G1/G2 on 300 users; pick the recency default. **Stop here if they fail.**
6. Keep rule and caps: `fitChecked7`, `judge7`, `isBetter7`; `fsrs7_app`; G3–G5; speed benchmark.
7. Settings and sync: `fsrsParams7`, `schedulerOptions` w7, `personalW20`, `prepare7` weights and cache.
8. Worker and UI: worker `fit7`, the sheet chooses by `fsrsVersion`, app.js row and reset; e2e-optimize7.
9. Docs and release: fsrs7-plan.md §3, README; bump `APP_VERSION` (js/app.js) and `CACHE` (sw.js), precache `js/fsrs7-fit.js`, `node tests/update-sw-hash.mjs`, `npm test`, `node tests/browser/run.mjs`.

Reference source: https://raw.githubusercontent.com/open-spaced-repetition/fsrs-rs/b6e6990/src/ (training.rs, training_v7.rs, analytic_v7.rs, parameter_initialization_fsrs7.rs, parameter_clipper_v7.rs, cosine_annealing.rs, dataset.rs).
