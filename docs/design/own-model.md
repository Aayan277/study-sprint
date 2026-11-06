# Own: Study Sprint's own memory model

This page explains, in plain words, what the "Own" model is, what data it may learn from, and how we will decide whether it is any good. The definitions of "better" below were written before any training run, on purpose: if we only picked the yardstick after seeing the results, we could fool ourselves.

Status: lab only. FSRS stays the default scheduler and the fallback. Nothing here changes the main app.

## 1. What the model is

When you answer a card, the model tries to predict one thing: the chance that you will remember it after a given number of days. That chance falling over time is called a forgetting curve. A scheduler then asks: "on which day does the curve fall to your target (say 90 percent)?" That day becomes the interval.

Own has four small memories that read your reviews one at a time, oldest first:

- a card memory (32 numbers per card)
- a note memory (16 numbers; a note is a group of sibling cards, such as a reverse pair)
- a deck memory (16 numbers)
- a you memory (16 numbers)

A memory here is just a short list of numbers that gets updated after every answer. That is what "recurrent" means: the new list depends on the old list plus the newest answer.

**Time decay.** Between answers, the note, deck and you memories drift back toward a resting value. How fast is learned, one speed per number (from hours to months). The card memory does not drift, because the forgetting curve already handles time for a single card.

**The update (a gate).** After each answer the cell decides, for every number, how much to keep and how much to overwrite: `new = (1 - z) * old + z * candidate`. The gate `z` is between 0 and 1 and is computed from the answer and the current memories.

**The curve head.** A small network reads the memories and produces the shape of a forgetting curve: a mix of three power-law curves (one fast, one medium, one slow) and a ceiling. We force this shape so the curve always falls as time passes, which makes "find the day it hits 90 percent" well defined. A mix can show the fast-then-slow forgetting that a single curve cannot.

**Turning a curve into an interval.** We search (bisection: keep halving the range) for the day where the curve crosses the target. For the Hard, Good and Easy buttons we pretend each was pressed, update the memories, and read three curves.

**Size.** About 19,000 numbers (parameters) in total, under 128 KB, small enough to run on a phone.

### Features: the numbers the model sees per answer

18 numbers per answer, built from the review log:

- Context (known before you answer): time since this card, note, deck and you last answered; whether it is the first answer; whether it is the same study day; how many answers and lapses this card has; days since the card was first seen; how many answers today; the share of Again today; how many new cards started today.
- Outcome (known only after you answer): which button you pressed; how long you took; whether the row was a Play replay.

**Leakage rule.** The prediction may only use the context numbers. If the model could see the button you pressed, it would "predict" the answer by reading it. A test checks that changing the rating or time taken of the answer being predicted does not change the prediction.

The study day turns over at 4 am local time, like the rest of the app.

