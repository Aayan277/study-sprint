# RWKV lab (a personal test build, never merged)

This branch (`claude/rwkv-lab`) tries a small neural memory model ("RWKV") next to Study Sprint's FSRS scheduler. It is for the
owner's own testing. It is **not** part of the app that ships: no pull request, no merge, no deployment.

## What is in this branch so far

- **Stage 0** (safety): the lab flag, the sync block, the ignore rules and a test that guards the rules below.
- **Stage 1** (the engine): code that reads the weights file, builds the model's inputs from the review log, runs the model, and turns
  its output into recall chances and intervals. Nothing in the app calls it yet (that is Stage 2).

## The rules (and the test that watches each one)

| Rule | Why | Checked by |
|---|---|---|
| The model weights, any dataset and any file of the model's own outputs are never committed. | The model's code and weights have no licence and its training data is restricted. | `tests/rwkv-guardrails.test.js`, `.gitignore` |
| Our test data holds only made-up inputs and numbers we computed ourselves. The model's answers on them live in `~/rwkv-lab-private/golden-expected.json`, outside the repo. | The answers are the model's output. | the same test, which also refuses output-looking keys in the fixture |
| The engine is written from the published description, not from the authors' code. The authors' Python reference is only run, from a path outside the repo, to get expected numbers. | Licence. | review, and `tools/rwkv-lab/make_golden.py` (imports the reference at run time) |
| Lab code makes no network requests. | The weights come only from the owner's own file. | `tests/rwkv-guardrails.test.js` (no `fetch(` and similar in `js/rwkv-*.js`) |
| Sync is off. Signing in or creating an account says "Sync is off in the lab build." | Lab due dates must never reach the real account. | the same test, plus `js/sync.js` |
| The main database keeps its shape (`DB_VERSION` stays 3) and no lab setting is in the synced settings. | The real app must still open this browser's data later. | the same test |
| FSRS stays the default and the fallback. | The lab can fail safely. | design (Stages 2 and 3) |

## Decisions about Study Sprint's data

Study Sprint has no Anki note ids or presets, so the lab maps its own data onto the model's five "streams":

- **card**: `c:` + the card id.
- **note**: `n:` + the note id when the card has one, otherwise the card is a note of its own.
- **deck**: `d:` + the card's deck id (the deck it is in now, for its whole history).
- **preset**: one shared preset, except a deck with its own options counts as its own preset.
- **user**: one constant.
- A review of a card that no longer exists gets its own note, deck `d:?` and the shared preset.
- Rows used: real reviews and imported Anki reviews, plus Play/test answers that changed the schedule. Resets do not cut the history.
- A new day starts at 4 am local time (same as Study Sprint's own rule, also on the days the clocks change).
- Each entity gets a fixed random-looking code from our own hash (FNV-1a, then mulberry32). Nothing needs saving for it.
- The calendar offset is 0.

### The `elapsed_days` check (done)

The question was whether the model's "days since this card's previous review" is simply the difference of the day numbers of the two
reviews. It is. In both example users of the package's test vectors (4,144 and 3,716 review rows) every review's value equals its day
number minus the day number of the same card's previous review, with no exceptions, and a "question" row carries the same values as the
review that follows it. So the lab uses `day - previous day of the card` (-1 on a card's first review), with days counted by the 4 am rule.
Nothing from those files is kept in the repo.

## How we know the engine is right

`tools/rwkv-lab/make_golden.py` makes a small made-up history (about 260 model rows over 150 days, 30 cards in 3 decks, sibling cards, same-day
relearns, reviews around 4 am and midnight, imported rows, applied Play answers, a deleted card), builds its inputs with an independently
written Python version of the rules, and runs the authors' reference on it. It writes:

- `tests/fixtures/rwkv/golden.json` (committed): the made-up history and our own computed inputs for 60 reviews and 20 questions. The
  test `rwkv-features.test.js` compares our JavaScript inputs with these (no weights needed).
- `~/rwkv-lab-private/golden-expected.json` (not committed): the model's answers and the weights fingerprint. `rwkv-model.test.js`
  reads it and **skips** when it or the weights file is missing (the weights are looked for in `RWKV_WEIGHTS`, else
  `~/rwkv-lab-private/weights.int8.bin`; `RWKV_PRIVATE_DIR` moves the folder).

Result with the owner's weights:

- **Exact state (stateBits 0):** largest difference 6.8e-6 on the curve numbers, 2.5e-6 on probabilities.
- **int8 state (stateBits 8):** the first 25 reviews agree to better than 1e-5. Later the largest difference is 7.9e-4 on curve numbers and
  8.6e-5 on probabilities (mean curve-number difference 3e-5). That is not a bug: with int8 state, a saved number can land on the other side of a
  rounding tie because the two programs add floating-point numbers in a slightly different order, and one step of one number then nudges later outputs. We
  checked this directly: making our own model's weights differ by one part in ten million changes its int8-state curve numbers by up to 1.2e-3 but its exact-state ones by only 2e-6.
  The test therefore uses the strict limits (5e-5 on probabilities, 1e-4 on curve numbers) for exact state and for the first 25 reviews with int8 state, and wider limits (3e-4 and 3e-3) for the whole int8 history.

## Speed (Node 22 on the build machine, one core)

| Step | Time |
|---|---|
| Load, convert and check the weights file | about 25 ms |
| One model step (question or what-if) | about 0.8 ms |
| One update step | about 0.85 ms |
| One review in the engine (question + update, int8 state) | about 1.9 ms |
| What-if for one card (4 steps) | about 3.3 ms |

Measured with `node tools/rwkv-lab/bench.mjs <weights file>`. A rebuild of 10,000 reviews should take roughly 20 seconds on a PC.

## Remaining stages

2: worker, Lab screen, shadow mode, rebuild, comparison. 3: opt-in RWKV scheduling. 4: how to run it.
