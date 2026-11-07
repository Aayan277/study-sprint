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

## 3b. How the model and engine are built (stage S3)

Two files: `js/own-model.js` (the network) and `js/own-engine.js` (remembers every card, note, deck and you, and answers "what is the chance?").

**One answer, step by step.**

1. The note, deck and you memories relax toward their resting vector by the time that passed since each was last used.
2. Prediction: the head reads the four memories plus context features 3 to 11 and draws the curve. The curve is read at the card's real gap in days. This number is what the loss is measured on, and it never sees the button, the time taken or the replay flag.
3. Update: the cell reads all 18 features plus the four (relaxed) memories and rewrites all four memories at once.

**Two copies of the same recipe.** The app uses plain loops (fast, states stored as 32-bit floats). Training uses the tape from `own-grad.js` (it can walk backwards to get gradients). Tests check that they agree to 1e-6, and check the tape's gradients against nudging numbers by hand through a chunk of a made-up history (3 cards, 2 decks).

**Training in chunks (TBPTT).** A learner's history is cut into chunks of events. Inside a chunk gradients flow through every step. Between chunks the memories are carried over as plain numbers, so no gradient crosses a chunk border (that is the "truncated" part, and it keeps memory use small). `trainChunk` returns the summed BCE loss over the scored answers; a card's first answer is not scored.

**Choices worth knowing.**

- After an answer, the engine saves the card's curve: it is the head read on the new memories with the same context features the answer had. `whatIf` does exactly this for each of Again, Hard, Good, Easy (without changing anything), so a what-if curve equals the curve a real answer would leave behind (a test checks this).
- Starting values: gates start mostly closed (bias -1), resting vectors start at 0, memory times are log-spaced from 0.05 to 100 days, the curve starts with a ceiling near 0.9 and stabilities of 0.5, 5 and 50 days. All from a seed.
- Saved per card: 32 float32 numbers plus 10 curve numbers (168 bytes). Note, deck and you: 16 float32 numbers each.
- Undo keeps the previous arrays and the previous feature counters, so undoing gives back the exact bytes (tested).

**Speed** (`node tools/own-model/bench.mjs`, Node v22.22.0, one core of the build machine, 20,000 made-up answers over 1,500 cards; a guide, not a test):

| Size | Parameters | Per review | Per what-if (4 curves) | Training speed (forward and backward) | Saved state (1,500 cards, JSON) |
|---|---|---|---|---|---|
| s (ships) | 19,178 | 0.07 ms | 0.19 ms | 6,200 answers/s (about 160 s per million answers) | 598 KB |
| m (research) | 63,306 | 0.15 ms | 0.53 ms | 2,600 answers/s (about 390 s per million answers) | 912 KB |

Both are well inside the guide (review at most 0.5 ms, what-if at most 2 ms).

## 3c. Training and evaluation tools (stage S5)

Everything runs in Node, using the same JavaScript as the app, so there is nothing to port and nothing to keep in step. All commands are in `package.json`:

| Command | What it does |
|---|---|
| `npm run own:train` | trains on made-up learners (`tools/own-model/train.mjs --source sim`) |
| `npm run own:train:real` | trains on the real logs (`--source anki10k`); needs the converted data folder |
| `npm run own:eval` | judges a model on held-out made-up learners and on the FSRS-world control |
| `npm run own:eval:real` | judges a model on the real test users |
| `npm run own:all` | the whole made-up track: simulator report, training, evaluation, then writes `js/own-params.js` if it is allowed to ship |

Pass options after `--`, for example `npm run own:train:real -- --cap 20000 --epochs 6`. `--help` on `train.mjs` and `eval.mjs` lists every option.

**How a training run works, in plain words**

