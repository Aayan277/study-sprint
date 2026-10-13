// Pooled recall at the next Review answer, by what last changed the card's schedule (mc / typing / review), per copy.
//   node nextrev.mjs <file.jsonl> [env filter key=value]
import { readFileSync } from 'node:fs';
const [,, file, filt = ''] = process.argv;
const f = filt ? filt.split('=') : null;
const acc = new Map();
for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
  const r = JSON.parse(l);
  if (f && String(r.env[f[0]] ?? '') !== f[1]) continue;
  const k = `${r.v} ${r.sc} ${r.le.split(':')[0]}`;
  const a = acc.get(k) || { mc: [0, 0], typing: [0, 0], review: [0, 0] };
  for (const s of ['mc', 'typing', 'review']) { a[s][0] += r.nextRev[s][0]; a[s][1] += r.nextRev[s][1]; }
  acc.set(k, a);
}
const ci = ([n, k]) => { if (!n) return '–'; const p = k / n; return `${(100 * p).toFixed(1)} ± ${(196 * Math.sqrt(p * (1 - p) / n)).toFixed(1)} (n=${n})`; };
console.log('| copy deck learner | after MC | after typing | after Review |\n|---|---|---|---|');
for (const [k, a] of [...acc].sort()) console.log(`| ${k} | ${ci(a.mc)} | ${ci(a.typing)} | ${ci(a.review)} |`);