Real datasets without clock times: a row may carry its own `day` and `gapSec` (seconds since this card's previous answer). When present, these replace the values worked out from timestamps. The app's own rows never set them, so the app behaves as before.

### Training in plain words

- A gradient says "if I nudge this number up a little, how much does the error change?" Backpropagation computes all the gradients at once by walking the calculation backwards. `js/own-grad.js` does this and is checked against nudging each number by hand (finite differences).
- Adam is the step rule: it takes the gradient, smooths it over time, and scales each step per number.
- Fine-tuning on your own reviews uses a leash (an L2 pull toward the starting values) so a few thousand reviews cannot drag the model somewhere silly. Gradients are also clipped to a maximum overall size so one odd batch cannot blow up training.

## 2. Data rules

1. The licence of the real review dataset (anki-revlogs-10k, held locally in `~/fsrs-data`) allows research by students and individuals. The owner is a student doing their own research, so local training and evaluation on it are allowed.
2. Nothing derived from that dataset goes in the repo: no rows, converted files, per-user numbers, per-review predictions or weights trained on it. Converted data goes to `~/fsrs-data/own/`. Real-data weights and per-user reports go to `~/own-model-private/` (override with `OWN_PRIVATE`). The repo may hold aggregate numbers only, in this document.
3. Real-data weights reach the lab only through a file picker. They are never committed or shipped until the Anki team gives permission for in-app use. Synthetic-only weights (`js/own-params.js`, `trainedOn: ['sim-v1']`) may be committed.
4. The data is read only by code we write, and is treated as untrusted: Python runs with `python -I`, scripts live in the repo (never in the data folder), every field is bounds-checked (ratings 1 to 4, finite numbers, row and user caps, a size limit per file), and paths come from `FSRS_DATA` (default `~/fsrs-data`).
5. Browser model code never mentions the dataset. Only `tools/own-model/sources/anki10k.mjs` and `tools/own-model/data/convert.py` may.
6. Model code never uses the network.

`tests/own-guardrails.test.js` enforces these on every test run: the dataset names appear only in the two reader files and docs; no tracked `*.parquet`, `*.npz` or `*.own`; nothing tracked under `tools/own-model/out/` or `.cache/`; no tracked file in `tools/own-model/` over 200 KB; `js/own-params.js` has `trainedOn` exactly `['sim-v1']`, at most 128 KB and 25,000 parameters; no tracked file holds the `OWNMODEL1` model-file header followed by binary data; the trainer and evaluator refuse output paths inside the repo; and the main database stays at version 3.

Note on timestamps: the real dataset has days and card gaps, but not wall-clock times. Gaps between different cards (note, deck and you memories) inside one day are therefore approximate (made from answer durations, or 10 s when missing). Days and card gaps are exact.

## 3. What "better" means (fixed before any training run)

A model is only "better" against another model on exactly the same reviews. Scored reviews are: not a card's first answer, and at least one study day since its previous answer. Measures are log loss (lower is better; it punishes confident wrong predictions hard), RMSE over 20 probability bins (how far the predicted chances are from the real rates) and AUC (can the model rank remembered above forgotten). AUC is reported but never decides.

### Synthetic data (held-out simulated learners)

Compared: FSRS-6 default; FSRS-6 fitted per learner on their first 80 percent of days; Own pretrained; Own pretrained plus per-learner fine-tune on the same 80 percent. All are scored on the last 20 percent.

Own is "better" when the mean per-learner log-loss difference (Own fine-tuned minus FSRS-6 fitted) is below 0, and its 95 percent bootstrap confidence interval (2,000 resamples over learners, seeded) is entirely below 0, and RMSE is at most 0.01 worse.

Control world: simulated memory that follows FSRS-6 exactly. Own should come out about equal there (absolute difference at most 0.005 log loss). If it wins by more, suspect a leak and stop.

A win on synthetic data only proves the model can learn effects we put in the simulator. It says nothing about real people.

### Real data (the main research track)

Users are split by a hash before any training: `fnv1a('own-split|' + userId) mod 100`: 0 to 66 train, 67 to 79 validation, 80 to 99 test. The exact counts follow from the hash and will be recorded here. Inside each test user the split is by time, using the same cutoff as `splitHistories` (80 percent of scored reviews before the cutoff day). Test users are touched only by the evaluation script, never while choosing the model or settings; the number of times the test set has been run is recorded here.

Compared on the same scored later-day reviews after each user's cutoff: FSRS-6 default; FSRS-6 fitted on the user's train part; FSRS-6 with fsrs-rs reference weights (only when they match the split); Own with synthetic weights; Own with real weights, zero-shot (memory replayed through the train part, no learning); Own with real weights plus per-user fine-tune.

Own is "better" when the mean per-user log-loss difference (Own real plus fine-tune minus FSRS-6 fitted) is below 0, with a 95 percent bootstrap confidence interval over users (2,000 resamples, seeded) entirely below 0, and RMSE at most 0.01 worse. Also reported: the share of users improved, and results split by collection size (under 5k reviews, 5k to 50k, more), and Own with the you-memory switched off, so we can see what it adds.

### Your own reviews (in the lab, on your device)

Time-ordered split with the same cutoff rule. All models replay the whole history for state but learn only from before the cutoff. FSRS-6 is fitted on the train part only. Fewer than 50 holdout predictions or fewer than 1,000 scored reviews gives "Not enough reviews yet" and no verdict. The confidence interval is a bootstrap over cards (1,000 resamples). Own may schedule only after a "Better" verdict on your own reviews.

## 4. Results

None yet. Aggregate numbers and the git stamp of each run will be pasted here, whatever they are.

## 5. Honest expectations

- Synthetic wins are built in, because the simulator has effects FSRS cannot represent.
- With a few thousand reviews of your own, the intervals are wide. "Not better" or "Not enough data" will be common and correct.
- On real data, Own is likely better than FSRS-6 default, and uncertain against per-user fitted FSRS-6.
- Once Own schedules, its own gaps shape its future training data. FSRS fields stay current so you can switch back.
