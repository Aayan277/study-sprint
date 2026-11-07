import './rwkv-utc.mjs';
// Tests for the trainer (tools/own-model/train-core.mjs) on 8 tiny made-up learners: it learns, the workers do not change the answer,
// a stopped run resumes to the same numbers, ablations freeze what they should, output inside the repo is refused. No real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { train, epochList, planData, DEFAULTS } from '../tools/own-model/train-core.mjs';
import { frozenFor, refuseInsideRepo, sha256OfParams, shuffled } from '../tools/own-model/common.mjs';
import { parseOwnFile } from '../js/own-file.js';
import { paramOffsets } from '../js/own-spec.js';
import { paramsModuleFrom, ownBytesFromParams } from '../tools/own-model/params-module.mjs';
import { initParams } from '../js/own-model.js';
import { REPO } from './realdata/lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-train-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const TINY = { source: 'sim', simTrain: 8, simVal: 2, simConfig: { days: [20, 25] }, epochs: 2, workers: 1, quiet: true, patience: 5 };
const paramsOf = file => parseOwnFile(fs.readFileSync(file)).params;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test('two epochs on 8 tiny learners reduce the validation loss, and the model file says what it is', async () => {
  const out = path.join(tmp, 'a.own');
  const r = await train({ ...TINY, out });
  assert.equal(r.stopped, false);
  const first = r.history[0].val, last = r.history.at(-1).val;
  assert.ok(Number.isFinite(first) && Number.isFinite(last));
  assert.ok(last < first - 0.05, `loss went ${first} -> ${last}`);
  const { header, params } = parseOwnFile(fs.readFileSync(out));
  assert.deepEqual(header.trainedOn, [{ id: 'sim-v1', licence: 'ours' }]);
  assert.equal(header.info.source, 'sim'); assert.equal(header.info.epochsRun, 2); assert.equal(header.info.valKind, 'sim');
  assert.ok(params.every(Number.isFinite));
  const run = JSON.parse(fs.readFileSync(out + '.run.json', 'utf8'));
  assert.equal(run.sha, sha256OfParams(params), 'the run record names the same parameters as the file (float32 of the best epoch)');
});

test('1 worker and 2 workers give identical parameters', async () => {
  const a = path.join(tmp, 'w1.own'), b = path.join(tmp, 'w2.own');
  await train({ ...TINY, workers: 1, out: a });
  await train({ ...TINY, workers: 2, out: b });
  assert.ok(same(paramsOf(a), paramsOf(b)));
});

test('a run stopped after one epoch and resumed equals the uninterrupted run', async () => {
  const full = path.join(tmp, 'full.own'), part = path.join(tmp, 'part.own');
  await train({ ...TINY, epochs: 3, out: full });
  const s = await train({ ...TINY, epochs: 3, out: part, stopAfter: 1 });
  assert.equal(s.stopped, true);
  assert.ok(fs.existsSync(part + '.ckpt') && !fs.existsSync(part), 'a checkpoint exists, the model does not yet');
  const r = await train({ ...TINY, epochs: 3, out: part, resume: true, workers: 2 });
  assert.equal(r.stopped, false);
  assert.ok(same(paramsOf(full), paramsOf(part)));
  assert.deepEqual(r.history.map(h => h.val), JSON.parse(fs.readFileSync(full + '.run.json', 'utf8')).history.map(h => h.val));
});

test('resuming with different settings is refused', async () => {
  const out = path.join(tmp, 'mix.own');
  await train({ ...TINY, epochs: 2, out, stopAfter: 1 });
  await assert.rejects(train({ ...TINY, epochs: 2, seed: 9, out, resume: true }), /different settings/);
});

test('--init continues from a model: the start loss is the old model\'s end loss', async () => {
  const a = path.join(tmp, 'init-a.own'), b = path.join(tmp, 'init-b.own');
  const ra = await train({ ...TINY, out: a });
  const rb = await train({ ...TINY, out: b, init: a, epochs: 1 });
  assert.ok(Math.abs(rb.history[0].val - ra.history.at(-1).val) < 1e-4, `${rb.history[0].val} vs ${ra.history.at(-1).val}`);
});

test('an ablation freezes the stream: its numbers never move and its memory stays at the resting vector', async () => {
  const out = path.join(tmp, 'ab.own');
  await train({ ...TINY, out, ablate: ['user', 'decay'] });
  const p = paramsOf(out), off = paramOffsets('s'), fz = frozenFor('s', ['user', 'decay']);
  for (let i = 0; i < fz.idx.length; i++) assert.equal(p[fz.idx[i]], Math.fround(fz.val[i]), 'frozen number moved');
  const bz = off['user.bz'].offset;
  assert.equal(p[bz], -30);
  const moved = paramsOf(path.join(tmp, 'a.own'));
  assert.notEqual(moved[off['user.bz'].offset], -30, 'without the ablation it moves');
  assert.throws(() => frozenFor('s', ['nope']), /Unknown ablation/);
  assert.equal(parseOwnFile(fs.readFileSync(out)).header.info.ablate, 'user,decay');
});

