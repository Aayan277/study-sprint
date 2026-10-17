# FSRS-7 (beta) in Study Sprint: plan and what was built

Status: steps 1 to 3 built (v4.14 + this branch, no version bump); step 4 (tuning FSRS-7 to a person's history) is documented below as future work.
Background: `docs/design/fsrs-research.md`, Part 2 and roadmap item 4 (on branch `claude/admiring-johnson-aek297`).
Owner decision: port FSRS-7 now behind an OFF-by-default switch, accepting that ts-fsrs 6.0.0-beta.14 is still a beta.

## 0. In one page

- **A new synced setting `fsrsVersion`** (6 = default, 7 = beta), in Settings → Study → Advanced scheduling → "Scheduler".
- **No beta library is loaded in the app.** The FSRS-7 maths is ported into three small pure files (`js/fsrs7-model.js`, `js/fsrs7-sched.js`, `js/srs7.js`) and checked against ts-fsrs 6.0.0-beta.14, installed as a devDependency, by 300 random histories (memory, curve, interval) and 150 random cards × 14 reviews × 4 ratings (due date, state, step, counters). Why: section 1.
- **Cards keep both memories.** FSRS-6's `stability`/`difficulty` stay on the card and move on with every review in either mode; FSRS-7's memory sits beside them in a new field `fsrs7`. Switching on, off and on again loses nothing. Section 2.
- **Older app versions cannot corrupt FSRS-7 data**, because a card state is saved and synced as one whole record and the FSRS-7 memory is only trusted when its `at` equals the card's `lastReview`. Section 2.
- **Exam maths** uses the FSRS-7 curve for cards that have an FSRS-7 memory. Section 4.
- **Not built:** tuning FSRS-7's 34 weights to a person (section 3). With FSRS-7 on, the Optimize row says "Personal tuning for FSRS-7 is coming; using standard FSRS-7 settings."

## 1. Loading the beta library: what I found, and why the app does not load it

Checked on 17 Oct 2026 against `npm pack ts-fsrs@6.0.0-beta.14` and jsDelivr.

| Question | Answer |
|---|---|
| Does the beta have an ESM build? | Yes, but it is not self-contained. `dist/index.mjs` (39.7 KB) imports 7 sibling chunks (`middlewares-*.mjs` 32.7 KB, `fsrs-6-*.mjs` 11 KB, `schema-*`, `constants-*`, `error.mjs`) and lazily `./models/fsrs-7.mjs` (13 KB, loaded by `import()` the first time FSRS-7 is asked for). It also imports **bare specifiers** from a new dependency, `@open-spaced-repetition/srs-kit@1.0.0-beta.9` (`/chrono/date`, `/chrono/numeric`, `/chrono/temporal-instant`, `/middleware`; another 34 KB over 8 files). |
| Can the browser load that from jsDelivr as it is? | No. A browser cannot resolve `@open-spaced-repetition/srs-kit` without an import map entry for it and for each subpath. Every file would also need its own `integrity` line. About 20 files, all of them beta, all to be re-hashed on every beta bump. |
| jsDelivr's `+esm` bundle? | Works (40 KB, rewrites the bare imports), but jsDelivr stamps it "Do NOT use SRI with dynamically generated files": it is built on demand and its bytes can change. It cannot be pinned with integrity. Not acceptable under our rule (SHA-384 on every CDN module). |
| The UMD build? | `dist/index.umd.js`: static, self-contained, 194,661 bytes (39 KB gzipped), contains `FSRS7Algorithm`. It can be pinned: `sha384-0dPcCHrAF6Q96ne3geSi/M/ztoRovRLAMl+nT8639v3DuLuR7QxJOU89o5KCLMzz` (identical to the npm file). It is a classic script, so it would have to be added with a `<script src integrity crossorigin>` element created on demand, not `import`. |
| API | New and async: `DefaultScheduler({ version: 'FSRS-7', ... })` returns an object with `review({ card, grade, now })`, cards in camelCase (`dueAt` as an ISO string, `scheduledDays`, `learningStep`, `stabilityFast`). The 5.4.2 `fsrs()` API we use today is a different shape. The beta can change it again before 6.0.0. |
| Conversion FSRS-6 → FSRS-7? | None. The library says so itself (`migrateFSRS7Parameters`: "FSRS-7 requires its own weights; replay review history to migrate memory states"). |

**Decision.** Port, do not load. The FSRS-7 model is about 150 lines of arithmetic and the scheduler rules around it (learning steps as a floor, graduating interval, monotonic intervals, fuzz) are about 100 more. We need the model in our own code anyway for step 4 (the optimizer needs its own forward model and gradients, as `fsrs-fit.js` has for FSRS-6). Running the port means:

- nothing extra to download, on or off; works offline from the first launch; no new CDN origin, no new integrity entry, no change to the service worker's pinned prefixes;
- no dependence on a beta API at run time;
- the beta library becomes a **test oracle** (devDependency `ts-fsrs-beta`, an npm alias of `ts-fsrs@6.0.0-beta.14`, next to `ts-fsrs` 5.4.2). When the beta changes the maths, `tests/fsrs7-parity.test.js` fails and says so; when the tests are skipped (no `npm install`) they print a loud warning, like the existing FSRS-6 parity test.

The cost is that we maintain a port of someone else's algorithm. The parity test is what makes that safe. **If the owner would rather run the library itself** once 6.0.0 is stable, the route is the UMD file: add `https://cdn.jsdelivr.net/npm/ts-fsrs@6.0.0/dist/index.umd.js` to the PINNED prefixes in `sw.js`, load it lazily with a script element carrying `integrity`, and replace `js/fsrs7-sched.js` by calls to `DefaultScheduler`. The model and the optimizer still need our own port, so the port would stay either way.

## 2. Card data: how FSRS-6 and FSRS-7 states live together

### What is saved

A `cardStates` record today: `{ cardId, due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview, updatedAt }`.

FSRS-7 adds exactly one field:

```
fsrs7: { stability, stabilityFast, difficulty, at }
```

`stability`/`stabilityFast`/`difficulty` are FSRS-7's memory (the slow trace, the fast trace, difficulty). `at` is the `lastReview` the memory belongs to. Everything else on the record is shared and means the same in both modes (`state` 0 to 3, `learningSteps` = the index of the step, `reps`, `lapses`, `due`). Two differences: `scheduledDays` can now be a fraction (0.0069 = 10 minutes), and `elapsedDays` is whole days as before.

The FSRS-6 fields `stability` and `difficulty` stay **valid in both modes**. In FSRS-7 mode each review also runs the FSRS-6 memory step (one extra `next()` call of ts-fsrs 5.4.2, with the same weights, no fuzz) and saves its stability/difficulty; the due date, state and step come from FSRS-7. FSRS-6's memory update depends only on the card's memory, the rating and the elapsed whole days, not on how the due date was chosen, so a card reviewed on the same days with the same ratings has the same FSRS-6 fields in both modes. `tests/fsrs7.test.js` checks this to 1e-9 over a 7-review sequence.

### Turning FSRS-7 on

Nothing is rewritten. On the first FSRS-7 review of a card (Review and Play), `prepare7` (srs7.js) rebuilds the card's FSRS-7 memory:

1. **Replay (preferred).** Run the card's review log through FSRS-7 from its first answer, with fractional days between answers. It uses the same rows the optimizer trains on (`rowKind` in fsrs-data.js: real reviews, imported Anki history, Play answers that moved the schedule), restarts at a "reset to new" row, and is only used if the log starts at "new" and its last row is within a minute of the card's `lastReview`.
2. **Seed (no usable log, e.g. an Anki import without history).** `stability` and `difficulty` as FSRS-6 has them, `stabilityFast` = 0.8 × `stability` (the ratio FSRS-7 itself gives a card's first answer).

The history must start at "new" (a first row with no `state` counts only when nothing at all came before it, the same rule as `buildHistories`). When the synced `ignoreBefore` setting (optimizer and health check, on another branch) has merged, the replay should treat it as a start boundary and seed from FSRS-6 if a card's history crosses it; there is a TODO at `replayRows`.

The library offers no conversion, so replay is the migration, as its own error message recommends. Cost: one indexed read of the log per card, once. Review starts the rebuild when a card is shown, so it is nearly always done before the answer; if it is not, the card is rated from the seed. Interval buttons use the same memory.

Until the first FSRS-7 review a card keeps its FSRS-6 due date. Turning FSRS-7 on does not reschedule anything (as with changing any scheduling option today: "Cards already scheduled keep their dates until you next review them").

### Turning it off, and on again

An FSRS-6 review writes a new state **without** `fsrs7`: after it the old FSRS-7 memory would be out of date. If it is left behind (an older app version spread the old fields into a new state), its `at` no longer equals `lastReview` and it is ignored. Turning FSRS-7 on again rebuilds by replay, now including the FSRS-6 reviews in between. So: nothing is lost either way, and no mode ever reads a memory that does not belong to the card's last review.

### Older app versions and sync

How a card state travels: `rowFromRecord` sends the whole record (everything except `updatedAt`/`syncedAt`) as the row's `data`; `recordFromRow` saves `data` as it came. Backups hold whole records too. So an unknown field such as `fsrs7` **round-trips unchanged** through sync (Supabase `data` is jsonb) and backup/restore. Checked by a unit test and an e2e test with the fake Supabase.

What an older app does with such a record:

- It reviews a card: it builds a brand-new state from its own known fields, so `fsrs7` is dropped, and the record (newest `updatedAt` wins) replaces ours everywhere. Nothing is half-updated, because the record is the unit. The next FSRS-7 review rebuilds the memory (replay). The cost is one rebuild, not wrong data.
- It postpones, "sets the due date" or pulls cards in for an exam: those spread the old record (`{ ...state, due }`), so `fsrs7` stays and `at` still equals `lastReview`: correct, because the memory did not change.
- It ignores the new synced setting `fsrsVersion` (`isSyncedSetting` only lets known keys through), so it keeps scheduling with FSRS-6 on its device. Two devices on different versions therefore mix schedulers; by the rules above that is safe, just not the experience wanted. FSRS-7 should be tried on one device, or on all of them after they update.
- A restored backup from before this version has no `fsrs7`: the same as turning FSRS-7 on.

Setting `fsrsVersion`: synced like `fsrsParams` (newest wins). Junk (not exactly 6 or 7) from the server or a backup is rejected by `acceptSetting` and `restoredSettings`, never stored as 6, because a stamped 6 would switch other devices back.

### Other places that read a state

`decks.js` (young/mature, `stability >= 21`), Browse's "Remembered for", stats and the Anki importer read the FSRS-6 `stability`, which stays valid. `exam.js` reads the FSRS-7 memory when FSRS-7 is on (section 4). Anki import with progress replays history through `rate()` and so produces FSRS-7 states directly when the switch is on.

### Differences you will see with FSRS-7 on

- A new card answered Good comes back in about 5 days, not after 10 minutes: the model decides, the steps are a floor (`allowModelOverride`, the library's default for FSRS-7). Again still gives the first step (1 minute).
- After a lapse the card comes back at the model's interval, between the relearning step and 1 day.
- With the defaults a new card's four buttons are about 1 minute, 14 hours, 5 days and 54 days (Again, Hard, Good, Easy). Easy is long on purpose: it is the model's interval for a card you found trivial.
- **Learning cards that cross a day.** Hard on a new card (about 14 hours) leaves it in the Learning state with a due time after the end of today's study day. The queue (`splitCards`) only shows a learning card that is due within today, so such a card is simply not shown again until its day, and then it comes back as an ordinary "learn" card (it is due, so it is in the reviews list). No queue rule was added: nothing is lost or shown twice, and FSRS-6 already behaves this way for a learning step longer than the rest of the day. If it turns out to feel wrong in use, the fix would be a rule in `splitCards` applying only under FSRS-7.
- Same-day repeats now change the memory (FSRS-6 only nudges stability slightly).
- Gaps are fractional days; `scheduledDays` is no longer a whole number. Load balancing and the 'Spread out due dates' option still pick whole days for gaps of 3 days or more.

## 3. Optimizer for FSRS-7 (step 4): not built, with the design

I stopped after step 3 on purpose, because step 4 is larger than the other three together and touches code other work is changing right now (recency weighting, health check, retention helper in `fsrs-fit.js`/Settings). What it needs, in order of risk:

1. **Histories with real time.** `fsrs-data.js` turns timestamps into whole UTC days (`deltaDays`) and a review counts as scored only when `delta > 0`. FSRS-7 is trained on same-day answers too (that is where most of its gain is) with fractional gaps `(t_i − t_{i−1}) / 86400000`, and every answer is scored, including same-day ones. A second builder next to `buildHistories`, `buildHistories7`, with `deltas: Float64Array`.
2. **A forward model for 34 weights with gradients.** The model is `js/fsrs7-model.js` (done, parity-tested). Gradients: `fsrs-fit.js` has forward-mode dual numbers for FSRS-6 with 17 trained weights in an arena buffer (`P = 17` derivatives per number). Generalise that arena to `P = 30` (w4..w33; w0..w3 are pretrained) rather than fork it, or write `js/fsrs7-fit.js` with its own copy to stay out of the way of the other work. New operations compared with FSRS-6: `pow` with an exponent that depends on the state (`sf^(w33−0.3)`, `sf^−w29`, `s^w30`), `exp((d−5)(w31−0.5))`, a two-trace mix, and the `min(s, fail)` / `0.8·stability` caps, whose derivative is the derivative of whichever branch is chosen (as `dmin` already does). The `roundTo(·, 8)` calls in the library are left out in the smooth version, as in `fsrs-fit.js` (`round = false`).
3. **Bounds and constraints.** `W7_BOUNDS` plus the ordering rules (w1..w3 each at least the weight before, w26 at least w25) that `clipWeights7` already applies after every Adam step.
4. **Pretraining** of w0..w3 from first answers, as for FSRS-6, but with the fast trace at 0.8 × the slow one.
5. **Regularisation and the keep rule.** The same held-out rule as for FSRS-6 (`decide`/`isBetter`/`judge` in fsrs-fit.js: keep new weights only if they predict better on reviews not trained on), `gamma` pulling towards `W7_DEFAULT`. The benchmark's FSRS-7 defaults (0.362) → tuned (0.340) gap is big, but all our current constants (gamma 1000, 400 reviews) were tuned on FSRS-6 simulator data. They must be re-tuned on real data (roadmap item 1) before FSRS-7 tuning is switched on for people.
6. **Storage.** A synced setting `fsrsParams7` (`{ w: [34] | null, at, reviews, cards, logLoss, rmse, version: 'fsrs-7' }`), cleaned like `fsrsParams`, and used by `srs7.js` (`opts.w7`, already supported) and `personalW20` (`w7`). The sheet is `optimize-sheet.js` with the version label switched.

Until then the Optimize row with FSRS-7 on shows "Personal tuning for FSRS-7 is coming; using standard FSRS-7 settings." and the button is disabled. Personal FSRS-6 weights are kept untouched, and used again when switching back.

## 4. Exam recall with the FSRS-7 curve

`exam.js` computed "chance of remembering" as `(1 + FACTOR · days / stability) ^ -w20`. FSRS-7's curve is a mix of two traces (`curve7`), so a stability and a decay are not enough.

- `personalW20(settings)` is the one place callers get the model from. With FSRS-6 it returns a number or `undefined`, exactly as before. With FSRS-7 on it returns `{ w20, w7 }`. Every exam function already passes this value along (`w20`), so no caller changed.
- `recallAt(state, when, model)`: with a `{ w7 }` model and a state whose `fsrs7.at === lastReview`, it uses the FSRS-7 curve with the card's memory; otherwise the FSRS-6 curve from `stability` (a card not yet reviewed with FSRS-7 has only that). A number or `undefined` model ignores `fsrs7` entirely.
- `examClamp` (called by `rate()` for each new review) and `examGainFrom` (the gain of a review before an exam: the recall after a Good against after an Again) take the memory the review just produced.
- The thresholds (`FINAL_R` 0.99, `READY_R`, `EXAM_RETENTION`) are unchanged. They were tuned on FSRS-6; with FSRS-7 the curve of a freshly learned card is steeper in the first days and flatter after, so these are the first numbers to check against real data.

## 5. Risks and how they are covered

| Risk | Cover |
|---|---|
| The beta changes before 6.0.0 (maths, defaults, API) | The port does not follow it, which keeps the app stable. The parity tests fail loudly on a drift and are the signal to update the port. Package pinned to an exact version. |
| Port bugs | 300 histories × 3 intervals and 8,400 scheduled outcomes compared against the library, including random weights, fuzz, steps variants, max-interval and retention variants, long gaps. A mutation check (graduating interval 1 → 2) makes the test fail. |
| FSRS-7 is not better for our users | Unknown: the benchmark is Anki users, our simulator's "students" are FSRS-6 by construction, so it cannot say. It is off by default and labelled beta. Judging it needs real data (roadmap item 1), and the review log and FSRS-6 memory stay intact so a person can switch back at any time. |
| Mixed versions across devices | Safe by construction (section 2). The mix is a cost, not corruption. |
| Memory rebuild fails or is incomplete (no log) | Falls back to the seed from FSRS-6, never blocks a review. `console.error` only. |
| Intervals are fractional: code that assumed whole days | `scheduledDays` is read by `lastSeen` (exam.js, fine), postpone.js (rounds), Browse "set due date". Intervals under a day are common under FSRS-7: Again on a new card is 1 minute, Hard on a new card about 14 hours, and after a lapse the card returns between the relearning step and a day. Covered by the e2e test (review a few cards, switch back). |
| Old synced `fsrsVersion` from a stale backup flips a device | Same rule as every synced setting: newest wins; a backup restore stamps the time of the restore. |
| Exam thresholds tuned on FSRS-6 | Documented in section 4; no change in behaviour for FSRS-6. |

### How to validate

- **Parity against ts-fsrs 6 beta** (`tests/fsrs7-parity.test.js`): the model, the curve, the interval, then the whole scheduler card by card. Run after every beta bump.
- **Unit and e2e** (`tests/fsrs7.test.js`, `tests/browser/e2e-fsrs7.mjs`): migration (replay, seed, staleness), routing in `srs.js`, the FSRS-6 fields staying identical, exam maths, setting validation, sync round trip with the fake Supabase.
- **The simulator is used for workload only.** Its true memory is FSRS-6, so it can compare reviews per day at different retentions under FSRS-7 settings, but it can never show that FSRS-7 predicts a person better. That claim needs real logs (roadmap item 1, the HuggingFace revlog sample, kept outside the repo) and, later, beta testers' own exports.
- **Real data later:** log loss and RMSE per user, FSRS-7 default weights against FSRS-6 default and against tuned FSRS-6, on held-out reviews; plus same-day repeats on their own.
