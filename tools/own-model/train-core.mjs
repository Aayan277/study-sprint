// Training the Own model. Importable (the tests call train() on tiny data); train.mjs is the command line around it.
//
// What happens, in plain words
//   * Every learner's history is cut into chunks of 128 answers. The trainer runs `batch` (16) learners side by side, one "slot" each: each step, every
//     slot runs its next chunk and the 16 gradients are averaged over the scored answers in them. When a slot's learner is finished the next learner moves in.
//   * The workers (worker_threads) share the parameters in shared memory; each writes its slots' gradients into separate blocks; the main thread adds the
//     blocks up in slot order. Adding in a fixed order makes the numbers identical for any number of workers.
//   * Adam steps with a cosine learning rate (3e-3 falling to 3e-4 over the run), gradients clipped to a norm of 1, a small pull of 1e-5 towards 0.
//   * After each epoch: log loss on a fixed seeded subset of validation learners (later-day scored answers only). The best epoch's parameters are kept;
//     training stops early when the loss has not improved for `patience` epochs. A checkpoint is written after every epoch, and also every
//     `ckptMin` minutes in the middle of an epoch (between two optimizer steps; it keeps each slot's learner, position and remembered states, the Adam and
//     EMA numbers, the loss sums and the position in the epoch), so a stopped run can --resume and gives exactly the model an uninterrupted run would.
import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { cpus } from 'node:os';
import { initParams } from '../../js/own-model.js';
import { Adam, cosineLr } from '../../js/own-grad.js';
import { paramCount, DEFAULT_SIZE } from '../../js/own-spec.js';
import { parseOwnFile, writeOwnFile } from '../../js/own-file.js';
import { fnv1a } from '../../js/rwkv-features.js';
import { SIM_VERSION } from './sim.mjs';
import { getSource } from './sources/index.mjs';
import { listUsers, LICENCE, DATASET_ID } from './sources/anki10k.mjs';
import { shuffled, frozenFor, applyFrozen, zeroFrozen, gitStamp, sha256OfParams, SIM_TRAINED, mergeTrainedOn, refuseInsideRepo } from './common.mjs';

export const SOURCE_IDS = ['sim', 'anki10k', 'sim+anki10k'];
export const DEFAULTS = {
  source: 'sim', size: DEFAULT_SIZE, cap: 40000, epochs: 8, seed: 1, workers: Math.max(1, cpus().length),
  lr: 3e-3, lrEnd: 3e-4, clip: 1, l2: 1e-5, batch: 16, chunk: 128, patience: 2,
  ckptMin: 20,                       // minutes between checkpoints inside an epoch (0 = only after each epoch). Not part of the resume key.
  ema: 0,                            // moving-average decay of the weights (0 = off; typical 0.999)
  usersPerEpoch: 0,                  // 0 = every train user, every epoch
  valUsers: 24, valCap: 20000,       // the fixed validation subset
  simTrain: 200, simVal: 16,         // how many made-up learners
  simConfig: { days: [40, 150] },    // simulator settings (days of study, new cards a day, ...)
  init: null,                        // a .own file to continue from
  ablate: [], out: null, resume: false, stopAfter: null, stopAfterSteps: null, root: undefined, quiet: false
};

// The settings that must not change between a run and its --resume.
const KEY_FIELDS = ['source', 'size', 'cap', 'epochs', 'seed', 'lr', 'lrEnd', 'clip', 'l2', 'batch', 'chunk', 'patience', 'usersPerEpoch', 'valUsers', 'valCap', 'simTrain', 'simVal', 'simConfig', 'ablate', 'legacyGap'];

