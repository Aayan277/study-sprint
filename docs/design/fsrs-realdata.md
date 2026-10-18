# FSRS on real Anki data: results (18 Oct 2026)

## The short answer

**Don't make FSRS-7 the default yet. Make it the default when we have an FSRS-7 optimizer.**

- With the weights tuned to each person, FSRS-7 is the best model we tested. It beats our tuned FSRS-6 for about 7 people in 10.
- But the app can only tune FSRS-6. FSRS-7 with its default weights is *worse* than our tuned FSRS-6 for about 2 people in 3. So switching now would make predictions worse for everyone who has pressed Optimize.
- For someone who has never tuned, FSRS-7 default is a little better than FSRS-6 default (about 2%). That alone is not worth a switch while FSRS-7 is still in beta (ts-fsrs 6.0 beta, fsrs-rs beta, Anki has not shipped it).
- Good news on the way: **our own FSRS-6 optimizer is as good as the official one** (fsrs-rs). No need to change it.

The FSRS-7 optimizer is planned for later (`docs/design/fsrs7-optimizer-plan.md`), once ts-fsrs 6.0 is out of beta.

## What was tested

- **Data:** 300 people picked at random (fixed seed) from the HuggingFace dataset `open-spaced-repetition/anki-revlogs-10k`: 22.9 million reviews. Each person in the dataset has at least 5,000 reviews. The data was kept outside the repository (the licence forbids sharing it).
- **The test, per person:** train on the first 80% of their days, then predict the last 20%, which no model saw. This is the same split the app's Optimize sheet uses.
- **Three sizes:** the whole history; only the first ~1,000 reviews (like a new student); only the first ~5,000.
- **Two kinds of review:**
  - *Long:* a review on a later day than the one before. This is what the scheduler is really about. **This is the main result.**
  - *Same-day:* repeats within one day (learning steps, cramming).
- **Scores:** *log loss* (how surprised the model is by what really happened; lower is better) is the main one. *AUC* (does it rank easy cards above hard ones; higher is better) and *RMSE* (are its percentages right on average; lower is better) are checks.

The models:

