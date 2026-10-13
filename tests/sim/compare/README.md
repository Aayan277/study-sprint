# Scheduling simulator (compare two versions of the app)

Tests a scheduling change against simulated students **before** it ships, using each version's **real** code
(queue building, `srs.rate`, exam plan, Play auto-grading) over an in-memory database (`memdb.mjs`).

Each simulated student has a *true* memory (FSRS with its own weights: `default`, `forgetful`, `strong`, plus
per-card differences); every answer is drawn from that true recall, so the app's predictions can be wrong, as in
real life. Results are paired by seed, so version A and B see the same students.

Used for v3.1 (exam final pass: `report-v3.1.md`, which caught that 95%/5 days lost 1–2 points; 99%/3 days passed)
and v3.5 (Play speed calibration and multiple-choice cap: see PLAN.md "Algorithm follow-ups").

## Setup (once, outside git)

```
cd tests/sim/compare
npm install --no-save --prefix deps ts-fsrs@5.4.2
git -C ../../.. archive origin/main | (mkdir -p base && tar -x -C base)     # version A
# version B: your working copy, e.g.  mkdir -p new && cp -r ../../../js new/js
```

## Run

```
node --loader ./loader.mjs run2.mjs out.jsonl 30 base,new A,B10,B60,C,D,E1,E2,F1,F2,G,H1,H2 default,forgetful,strong
node summarize2.mjs out.jsonl base new
```

`harness2.mjs` / `harness3.mjs` are the scenario drivers (scenarios and learners are listed at the top of each);
`run.mjs` / `summarize.mjs` are the older v3.1 runner. Decide the pass rule **before** running, e.g. "mean exam-day
recall and long-run retention no worse than A by more than 0.3–0.5 points in any cell".

`deps/`, `base/`, `new/` and `*.jsonl` are not saved in git.