- Each learner's history is cut into chunks of 128 answers. The trainer runs 16 learners side by side; at every step each one runs its next chunk, the 16 gradients are averaged over the answers that were scored, and Adam takes one step (learning rate 3e-3 falling to 3e-4 on a cosine curve, gradient length clipped to 1, a tiny pull of 1e-5 towards 0). When a learner is finished the next one moves in.
- `--workers N` splits those 16 learners over N worker threads. They share the parameters in shared memory, each writes its gradients into its own slot, and the main thread adds the slots up in slot order. Adding in a fixed order makes the result the same for any N (a test checks 1 against 2 workers). Results can still differ in the last bits between Node versions, because `Math.exp` may differ.
- After every epoch the model is scored on a fixed, seeded subset of validation learners (24 users, at most 20,000 rows each for the real data; later-day scored answers only). The best epoch's parameters are kept, and training stops early when the validation loss has not improved for 2 epochs.
- A checkpoint (parameters, Adam memory, the best model so far, history) is written next to `--out` after every epoch (`<out>.ckpt`). Stop the run any time and start the same command again with `--resume`; a test checks that stop-and-resume gives exactly the numbers of an uninterrupted run. A checkpoint made with other settings is refused.
- `--users-per-epoch N` trains each epoch on a different seeded subset of N train users, which makes an epoch short without ever dropping a user for good. `--cap N` limits one user to N rows, thinned by whole cards (seeded by the user id).
- `--init FILE.own` continues from a model, for example the made-up-learner model and then real data (`trainedOn` then lists both).
- `--ablate=user,note,deck,decay` switches parts off by freezing them (a stream is frozen shut at its resting vector; `decay` freezes the memory times at about 27,000 years). The model file records which were off, and fine-tuning in the evaluation keeps them frozen. This is how we see what each part buys.
- `--size m` trains the bigger research model (63,306 parameters; 2.4 times slower).
- The trainer and evaluator refuse to write inside the repo (`insideRepo`). Without `--out`, files go to `~/own-model-private/` (override with `OWN_PRIVATE`): `own-sim-v1.own`, `own-real-v1.own`, `own-simreal-v1.own`, each with a `.run.json` (settings, git stamp, per-epoch history, sha256 of the parameters).

**The model file (`.own`, `js/own-file.js`).** The marker `OWNMODEL1`, a whole number for the header length, a JSON header (`arch`, `size`, `sizes`, `paramCount`, `featureVersion`, `trainedOn` with a licence per source, `seed`, `gitStamp`, `createdAt`, plain notes in `info`), then the parameters as 32-bit floats. The reader treats the file as untrusted: at most 2 MB, header at most 16 KB and must parse, memory sizes and parameter count must match `own-spec` for the stated size, every number finite, nothing after the last parameter. Errors are in plain English ("This isn't an Own model file.", "This model was made for a different app version."). The same code will serve the lab's file picker later.

**How the evaluation works.** For each held-out learner the evaluator makes the time split (80 percent of the later-day scored reviews before the cutoff day, like `splitHistories`) and scores every model on exactly the same reviews after the cutoff: FSRS-6 with default weights; FSRS-6 fitted by `fit` on the train part; FSRS-6 fsrs-rs reference weights, only when they were made for this very split (same cutoff and train-row count, so users that are capped usually do not match); Own zero-shot (the memory replays the whole history but nothing is learned from the user); and Own plus a per-user fine-tune (Adam, learning rate 1e-3, a leash of 1e-3 pulling the weights back towards the starting model, at most 4 epochs, early stop on the last 10 percent of the train days, with epoch 0 meaning "no change" so fine-tuning can never end worse than it started on those check days). On real data it also scores the shipped made-up-learner weights and any `--extra "label=file"` models (for example one trained with `--ablate=user`).

- The FSRS rows were checked against the existing `tests/realdata` results: for users that are not capped, cutoff day, number of held-out reviews and log loss agree to four decimals.
- **RWKV reference.** `~/fsrs-data/rwkv-preds/<user>.npz` holds, per user, `p_curve` and `p_imm` (one number per row of the user's data file, empty on a card's first answer) and `n` (the row count). The reader (`npz.mjs`) is ours and refuses anything unusual. The evaluator uses a user's predictions only if they line up with the rows: the row count must match, nearly all rows that surely get a prediction must have one, and nearly all first answers must have none. Otherwise the user is reported as "present but not used" and nothing is guessed. Predictions are read for the same later-day reviews the other models are scored on, and the report shows Own against RWKV on exactly those users. The files exist for 29 users, 8 of them in the test group.
- **The verdict is the one written down in section 3.** For the per-user log-loss differences (Own fine-tuned minus FSRS-6 fitted, users with at least 50 held-out reviews) the report gives the mean, a 95 percent bootstrap interval (2,000 resamples over users, seeded), the share of users improved, and the RMSE difference (limit +0.01 on average per user). "BETTER" needs the whole interval below 0 and the RMSE limit met. It also shows Own against FSRS-6 default, fine-tune against zero-shot, results by collection size (under 5k, 5k to 50k, over 50k reviews of the user, before any cap), users with note and deck information against users without, same-day reviews separately, and in the FSRS-world control whether Own and FSRS-6 agree within 0.005.
- Per-user records go to `~/own-model-private/results/<tag>.jsonl` (resumable with the same `--tag`), the aggregate report to the screen and `summary-<tag>.md`. Runs on the real test users are counted in `results/test-runs.json`; `--split val` is for choosing settings.