test('per-epoch learner lists are seeded, differ between epochs, and --users-per-epoch takes a subset', () => {
  const list = Array.from({ length: 30 }, (_, k) => ({ k }));
  const cfg = { seed: 4, usersPerEpoch: 0 };
  assert.deepEqual(epochList(list, 0, cfg), epochList(list, 0, cfg));
  assert.notDeepEqual(epochList(list, 0, cfg), epochList(list, 1, cfg));
  const some = epochList(list, 2, { seed: 4, usersPerEpoch: 7 });
  assert.equal(some.length, 7); assert.equal(new Set(some.map(x => x.k)).size, 7);
  assert.deepEqual(shuffled([1, 2, 3, 4, 5, 6], 'x'), shuffled([1, 2, 3, 4, 5, 6], 'x'));
});

test('planData: sim learners train, other sim learners validate; unknown or empty data is refused', () => {
  const p = planData({ ...DEFAULTS, ...TINY, simConfig: { days: [20, 25] } });
  assert.equal(p.train.length, 8); assert.equal(p.val.length, 2); assert.equal(p.valKind, 'sim');
  assert.ok(p.train.every(s => s.split === 'train') && p.val.every(s => s.split === 'val'));
  assert.throws(() => planData({ ...DEFAULTS, source: 'sim', simTrain: 0, simVal: 2 }), /no training learners/);
  const gone = path.join(tmp, 'nodata');
  assert.throws(() => planData({ ...DEFAULTS, source: 'anki10k', root: gone }), /not available/);
});

test('an output path inside the repo is refused (library and command line); outside is fine', async () => {
  assert.throws(() => refuseInsideRepo('--out', path.join(REPO, 'tools', 'own-model', 'out', 'x.own')), /inside the repo/);
  assert.throws(() => refuseInsideRepo('--out', path.join(REPO, 'x.own')), /inside the repo/);
  assert.doesNotThrow(() => refuseInsideRepo('--out', path.join(os.homedir(), 'own-model-private', 'x.own')));
  await assert.rejects(train({ ...TINY, out: path.join(REPO, 'tools', 'own-model', 'out', 'refused.own') }), /inside the repo/);
  const target = path.join(REPO, 'tools', 'own-model', 'out', 'cli.own');
  const r = spawnSync(process.execPath, ['tools/own-model/train.mjs', '--source', 'sim', '--sim-train', '2', '--sim-val', '1', '--epochs', '1', '--out', target], { cwd: REPO, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside the repo/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.ckpt'), false);
});

test('the evaluator refuses a results folder inside the repo', () => {
  const r = spawnSync(process.execPath, ['tools/own-model/eval.mjs', '--source', 'sim'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, OWN_PRIVATE: path.join(REPO, 'tools', 'own-model', 'out', 'private') } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the repo/);
  assert.equal(fs.existsSync(path.join(REPO, 'tools', 'own-model', 'out', 'private')), false);
});

test('shipping parameters: only simulator-trained models within budget become js/own-params.js', () => {
  const p = initParams('s', 2);
  const ok = paramsModuleFrom(ownBytesFromParams('s', Float32Array.from(p)));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body.trainedOn, ['sim-v1']);
  assert.equal(ok.body.paramCount, 19178);
  assert.ok(ok.text.length < 128 * 1024);
  assert.match(ok.text, /^\/\/ Own model: the shipped parameters/);
  const real = paramsModuleFrom(ownBytesFromParams('s', Float32Array.from(p), [{ id: 'anki-revlogs-10k', licence: 'x' }]));
  assert.equal(real.ok, false); assert.match(real.reason, /only simulator-only/);
  const mixed = paramsModuleFrom(ownBytesFromParams('s', Float32Array.from(p), [{ id: 'sim-v1', licence: 'ours' }, { id: 'anki-revlogs-10k', licence: 'x' }]));
  assert.equal(mixed.ok, false);
  const big = paramsModuleFrom(ownBytesFromParams('m', Float32Array.from(initParams('m', 2))));
  assert.equal(big.ok, false); assert.match(big.reason, /budget/);
});

test('the committed js/own-params.js decodes to a model that matches its own sha256 and is the right size', async t => {
  if (!fs.existsSync(path.join(REPO, 'js', 'own-params.js'))) return t.skip('js/own-params.js has not been generated yet');
  const { OWN_PARAMS } = await import('../js/own-params.js');
  const bytes = Buffer.from(OWN_PARAMS.b64, 'base64');
  assert.equal(bytes.length, OWN_PARAMS.paramCount * 4);
  assert.equal(OWN_PARAMS.paramCount, 19178);
  assert.equal(OWN_PARAMS.size, 's');
  assert.equal(sha256OfParams(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))), OWN_PARAMS.sha256);
  assert.deepEqual(OWN_PARAMS.trainedOn, ['sim-v1']);
});

