// Data source: the simulator (tools/own-model/sim.mjs). Ours, synthetic, made on the fly.
import { learners as simLearners } from '../sim.mjs';

const BASE = { train: 1, val: 10001, test: 20001, control: 30001 };
const COUNT = { train: 1600, val: 200, test: 200, control: 200 };

export default {
  id: 'sim',
  licence: 'ours',
  node: true,
  browser: false,
  available: () => ({ ok: true }),
  describe: (opts = {}) => ({ learners: opts.count ?? COUNT[opts.split || 'train'], reviews: null }),
  // opts: { split: 'train'|'val'|'test'|'control', seed (offset, default 0), count, plus any simulator config (effects, days, ...) }
  *learners(opts = {}) {
    const split = opts.split || 'train';
    if (!(split in BASE)) throw new Error(`Unknown split: ${split}`);
    const { split: _s, seed = 0, count = COUNT[split], ...config } = opts;
    if (split === 'control') config.world = 'fsrs';
    for (const l of simLearners({ ...config, count }, BASE[split] + seed)) yield { ...l, split };
  }
};
