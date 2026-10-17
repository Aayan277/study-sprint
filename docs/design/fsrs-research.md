# FSRS in Study Sprint: what we have, FSRS-7, and what to build next

## Summary for the owner

FSRS really has three parts. Study Sprint has all three in some form:

- **The scheduler:** the code that picks each card's next due date. We run it through the ts-fsrs 5.4.2 library (FSRS-6).
- **The optimizer:** it tunes the scheduler to one person's review history. Ours is our own JavaScript version, added in v4.10 to v4.14. It is careful: it only keeps new settings if they predict better on reviews it did not train on.
- **The helper tools:** postpone, review ahead, load balancing, easy days, catch-up after a break and sibling limits. Most of these exist. The missing ones are reschedule-all, steps stats, the "which retention should I pick" helper and a health check.

**Is there an FSRS-7? Yes.** It is real and almost ready.
- It now tops the official benchmark among FSRS models.
- The ts-fsrs library has a working beta (6.0.0-beta.14, 9 Oct 2026). I ran it locally.
- Anki is building it in now (issue #5688, opened 24 Sep 2026, "In progress"). Anki has not shipped it yet.

**What FSRS-7 changes:**
- It tracks a fast-fading memory and a slow-fading one, not a single "stability".
- It works in fractions of a day.
- It is the first FSRS that predicts same-day repeats properly. That matters for us, because students cram, use learning steps and do exam prep.

**Can we be "smarter than Anki"? Honestly, not by having a better per-card formula.**
- Once Anki ships FSRS-7, adopting FSRS-7 only gets us level with it.
- The only models clearly better than FSRS-7 are large neural networks (RWKV, about 2.8 million numbers) trained on thousands of users' data on servers. That is not practical for a static browser app.
- Our real edge is elsewhere, and Anki lacks most of it: exam-date planning, game answers that feed the schedule, retention and workload guidance, and clean data.

**Recommendation, in order:**
1. **Test our optimizer on real data first.** Our simulator cannot judge a new algorithm, because its "students" are FSRS-6 by construction.
2. **Cheap upgrades:** weight recent reviews more in the fit, and add a health check and better retention stats.
3. **A "pick your retention" helper** that shows reviews per day and exam readiness for each retention level.
4. **FSRS-7**, behind a switch, once ts-fsrs 6.0 is out of beta. Keep it only if the real-data test shows it is better.
5. **Experimental:** use game answers as weak evidence in the fit.

**Don't build:** per-deck parameters (the benchmark shows them worse), models based on answer time, card-text AI, or RWKV for now.

---

## Part 1: The FSRS toolkit compared with Study Sprint (each row checked in origin/main v4.14)

| Feature | Study Sprint | Gap | Value | Effort |
|---|---|---|---|---|
| FSRS-6 scheduler (fuzz, max interval, target retention) | Yes: `srs.js`, `sched-settings.js`; retention slider 80–97% globally and per deck (`decks.js`) | none | – | – |
| Learning and relearning steps, short-term memory | Yes (`enable_short_term: true`) | FSRS-6 predicts same-day repeats badly | High (via FSRS-7) | L |
| Optimizer | Yes, our own JavaScript: `fsrs-fit.js`, worker, `optimize-sheet.js`. Held-out keep rule, gamma 1000 (pull toward the defaults), unlocks at 400 reviews | Does not weight recent reviews more. Tuned only in the simulator | Medium | S |
| Evaluate (log loss, RMSE) | Partly: shown as before/after on the optimize sheet | No standalone "how well does it fit me" check | Low–Medium | S |
| Optimal retention / desired-retention simulator | No (grep finds no CMRR or retention simulator) | Missing | High | M |
| Optimal learning steps / steps stats | No | Missing | Low–Medium | M |
| Reschedule all cards with new parameters | No: the owner declined it (plan Q3) | New weights apply only from each card's next review | Medium | M (sync risk) |
| Postpone / advance | Yes: `postpone.js`, Review ahead (`aheadQueue`) | none | – | – |
| Load balancing and easy days | Yes: `balance.js` `pickDay`, plus rest days | none | – | – |
| Schedule a break | Partly: the "Back from a break" catch-up plan (`rescueOffer`) only works after the break | No planning before a break | Low | S |
| Disperse siblings | Partly: one cloze or occlusion card per note per day (`limitSiblings`), spread within a session | Due dates are not dispersed | Low | S |
| Flatten (cap future days) | Partly: review limits plus the catch-up plan | none needed | Low | – |
| Remedy Hard misuse | No | Missing | Low | S |
| Health check | No | Missing | Medium | S |
| Per-preset or per-deck parameters | No: one global set (by design) | Benchmark says not worth it (Part 2) | Low | – |
| Ignore cards reviewed before a date | No | Missing; helps after messy Anki imports | Low–Medium | S |
| True retention stats | Partly: due-review recall for the last 30 days (`stats-calc.js` `retention`) | No young/mature split and no comparison with the target | Medium | S |

## Part 2: The state of the art beyond FSRS-6

**FSRS-7**
- **What it is:** 34 parameters. Two memory traces (fast and slow). Fractional-day intervals. An 8-parameter forgetting curve. Optional recency weighting and "scheduling penalties".
- **In the benchmark:** srs-benchmark README, read 17 Oct 2026.
- **In ts-fsrs:** 6.0.0-beta.14 (MIT) ships `FSRS7Algorithm`, with 34 default weights and a `stabilityFast` field. I ran it: first Good gives 4.8 days, then about 10 days, then 43 days. It has no optimizer.
- **In fsrs-rs:** the `@open-spaced-repetition/binding` 0.6.0-beta.3 to beta.6 (22–29 Sep 2026) trains FSRS-7 by default. It still needs cross-origin isolation (special page headers), which GitHub Pages cannot send.
- **In Anki:** integration is in progress (#5688). A community fork already ships FSRS-7 builds (JSchoreels 26.09.3+fsrs7, 7 Oct 2026).

**Benchmark results** (about 10,000 Anki users; lower log loss and RMSE are better, higher AUC is better)

| Model | Params | Log loss (no same-day) | RMSE (bins) | AUC | Log loss (with same-day) |
|---|---|---|---|---|---|
| RWKV-Instant | 2.76M | 0.2773 | 0.0250 | 0.833 | 0.2660 |
| LSTM (uses answer time) | 8,869 | 0.3332 | 0.0538 | 0.733 | 0.3140 |
| GRU (pretrained) | 503 | 0.3328 | 0.0549 | 0.732 | 0.3141 |
| FSRS-7 + recency | 34 | 0.3370 | 0.0593 | 0.722 | 0.3178 |
| FSRS-7 | 34 | 0.3401 | 0.0634 | 0.717 | 0.3206 |
| FSRS-7 per-preset | 34 | 0.3401 | 0.0630 | 0.718 | 0.3206 |
| FSRS-7 per-deck | 34 | 0.3489 | 0.0719 | 0.710 | 0.3276 |
| FSRS-7 default params | 0 | 0.3620 | 0.0910 | 0.703 | 0.3399 |
| FSRS-6 + recency (fsrs-rs) | 21 | 0.3443 | 0.0635 | 0.707 | – |
| FSRS-6 | 21 | 0.3460 | 0.0653 | 0.703 | 0.3842 |
| DASH / ACT-R / HLR | 9 / 5 / 3 | 0.368 / 0.403 / 0.469 | – | – | – |

The README gives no compute costs. FSRS fits in seconds. RWKV is trained once on 5,000 users and tested on another 5,000; it is not fitted per user.

**What the numbers say:**
- On long-term reviews, FSRS-7 beats FSRS-6 by about 1.7% in log loss and about 3% in RMSE. On same-day repeats the gain is much bigger (0.384 to 0.321), because FSRS-6 is poor there.
- Personal tuning is worth more than any change of model: FSRS-7 default 0.362 against tuned 0.340.
- Weighting recent reviews more is a cheap gain of about 0.5–1%.
- **Per-deck parameters make predictions worse.** Per-preset parameters gain nothing.

**The other ideas, with their evidence:**
- **Answer time:** only the neural models use it. Expertium found the expected time-by-button order held for only about 40% of users, and calls time an unreliable stand-in for buttons. Low value.
- **Siblings and mix-ups:** RWKV uses sibling information, but there is no evidence for it inside FSRS. Treat it as a UX feature, not a model input.
- **Card text:** KARL (EMNLP 2024) used BERT on card text and improved AUC, but only on trivia with 27 online users. In a browser it would need about a 25 MB model. Unproven at scale.
- **Optimal retention:** Anki removed "compute minimum recommended retention", saying it has issues with FSRS-6. It now offers a simulator and a workload graph instead (Anki forums, 2025). A workload-against-retention view is the accepted answer.
- **Exam-aware scheduling:** Anki has nothing like it, and we already have it. This is our most defensible edge.
- **Play answers as weak evidence:** there is no outside data. We would have to validate it on our own exported logs.

## Part 3: Roadmap

| # | Build | Expected gain | Risk | Effort | How to validate |
|---|---|---|---|---|---|
| 1 | **Real-data check.** Download 100–300 users from HuggingFace `anki-revlogs-10k` and score `fsrs-fit.js`, the default weights and gamma choices on their logs. | Honest numbers. Probably re-tunes gamma 1000 and the 400-review unlock, which were tuned on simulated FSRS students | Licence: research use by students and individuals, no redistribution. The dataset is gated (log in and accept the terms). Keep it outside the repo and out of CI | M | Log loss and RMSE on held-out reviews per user, paired |
| 2 | **Cheap upgrades:** recency weighting in the fit loss; a health check (fit quality, true retention against the target, young/mature split); "ignore reviews before a date" | About 0.5–1% log loss (fsrs-rs row); better user trust | Low | S | Step 1's harness, plus existing unit tests |
| 3 | **Retention and workload helper:** reviews per day against target retention, plus exam-day readiness, using the person's own weights in a worker | Users pick sensible targets. This is where real time is saved | Medium: the simulator is FSRS-based, so treat it as relative guidance | M | `tests/sim/compare` (valid here, because it compares retention levels under a fixed model) |
| 4 | **FSRS-7**, behind a setting, after ts-fsrs 6.0 is stable. Port the 34-weight forward model and gradients into `fsrs-fit.js`; migrate cards to the new `stabilityFast` field | About 2% (long-term), up to 15% on same-day repeats | High: beta API, card-data migration and sync, a rewritten optimizer, parity tests | L | Step 1 data against the published numbers; parity test against ts-fsrs 6; the simulator only for workload |
| 5 | **Play answers as weak evidence:** score typed Play answers with a reduced weight in the fit | Unknown | Medium: could bias the fit | M | Owner and beta users' exported logs, held-out reviews only |

**Note on validation:** the simulator's "true memory" *is* FSRS-6 (`harness2.mjs` builds `TRUE` from ts-fsrs). That makes it good for UX and policy changes, such as retention, exam plans and load balancing. It can never show that a different model predicts better. Any claim like "FSRS-7 is better for our users" needs real data (step 1).

**Bottom line:** for a per-card model running in a browser, FSRS-7 is close to the practical ceiling. We can match Anki on the formula and beat it on planning, exams, games and data quality.

## Sources

- srs-benchmark README, read 17 Oct 2026: https://github.com/open-spaced-repetition/srs-benchmark
- Anki issue #5688, "Integrate FSRS7 into Anki" (24 Sep 2026): https://github.com/ankitects/anki/issues/5688
- FSRS-7 fork build (7 Oct 2026): https://github.com/JSchoreels/anki/releases/tag/26.09.3%2Bfsrs7.build.100
- ts-fsrs 6.0.0-beta.14 and @open-spaced-repetition/binding 0.6.0-beta.6, from the npm registry (inspected locally)
- Dataset, 727,738,650 reviews, about 15.7 GB, licence "other": https://huggingface.co/datasets/open-spaced-repetition/anki-revlogs-10k
- FSRS Helper add-on features: https://github.com/open-spaced-repetition/fsrs4anki-helper
- Expertium, "A short analysis of how review time is related to answer buttons" (no date on the page): https://expertium.github.io/Buttons.html
- KARL (EMNLP 2024): https://arxiv.org/abs/2402.12291
- Anki forums on the removal of "compute minimum recommended retention" and the simulator: https://forums.ankiweb.net/t/anki-25-06-beta/62271?page=2 and https://forums.ankiweb.net/t/playing-with-fsrs-simulator/63768
- Repo files read: `/home/user/study-sprint` origin/main (v4.14): `js/srs.js`, `js/sched-settings.js`, `js/fsrs-fit.js`, `js/balance.js`, `js/postpone.js`, `js/exam.js`, `js/queue.js`, `js/stats-calc.js`, `docs/design/fsrs-optimizer-plan.md`, `tests/sim/compare/report-optimizer.md`, `tests/sim/compare/harness2.mjs`. No repo files were edited. Scratch copies are in `/tmp/claude-0/-home-user-study-sprint/b156d69a-a765-5609-999d-2835cc7accb8/scratchpad/`.
