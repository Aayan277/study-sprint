// Runs harness.mjs for every (version, scenario, learner) with N seeds, 4 at a time, and saves raw results.
//   node run.mjs <outFile.json> <seeds> <versions comma> [scenarios comma] [learners comma]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const [,, out, seedsArg = '30', versArg = 'v30,v31', scArg = 'A,A_easy,B10,B60,C,D,E1,E2,F1,F2,G,H1,H2', lArg = 'default,forgetful,strong'] = process.argv;
const seeds = +seedsArg, versions = versArg.split(','), scenarios = scArg.split(','), learners = lArg.split(',');
const jobs = [];
for (const sc of scenarios) for (const le of learners) for (const v of versions) {
  const chunks = sc === 'C' || sc === 'D' || sc === 'G' ? 3 : 1;
  const per = Math.ceil(seeds / chunks);
  for (let c = 0; c < chunks; c++) jobs.push({ v, sc, le, from: 1 + c * per, to: Math.min(seeds, (c + 1) * per) });
}
const results = [];
let i = 0;
const runOne = job => new Promise((res, rej) => {
  const p = spawn('node', [path.join(here, 'harness.mjs'), path.join(here, job.v), job.sc, job.le, String(job.from), String(job.to)], { env: { ...process.env, TZ: 'UTC' }, cwd: here });
  let buf = '', err = '';
  p.stdout.on('data', d => (buf += d));
  p.stderr.on('data', d => (err += d));
  p.on('close', code => {
    if (code) return rej(new Error(`${job.v} ${job.sc} ${job.le}: ${err}`));
    for (const line of buf.trim().split('\n')) results.push({ v: job.v, sc: job.sc, le: job.le, ...JSON.parse(line) });
    res();
  });
});
const worker = async () => { while (i < jobs.length) await runOne(jobs[i++]); };
const t = Date.now();
await Promise.all([1, 2, 3, 4].map(worker));
writeFileSync(out, JSON.stringify(results));
console.error(`${jobs.length} jobs, ${results.length} runs, ${((Date.now() - t) / 1000).toFixed(0)}s -> ${out}`);
