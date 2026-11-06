// Data source: a tiny made-up set kept in the repo (fixture.json: four learners, about 100 answers each, made once with the simulator). For tests.
import { readFileSync } from 'node:fs';

const learners = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

export default {
  id: 'fixture',
  licence: 'ours',
  node: true,
  browser: false,
  available: () => ({ ok: true }),
  describe: (opts = {}) => {
    const l = opts.split ? learners.filter(x => x.split === opts.split) : learners;
    return { learners: l.length, reviews: l.reduce((a, x) => a + x.logs.length, 0) };
  },
  *learners(opts = {}) {
    for (const l of learners) if (!opts.split || l.split === opts.split) yield structuredClone(l);
  }
};