test('--ema: the saved model is the moving average, a resume restores it, and off (0) changes nothing', async () => {
  const off = path.join(tmp, 'e0.own'), on = path.join(tmp, 'e1.own'), full = path.join(tmp, 'e2.own'), part = path.join(tmp, 'e3.own');
  await train({ ...TINY, out: off });
  await train({ ...TINY, ema: 0, out: path.join(tmp, 'e0b.own') });
  assert.ok(same(paramsOf(off), paramsOf(path.join(tmp, 'e0b.own'))));
  const r = await train({ ...TINY, ema: 0.9, out: on });
  assert.ok(!same(paramsOf(off), paramsOf(on)), 'averaged weights differ from raw weights');
  assert.equal(JSON.parse(fs.readFileSync(on + '.run.json', 'utf8')).ema, 0.9);
  assert.ok(r.history.at(-1).val < r.history[0].val - 0.05);
  await train({ ...TINY, epochs: 3, ema: 0.9, out: full });
  await train({ ...TINY, epochs: 3, ema: 0.9, out: part, stopAfter: 1 });
  assert.ok(JSON.parse(fs.readFileSync(part + '.ckpt', 'utf8')).ema, 'the checkpoint holds the average');
  await train({ ...TINY, epochs: 3, ema: 0.9, out: part, resume: true });
  assert.ok(same(paramsOf(full), paramsOf(part)));
  await assert.rejects(train({ ...TINY, ema: 1.5, out: path.join(tmp, 'e4.own') }), /--ema must be/);
});

test('a checkpoint inside an epoch resumes to the identical model (with and without --ema), also with another worker count', async () => {
  for (const ema of [0, 0.9]) {
    // batch 3 on 8 learners, so learners finish and new ones move into slots before and after the stop
    const base = { ...TINY, epochs: 3, batch: 3, ema, ckptMin: 0 };
    const full = path.join(tmp, `m${ema}-full.own`), part = path.join(tmp, `m${ema}-part.own`);
    const rf = await train({ ...base, out: full });
    for (const [stopAt, workers] of [[7, 1], [20, 2]]) {
      const s = await train({ ...base, out: part, stopAfterSteps: stopAt });
      assert.equal(s.stopped, true);
      const c = JSON.parse(fs.readFileSync(part + '.ckpt', 'utf8'));
      assert.ok(c.mid && c.mid.slots.length > 0, 'the checkpoint holds the position inside the epoch');
      assert.equal(!!c.ema, !!ema);
      assert.ok(!fs.existsSync(part + '.ckpt.part'));
      const r = await train({ ...base, out: part, resume: true, workers });
      assert.equal(r.stopped, false);
      assert.ok(same(paramsOf(full), paramsOf(part)), `ema ${ema}, stop at step ${stopAt}`);
      assert.deepEqual(r.history.map(h => h.val), rf.history.map(h => h.val));
      assert.deepEqual(r.history.map(h => h.train), rf.history.map(h => h.train));
      fs.rmSync(part + '.ckpt'); fs.rmSync(part);
    }
  }
});

test('a stop twice in a row inside epochs, and --ckpt-min is not part of the resume key', async () => {
  const base = { ...TINY, epochs: 2, batch: 3 };
  const full = path.join(tmp, 'k-full.own'), part = path.join(tmp, 'k-part.own');
  await train({ ...base, out: full });
  await train({ ...base, out: part, stopAfterSteps: 5, ckptMin: 0 });
  await train({ ...base, out: part, resume: true, stopAfterSteps: 9, ckptMin: 7 });
  await train({ ...base, out: part, resume: true, ckptMin: 3 });
  assert.ok(same(paramsOf(full), paramsOf(part)));
});

test('an end-of-epoch checkpoint (no position inside the epoch) still resumes', async () => {
  const base = { ...TINY, epochs: 3, batch: 3, ckptMin: 0 };
  const full = path.join(tmp, 'o-full.own'), part = path.join(tmp, 'o-part.own');
  await train({ ...base, out: full });
  await train({ ...base, out: part, stopAfter: 1 });
  assert.equal(JSON.parse(fs.readFileSync(part + '.ckpt', 'utf8')).mid, undefined);
  await train({ ...base, out: part, resume: true });
  assert.ok(same(paramsOf(full), paramsOf(part)));
});
