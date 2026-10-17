// Runs harness2.mjs over a grid, 4 processes at a time, 10 seeds per process; appends JSON lines to <out>.
//   node run2.mjs <out.jsonl> <seeds> <copies,> <scenarios,> <learners,> '<JSON array of env objects>'
// Each result line carries its copy (v), scenario, learner and env, so summarize2.mjs can pair by seed.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const [,, out, seedsArg, vArg, scArg, lArg, gridArg = '[{}]'] = process.argv;
const seeds = +seedsArg, vs = vArg.split(','), scs = scArg.split(','), ls = lArg.split(','), grid = JSON.parse(gridArg);
const jobs = [];
for (const env of grid) for (const sc of scs) for (const le of ls) for (const v of vs)
  for (let f = +(process.env.SEED_FROM || 1); f <= seeds; f += 10) jobs.push({ v, sc, le, env, from: f, to: Math.min(seeds, f + 9) });
writeFileSync(out, '');
let i = 0, done = 0;
const runOne = job => new Promise((res, rej) => {
  const p = spawn('node', [path.join(here, process.env.HARNESS || 'harness2.mjs'), path.join(here, job.v), job.sc, job.le, String(job.from), String(job.to)],
    { env: { ...process.env, TZ: 'UTC', ...job.env }, cwd: here });
  let buf = '', err = '';
  p.stdout.on('data', d => (buf += d)); p.stderr.on('data', d => (err += d));
  p.on('close', code => {
    if (code) return rej(new Error(`${JSON.stringify(job)}: ${err}`));
    const lines = buf.trim().split('\n').map(l => { const r = JSON.parse(l); delete r.perDay; return JSON.stringify({ v: job.v, sc: job.sc, le: job.le, env: job.env, ...r }); });
    appendFileSync(out, lines.join('\n') + '\n');
    if (++done % 50 === 0) console.error(`${done}/${jobs.length}`);
    res();
  });
});
const t = Date.now();
await Promise.all([1, 2, 3, 4].map(async () => { while (i < jobs.length) await runOne(jobs[i++]); }));
console.error(`${jobs.length} jobs, ${((Date.now() - t) / 1000).toFixed(0)}s -> ${out}`);