## 4. Results

Every number below is an aggregate. Per-user numbers, model files trained on the real data and per-review predictions stay in `~/own-model-private` and are never committed. Code version of the runs: git head b4e214f plus the uncommitted stage S5 files (the stage S5 commit contains exactly the code that ran; the small edits made after the sim run only moved a dataset id string and added `--help`).

### Simulator track (`npm run own:all -- --learners 500 --epochs 6 --days 40,150`, 27 minutes on 4 cores)

Training: 500 made-up learners (seeds 1 to 500, 40 to 150 days of study, 1.95 million answers per epoch), 6 epochs of about 3 minutes each at about 10,000 answers per second, batch 16 learners, validation on 16 other learners. Validation log loss: 0.656 before training, 0.227, 0.217, 0.221, 0.215, 0.218 and 0.214 after the six epochs; the last was the best and became the model (19,178 parameters, committed as `js/own-params.js`, sha256 244883530cfe, `trainedOn: ['sim-v1']`, 102,797 bytes).

Evaluation on 200 held-out made-up learners (seeds 20001 to 20200) and 200 control learners whose memory is exactly FSRS-6 (seeds 30001 to 30200). Each learner is split by time; all rows are scored on the same later-day reviews after the cutoff. Log loss is the mean per learner (lower is better).

| Model | Own world: log loss | RMSE | AUC | Control world (memory is FSRS-6): log loss | RMSE | AUC |
|---|---|---|---|---|---|---|
| FSRS-6 default | 0.3068 | 0.0924 | 0.505 | 0.4048 | 0.0533 | 0.571 |
| FSRS-6 fitted on the train part | 0.2724 | 0.0544 | 0.633 | 0.4045 | 0.0526 | 0.569 |
| Own, zero-shot | 0.2515 | 0.0569 | 0.684 | 0.4567 | 0.1104 | 0.494 |
| Own + per-learner fine-tune | 0.2490 | 0.0533 | 0.684 | 0.4330 | 0.0954 | 0.510 |