// Mid-epoch slot states live in <out>.ckpt.slots: a 32-character id, then raw Float64 bytes. The JSON checkpoint holds offsets and lengths plus the same id.
const SLOT_ID_LEN = 32;
const refuseSlots = why => new Error(`The checkpoint's slot file (.ckpt.slots) ${why}; start again without --resume (or delete the .ckpt file).`);
function readSlots(file, mid) {
  if (!existsSync(file)) throw refuseSlots('is missing');
  const buf = readFileSync(file);
  if (buf.length !== mid.slotsBytes || buf.length < SLOT_ID_LEN || buf.toString('latin1', 0, SLOT_ID_LEN) !== mid.slotsId) throw refuseSlots('does not belong to this checkpoint (or is damaged)');
  const take = (off, len) => {
    if (!(off >= SLOT_ID_LEN && len >= 0 && off + len * 8 <= buf.length)) throw refuseSlots('is damaged');
    return new Float64Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + len * 8));
  };
  return mid.slots.map(a => {
    const lists = {};
    for (const key of ['cards', 'notes', 'decks']) lists[key] = a[key].map(([k, off, len]) => [k, take(off, len)]);
    return { ...a, store: { ...lists, user: a.user ? take(a.user[0], a.user[1]) : null } };
  });
}
const b64 = f64 => Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength).toString('base64');
const unb64 = text => { const b = Buffer.from(text, 'base64'); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// ---------- who trains, who validates ----------
export function planData(cfg) {
  const use = cfg.source.split('+');
  const train = [], val = [], trainedOn = [];
  let valKind = null;
  if (use.includes('sim')) {
    for (let k = 0; k < cfg.simTrain; k++) train.push({ kind: 'sim', split: 'train', k, config: cfg.simConfig });
    trainedOn.push(SIM_TRAINED);
    if (!use.includes('anki10k')) { for (let k = 0; k < cfg.simVal; k++) val.push({ kind: 'sim', split: 'val', k, config: cfg.simConfig }); valKind = 'sim'; }
  }
  if (use.includes('anki10k')) {
    const src = getSource('anki10k'), avail = src.available({ root: cfg.root });
    if (!avail.ok) throw new Error(`The real-data source is not available: ${avail.reason}.`);
    const users = listUsers({ root: cfg.root });
    for (const u of users) if (u.split === 'train') train.push({ kind: 'real', id: String(u.id), cap: cfg.cap, seed: cfg.seed, root: cfg.root, legacyGap: cfg.legacyGap });
    const pool = users.filter(u => u.split === 'val').map(u => ({ kind: 'real', id: String(u.id), cap: cfg.valCap, seed: 0, root: cfg.root, legacyGap: cfg.legacyGap }));
    val.push(...shuffled(pool, `own-val|${cfg.seed}`).slice(0, cfg.valUsers));
    valKind = 'real';
    trainedOn.push({ id: DATASET_ID, licence: LICENCE });
  }
  if (!train.length) throw new Error('There are no training learners.');
  if (!val.length) throw new Error('There are no validation learners.');
  return { train, val, trainedOn, valKind };
}

// The learners of epoch e: a seeded shuffle, then (when asked) a subset.
export function epochList(train, e, cfg) {
  const all = shuffled(train, `own-epoch|${cfg.seed}|${e}`);
  return cfg.usersPerEpoch > 0 ? all.slice(0, cfg.usersPerEpoch) : all;
}

// ---------- the worker pool ----------
class Pool {
  constructor({ size, n, batch, chunk, workers }) {
    this.n = n; this.batch = batch;
    this.paramsBuf = new SharedArrayBuffer(n * 8);
    this.gradsBuf = new SharedArrayBuffer(n * 8 * batch);
    this.params = new Float64Array(this.paramsBuf);
    this.grads = new Float64Array(this.gradsBuf);
    this.workers = Array.from({ length: workers }, () => new Worker(new URL('./train-worker.mjs', import.meta.url), {
      workerData: { size, paramsBuf: this.paramsBuf, gradsBuf: this.gradsBuf, n, chunk }, env: { ...process.env, TZ: 'UTC' }
    }));
    for (const w of this.workers) w.on('error', e => { this.failed = e; });
  }
  ask(w, msg) {
    return new Promise((resolve, reject) => {
      const onMsg = m => { w.off('error', onErr); if (m.type === 'error') reject(new Error(m.error)); else resolve(m); };
      const onErr = e => { w.off('message', onMsg); reject(e); };
      w.once('message', onMsg); w.once('error', onErr);
      w.postMessage(msg);
    });
  }
  async close() { await Promise.all(this.workers.map(w => w.terminate())); }
}

// ---------- validation ----------
// ema (Float64Array or null): judge these weights instead of the raw ones; the pool reads pool.params, so they are swapped in and back.
async function validate(pool, valSpecs, ema = null) {
  const raw = ema ? Float64Array.from(pool.params) : null;
  if (ema) pool.params.set(ema);
  try { return await validateRaw(pool, valSpecs); } finally { if (raw) pool.params.set(raw); }
}
async function validateRaw(pool, valSpecs) {
  const N = pool.workers.length, per = Array.from({ length: N }, () => []);
  valSpecs.forEach((spec, i) => per[i % N].push({ i, spec }));
  const got = await Promise.all(pool.workers.map((w, k) => (per[k].length ? pool.ask(w, { type: 'val', specs: per[k] }) : { results: [] })));
  const byIdx = [];
  for (const g of got) for (const r of g.results) byIdx[r.i] = r;
  let loss = 0, count = 0, skipped = 0;
  for (const r of byIdx) { if (!r) continue; loss += r.loss; count += r.count; if (r.skipped) skipped++; }       // learner order, so the sum never depends on the workers
  return { loss: count ? loss / count : NaN, count, skipped };
}

// ---------- the run ----------
// cfg as DEFAULTS. hooks: { log(line) }. Returns { stopped, params (best, Float64Array), history, config, header, outFile }.
export async function train(userCfg, hooks = {}) {
  const cfg = { ...DEFAULTS, ...userCfg, simConfig: { ...DEFAULTS.simConfig, ...(userCfg.simConfig || {}) } };
  const log = hooks.log || (cfg.quiet ? () => {} : line => console.log(line));
  if (!SOURCE_IDS.includes(cfg.source)) throw new Error(`Unknown --source ${cfg.source} (use ${SOURCE_IDS.join(', ')}).`);
  if (!cfg.out) throw new Error('--out is needed.');
  refuseInsideRepo('--out', cfg.out);
  const n = paramCount(cfg.size);
  const frozen = frozenFor(cfg.size, cfg.ablate);
  if (!(typeof cfg.ckptMin === 'number' && Number.isFinite(cfg.ckptMin) && cfg.ckptMin >= 0)) throw new Error('--ckpt-min must be a number of minutes, 0 or more (0 = only after each epoch).');
  if (cfg.ema && !(cfg.ema > 0 && cfg.ema < 1)) throw new Error('--ema must be between 0 and 1 (for example 0.999), or 0 for off.');
  const { train: trainAll, val: valSpecs, trainedOn: dataTrainedOn, valKind } = planData(cfg);

  // start: from --init, from scratch, or from a checkpoint
  let startParams, initInfo = null, initTrainedOn = [];
  if (cfg.init) {
    const f = parseOwnFile(readFileSync(cfg.init));
    if (f.header.size !== cfg.size) throw new Error(`--init is a size ${f.header.size} model but --size is ${cfg.size}.`);
    startParams = Float64Array.from(f.params);
    initInfo = sha256OfParams(startParams).slice(0, 12);
    initTrainedOn = f.header.trainedOn;
  } else startParams = initParams(cfg.size, cfg.seed);
  applyFrozen(startParams, frozen);
  const key = JSON.stringify({ ...Object.fromEntries(KEY_FIELDS.map(k => [k, cfg[k]])), legacyGap: !!cfg.legacyGap, init: initInfo, ...(cfg.ema ? { ema: cfg.ema } : {}) });
  const ckptFile = cfg.out + '.ckpt';

  const pool = new Pool({ size: cfg.size, n, batch: cfg.batch, chunk: cfg.chunk, workers: Math.max(1, cfg.workers) });
  const params = pool.params;
  params.set(startParams);
  const ema = cfg.ema ? Float64Array.from(params) : null;     // weights averaged over the steps; validation and the saved model use these
  const adam = new Adam(n, { lr: cfg.lr, l2: cfg.l2, clip: cfg.clip });
  const t0 = Date.now();
  let mid = null, midSlots = null, epoch = 0, best = null, bad = 0, history = [], startLoss = null, usedSeconds = 0;
  try {
    if (cfg.resume && existsSync(ckptFile)) {
      const c = JSON.parse(readFileSync(ckptFile, 'utf8'));
      if (c.key !== key) throw new Error('The checkpoint was made with different settings; start again without --resume (or delete the .ckpt file).');
      params.set(unb64(c.params));
      if (ema && c.ema) ema.set(unb64(c.ema)); else if (ema) ema.set(params);
      adam.t = c.adam.t; adam.m.set(unb64(c.adam.m)); adam.v.set(unb64(c.adam.v));
      epoch = c.epoch; bad = c.bad; history = c.history; startLoss = c.startLoss; usedSeconds = c.usedSeconds || 0;
      best = c.best ? { epoch: c.best.epoch, loss: c.best.loss, params: unb64(c.best.params) } : null;
      mid = c.mid || null;
      if (mid) midSlots = readSlots(ckptFile + '.slots', mid);
      log(`resuming after epoch ${epoch}${mid ? ` (inside epoch ${epoch + 1}, ${mid.learnersDone} learners done)` : ''} (validation loss ${history.at(-1)?.val?.toFixed(4)})`);
    } else if (cfg.resume) log('no checkpoint found; starting from the beginning');
    if (startLoss === null) {
      const v = await validate(pool, valSpecs, ema);
      startLoss = v.loss;
      best = { epoch: 0, loss: v.loss, params: Float64Array.from(ema || params) };
      history.push({ epoch: 0, val: v.loss, valCount: v.count });
      log(`start: validation loss ${v.loss.toFixed(4)} on ${v.count} later-day answers of ${valSpecs.length} learners (${v.skipped} skipped)`);
    }

    const B = cfg.batch, N = pool.workers.length;
    let stopped = false, stepsRun = 0, lastCkpt = Date.now();
    const saveCkpt = midState => {
      mkdirSync(dirname(ckptFile), { recursive: true });
      writeFileSync(ckptFile + '.part', JSON.stringify({
        key, epoch, bad, history, startLoss, usedSeconds: usedSeconds + (Date.now() - t0) / 1000,
        params: b64(params), ...(ema ? { ema: b64(ema) } : {}), adam: { t: adam.t, m: b64(adam.m), v: b64(adam.v) }, best: { epoch: best.epoch, loss: best.loss, params: b64(best.params) },
        ...(midState ? { mid: midState } : {})
      }));
      renameSync(ckptFile + '.part', ckptFile);
      lastCkpt = Date.now();
      if (!midState) { try { unlinkSync(ckptFile + '.slots'); } catch { /* none */ } }
    };
    // The slot states go to a binary file first (renamed into place before the JSON, so the JSON never points at a file that does not match it).
    const saveMid = snap => {
      const id = randomBytes(SLOT_ID_LEN / 2).toString('hex'), file = ckptFile + '.slots';
      mkdirSync(dirname(ckptFile), { recursive: true });
      const fd = openSync(file + '.part', 'w');
      let at = 0;
      const put = buf => { let o = 0; while (o < buf.length) o += writeSync(fd, buf, o, buf.length - o); at += buf.length; };
      const putF64 = f => { const off = at; put(Buffer.from(f.buffer, f.byteOffset, f.byteLength)); return [off, f.length]; };
      let slots;
      try {
        put(Buffer.from(id, 'latin1'));
        slots = snap.slots.map(a => {
          const o = { slot: a.slot, qi: a.qi, pos: a.pos };
          for (const key of ['cards', 'notes', 'decks']) o[key] = a.store[key].map(([k, v]) => [k, ...putF64(v)]);
          o.user = a.store.user ? putF64(a.store.user) : null;
          return o;
        });
      } finally { closeSync(fd); }
      renameSync(file + '.part', file);
      const { slots: _drop, ...rest } = snap;
      saveCkpt({ ...rest, slots, slotsId: id, slotsBytes: at });
    };
    // the state of the epoch in progress, taken between two steps: which learner sits in which slot, how far it got, and what it remembers
    const snapshotMid = async s => {
      const act = [];
      for (let k = 0; k < B; k++) if (s.slotActive[k]) act.push(k);
      const per = Array.from({ length: N }, () => []);
      for (const k of act) per[k % N].push(k);
      const got = await Promise.all(pool.workers.map((w, k) => (per[k].length ? pool.ask(w, { type: 'dump', slots: per[k] }) : { results: [] })));
      const by = new Map();
      for (const g of got) for (const r of g.results) by.set(r.slot, r);
      return {
        queueLen: s.queueLen, next: s.next, steps: s.steps, answers: s.answers, lossSum: s.lossSum, lossCount: s.lossCount, learnersDone: s.learnersDone,
        epochSeconds: (Date.now() - s.epochT0) / 1000, slots: act.map(k => ({ slot: k, qi: s.slotQ[k], pos: by.get(k).pos, store: by.get(k).store }))
      };
    };
    outer:
    while (epoch < cfg.epochs && bad < cfg.patience) {
      const queue = epochList(trainAll, epoch, cfg);
      const slotActive = new Array(B).fill(false), slotQ = new Array(B).fill(-1);
      let next = 0, steps = 0, answers = 0, lossSum = 0, lossCount = 0, lastLog = Date.now(), learnersDone = 0;
      let epochT0 = Date.now();
      if (mid) {                                                  // continue the epoch a checkpoint stopped in
        if (mid.queueLen !== queue.length) throw new Error('The checkpoint does not match the learner list (the data changed); start again without --resume.');
        ({ next, steps, answers, lossSum, lossCount, learnersDone } = mid);
        epochT0 = Date.now() - mid.epochSeconds * 1000;
        const per = Array.from({ length: N }, () => []);
        for (const a of midSlots) { slotActive[a.slot] = true; slotQ[a.slot] = a.qi; per[a.slot % N].push({ slot: a.slot, spec: queue[a.qi], pos: a.pos, store: a.store }); }
        await Promise.all(pool.workers.map((w, k) => (per[k].length ? pool.ask(w, { type: 'load', slots: per[k] }) : null)));
        mid = null; midSlots = null;
      }
      for (;;) {
        const assign = Array.from({ length: N }, () => []);
        let active = 0;
        for (let s = 0; s < B; s++) {
          if (!slotActive[s] && next < queue.length) { slotQ[s] = next; assign[s % N].push({ slot: s, spec: queue[next++] }); slotActive[s] = true; }
          else if (slotActive[s]) assign[s % N].push({ slot: s });
          if (slotActive[s]) active++;
        }
        if (!active) break;
        const got = await Promise.all(pool.workers.map((w, k) => (assign[k].length ? pool.ask(w, { type: 'step', assign: assign[k] }) : { results: [] })));
        const bySlot = new Array(B).fill(null);
        for (const g of got) for (const r of g.results) bySlot[r.slot] = r;
        const total = new Float64Array(n);
        let count = 0, loss = 0;
        for (let s = 0; s < B; s++) {
          const r = bySlot[s];
          if (!r) continue;
          if (r.count) { const g = pool.grads.subarray(s * n, (s + 1) * n); for (let i = 0; i < n; i++) total[i] += g[i]; count += r.count; loss += r.loss; }
          if (r.done) { slotActive[s] = false; learnersDone++; }
        }
        if (count) {
          for (let i = 0; i < n; i++) total[i] /= count;
          zeroFrozen(total, frozen);
          const lr = cosineLr(epoch + next / queue.length, cfg.epochs, cfg.lr, cfg.lrEnd);
          adam.step(params, total, lr);
          applyFrozen(params, frozen);
          if (ema) { const d = cfg.ema, e = 1 - d; for (let i = 0; i < n; i++) ema[i] = d * ema[i] + e * params[i]; }
          if (!params.every(Number.isFinite)) throw new Error('Training broke: a parameter is no longer a number. Try a lower --lr.');
          lossSum += loss; lossCount += count; answers += count; steps++;
        }
        stepsRun++;
        const dueSteps = cfg.stopAfterSteps && stepsRun >= cfg.stopAfterSteps;
        if (dueSteps || (cfg.ckptMin > 0 && Date.now() - lastCkpt >= cfg.ckptMin * 60000)) {
          try {
            saveMid(await snapshotMid({ slotActive, slotQ, queueLen: queue.length, next, steps, answers, lossSum, lossCount, learnersDone, epochT0 }));
          } catch (e) {
            if (dueSteps) throw e;
            lastCkpt = Date.now();
            log(`warning: could not write the mid-epoch checkpoint (${String(e.message || e).slice(0, 150)}); training goes on`);
          }
          if (dueSteps) { stopped = true; break outer; }
        }
        if (Date.now() - lastLog > 20000) {
          lastLog = Date.now();
          const frac = Math.min(0.999, (learnersDone / queue.length)), el = (Date.now() - epochT0) / 1000;
          const etaEpoch = el / Math.max(frac, 1e-3) - el, runFrac = (epoch + frac) / cfg.epochs;
          const runEl = usedSeconds + (Date.now() - t0) / 1000;
          log(`epoch ${epoch + 1}/${cfg.epochs}  ${(frac * 100).toFixed(0)}%  learners ${learnersDone}/${queue.length}  steps ${steps}  train loss ${(lossSum / Math.max(1, lossCount)).toFixed(4)}  ${Math.round(answers / el)} answers/s  epoch ETA ${fmt(etaEpoch)}  run ETA ${fmt(runEl / Math.max(runFrac, 1e-3) - runEl)}`);
        }
      }
      epoch++;
      const v = await validate(pool, valSpecs, ema);
      const trainLoss = lossSum / Math.max(1, lossCount), secs = (Date.now() - epochT0) / 1000;
      history.push({ epoch, train: trainLoss, val: v.loss, valCount: v.count, seconds: Math.round(secs), answers, steps });
      let tag = '';
      if (v.loss < best.loss - 1e-5) { best = { epoch, loss: v.loss, params: Float64Array.from(ema || params) }; bad = 0; tag = '  (best)'; } else bad++;
      log(`epoch ${epoch}/${cfg.epochs} done in ${fmt(secs)}: ${answers} answers, train loss ${trainLoss.toFixed(4)}, validation loss ${v.loss.toFixed(4)}${tag}`);
      saveCkpt(null);
      if (cfg.stopAfter && epoch >= cfg.stopAfter && epoch < cfg.epochs) { stopped = true; break; }
    }
    if (stopped) { log(`stopped after ${cfg.stopAfterSteps && stepsRun >= cfg.stopAfterSteps ? `${stepsRun} steps` : `epoch ${epoch}`} as asked; checkpoint ${ckptFile}`); return { stopped: true, history, config: cfg }; }

    // the best epoch becomes the model
    const final = best.params;
    const seconds = usedSeconds + (Date.now() - t0) / 1000;
    const info = {
      source: cfg.source, size: cfg.size, epochsRun: epoch, bestEpoch: best.epoch, valLoss: +best.loss.toFixed(5), valLossStart: +startLoss.toFixed(5),
      valKind, cap: cfg.cap, usersPerEpoch: cfg.usersPerEpoch, trainLearners: trainAll.length, valLearners: valSpecs.length,
      ablate: cfg.ablate.join(',') || 'none', initFrom: initInfo || 'none', node: process.version, seconds: Math.round(seconds), batch: cfg.batch, lr: cfg.lr, ema: cfg.ema || 0
    };
    const trainedOn = mergeTrainedOn(initTrainedOn, dataTrainedOn);
    const bytes = writeOwnFile({ size: cfg.size, params: Float32Array.from(final), trainedOn, seed: cfg.seed, gitStamp: gitStamp(), info });
    mkdirSync(dirname(cfg.out), { recursive: true });
    writeFileSync(cfg.out + '.part', bytes);
    renameSync(cfg.out + '.part', cfg.out);
    const header = { ...info, sha: sha256OfParams(final), trainedOn, history };
    writeFileSync(cfg.out + '.run.json', JSON.stringify({ config: { ...cfg, out: undefined }, ...header, gitStamp: gitStamp() }, null, 1));
    log(`done: best epoch ${best.epoch}, validation loss ${best.loss.toFixed(4)} (start ${startLoss.toFixed(4)}); wrote ${cfg.out}`);
    return { stopped: false, params: final, history, config: cfg, header, outFile: cfg.out };
  } finally {
    await pool.close();
  }
}

export function fmt(sec) {
  if (!Number.isFinite(sec)) return '?';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}
