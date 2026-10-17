# Plan: "Optimize FSRS parameters" (personal FSRS-6 weights)

Status: plan for approval. Base: `main` at v4.9 (APP_VERSION in `js/app.js` still says 4.8.1). Owner-approved points:
- it unlocks at about 400 reviews
- new parameters are kept only if they predict the user's history better (log loss and RMSE) than the current ones
- it is one synced setting with "Reset to default"
- it runs locally in the browser

PLAN.md "After v1" items 3 and 5 refer to this work. Item 5 said "fsrs-rs WASM, @open-spaced-repetition/binding, on a separate page". This plan recommends against that route; reasons are in section 2.

## 1. What exists today

- **The scheduler.** `js/srs.js` wraps ts-fsrs 5.4.2 (FSRS-6, 21 weights). `scheduler(opts)` builds `fsrs(generatorParameters({...}))` without `w`, so it always uses `default_w`. It caches on `JSON.stringify(opts)`, so adding `w` to the options rebuilds it correctly.
- **Scheduler options.**
  - `schedulerOptions(settings)` in `js/sched-settings.js` builds them.
  - `deckSchedulerOptions(settings, deck)` spreads `deck.options` over the global settings. Today `deck.options` holds `{ targetRetention, learningSteps, relearningSteps, maxInterval }`.
  - So a new global setting reaches every deck automatically.
- **The review log** (`js/db.js`, store `reviewLog`). Each row: `{ id, uid, cardId, timestamp, source, mode, correct, ms, rating, state, updatedAt }`.
  - `source` is `'review'` (`js/review.js`, `js/onboarding.js`), `'play'` (`js/play.js`) or `'anki'` (`js/anki.js`, imported history).
  - `state` is the card's state before the answer (0 = new). review.js already notes it is there "for FSRS tuning later".
  - Play rows also carry `applied` (did the answer change the schedule?) and `reason` (`due`, `again`, `first`, `not-due`, `new`, `new-limit`, `already`, `short-time`).
  - `isAnswerLog` in `js/stats-calc.js` accepts all three sources.
