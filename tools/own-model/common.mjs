// Shared helpers for the training and evaluation tools. Node only. Nothing here reads real review data itself.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { insideRepo } from '../../tests/realdata/lib.mjs';
import { paramOffsets, DECAY_STREAMS } from '../../js/own-spec.js';
import { mulberry32 } from '../../js/fsrs-fit.js';
import { fnv1a } from '../../js/rwkv-features.js';
import { getSource, rowsOf } from './sources/index.mjs';
import { SIM_VERSION } from './sim.mjs';

export { insideRepo };

// ---------- where things go ----------
// Model files and reports made from real data go OUTSIDE the repo: ~/own-model-private (override: OWN_PRIVATE).
export const privateDir = () => process.env.OWN_PRIVATE || join(homedir(), 'own-model-private');
export function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir; }

// Throws (never exits) when an output path is inside the repo.
export function refuseInsideRepo(label, p) {
  if (insideRepo(p)) throw new Error(`Refusing: ${label} (${resolve(p)}) is inside the repo. Models and results made from review data must stay outside it (default: ${privateDir()}).`);
  return resolve(p);
}

// The code version a number comes from: short git hash, +dirty when js/ or tools/own-model have uncommitted changes.
export function gitStamp() {
  try {
    const sh = (...args) => execFileSync('git', args, { cwd: new URL('../..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return sh('rev-parse', '--short', 'HEAD') + (sh('status', '--porcelain', '--', 'js', 'tools/own-model', 'tests/realdata') ? '+dirty' : '');
  } catch { return 'unknown'; }
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const sha256OfParams = params => { const f = Float32Array.from(params); return sha256Hex(new Uint8Array(f.buffer)); };

// ---------- seeded shuffles ----------
export function shuffled(list, seedText) {
  const a = list.slice(), rng = mulberry32(fnv1a(seedText));
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- which rows count ----------
// Real data marks rows that update the memory but are not scored with row.scored === false. Sim rows have no such mark.
// 'long': a later study day than the card's previous answer (what the app predicts). 'same': the same day.
export const isLong = row => row.scored !== false && row.dDays > 0;
export const isSame = row => row.scored !== false && row.dDays === 0;

// ---------- loading one learner ----------
// spec: { kind: 'sim', split, k, config }  or  { kind: 'real', id, cap, seed, root }
// -> { id, rows, meta } (rows as rowsOf makes them); throws when a real user's file is refused (DataError)
export function loadLearner(spec) {
  let learner;
  if (spec.kind === 'sim') {
    learner = getSource('sim').learners({ ...(spec.config || {}), split: spec.split, seed: spec.k, count: 1 }).next().value;
  } else if (spec.kind === 'real') {
    learner = getSource('anki10k').learners({ users: [spec.id], cap: spec.cap, seed: spec.seed ?? 0, root: spec.root, onSkip: (id, why) => { throw new Error(`user ${id} refused: ${why}`); } }).next().value;
    if (!learner) throw new Error(`user ${spec.id} not found`);
  } else throw new Error(`unknown learner kind: ${spec.kind}`);
  return { id: learner.id, rows: rowsOf(learner), meta: learner.meta || { hasNote: true, hasDeck: true, rawRows: learner.logs.length }, learner };
}

// ---------- ablations ----------
// --ablate=user,note,deck,decay. A stream is switched off by freezing its gate shut (the memory stays at its resting vector 0) and its
// weights at 0; "decay" freezes the memory times at about 27,000 years (no forgetting between answers). Returns { idx, val } of the frozen numbers.
export const ABLATIONS = ['user', 'note', 'deck', 'decay'];
export function frozenFor(size, ablate = []) {
  const off = paramOffsets(size), idx = [], val = [];
  const freeze = (name, v) => { const { offset, length } = off[name]; for (let i = 0; i < length; i++) { idx.push(offset + i); val.push(v); } };
  for (const a of ablate) if (!ABLATIONS.includes(a)) throw new Error(`Unknown ablation: ${a} (use ${ABLATIONS.join(', ')})`);
  for (const tag of ['note', 'deck', 'user']) {
    if (!ablate.includes(tag)) continue;
    freeze(`${tag}.Wz`, 0); freeze(`${tag}.bz`, -30); freeze(`${tag}.Wc`, 0); freeze(`${tag}.bc`, 0); freeze(`${tag}.h0`, 0);
  }
  if (ablate.includes('decay')) for (const tag of DECAY_STREAMS) if (!ablate.includes(tag)) freeze(`${tag}.theta`, Math.log(1e7));
  return { idx: Int32Array.from(idx), val: Float64Array.from(val) };
}
export const applyFrozen = (params, fz) => { for (let i = 0; i < fz.idx.length; i++) params[fz.idx[i]] = fz.val[i]; };
export const zeroFrozen = (grad, fz) => { for (let i = 0; i < fz.idx.length; i++) grad[fz.idx[i]] = 0; };

// ---------- what the model was trained on ----------
export const SIM_TRAINED = { id: SIM_VERSION, licence: 'ours' };
export function mergeTrainedOn(...lists) {
  const seen = new Map();
  for (const l of lists) for (const t of l || []) if (!seen.has(t.id)) seen.set(t.id, { id: t.id, licence: t.licence });
  return [...seen.values()];
}

// ---------- predictions for a whole event list ----------
// predictChunk gives p for scored events only; this spreads them back out (NaN where an event is not scored).
export function predictAll(model, events, store) {
  const ps = model.predictChunk(events, store), out = new Float64Array(events.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < events.length; i++) if (events[i].score) out[i] = ps[j++];
  return out;
}

// ---------- command line ----------
// --name value, --name=value, bare --flag (listed in `booleans`); a name given twice becomes a list.
export function parseArgs(argv, booleans = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unexpected argument: ${argv[i]}`);
    const v = m[2] !== undefined ? m[2] : booleans.includes(m[1]) ? true : argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value`);
    if (m[1] in flags) flags[m[1]] = [].concat(flags[m[1]], v); else flags[m[1]] = v;
  }
  return flags;
}

// --help: print the comment block at the top of the command's own file.
export function helpAndExit(argv, fileUrl) {
  if (!argv.includes('--help') && !argv.includes('-h')) return;
  const lines = readFileSync(new URL(fileUrl), 'utf8').split('\n').filter(l => !l.startsWith('process.env'));
  const out = [];
  for (const l of lines) { if (l.startsWith('//')) out.push(l.replace(/^\/\/ ?/, '')); else if (out.length) break; }
  console.log(out.join('\n'));
  process.exit(0);
}