| Name in the tables | What it is |
|---|---|
| FSRS-6 default | FSRS-6 with the standard weights (what a new user gets today) |
| FSRS-6 app | What the app really does: Optimize with its keep rule (new weights only if they predict better), else the defaults |
| FSRS-6 tuned | Our optimizer (`js/fsrs-fit.js`) without the keep rule |
| FSRS-6 official | The same, tuned by the official fsrs-rs optimizer (to check ours) |
| FSRS-7 default | FSRS-7 with the standard weights (what the app's FSRS-7 switch gives today) |
| FSRS-7 official | FSRS-7 tuned by fsrs-rs (what an FSRS-7 optimizer could give) |
| Constant | Always guesses the person's average recall rate (a floor every model must beat) |

## Results: long reviews (the main result)

Average per person, log loss (lower is better):

| Model | Whole history | First ~1,000 | First ~5,000 |
|---|---:|---:|---:|
| Constant | 0.448 | 0.360 | 0.398 |
| FSRS-6 default | 0.417 | 0.334 | 0.374 |
| FSRS-7 default | 0.408 | 0.328 | 0.369 |
| FSRS-6 app | 0.397 | 0.329 | 0.359 |
| FSRS-6 tuned | 0.396 | 0.325 | 0.355 |
| FSRS-6 official | 0.398 | 0.323 | 0.354 |
| **FSRS-7 official** | **0.387** | **0.311** | **0.347** |

People counted: 300, 143 and 287. In the "first ~1,000" test, only people with at least 30 long reviews in their last 20% count, so it leans towards people who spread their first reviews over many days.

The comparisons that decide the question (difference in log loss, with a 95% range; "wins" = share of people where the first model is better):

| Comparison | Whole history | First ~1,000 | First ~5,000 |
|---|---|---|---|
| FSRS-7 default vs FSRS-6 default | −0.009 (−0.013 to −0.005), wins 62% | −0.006 (−0.012 to −0.001), wins 58% | −0.005 (−0.011 to +0.001), wins 56% |
| FSRS-7 default vs FSRS-6 app | **+0.011** (+0.005 to +0.016), wins 35% | −0.001 (−0.008 to +0.006), wins 51% | **+0.010** (+0.002 to +0.018), wins 38% |
| FSRS-7 official vs FSRS-6 app | **−0.010** (−0.015 to −0.006), wins 72% | **−0.018** (−0.027 to −0.009), wins 67% | **−0.012**, wins 63% |
| FSRS-6 official vs FSRS-6 tuned | +0.002 (−0.001 to +0.006) | −0.002 (−0.007 to +0.003) | −0.001 |
| FSRS-6 app vs FSRS-6 default | −0.020, wins 61% (kept the defaults for 25%) | −0.005 | −0.015 |

What this says, in plain words:
- **Tuning matters more than the model.** Tuning FSRS-6 gains about 5%. Switching from FSRS-6 to FSRS-7 with default weights gains about 2%.
- **FSRS-7 default loses to our tuned FSRS-6** on whole histories (about 2.6% worse; better for only 35% of people). For small collections they are even.
- **Tuned FSRS-7 wins everywhere:** about 2.6% better than the app's FSRS-6 on whole histories, about 5% better on small ones.
- **Our optimizer matches the official one.** The log loss differences are within noise in every test. The official one ranks cards very slightly better (AUC +0.006); ours is very slightly better calibrated (RMSE −0.0025).
- The app's keep rule works as meant: on whole histories it kept new weights for 224 of 300 people, and the result is almost as good as always keeping them (0.397 against 0.396).

AUC tells the same story (whole history): FSRS-6 default 0.685, FSRS-7 default 0.693, FSRS-6 app 0.697, FSRS-7 official 0.714.

## Results: same-day repeats

FSRS-6 cannot really predict these: the app uses learning steps instead, and its forgetting curve is made for days, not minutes. On same-day repeats it does worse than the constant guess (log loss 0.670 against 0.366). So the large "FSRS-7 beats FSRS-6" numbers here (about −0.35) mostly show that FSRS-6 doesn't try.

The fairer check is FSRS-7 against the constant guess: FSRS-7 default 0.323 and FSRS-7 official 0.309, against 0.366 (AUC 0.70 against 0.50). So FSRS-7 does tell something useful about same-day repeats. This matters for students who cram, and it is a second reason to want FSRS-7 once it can be tuned.

## Caveats

- **Everyone in the dataset has 5,000+ reviews.** The "first ~1,000" test imitates a new student, but these are people who went on to study a lot.
- **The default weights may have seen some of these people.** FSRS-7's defaults were tuned by its authors, probably on this same dataset, and FSRS-6's were pretrained on users 1 to 500 (16 of our 300). That flatters both default models slightly, by the same small amount.
- **RMSE is measured our way** (20 equal bins, as on the Optimize sheet), not with the official benchmark's bins, so it doesn't match the benchmark's published RMSE numbers. Log loss is the main score for that reason.
- **Rows marked "state 4"** (1.7%, most likely reviews in filtered decks) were kept, as the official benchmark does.
- **The FSRS-7 official weights come from a beta** (`@open-spaced-repetition/binding` 0.6.0-beta.6, default training settings).

These agree with the official benchmark's direction: there, FSRS-7 default (0.362) is also behind tuned FSRS-6 (0.346), and tuned FSRS-7 (0.340) is ahead.

## What to do

1. **Keep FSRS-6 as the default.** Keep the FSRS-7 switch as it is (opt-in).
2. **Later: build the FSRS-7 optimizer** (plan saved, `docs/design/fsrs7-optimizer-plan.md`). Start once ts-fsrs 6.0 is out of beta. It must match the official FSRS-7 weights on this test before it ships (the harness and the reference weights are ready).
3. **Then make FSRS-7 the default.**
4. No change is needed to our FSRS-6 optimizer, the 400-review unlock or gamma: they hold up on real data.

## How to repeat this

Everything is in `tests/realdata/` (see its README): `fetch.py` downloads the sample, `run.mjs` scores every person, `rs-weights.mjs` makes the official reference weights, `summarize.mjs` makes the tables. A full run takes about 15 minutes on 4 cores. The results behind this page: code version 5c0c375, `~/fsrs-data/results/summary-final.md` on the machine that ran it (not in the repository).