- **Days.** `js/days.js` starts the day at 4am (`ROLLOVER_HOUR = 4`), like Anki's "next day starts at".
- **Synced settings.** `SYNCED_SETTINGS` in `js/sync-data.js`. Each key has its own `_times` stamp and the newest copy wins (`applyRemote` in `js/db.js`); only `restDays` is merged.
- **The hard-coded decay.** `js/exam.js` hard-codes `DECAY = -0.1542` (FSRS-6's default w20) in `recall()`, with the comment "the app doesn't use personal weights yet". `recall` / `recallAt` feed `examClamp`, `examGainFrom` and `readiness` (Stats). This must follow the personal w20.
- **CDN integrity.** The import map in `index.html` pins five CDN modules with SHA-384; `tests/integrity.test.js` checks it. Import maps do not apply inside Web Workers. `js/math.js` already shows the fallback pattern: fetch, `crypto.subtle.digest('SHA-384')`, compare, import from a blob.
- **Service worker.** `sw.js` lists every app file in `CORE`. Bump `CACHE` (currently v81) and refresh the files-hash with `node tests/update-sw-hash.mjs`. `PINNED` lists the CDN prefixes that are carried over between caches.
- **Simulator.** `tests/sim/compare` already simulates learners with their own true FSRS weights (`default`, `forgetful`, `strong`). This is ideal for checking that the optimizer recovers weights and helps scheduling.

## 2. Options researched

### 2a. ts-fsrs itself
ts-fsrs 5.4.2 exports no optimizer; I checked the export list in its `index.d.ts`. It does export the useful pieces:
- `default_w`
- `CLAMP_PARAMETERS(w17_w18_ceiling, enable_short_term)`, `W17_W18_Ceiling`
- `clipParameters(params, numRelearningSteps, enableShortTerm)`
- `checkParameters`, `migrateParameters`
- `forgetting_curve`, `computeDecayFactor`
- `FSRSAlgorithm`, the memory-state maths

### 2b. `@open-spaced-repetition/binding` (fsrs-rs through napi-rs)

Findings from the npm registry and jsDelivr on 2026-10-17:

| Question | Finding |
| --- | --- |
| Versions | `latest` 0.5.0 (2026-06-06), `beta` 0.6.0-beta.6. Pre-1.0, MIT. |
| Browser build | Yes. The `browser` export re-exports `@open-spaced-repetition/binding-wasm32-wasi` (target `wasm32-wasip1-threads`). There is also a `./dynamic-wasi` entry (`initOptimizer({ wasm, worker })`) for loading the wasm and worker from your own URLs. |
| API | `computeParameters(items, { enableShortTerm, numRelearningSteps, trainingConfig, progress(current,total), timeout })` returns `Promise<number[]>`. `evaluateWithTimeSeriesSplits` returns `{ logLoss, rmseBins }`. Also `FSRS#evaluate`, `computeOptimalSteps`, and `FSRSItem` / `FSRSReview(rating, deltaT)`. This is exactly Anki's optimizer, including pretraining and outlier filtering. |
| Size | `fsrs-binding.wasm32-wasi.wasm` is 598,176 bytes raw and about 222 KB over the wire with brotli. Glue JS: `fsrs-binding.wasi-browser.js` 2.7 KB and `wasi-worker-browser.mjs` 1 KB. It also needs `@napi-rs/wasm-runtime` (and through it `@emnapi/core`, `@emnapi/runtime`, `@tybys/wasm-util`, `tslib`). On jsDelivr these come from `+esm` builds. |
| Pin + hash | The package files are static, so they can be pinned. Example `sha384` values:<br>wasm `G4ki/6Vb0Xh9KxIJjFosXZvXiEahrYdVpODwaaWXJMs3Kt6m4kPidsjTV6Gqq+QW`<br>browser glue `BBTCxNkYeOA9ICTVizcNWhzhyKZmsHWkHSJg98ewXb7W5eb/1naubNopU8gG9q8S`<br>worker `ZCZd77gE6DPV1VmgWeMqfHYDw4IVjm5mleB46Lxc2xhXXCv5YnKt2sK6G3hMWiax`<br>jsDelivr serves them with `access-control-allow-origin: *` and `cross-origin-resource-policy: cross-origin`.<br>But the glue imports a bare specifier (`@napi-rs/wasm-runtime`), so it has to go through jsDelivr's generated `+esm` bundles. Those pull further `+esm` files at versions picked when jsDelivr built them (for example `wasm-runtime@1.1.4/+esm` imports `@emnapi/core@1.9.2/+esm`, while the binding asks for `^1.10.0`). Generated bundles are a weaker pin than static files. |
| Blocker: cross-origin isolation | The glue creates `new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true })` and spawns a thread worker. Shared memory needs `crossOriginIsolated`, which means the headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The package README says the same. **GitHub Pages cannot send response headers.** The only workaround is a service worker that adds them (the "coi-serviceworker" trick). That works only after the first load (a reload is needed), and turning COEP on for the whole app risks breaking Google Fonts, card images and other cross-origin loads. That is why item 5 said "on a separate page": an `optimize.html` that only the service worker isolates. |
| Blocker: memory | `initial: 4000` pages reserves about 250 MB of shared memory up front. That can fail with a RangeError on low-end Android phones and on iOS Safari, which is exactly the phone-first audience. |
| Inside a Worker | The default glue calls `window.dispatchEvent` on errors, and `window` does not exist in a worker. The `dynamic-wasi` entry with `errorEvent: false` avoids that. The import map's integrity does not cover worker imports, so every file (glue, runtime `+esm` chain, nested worker, wasm) would need manual hash checks and blob URLs. `WebAssembly.instantiate*` has no integrity option. `tests/integrity.test.js` only looks for `.m?js` URLs and would need extending to `.wasm` and `+esm`. |

### 2c. A small pure-JS fit (written by us)

A plain ES module, `js/fsrs-fit.js`, with no imports:
- an FSRS-6 forward model that mirrors ts-fsrs 5.4.2's `FSRSAlgorithm`, enforced by a parity test
- log loss
- gradients
- Adam with clamping
- a separate pretraining of the starting stabilities w0–w3

It is roughly 300–400 lines.

### 2d. Trade-offs

| | Binding (fsrs-rs WASM) | Pure JS (ours) |
| --- | --- | --- |
| Accuracy and Anki parity | Exact Anki optimizer: pretraining, outlier filter, recency weighting, its RMSE(bins) | Close but not identical. Results will be in the same ballpark; metrics are computed our way. |
| Works on GitHub Pages | Only with service-worker-injected COOP/COEP on a separate page, after a reload | Yes, anywhere a module Worker runs (Safari 15+, Chrome 80+, Firefox 114+), with a main-thread fallback |
| Phone memory | About 250 MB shared memory reserved at start | A few MB (typed arrays per card) |
| Download | About 222 KB wasm plus about 60 KB runtime, new cache entries, more pinned URLs | About 12 KB of our own code, cached by `sw.js` with the app |
| Integrity story | Manual hash checks for 6+ files, `+esm` pins that can drift, test changes | Nothing new: same-origin files only, integrity test unchanged |
| Maintenance | Pre-1.0 API (0.6 is in beta), napi/emnapi version coupling | Our code. Must follow ts-fsrs if FSRS-7 arrives (parity test catches drift). |
| Testability | Node tests need the napi build; browser e2e needs isolation | `node --test` on fixed synthetic logs, no network |
| Effort | 4–5 days, but with open-ended risk (isolation, iOS memory) | 6–7 days, predictable |

**Recommendation: pure JS.** The whole-app constraints (static GitHub Pages, phone-first, pinned and hashed CDN files) rule the binding out for now. Keep the binding as a later option if GitHub Pages is ever replaced by a host that can send headers. The keep-only-if-better rule protects users from a weaker fit either way.

## 3. Which log rows are "real reviews"

The game's answers will soon not write to FSRS or the log by default. The optimizer must train only on real reviews.

**No new field and no migration are needed.** `source` has been on every row since v1, and Play rows carry `applied`. A new pure module, `js/fsrs-data.js`, holds the rules:

1. **Training rows** (scored and used as history): `source === 'review'` or `source === 'anki'`, `rating` 1–4, a finite `timestamp`, and a `cardId`.
   - Onboarding's "Try it" answers are `source: 'review'` and count; they are real flips.
   - Review's Custom study and exam-prep sessions also count: they are rated by hand and rescheduled by FSRS. Anki only drops "cram without rescheduling", which this app does not have.
2. **Play rows that changed the schedule** (`source === 'play' && applied === true`) are **replayed but never scored**:
   - they update the card's memory state, so the gap before the next real review is measured from the moment the scheduler actually used
   - no prediction or loss is computed for them, and they do not count toward the 400
   - this follows "train only on real reviews" (game answers never become training targets) without throwing away the histories of heavy Play users
   - The stricter alternative is to cut a card's history at its first applied Play row. That is a one-line switch (`PLAY_POLICY = 'replay' | 'truncate'`). **Owner decision Q1; default `replay`.**
3. **Play rows that did not change the schedule** (`applied === false`, or no `applied`) are ignored completely. They are only logged for stats.
4. **Unknown sources** (a future one, or junk from a backup) are ignored, so a new kind of answer is excluded by default. Rule for the future: any new answer kind gets its own `source` value (for example `'test'`) and must be added to the training list on purpose.
5. **A card's history must start at "new".** The card's earliest row of kinds 1–2 must have `state === 0`, or no `state` at all *and* no earlier row of any source. Otherwise the start is unknown and the card is skipped.
   - Example: an Anki import whose earlier history was not brought over.
   - Anki and fsrs-rs skip incomplete histories the same way.
6. **Undo** already deletes the log row (`undoReview`), and deleting a card deletes its rows, so neither needs anything special.
7. **Day gaps:** the same rule the live scheduler uses: ts-fsrs's `dateDiffInDays`, i.e. `floor((UTC date of t2 - UTC date of t1) / 86400000)` on the review times (see `toLibrary` in `srs.js`). It ignores the time zone, DST and the 4am rollover on purpose, so the weights are trained on the same t they are applied with. Same-date rows give 0 and go through the short-term formula (w17–w19), as with `enable_short_term: true`.
8. **Unlock count** = the number of scored training rows with deltaDays > 0 (long-term reviews) on eligible cards, plus same-day ones, i.e. all kind-1 rows that survive rule 5. It needs at least 400. The UI explains the gap between "answers" and "reviews that count".

The game change itself (Play stops writing to FSRS and the log by default) is a separate task. This module needs no change when it lands: new Play rows will simply be absent or have `applied: false`.

## 4. The fit (`js/fsrs-fit.js`, pure, no imports)

**Inputs:**
- `cards`: an array of `{ deltas: Int32Array, ratings: Uint8Array, scored: Uint8Array }`, built by `fsrs-data.js`
- `current`: the 21 weights in use
- `defaults`: `default_w`
- `bounds`: `CLAMP_PARAMETERS(W17_W18_Ceiling, true)`
- `config`: `{ epochs: 5, batchSize: 512, lr: 0.04, gamma, seed }`

The main thread gets all of these from ts-fsrs, so the worker never imports from a CDN.

**Steps:**
1. **Forward model.** Walk each card's history once. Before each scored review, predict R with the FSRS-6 forgetting curve and the current decay w20 (`R = (1 + f·t/S)^(-w20)`, with `f = 0.9^(-1/w20) - 1`), then update S and D exactly as ts-fsrs 5.4.2 does: initial S/D, recall and forget stability, the hard/easy factors, the short-term same-day update, and mean reversion of D. This is one pass per card (O(n)), not fsrs-rs's re-run of every prefix.
2. **Loss.** Binary cross-entropy of R against `rating > 1` over scored long-term reviews (deltaDays > 0), as fsrs-rs does. Add an L2 pull toward `defaults`, scaled per weight, so sparse data stays near the defaults.
3. **Pretraining w0–w3** (starting stability by first rating):
   - For each first rating, collect `(deltaDays, recalled)` of the card's next long-term review.
   - Minimise the log loss over log-S in [0.001, 100] with a golden-section search.
   - Blend with the default value when there are few samples (weight n/(n+k)).
   - Force the order w0 ≤ w1 ≤ w2 ≤ w3.
   - Then keep w0–w3 fixed while the others train (fewer degrees of freedom, as fsrs-rs does).
4. **Gradients** by forward-mode dual numbers. Each scalar carries a `Float64Array(17)` of derivatives for w4–w20. The result is exact and simple to get right; a unit test checks it against finite differences. Rough cost: 20k reviews × 5 epochs × about 17 × 60 flops ≈ 0.1 GFLOP, about 1–3 seconds on a mid-range phone.
5. **Adam** with mini-batches from a seeded shuffle (mulberry32) for reproducible results. After each step, clamp to `bounds`. Afterwards the main thread runs `clipParameters(w, numRelearningSteps, true)` once more (ceiling logic stays in ts-fsrs).
6. **Metrics** for `current` and `fitted` on the same eligible history:
   - `logLoss`
   - `rmse`: predictions binned into 20 R bins, then the count-weighted RMSE of mean predicted against observed recall. It is labelled "RMSE (bins)" in the UI but is not numerically identical to Anki's binning, which is fine because only the comparison matters.
7. **Decision: keep the fitted weights only if `logLoss` is lower AND `rmse` is not more than 0.01 (absolute) higher** (see §14, PR 2: the check is on held-out reviews and the RMSE has a slack). Otherwise keep the current weights.
   - "Current" means the saved personal weights, or `default_w` if there are none.
   - (Superseded in PR 2, see §14: the decision is made on the newest 20% of the history, which the fit does not see.) Like Anki, this was first planned as judged on the full history (owner-approved "on the user's history"). An optional `evaluateSplit` (train on the first 80% by time, score on the last 20%) is exposed for the simulator only, to report honest out-of-sample gains.

`fit` is a generator, `function* fit(input) { ... yield { phase, done, total } ... return result }`, so the same code:
- runs to completion in Node tests
- runs in the worker, posting progress every about 100 ms
- can be stepped on the main thread as a fallback, yielding with `setTimeout` every 30 ms

## 5. Web Worker

- **`js/fsrs-optimize-worker.js`** (module worker, same origin, about 30 lines) imports `./fsrs-fit.js`. It answers `{ type: 'fit', input }` with `progress` messages and then `{ type: 'done', result }` or `{ type: 'error', message }`. Typed arrays go over as transferables.
- **Started from `js/optimize-sheet.js`** with `new Worker(new URL('./fsrs-optimize-worker.js', import.meta.url), { type: 'module' })`.
- **Cancel** calls `worker.terminate()`. Nothing has been saved at that point.
- **Time limit:** 120 s. After that, terminate and say so; nothing changes.
- **Fallback:** if `Worker` or module workers fail (old Safari, a private mode that blocks them), run the same generator on the main thread in 30 ms slices, with an extra note: "This may make the app slower until it's done."
- **Integrity:** no CDN code runs in the worker. The import map limitation does not matter, and `tests/integrity.test.js` is unchanged.
- **Reading the log:** the main thread reads it with one `getAll` (the `index('timestamp')` range over everything), then builds per-card typed arrays in `fsrs-data.js`. For 50k rows this is a few hundred ms and happens behind the "Reading your reviews…" step. (Opening IndexedDB inside the worker was considered and rejected: it would duplicate db.js's open and upgrade logic.)
- **`sw.js`:** add both new files and the sheet to `CORE`, bump `CACHE` to v82, and run `node tests/update-sw-hash.mjs`.

## 6. Settings, scheduling and rescheduling

**New synced setting `fsrsParams`:**
- default `null`, added to `DEFAULT_SETTINGS` in `js/db.js` and to `SYNCED_SETTINGS` in `js/sync-data.js`. It is "newest wins", not merged.
- value shape:
  ```
  { w: number[21] | null, at, reviews, cards,
    logLoss: { before, after }, rmse: { before, after }, version: 'fsrs-6' }
  ```
- "Reset to default" saves `{ w: null, at, version: 'fsrs-6' }`. It is not deleted, because a stamped value syncs and a missing key does not.
- `cleanFsrsParams(v)` in `js/sched-settings.js` returns the value only if `w` is null, or 21 finite numbers and `version === 'fsrs-6'`. Otherwise it returns null. Use it in:
  - `getSettings`
  - `applyRemote` (junk from the server is ignored)
  - `importAll` / `checkBackup` (backups)

**Scheduling:**
- `schedulerOptions()` adds `w: cleanFsrsParams(settings.fsrsParams)?.w ?? undefined`.
- `scheduler()` in `js/srs.js` passes `w` to `generatorParameters`, which already runs `migrateParameters`/`clipParameters`.
- `deckSchedulerOptions` keeps it global, because `deck.options` never holds `fsrsParams`.

**Fix in `js/exam.js`:** `recall(stability, days, decay = DEFAULT_DECAY)`. Pass the decay through `examClamp` (opts carry `w`), `examGainFrom` and `readiness`, with `FACTOR` computed from it. Without this, the exam features would use the wrong forgetting curve as soon as w20 changes. Add a test.

**Rescheduling existing cards: do not touch them.**
- Saved due dates, stability and difficulty stay as they are. The new weights apply from each card's next review, which is what the Advanced scheduling note already promises ("Changes apply to future reviews. Cards already scheduled keep their dates until you next review them.").
- Recomputing S/D for every card (Anki's "reschedule on change") was rejected for v1, for three reasons:
  - It rewrites every `cardStates` row with a new `updatedAt`. The next sync would push thousands of rows, and because cardStates are "newest change wins", an offline review on another device could be overwritten. That loses a review.
  - Histories with Play or partial Anki rows cannot be replayed exactly.
  - It is a large change that is hard to undo.
- The mismatch (S/D computed under the old weights) fades after one review per card.
- A later, opt-in "Recalculate my cards now" could recompute memory states only, keep due dates, and sync them as one batch. Out of scope here.

**Per-deck vs global: global only.** One set of weights for all decks, trained on all eligible history. Per-deck retention and steps (`deck.options`) keep working as now. Each preset would need its own 400 reviews, and per-deck weights would complicate sync and the UI. Adding them later would mean putting `fsrsParams` into `deck.options` and training on that deck's subtree; the data layer already supports filtering by deck.

## 7. Sync conflicts

- **Two devices optimise:** the newest `_times` stamp wins as a whole object. `w` and its metrics always travel together. Both results were valid fits, so either is acceptable.
- **Settings change during a run:** before saving, the sheet re-reads `fsrsParams`. If it changed since the run started (a sync landed), the worker scores the new current weights against the fitted ones. Save only if the fitted weights still win; otherwise say "Your other device already updated your parameters; they predict as well, so nothing changed."
- **Reset on one device, optimise on another:** newest wins. The result line names the source and date ("Your parameters, from 3,412 reviews on 12 Oct"), so a surprising change can be explained.
- **No other data changes,** because nothing in `cardStates` is rewritten (section 6). So there are no record conflicts.
- **Backups:** export includes the setting. Restore replaces it, like the other synced settings, after `cleanFsrsParams`.

## 8. UI and wording

**Settings → Study → Advanced scheduling**, a new row after "Spread out due dates": **Personal parameters**. Opening Settings never reads the whole log; the row uses the setting plus `count('reviewLog')`.
- Status line, one of:
  - "Using the standard FSRS settings."
  - "Using your own settings, from 3,412 reviews (12 Oct)."
- Button **Optimize…** opens the sheet. If the total log count is under 400, the button is disabled with the reason "Available after 400 reviews (you have 132)."
- **Reset to default** is a link, shown only when personal weights are in use. It asks for confirmation inside the page, not with `confirm()`: "Go back to the standard settings? Your cards keep their dates." Buttons: Reset / Cancel.

**Sheet `js/optimize-sheet.js`** (lazy, the standard sheet frame):
- **Intro:** "Fit the scheduler to your own review history so it predicts more accurately when you'll forget. It runs on this device and takes up to a minute. Your cards keep their dates; the new settings apply from each card's next review. Only cards you rate in Review (and Anki history) are used, not game answers."
- **Not enough:** "Not enough reviews yet: 380 of 400 count. Game answers and cards whose history is incomplete aren't used."
- **Running:**
  - a `role="progressbar"` with `aria-valuenow`
  - phase text in an `aria-live="polite"` line, announced only when the phase changes or every 25%:
    1. "Reading your reviews… 3,412 reviews of 611 cards"
    2. "Finding your settings… 42%"
    3. "Checking they predict better…"
  - a **Cancel** button
  - the rest of the app stays usable; the sheet can be closed and the run continues in the worker until it finishes or the page closes
- **Better:** "Done. Your new settings predict your answers better, so they're now in use." Details: "Checked on your newest 20% of reviews, which the fit did not see: prediction error (log loss) 0.312 → 0.298 · RMSE 4.1% → 3.2%". If a run is reset from Settings while it works: "You reset your parameters while this was running, so nothing changed." Then: "Run this again every month or so as you review more."
- **Not better:** "Done. Your current settings already predict your answers as well as the new ones, so nothing changed."
- **Cancelled:** "Stopped. Nothing changed."
- **Timed out or error:** "Couldn't finish on this device. Nothing changed."
- **Details** (folded): the 21 numbers in mono as a comma-separated list (the same format as Anki's, for copying), and the number of reviews and cards used.

Add styles to an existing sheet section of `css/styles.css`. Check 375px with no sideways scroll, dark and light themes, and reduced motion.

## 9. Tests

**Unit, `node --test`, no network** (core tests do not need ts-fsrs):
- **`tests/fsrs-data.test.js`**, on a hand-built fixed log of about 30 rows:
  - review and anki rows are kept; applied Play rows are replayed but not scored; other Play rows are ignored
  - unknown sources are ignored
  - a card whose first row has `state !== 0` is skipped
  - the UTC-date rule, and a DST night in a non-UTC time zone via a TZ child process (as in `tests/stats-dst.child.mjs`)
  - the unlock count
  - the `truncate` policy switch
- **`tests/fsrs-fit.test.js`**:
  - a synthetic log from a seeded generator inside the test: 400 cards and about 4,000 reviews from known "forgetful" true weights, generated with `fsrs-fit.js`'s own forward model
  - the dual-number gradient matches central finite differences (relative 1e-5)
  - the fit lowers log loss against `default_w` and moves w20 and w0–w3 toward the truth (tolerances set after the first run)
  - all weights stay within `bounds`
  - the same input gives identical output (seeded)
  - progress is monotonic and ends at 1
  - stopping the generator early returns nothing
  - a log generated from `default_w`, with `current = default_w`, results in "keep current", which checks the decision rule
  - fewer than 400 eligible reviews gives "not enough"
- **`tests/fsrs-parity.test.js`**: our forward model's S/D after 200 random histories equals ts-fsrs 5.4.2 within 1e-9, for both default and random clamped weights. It is skipped if ts-fsrs is not installed locally, using the same `tests/sim/loader.mjs` pattern as `tests/exam-rate.test.js`.
- **Additions to existing tests:**
  - `tests/sched.test.js`: `cleanFsrsParams`; `schedulerOptions` passes `w`; `deckSchedulerOptions` keeps it global
  - `tests/sync.test.js`: `fsrsParams` is synced, newest wins, junk is ignored
  - `tests/backup.test.js`: restore and clean
  - `tests/exam-rate.test.js`: recall follows a custom w20
  - `tests/sw.test.js` and the hash refresh

**E2E, `tests/browser/e2e-optimize.mjs`** (`node tests/browser/run.mjs optimize`):
- Seed through `db.addImport` with a fixed seed: 450 review rows from non-default weights plus 80 Play rows.
- Settings → Advanced: the status reads the standard settings. Open the sheet.
- Click Optimize: the progress bar appears. A `requestAnimationFrame` heartbeat in the page never stalls more than 200 ms while running, which proves the worker keeps the UI free.
- Wait for "Done": `fsrsParams.w` is saved with 21 numbers, and the Review button preview ("Good · Xd") for a test card reflects the new weights.
- Reset to default → confirm in the page: `w` is null.
- A second run with Cancel: nothing saved.
- A first pass with only 100 rows: the button is disabled with the "after 400 reviews" text.
- 375px and 1440px, dark and light, no sideways scroll, no console errors.

**Simulator check** (PLAN rule: "Check every change with the scheduling simulator first"):
- Add an "optimize at 400 reviews, then every 30 days" option to `tests/sim/compare/harness2.mjs`.
- Run the learners `default`, `forgetful` and `strong` over 30 seeds.
- Pass rule, decided before running:
  - long-run retention is within ±0.5 points of target and no worse than the defaults in any cell
  - reviews per day are no more than 3% higher for `default` learners
  - out-of-sample log loss improves for `forgetful` and `strong`
- Write the results to `tests/sim/compare/report-optimizer.md`.

## 10. Build steps

| # | Step | Files | Effort |
| --- | --- | --- | --- |
| 1 | Training-data selection (section 3) and its tests | `js/fsrs-data.js` (new), `tests/fsrs-data.test.js` (new) | 0.5 day |
| 2 | Forward model, duals, pretraining, Adam, metrics, decision; generator API | `js/fsrs-fit.js` (new), `tests/fsrs-fit.test.js`, `tests/fsrs-parity.test.js` (new) | 2–2.5 days |
| 3 | Worker plus main-thread fallback and a timeout wrapper `runFit()` | `js/fsrs-optimize-worker.js` (new), `js/optimize-sheet.js` (new, run part) | 0.5 day |
| 4 | Setting, sync, cleaning, scheduler `w`, exam decay | `js/db.js`, `js/sync-data.js`, `js/sched-settings.js`, `js/srs.js`, `js/exam.js`, `js/stats.js` (readiness opts), tests in sched/sync/backup/exam-rate | 0.5–1 day |
| 5 | Settings row and sheet UI, wording, CSS | `js/app.js` (row and wiring), `js/optimize-sheet.js`, `css/styles.css` | 1 day |
| 6 | Service worker files, CACHE bump, hash, APP_VERSION | `sw.js`, `js/app.js` | 0.1 day |
| 7 | E2E, simulator run and report, PLAN.md / README notes | `tests/browser/e2e-optimize.mjs` (new), `tests/sim/compare/harness2.mjs`, `report-optimizer.md`, `PLAN.md` | 1 day |

**Total: about 6–7 working days.** Order: steps 1 → 2 → 4 can land as pure modules first (PR 1, no UI). Then 3 → 5 → 6 → 7 (PR 2).

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Our forward model drifts from ts-fsrs (now, or in a future FSRS-7) | The parity test; the fit pins `version: 'fsrs-6'` and `cleanFsrsParams` rejects other versions |
| A pure-JS fit is weaker than fsrs-rs | The keep-only-if-better rule; simulator check; L2 pull toward the defaults; the binding stays a later option |
| Overfitting on the user's own history (the decision is in-sample, as in Anki) | L2 regularisation, fixed w0–w3 after pretraining, 5 epochs; the simulator reports out-of-sample gains |
| Slow phones or huge logs | Typed arrays, O(n) per card, a 120 s limit and Cancel; perf check in e2e with 20k synthetic rows |
| No module Worker (old iOS) | Main-thread fallback in slices, with a note |
| Sync: a stale fit wins because its stamp is newer | It is valid data either way; re-check before saving; the source and date are shown |
| Mismatch between old S/D and new weights until the next review | Documented; fades after one review; the optional recalculation comes later |
| Exam and readiness numbers shift because w20 changes | Intended (more accurate); covered by the exam-rate test |
| The Play policy (replay vs truncate) is judged wrong | One constant, decided by the owner (Q1); tests cover both |

## 12. Questions for the owner

- **Q1.** Play answers that changed a card's schedule: replay them as history without scoring them (recommended), or cut that card's history at the first one?
- **Q2.** The decision rule: "lower log loss and RMSE no higher" (recommended), or log loss alone?
- **Q3.** Is a later "Recalculate my cards now" wanted, or never?

## 13. Key decisions (summary)

- **Pure-JS optimizer in a module Web Worker, not `@open-spaced-repetition/binding`.** The binding has a browser WASM build that can be pinned on jsDelivr, at about 222 KB brotli (598 KB raw). But it needs cross-origin isolation, which GitHub Pages cannot provide, reserves about 250 MB of shared memory, relies on generated `+esm` dependency bundles that can drift, and is pre-1.0.
- **Real reviews = `source` `review` or `anki`.** The field already exists on every row, so no migration. Play rows that changed the schedule are replayed but never scored; all other Play rows and unknown sources are ignored; cards without a "new" start are skipped.
- **One global synced setting, `fsrsParams`** (newest wins, cleaned on every way in). Reset saves `w: null`. Per-deck options keep only retention and steps.
- **Keep only if better:** lower log loss and RMSE no higher than the current or default weights, on the user's eligible history. It unlocks at 400 reviews that count.
- **Existing cards are not rescheduled.** The new weights apply from each card's next review, which avoids mass `cardStates` rewrites and sync overwrites.
- **Fix `js/exam.js`'s hard-coded decay** so exam features and readiness follow the personal w20.
- **Tests:** unit tests on a seeded synthetic log (gradient, recovery, decision, bounds), a ts-fsrs parity test, one e2e that also checks the UI stays responsive, and a simulator run before shipping.

## 14. As built in PR 1 (steps 1, 2 and 4)

Owner decisions: Q1 replay, Q2 lower log loss AND RMSE no higher, Q3 no recalculation now. What differs from the plan above:

- **Refine step.** After Adam, `fit` re-searches w0 to w3 (golden section on log S, over the whole history of the cards that began with that rating, with the same pull towards the defaults) and puts them back in order. Pretraining only sees each card's first long-term review and uses the curve we started from, so on its own it is biased. Progress phases are `pretrain` 5%, `train` 80%, `refine` 7%, `check` 8%.
- **The decision is in-sample, so it is generous.** On a history made from the default weights, judged against those same weights, the fit still wins about half the time by a hair (noise it has fitted). That is the owner-approved rule (same as Anki); the test only requires that the answer follows the rule and that such a gain is tiny. Judging out of sample is `evaluateSplit`, for the simulator.
- **Some weights cannot be recovered from a log.** w7 and w12 to w19 act through rare or same-day answers (same-day answers are never scored), so the test checks recovery on w0 to w6, w8 to w10 and w20 only.
- **Decay follows w20 in every exam function, not only the three named in section 6.** `recall`, `recallAt`, `planFinalPass`, `examSchedule`, `examGainFrom`, `pullIn`, `examPrepQueue` and `readiness` take a trailing `w20`; `examClamp` reads `opts.w[20]`. `personalW20(settings)` (sched-settings.js) gives the number; it is kept in 0.1 to 0.8, the range the scheduler allows.
- **`fsrsParams` cleaning.** `cleanFsrsParams` returns a clean copy with only the known fields. Settings reads, server rows (`acceptSetting` in sync-data.js: `null` is a real value, junk is skipped) and backups (`restoredSettings` in db.js: junk is left out of the restore, not stored as `null`, so it cannot be stamped as a reset and wipe weights synced from another device) all use it. `checkBackup` does not refuse a backup for a bad `fsrsParams`: the weights are derived data and the rest of the backup is still good.
- **`schedulerOptions` leaves `w` out** when no personal weights are in use, so existing option objects and the scheduler's cache key do not change.
- **`sw.js`.** The new modules are listed in `CORE` and CACHE is bumped to v83, because `tests/preload.test.js` and `tests/sw.test.js` require both for any change under `js/`.
- **Resets.** A kept row with state 0 after earlier kept rows is a reset (Browse "Reset to new", Anki Forget); only the part after the last reset is used (rule 3a, as Anki does).
- **Day gaps are UTC dates, not study days (supersedes 3.7).** `deltaDays` mirrors ts-fsrs's `dateDiffInDays`, which the live scheduler applies to the review times, so training and use see the same t. The 4am rollover still decides when a card is *due* in the app; it does not enter the fit.
- **For PR 2 (per-deck relearning steps).** `generatorParameters` clips w17 and w18 to a ceiling that depends on the deck's relearning-step count. Before PR 2 evaluates "current" and "fitted" weights (and before the final save), it must run `clipParameters(w, numRelearningSteps, true)` for each deck's step count, and compare the metrics on what the scheduler will really use.
- **Ordering and speed.** After the refine step w0 to w3 are put in order with the same pool-adjacent-violators code as pretraining (`poolAscending`). The dual numbers keep their derivatives in one shared arena buffer instead of a new array per operation: same results bit for bit, about 12 times faster (49,851 answers: 14.8 s to 1.2 s).

## 14b. As built in PR 2, and what changed after the simulator and review

- **Held-out keep rule (supersedes §4.7's in-sample check).** The first simulator run failed its pre-registered rule (report-optimizer.md): judged in-sample, weights fitted on the first 80% of a default-like student's history predicted the last 20% worse than the standard ones. So `fitChecked` (fsrs-fit.js, run by the worker) fits on the first 80% of the days, judges those weights against the current ones on the last 20% (`judge`, each deck's weights clipped for its relearning steps by `clipWeights`, which a parity test checks against ts-fsrs `clipParameters`), and refits on everything only if they win. Fewer than `HOLDOUT_MIN` (50) held-out predictions: the current weights stay. The cutoff day counts only reviews that get a prediction (scored, not a card's first answer, on a later day), so the held-out part really is about 20% of the predictions.
- **RMSE slack (decision made after review).** "RMSE no higher" became "not more than 0.01 higher" (`RMSE_SLACK`). The binned RMSE is noisy on a small held-out slice; the code reviewer measured the strict rule accepting 22 of 40 simulated gains at about 800 reviews, and 29 of 40 with the slack. Log loss must still be strictly lower.
- **Gamma 8 to 1000**, tuned on simulator seeds 31 to 60 and reported on seeds 1 to 30.
- **Weights are judged per deck** and saved with plain bounds; each deck clips again for its own steps when it schedules.
- **Sync and reset during a run.** The setting is re-read before saving. A reset saved from Settings while the run works (`{ w: null }` with a newer time) is not overwritten; any other change makes the sheet score the new current weights against the weights the check used (on the same held-out slice). Cancel is checked once more right before saving.
- **An open Review session starts again** when `fsrsParams` changes, here or from the server (`scheduleVersion` is bumped in `setSetting` and `applyRemote`). review.js no longer absorbs a bump that landed before its own save.
- **Main-thread fallback:** fit() skips its own in-sample check when `fitChecked` calls it, and the refine step yields every search step, so the longest gap between yields is about 60 ms on 50,000 reviews in Node.
