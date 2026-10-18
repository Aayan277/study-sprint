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

## Things to know

- `long` reviews are the ones the app predicts (a later day than the card's last review). `same` are repeats on the same day.
  FSRS-6 has no same-day curve; here it gets the fractional gap anyway, which flatters it.
- FSRS-7 sees fractional days between reviews (from `elapsed_seconds`), as the app does; FSRS-6 sees whole days.
