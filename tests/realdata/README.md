# Real-data FSRS check

Scores FSRS models on real Anki review logs, one user at a time, on reviews the model never saw (fit on the first 80% of the
days, judge on the last 20%). The aim: decide whether FSRS-7 should become the app's default.

Models: FSRS-6 with the default weights, FSRS-6 fitted by our optimizer (`fit`), FSRS-6 as the app would ship it (`fitChecked`,
which keeps the fit only if it wins), and FSRS-7 with its default weights. Reference fits by fsrs-rs, if present in
`~/fsrs-data/weights/<user>.<scenario>.json` as `{ "fsrs6": [21 numbers], "fsrs7": [34 numbers] }`, are scored as `fsrs6_rs` and `fsrs7_rs`.
Each user is run on the whole log (`full`) and on just their first 1000 and first 5000 reviews, to imitate a young collection.

## Licence: keep the data out of the repo

The dataset (open-spaced-repetition/anki-revlogs-10k on HuggingFace) is gated and must not be redistributed. Everything lives in
`~/fsrs-data` (override with the environment variable `FSRS_DATA`). Never copy it, or per-user results, into the repository.
The summary contains only aggregate numbers.

## Running it

1. Download a seeded sample of 300 users (needs Python with pyarrow in a virtual environment, and a HuggingFace token):

       python3 -m venv ~/fsrs-venv && ~/fsrs-venv/bin/pip install pyarrow
       HF_TOKEN=... ~/fsrs-venv/bin/python -I tests/realdata/fetch.py

   It can be stopped and started again; finished users are skipped.
2. Score the users (needs `npm install` once, for the ts-fsrs default weights and bounds):

       node tests/realdata/run.mjs [--users 1,2,3 | --limit N] [--jobs 4] [--out file] [--cap N]

   One JSON line per user is appended to `~/fsrs-data/results/results.jsonl`. Users already in the file are skipped, so it can be
   resumed. `--cap N` thins a user to N rows by whole cards (seeded by the user id); off by default, as even 776,000 rows takes under a minute.
3. Summarise: `node tests/realdata/summarize.mjs` writes and prints `~/fsrs-data/results/summary.md`.

The unit test, `tests/realdata.test.js`, runs in `npm test` on tiny made-up users and does not need the dataset.

## Reference fits by fsrs-rs (optional)

`rs-weights.mjs` trains FSRS-6 and FSRS-7 with the official Rust optimizer (npm `@open-spaced-repetition/binding`, tested with 0.6.0-beta.6)
on the same train half as `run.mjs` and writes `~/fsrs-data/weights/<user>.<scenario>.json` (`{ fsrs6, fsrs7, binding, settings }`; null where
training failed). `run.mjs` then also scores them as `fsrs6_rs` and `fsrs7_rs`. The package is not a dependency of this repo; install it in any folder:

    mkdir ~/fsrs-binding && cd ~/fsrs-binding && npm init -y
    npm i @open-spaced-repetition/binding@0.6.0-beta.6 @open-spaced-repetition/binding-linux-x64-gnu@0.6.0-beta.6

The second package is the native build for Linux x64 (npm did not pull it in by itself; without it the slower WASI build loads). The package says it
needs Node 24; Node 22 only prints an EBADENGINE warning and works. Then:

    FSRS_BINDING_DIR=~/fsrs-binding node tests/realdata/rs-weights.mjs [--users 1,2,3] [--jobs 4]
    node tests/realdata/run.mjs --out ~/fsrs-data/results/results-rs.jsonl
    node tests/realdata/summarize.mjs ~/fsrs-data/results/results-rs.jsonl ~/fsrs-data/results/summary-rs.md

Settings: enableShortTerm true, numRelearningSteps 1, default training config; FSRS-7 gets fractional days, FSRS-6 whole days. Existing weight
files are skipped. Training is single-threaded per fit and takes about 1 s per user for FSRS-6 and FSRS-7 together (300 users in 6 minutes on 4 workers).

## Things to know

- `long` reviews are the ones the app predicts (a later day than the card's last review). `same` are repeats on the same day.
  FSRS-6 has no real same-day prediction (the app uses learning steps); its `same` number uses the fractional gap on a curve made for days used at minutes, kept only for reference. The honest same-day yardstick is `base_rate`, a constant (the train half's recall rate for that set; AUC 0.5).
- Every results line is stamped with the code version (`git rev-parse --short HEAD`, `+dirty` if js/ or tests/realdata have uncommitted changes); summarize warns if a file mixes stamps. `run.mjs` only scores fsrs-rs weights whose `cutoff` and `headRows` match the current split. Results/weights paths inside the repo are refused.
- FSRS-7 sees fractional days between reviews (from `elapsed_seconds`), as the app does; FSRS-6 sees whole days.