(91,675 held-out later-day reviews in the own world, 98,498 in the control; the simulator's oracle, a predictor that knows the hidden truth, scores 0.2225 on 24 other learners, FSRS-6 default 0.2801 there.)

| Comparison (mean per-learner difference, below 0 is better) | Own world | Control world |
|---|---|---|
| Own + fine-tune minus FSRS-6 fitted (the pre-registered test) | -0.0236, 95% interval [-0.0263, -0.0207], RMSE difference -0.0016, 183 of 199 learners improved: **BETTER** | +0.0286, [+0.0253, +0.0319], RMSE +0.0428, 5 of 200 improved: not better |
| Own zero-shot minus FSRS-6 default | -0.0554, [-0.0602, -0.0507] | +0.0519 |
| Own + fine-tune minus Own zero-shot | -0.0025, [-0.0037, -0.0015] | -0.0237 |

By collection size (own world): under 5k reviews (114 learners) -0.0239, 5k to 50k (85 learners) -0.0231; no simulated learner had more than 50k reviews.

What this says, honestly:

- In the own world Own wins clearly and the pre-registered test passes. This only shows that the model and training can learn the effects we put into the simulator (siblings, interference, drift, bad days, answer time); it says nothing about real people.
- In the control world Own does not match FSRS-6: it is worse by 0.029 even after fine-tuning (the pre-registered "about equal within 0.005" check is not met). It is not a leak (Own is worse, not better). The reason is that this model was trained only on own-world learners, so its curves have the wrong shape for FSRS memory, and a 4-epoch fine-tune on a few thousand reviews cannot fully repair that. A mixed training set (both worlds) would be the fix if the control must pass; we did not try it because the time budget was used up.
- Fine-tuning helps a little in the own world and a lot in the control world, which is what a leash plus early stopping should do.

### Real data (stage S5 smoke run only: not a result)

The full real-data training is run separately. This only proves the pipeline end to end, and its numbers must not be quoted as results. Settings: size s, 100 train users in one epoch, cap 20,000 rows per user, 24 validation users (cap 20,000), then evaluation on the first 40 test users (cap 40,000 rows per user; this counts as test-set run number 1). Code version b4e214f plus the stage S5 files.

- Training: 1.37 million answers, one epoch in 1 min 42 s (110 s with validation), validation log loss 0.711 before and 0.319 after.
- Evaluation of 40 users took 211 s with 4 jobs (about 21 s per user including the FSRS-6 fit and the fine-tune).
- Held-out later-day reviews: 102,141 over 40 users. Mean per-user log loss: FSRS-6 default 0.4123, FSRS-6 fitted 0.3955, Own zero-shot 0.3719, Own + fine-tune 0.3538 (RMSE 0.0792 against 0.0934; AUC 0.761 against 0.694). Own + fine-tune minus FSRS-6 fitted: -0.0417, interval [-0.0626, -0.0219], 33 of 40 users improved. The made-up-learner weights alone scored 0.5502 on real users (clearly worse than FSRS). These 40 users are too few and the model had one short epoch; read this only as "the pipeline runs and the direction is plausible".
- Reference rows worked: fsrs-rs weights matched the split for 5 of the 40 users (the others are capped or have no weights), and RWKV predictions lined up with the rows for 2 users (both checks passed: same row count, every row with an earlier answer has a prediction, every first answer has none). On those 2 users, mean log loss: Own + fine-tune 0.3275, Own zero-shot 0.3239, RWKV 0.3366, FSRS-6 fitted 0.3397.

### Speed on real data (4 workers on the 4-core build machine, node v22.22.0, one epoch over 32 random train users)

| Size | Cap | Answers per second | Projected epoch over all 1,345 train users |
|---|---|---|---|
| s | 10,000 | 15,300 | 12.7 M answers, about 14 min |
| s | 20,000 | 15,400 | 22.2 M answers, about 24 min |
| s | 40,000 | 13,400 | 35.9 M answers, about 45 min |
| m | 10,000 | 6,800 | about 31 min |
| m | 20,000 | 6,800 | about 54 min |
| m | 40,000 | 5,500 | about 109 min |

Loading and parsing user files is included (it is a few percent). Validation (24 users, cap 20,000) adds about 30 to 60 seconds per epoch.

### Recommended settings for three parallel real-data runs (each on its own 4-core machine, finishing in about 3 hours of training plus 35 minutes of evaluation)

| Variant | Flags (add `--out ~/own-model-private/own-real-VARIANT.own`) | Per epoch | Total |
|---|---|---|---|
| A: baseline, size s | `--cap 40000 --users-per-epoch 400 --epochs 12` | 10.7 M answers, about 14 min | about 2.9 h |
| B: bigger model, size m | `--size m --cap 20000 --users-per-epoch 300 --epochs 14` | 5.0 M answers, about 13 min | about 3.0 h |
| C: pretrain on made-up learners, then real | first `npm run own:train -- --sim-train 500 --epochs 6 --sim-days 40,150` (about 18 min), then `--init ~/own-model-private/own-sim-v1.own --cap 40000 --users-per-epoch 400 --epochs 10` | about 14 min | about 2.8 h |

To see what the you-memory adds, run A again with `--ablate=user --epochs 6` (about 1.5 h) and pass it to the evaluation with `--extra "Own, no you-memory=FILE"`. All runs can be stopped and continued with `--resume`. Use `--split val` for any comparison between variants and keep the test split for the one model you report.

### Data conversion (aggregate counts only, stage S4)

- The raw files have these columns: `card_id, day_offset, rating, state, duration, elapsed_days, elapsed_seconds` (all whole numbers; `duration` is the answer time in milliseconds, `elapsed_seconds` is -1 on a card's first answer). There is no note, deck or preset column in them.
- Note, deck and preset ids exist only in the separate meta files: `cards-<u>` has `card_id, note_id, deck_id`, and `decks-<u>` has `deck_id, parent_id, preset_id`. Those were first fetched for 36 users; the full set was fetched later (below).
- Converted: 2,004 users and 141.6 million rows. Every user has answer times. After the meta tables arrived and the data was converted again (`convert.py --force`), 1,987 users (99.2%) have note and deck ids (17 users' cards tables cannot be downloaded) and decks tables exist for all 2,004. No row or file was dropped by the checks (0 bad rows, 0 bad elapsed or duration values, 0 files refused, 0 users with days going backwards).
- By the hash rule the 2,004 users split into 1,345 train, 269 validation and 390 test.
- The 17 users without cards tables keep "note = card, deck = unknown"; results are reported with and without such users.
- A first reading of 200 of the users with the source (cap 40,000 rows each) gave 5.3 million rows, of which 2.9 million are later-day ("long") reviews and 1.5 million same-day ones.

## 5. Honest expectations

- Synthetic wins are built in, because the simulator has effects FSRS cannot represent.
- With a few thousand reviews of your own, the intervals are wide. "Not better" or "Not enough data" will be common and correct.
- On real data, Own is likely better than FSRS-6 default, and uncertain against per-user fitted FSRS-6.
- Once Own schedules, its own gaps shape its future training data. FSRS fields stay current so you can switch back.

## 6. Test data: the simulator and the data sources

### The simulator (`tools/own-model/sim.mjs`, `npm run own:sim`)

It makes made-up learners who study like an Anki user with FSRS-6 default scheduling, and writes Study Sprint log rows. The hidden truth (`truth`) lives next to the rows, never inside them.

- **Hidden memory.** Every card has a fast trace (about 1 day) and a slow trace (about 30 days). A success adds to the slow trace, more when the recall was hard (the spacing effect). A failure shrinks the slow trace. This is not FSRS on purpose.
- **Six switchable effects FSRS cannot see:** `siblings` (cards of one note share difficulty and prime each other), `interference` (answering a card weakens the other cards of a hidden confusion group), `drift` (the learning gain wanders from day to day, with exam-term steps), `badDays` (a two-state chain of normal and bad days that lowers recall), `answerTime` (slower answers when recall was less likely), and `schedNoise` (days off, a backlog, late and off-schedule reviews).
- **Control world** (`world: 'fsrs'`): memory follows FSRS-6 exactly with weights jittered per learner. No model should beat FSRS-6 there.
- **Oracle:** `sim-report.mjs` prints the log loss of a predictor that knows the truth, next to a constant guess and FSRS-6 default. The gap is the most any model could gain.
- Settings I chose where the plan left room: card difficulty has a share that belongs to the note (0.5) and a per-deck offset; the success gain is proportional to (1 + current slow trace) so the traces can grow into months; the base logit is around 2.5 and the gain about 2.5 so that recall lands near 87% under FSRS scheduling. With the plan's 5 to 20 new cards a day over 60 to 400 days a learner has about 24,000 reviews, not 1,900, so the trainer should choose `days` and `count` itself.

### Data sources (`tools/own-model/sources/`)

Each source is `{ id, licence, node, browser, available(), describe(), *learners() }`; splits are by learner.

- `sim`: the simulator (seeds 1.., 10001.., 20001.., control 30001..).
- `fixture`: four tiny made-up learners kept in the repo, for tests.
- `anki10k`: real logs, from a folder outside the repo (`FSRS_DATA`, default `~/fsrs-data`). Used only when asked for and when the folder exists; otherwise skipped cleanly. It reads `own/users/<u>.json` (made by `data/convert.py`, with answer time, note, deck, preset) and falls back to `users/<u>.json` (six basic columns). The converted file wins when both exist, because it holds the same rows plus more columns. Every user file that exists is used. Each file is checked (types, ranges, equal lengths, row and size caps, no unknown columns) and refused whole if anything is wrong.
- The data has days but no clock. Rows get a made-up clock (day at 04:00 plus the running answer times of that day, 10 s when unknown); only the gaps between different cards, notes and decks use it. A card's own gap comes from `elapsed_seconds` minus the current answer's own duration (when known; `--legacy-gap` keeps the old value) and its study day from `day_offset` (the `gapSec` and `day` overrides in `js/own-features.js`). The subtraction is needed because `elapsed_seconds` runs to the end of the answer being predicted, so the raw value would hide how long the person took on it, and slow answers go with forgetting: the outcome would leak into the input. Unknown answer times read as the neutral 8,000 ms.
- Rules as in `tests/realdata/lib.mjs`: ratings 1 to 4; a state-0 row after earlier rows is a reset (the card gets a new life `c<id>~2`, the note, deck and user memories carry on); only the last life of a card is scored, and only if it starts at state 0. Rows that are not scored carry `scored: false` and still update the memories. `rowsOf()` adds `dDays` (whole days since the card's previous row): later-day ("long") rows have `dDays > 0`, same-day rows 0.
- Split by learner: `fnv1a('own-split|' + id) mod 100`: 0 to 66 train, 67 to 79 validation, 80 to 99 test. A per-user cap (default 40,000 rows) thins by whole cards, seeded by the user id.
- `data/convert.py` turns raw files into the converted ones (resumable, refuses folders inside the repo, drops bad rows and counts them).

## 7. How to train on another machine

For a fresh cloud session (Linux, Node 22, Python 3, at least 4 cores, about 12 GB of free disk, 8 GB of memory). Every step is copy-paste. The data never goes into git: it lives in `~/fsrs-data`, results in `~/own-model-private`.

**1. Get the code and install it** (the clone lands in `~/study-sprint` if you run it from your home folder)

```
cd ~
git clone --branch claude/own-model --single-branch https://github.com/Aayan277/study-sprint.git
cd ~/study-sprint
npm install
node --version
```

`node --version` should print v22 or newer. `npm install` only fetches the FSRS reference package that the default weights come from.

**2. Python tools that read the dataset files (once)**

```
python3 -m venv ~/fsrs-venv
~/fsrs-venv/bin/pip install pyarrow
```

**3. Your HuggingFace token (once per session; type it, never paste it into a file or commit it)**

```
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
```

**4. Download the 2,004 users (the two commands reproduce exactly the set the results in this page are about: the first 300-user sample plus the 2,000-user sample, 4 users apart)**

```
~/fsrs-venv/bin/python -I tests/realdata/fetch.py --n 300 --meta
~/fsrs-venv/bin/python -I tests/realdata/fetch.py --n 2000 --meta
```

It can be stopped and started again; finished users and tables are skipped. A few users have no cards table in the dataset: they print "download failed" and are used without note and deck ids. It takes a while (about 2.5 GB of review logs). The token is read from the environment and never printed.

**5. Convert to the files the trainer reads**

```
~/fsrs-venv/bin/python -I tools/own-model/data/convert.py
```

Expected end of the output: `done: {"users": 2004, "refused": 0, ...}`. It can be resumed; add `--force` to convert users again (for example after more meta files arrived). Check what the trainer sees:

```
node -e "import('./tools/own-model/sources/anki10k.mjs').then(m => console.log(m.default.describe({})))"
```

It should print 2004 learners with `split: { train: 1345, val: 269, test: 390 }`.

**6. A one-minute check that everything works (a tiny run; the model it makes is useless)**

```
node tools/own-model/train.mjs --source anki10k --users-per-epoch 8 --epochs 1 --cap 5000 --val-users 2 --val-cap 3000 --out ~/own-model-private/check.own
```

It should print a start line, one epoch line and `done`.

**7. The real run.** Run it in the background so a dropped connection does not stop it, and watch the log:

```
cd ~/study-sprint
nohup node tools/own-model/train.mjs --source anki10k RUN_FLAGS --out ~/own-model-private/own-real-VARIANT.own > ~/own-model-private/VARIANT.log 2>&1 &
tail -f ~/own-model-private/VARIANT.log
```

Replace `RUN_FLAGS` and `VARIANT` with the flags of the variant (section 7.1 below). Progress lines show the percentage, answers per second and the estimated time left for the epoch and for the run. If the session stops, run the same command again with `--resume` added (the checkpoint is `<out>.ckpt`).

**8. Judge it on the test users.** `--split val` is for trying settings; the test split is the real exam and is counted (`results/test-runs.json`), so use it only for the model you mean to report:

```
node tools/own-model/eval.mjs --source anki10k --model ~/own-model-private/own-real-VARIANT.own --jobs 4 --tag VARIANT
```

It prints the aggregate report and saves it as `~/own-model-private/results/summary-VARIANT.md`. If a comparison model exists (`--extra "Own, no you-memory=~/own-model-private/own-real-nouser.own"`), it appears as a row.

**9. Copy the result back.** Only aggregate numbers may go into the repo or into chat; the model file itself is small and may be moved by hand (never committed: git refuses `*.own`):

```
cat ~/own-model-private/results/summary-VARIANT.md
sha256sum ~/own-model-private/own-real-VARIANT.own
base64 -w0 ~/own-model-private/own-real-VARIANT.own
```

Paste the output of `base64` on the other machine into `echo '...' | base64 -d > own-real-VARIANT.own` and compare the `sha256sum` of the two files (it must be identical). `~/own-model-private/own-real-VARIANT.own.run.json` has the settings, git stamp and per-epoch history of the run. Per-user results (`results/*.jsonl`) stay on the machine that made them.
