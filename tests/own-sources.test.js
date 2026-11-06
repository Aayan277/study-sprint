import './rwkv-utc.mjs';
// Tests for the data sources and the real-data converter. Tiny made-up users in the dataset's column shape only: the dataset itself is never needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCES, getSource, resolveSources, rowsOf, splitOf, bucketOf } from '../tools/own-model/sources/index.mjs';
import anki, { validateUser, parseUserText, userToLearner, DataError, LIMITS, LICENCE } from '../tools/own-model/sources/anki10k.mjs';
import { OwnFeatures } from '../js/own-features.js';
import { fnv1a } from '../js/rwkv-features.js';
import { rowKind } from '../js/fsrs-data.js';
import { toHistories, REPO, insideRepo } from './realdata/lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-sources-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (rel, obj) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const DAY = 86400000;

// rows: [card, day, rating, state, elapsedSeconds, durationMs?, note?, deck?]
function user(rows, id = 1, withMeta = true) {
  const u = { user: id, card_id: rows.map(r => r[0]), day_offset: rows.map(r => r[1]), rating: rows.map(r => r[2]), state: rows.map(r => r[3]), elapsed_seconds: rows.map(r => r[4]) };
  if (withMeta) { u.duration_ms = rows.map(r => r[5] ?? null); u.note_id = rows.map(r => r[6] ?? null); u.deck_id = rows.map(r => r[7] ?? null); u.preset_id = rows.map(() => null); }
  return u;
}
const ROWS = [
  [10, 0, 3, 0, -1, 6000, 100, 7], [11, 0, 1, 0, -1, 9000, 100, 7], [10, 0, 3, 1, 600, 5000, 100, 7], [11, 0, 3, 1, 300, 4000, 100, 7],
  [10, 3, 3, 2, 3 * 86400 - 600, 7000, 100, 7], [12, 1, 0, 0, -1, 1000, 101, 8], [12, 4, 3, 1, 3 * 86400, 8000, 101, 8], [11, 2, 1, 2, 2 * 86400 - 300, 12000, 100, 7],
  [11, 2, 3, 3, 600, 6000, 100, 7], [13, 2, 2, 2, 5000, 6500, 102, 8],            // card 13 starts at state 2: its start is unknown
  [10, 9, 4, 2, 6 * 86400, 3000, 100, 7], [11, 9, 3, 0, -1, 4000, 100, 7], [11, 12, 3, 2, 3 * 86400, 9000, 100, 7]   // card 11 is reset on day 9
];

test('the registry holds sim, fixture and anki10k with the documented fields', () => {
  assert.deepEqual(Object.keys(SOURCES), ['sim', 'fixture', 'anki10k']);
  for (const s of Object.values(SOURCES)) {
    assert.equal(typeof s.id, 'string'); assert.equal(typeof s.licence, 'string'); assert.equal(s.node, true);
    assert.equal(typeof s.describe, 'function'); assert.equal(typeof s.learners, 'function'); assert.equal(typeof s.available, 'function');
  }
  assert.equal(SOURCES.sim.licence, 'ours'); assert.equal(SOURCES.anki10k.browser, false);
  assert.equal(LICENCE, 'anki-revlogs-10k: research use by students/individuals, no redistribution');
  assert.throws(() => getSource('nope'), /Unknown data source/);
  assert.throws(() => getSource('constructor'), /Unknown data source/);
});

test('anki10k is skipped cleanly when the data folder is absent, empty or inside the repo', () => {
  const none = path.join(tmp, 'nothing-here');
  let r = resolveSources(['sim', 'fixture', 'anki10k'], { root: none });
  assert.deepEqual(r.use.map(s => s.id), ['sim', 'fixture']);
  assert.equal(r.skipped[0].id, 'anki10k'); assert.match(r.skipped[0].reason, /no data folder/);
  fs.mkdirSync(path.join(tmp, 'empty', 'users'), { recursive: true });
  assert.match(resolveSources(['anki10k'], { root: path.join(tmp, 'empty') }).skipped[0].reason, /no user files/);
  assert.match(resolveSources(['anki10k'], { root: REPO }).skipped[0].reason, /inside the repo/);
});

test('insideRepo refusal: the source will not read from a folder inside the repo', () => {
  for (const root of [REPO, path.join(REPO, 'tools', 'own-model', 'out'), path.join(REPO, 'tests')]) {
    assert.equal(insideRepo(root), true);
    assert.throws(() => [...anki.learners({ root })], /inside the repo/);
  }
});

test('the fixture and the simulator work through the interface', () => {
  const fx = [...SOURCES.fixture.learners()];
  assert.equal(fx.length, 4);
  assert.deepEqual(fx.map(l => l.split), ['train', 'train', 'val', 'test']);
  assert.equal([...SOURCES.fixture.learners({ split: 'val' })].length, 1);
  assert.equal(SOURCES.fixture.describe().learners, 4);
  for (const l of fx) { assert.ok(l.logs.length > 30); assert.ok(l.logs.every(x => rowKind(x) === 'train')); assert.ok(!('truth' in l)); assert.ok(rowsOf(l).length === l.logs.length); }
  const sim = [...SOURCES.sim.learners({ split: 'val', count: 2, days: 20, newPerDay: 4 })];
  assert.deepEqual(sim.map(l => l.id), ['sim10001', 'sim10002']);
  assert.ok(sim.every(l => l.split === 'val'));
  assert.equal([...SOURCES.sim.learners({ split: 'control', count: 1, days: 20 })][0].truth.world, 'fsrs');
  assert.throws(() => [...SOURCES.sim.learners({ split: 'dev' })], /Unknown split/);
  assert.equal(SOURCES.sim.describe({ split: 'test' }).learners, 200);
});

test('the split is by learner id: the hash rule, stable and about 67/13/20', () => {
  assert.equal(bucketOf('1234'), fnv1a('own-split|1234') % 100);
  for (const id of ['1', '1007', '10000']) { const b = fnv1a('own-split|' + id) % 100; assert.equal(splitOf(id), b < 67 ? 'train' : b < 80 ? 'val' : 'test'); }
  const n = { train: 0, val: 0, test: 0 };
  for (let i = 1; i <= 10000; i++) n[splitOf(String(i))]++;
  assert.ok(Math.abs(n.train - 6700) < 250 && Math.abs(n.val - 1300) < 200 && Math.abs(n.test - 2000) < 200, JSON.stringify(n));
  assert.equal(splitOf('77'), splitOf('77'));
});

test('a user in the dataset shape becomes a learner: ratings, resets, unknown starts, overrides', () => {
  const l = userToLearner(validateUser(user(ROWS, 5)), { id: '5' });
  assert.equal(l.meta.droppedRating, 1);              // card 12's first row has rating 0
  assert.equal(l.meta.resets, 1);                     // card 11 on day 9
  assert.equal(l.logs.length, ROWS.length - 1);
  assert.ok(l.logs.every(x => rowKind(x) === 'train'));
  assert.deepEqual(l.logs.map(x => x.id), l.logs.map((_, i) => i));
  assert.equal(l.split, splitOf('5'));
  // the old life of card 11 and the unknown start of card 13 are not scored; the rest is
  const byKey = k => l.logs.filter(x => x.cardId === k);
  assert.ok(byKey('c11').length === 4 && byKey('c11').every(x => x.scored === false));
  assert.ok(byKey('c11~2').length === 2 && byKey('c11~2').every(x => x.scored !== false));
  assert.ok(byKey('c13').every(x => x.scored === false));
  assert.ok(byKey('c10').every(x => x.scored !== false));
  // card gaps come from elapsed_seconds; a dropped row's seconds still count towards the next gap
  assert.equal(byKey('c10')[1].gapSec, 600);
  assert.equal(byKey('c12')[0].gapSec, undefined);
  assert.equal(byKey('c12')[0].day, 4);
  // notes, decks
  const card = id => l.cards.find(c => c.id === id);
  assert.deepEqual(card('c10'), { id: 'c10', deckId: '7', noteId: '100' });
  assert.equal(card('c11~2').noteId, '100');
  // the made-up clock: day at 04:00 plus the running durations of that day
  const first = l.logs[0], second = l.logs[1];
  assert.equal(first.timestamp, 0 * DAY + 4 * 3600000);
  assert.equal(second.timestamp - first.timestamp, 6000);
  assert.ok(l.logs.every((x, i) => i === 0 || x.timestamp >= l.logs[i - 1].timestamp));
  // the rows the features read: overrides are carried, a missing duration is neutral
  const rows = rowsOf(l);
  assert.equal(rows.length, l.logs.length);
  assert.ok(rows.every(r => r.day === l.logs.find(x => x.id === r.logId).day));
  const same = rows.filter(r => r.dDays === 0), long = rows.filter(r => r.dDays > 0);
  assert.ok(same.length > 0 && long.length > 0);
});

test('without notes, decks or durations: note = card, deck = d:?, neutral answer time', () => {
  const l = userToLearner(validateUser(user(ROWS.map(r => r.slice(0, 5)), 6, false)), { id: '6' });
  assert.equal(l.meta.hasNote, false); assert.equal(l.meta.hasDeck, false); assert.equal(l.meta.hasDuration, false);
  assert.deepEqual(l.cards.find(c => c.id === 'c10'), { id: 'c10', deckId: '?', noteId: 'c10' });
  const rows = rowsOf(l);
  assert.ok(rows.every(r => r.ms === 8000));
  assert.ok(rows.every(r => r.deckKey === 'd:?'));
  const f = new OwnFeatures();
  assert.equal(f.features(rows[0])[16], 0);            // the neutral answer time reads as 0
  assert.equal(l.logs[0].timestamp, 4 * 3600000);
  assert.equal(l.logs[1].timestamp - l.logs[0].timestamp, 10000);   // 10 s per answer when the duration is unknown
});

test('the scored rows agree with toHistories (same rules as the FSRS scores)', () => {
  const u = user(ROWS, 7);
  const ref = toHistories(u);
  const l = userToLearner(validateUser(u), { id: '7' });
  const scored = l.logs.filter(x => x.scored !== false);
  assert.equal(scored.length, ref.cards.reduce((a, c) => a + c.ratings.length, 0));
  const rows = rowsOf(l);
  const long = rows.filter(r => r.scored !== false && r.dDays > 0).length;
  const refLong = ref.cards.reduce((a, c) => a + Array.from(c.deltas).filter((d, i) => i > 0 && d > 0).length, 0);
  assert.equal(long, refLong);
});

test('features from the overrides equal features from timestamps when the two tell the same story', () => {
  // one made-up user; elapsed_seconds are set from the made-up clock itself, so the two sources must agree
  const first = userToLearner(validateUser(user(ROWS.map(r => [r[0], r[1], r[2] || 3, r[3], null, r[5] - (r[5] % 1000), r[6], r[7]]), 8)), { id: '8' });
  const prevT = new Map(), es = [];
  for (const x of first.logs) { const p = prevT.get(x.cardId); es.push(p === undefined ? -1 : (x.timestamp - p) / 1000); prevT.set(x.cardId, x.timestamp); }
  // rebuild with those seconds (rows are in the same order because they were sorted by day then file order; compare by card)
  const order = ROWS.map(r => [r[0], r[1], r[2] || 3, r[3], r[5] - (r[5] % 1000), r[6], r[7]]);
  const sorted = order.map((r, i) => ({ r, i })).sort((a, b) => a.r[1] - b.r[1] || a.i - b.i);
  const seconds = new Map(sorted.map((x, k) => [x.i, es[k]]));
  const u2 = user(order.map((r, i) => [r[0], r[1], r[2], r[3], seconds.get(i), r[4], r[5], r[6]]), 8);
  const l = userToLearner(validateUser(u2), { id: '8' });
  const rows = rowsOf(l);
  const stripped = rows.map(r => { const { gapSec, ...rest } = r; return { ...rest, day: Math.floor(r.t / DAY) }; });
  const run = rs => { const f = new OwnFeatures(), out = []; for (const r of rs) { out.push(f.features(r)); f.commit(r); } return out; };
  const a = run(rows), b = run(stripped);
  a.forEach((f, i) => { for (let k = 0; k < f.length; k++) assert.ok(Math.abs(f[k] - b[i][k]) < 1e-6, `row ${i} feature ${k}: ${f[k]} vs ${b[i][k]}`); });
  assert.ok(rows.some(r => Number.isFinite(r.gapSec)));
});

test('cap thins whole cards, seeded, and keeps what is kept in time order', () => {
  const rows = [];
  for (let c = 0; c < 40; c++) { rows.push([c, c % 5, 3, 0, -1, 5000, c, 1]); rows.push([c, 10 + c % 5, 3, 2, 10 * 86400, 5000, c, 1]); }
  const u = validateUser(user(rows, 9));
  const a = userToLearner(u, { cap: 30, seed: 1, id: '9' }), b = userToLearner(u, { cap: 30, seed: 1, id: '9' }), c = userToLearner(u, { cap: 30, seed: 2, id: '9' });
  assert.equal(a.logs.length, 30); assert.equal(a.meta.capped, true);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.cards.map(x => x.id), c.cards.map(x => x.id));
  const per = new Map();
  for (const x of a.logs) per.set(x.cardId, (per.get(x.cardId) || 0) + 1);
  assert.ok([...per.values()].every(n => n === 2), 'whole cards only');
  assert.ok(a.logs.every((x, i) => i === 0 || x.timestamp >= a.logs[i - 1].timestamp));
  assert.equal(userToLearner(u, { cap: 1e6, id: '9' }).meta.capped, false);
});

test('a data file is untrusted: NaN, huge arrays, bad ratings and the like are refused', () => {
  const ok = () => user(ROWS, 1);
  assert.doesNotThrow(() => validateUser(ok()));
  const refused = (mutate, re, limits) => { const u = ok(); mutate(u); assert.throws(() => validateUser(u, limits), e => e instanceof DataError && re.test(e.message)); };
  refused(u => { u.rating[3] = 7; }, /rating/);
  refused(u => { u.rating[3] = 2.5; }, /rating/);
  refused(u => { u.rating[3] = '3'; }, /rating/);
  refused(u => { u.rating[3] = NaN; }, /rating/);
  refused(u => { u.day_offset[0] = Infinity; }, /day_offset/);
  refused(u => { u.day_offset[0] = -5; }, /day_offset/);
  refused(u => { u.card_id[0] = null; }, /card_id/);
  refused(u => { u.card_id[0] = 1.5; }, /card_id/);
  refused(u => { u.state[1] = 9; }, /state/);
  refused(u => { u.elapsed_seconds[1] = NaN; }, /elapsed_seconds/);
  refused(u => { u.elapsed_seconds[1] = -7; }, /elapsed_seconds/);
  refused(u => { u.duration_ms[1] = -1; }, /duration_ms/);
  refused(u => { u.duration_ms[1] = NaN; }, /duration_ms/);
  refused(u => { u.duration_ms[1] = 1e12; }, /duration_ms/);
  refused(u => { u.note_id[1] = 'x'; }, /note_id/);
  refused(u => { u.deck_id.pop(); }, /deck_id/);
  refused(u => { delete u.rating; }, /rating/);
  refused(u => { u.rating = 'abc'; }, /rating/);
  refused(u => { u.surprise = [1]; }, /unknown column/);
  refused(() => {}, /too many rows/, { ...LIMITS, maxRows: 5 });
  assert.throws(() => validateUser(null), DataError);
  assert.throws(() => validateUser([1, 2]), DataError);
  assert.throws(() => validateUser({}), DataError);
  // text level
  assert.throws(() => parseUserText('{"card_id":[NaN]}'), /not valid JSON/);
  assert.throws(() => parseUserText('{"card_id":[1],'), /not valid JSON/);
  assert.throws(() => parseUserText('x'.repeat(100), { ...LIMITS, maxFileBytes: 10 }), /too large/);
  assert.throws(() => parseUserText(JSON.stringify({ card_id: new Array(6).fill(1), day_offset: [], rating: [], state: [] }), { ...LIMITS, maxRows: 5 }), /too many rows/);
  assert.doesNotThrow(() => parseUserText(JSON.stringify(ok())));
  // a prototype-pollution style key does not become a column
  assert.throws(() => parseUserText('{"card_id":[],"day_offset":[],"rating":[],"state":[],"__proto__":[1]}'), DataError);
});

test('the source reads both folders, prefers own/users, skips bad files and counts them', () => {
  const root = path.join(tmp, 'data1');
  write('data1/users/1.json', user(ROWS.map(r => r.slice(0, 5)), 1, false));                 // old shape only
  write('data1/users/2.json', user(ROWS.map(r => r.slice(0, 5)), 2, false));
  write('data1/own/users/2.json', user(ROWS, 2));                                          // converted: has notes, decks, durations
  write('data1/own/users/3.json', user(ROWS, 3));
  write('data1/users/4.json', '{"card_id":[NaN]}');                                          // junk
  write('data1/users/5.json', { ...user(ROWS, 5), rating: ROWS.map(() => 99) });
  write('data1/users/notes.txt', 'ignored'); write('data1/users/abc.json', 'ignored');
  assert.deepEqual(anki.available({ root }), { ok: true });
  assert.equal(anki.describe({ root }).learners, 5);
  const skipped = [];
  const got = [...anki.learners({ root, onSkip: (id, why) => skipped.push([id, why]) })];
  assert.deepEqual(got.map(l => l.id), ['1', '2', '3']);
  assert.deepEqual(skipped.map(s => s[0]), ['4', '5']);
  assert.equal(got[0].meta.hasNote, false); assert.equal(got[1].meta.hasNote, true, 'own/users wins for user 2'); assert.equal(got[1].meta.hasDuration, true);
  assert.ok(got.every(l => l.source === 'anki10k' && l.split === splitOf(l.id)));
  // split, users and limit filters
  const sp = [...anki.learners({ root, split: 'train' })].map(l => l.id);
  assert.deepEqual(sp, ['1', '2', '3'].filter(id => splitOf(id) === 'train'));
  assert.deepEqual([...anki.learners({ root, users: [3] })].map(l => l.id), ['3']);
  assert.equal([...anki.learners({ root, limit: 1 })].length, 1);
  assert.equal(anki.describe({ root }).split.train + anki.describe({ root }).split.val + anki.describe({ root }).split.test, 5);
});

test('a file that is too big is refused before it is read', () => {
  const root = path.join(tmp, 'data2');
  write('data2/users/1.json', user(ROWS, 1));
  const was = LIMITS.maxFileBytes;
  LIMITS.maxFileBytes = 50;
  try {
    const skipped = [];
    assert.deepEqual([...anki.learners({ root, onSkip: (id, why) => skipped.push(why) })], []);
    assert.deepEqual(skipped, ['file too large']);
  } finally { LIMITS.maxFileBytes = was; }
  assert.equal([...anki.learners({ root })].length, 1);
});

// ---------- convert.py (needs pyarrow: skipped where the venv is missing) ----------
const PY = [path.join(os.homedir(), 'fsrs-venv', 'bin', 'python'), 'python3'].find(p => { const r = spawnSync(p, ['-I', '-c', 'import pyarrow'], { stdio: 'ignore' }); return r.status === 0; });
const CONVERT = fileURLToPath(new URL('../tools/own-model/data/convert.py', import.meta.url));

test('convert.py refuses a data folder inside the repo', t => {
  if (!PY) return t.skip('pyarrow is not installed');
  const r = spawnSync(PY, ['-I', CONVERT, '--data', REPO], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside the repo/);
  const r2 = spawnSync(PY, ['-I', CONVERT, '--data', path.join(REPO, 'tools', 'own-model', 'out')], { encoding: 'utf8' });
  assert.match(r2.stderr, /inside the repo/);
});

test('convert.py turns made-up parquet files into files the source accepts, resumably', t => {
  if (!PY) return t.skip('pyarrow is not installed');
  const root = path.join(tmp, 'data3');
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true }); fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
  const make = `
import sys, pyarrow as pa, pyarrow.parquet as pq
root = sys.argv[1]
def put(name, cols): pq.write_table(pa.table(cols), root + '/' + name)
# user 1: with meta. rows: one bad rating (9), one negative day, one bad duration
put('raw/1.parquet', {'card_id': [10, 10, 11, 11, 11], 'day_offset': [0, 3, 0, 1, -4], 'rating': [3, 9, 1, 3, 3], 'state': [0, 2, 0, 1, 2],
  'duration': [5000, 7000, 99999999999, 4000, 4000], 'elapsed_days': [-1, 3, -1, 1, 1], 'elapsed_seconds': [-1, 259000, -1, 86000, 5]})
put('meta/cards-1.parquet', {'card_id': [10, 11], 'note_id': [100, 101], 'deck_id': [7, 8]})
put('meta/decks-1.parquet', {'deck_id': [7, 8], 'parent_id': [0, 0], 'preset_id': [70, 80]})
# user 2: no meta
put('raw/2.parquet', {'card_id': [1, 1], 'day_offset': [0, 2], 'rating': [3, 3], 'state': [0, 2], 'duration': [3000, 3000], 'elapsed_days': [-1, 2], 'elapsed_seconds': [-1, 172800]})
# user 3: a column missing
put('raw/3.parquet', {'card_id': [1], 'day_offset': [0], 'rating': [3]})
`;
  assert.equal(spawnSync(PY, ['-I', '-c', make, root], { encoding: 'utf8' }).status, 0);
  const run = () => spawnSync(PY, ['-I', CONVERT, '--data', root], { encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"users": 2/); assert.match(r.stdout, /"refused": 1/);
  const o1 = JSON.parse(fs.readFileSync(path.join(root, 'own', 'users', '1.json'), 'utf8'));
  assert.deepEqual(o1.card_id, [10, 11, 11]);                  // the bad-rating row and the negative-day row are gone
  const out = (u) => JSON.parse(fs.readFileSync(path.join(root, 'own', 'users', `${u}.json`), 'utf8'));
  assert.equal(out(1).rating.length, out(1).card_id.length);
  assert.deepEqual(out(1).note_id, [100, 101, 101]);
  assert.deepEqual(out(1).deck_id, [7, 8, 8]);
  assert.deepEqual(out(1).preset_id, [70, 80, 80]);
  assert.equal(out(1).duration_ms[1], null, 'an impossible duration becomes unknown');
  assert.equal(out(2).note_id, null); assert.equal(out(2).deck_id, null); assert.deepEqual(out(2).duration_ms, [3000, 3000]);
  assert.ok(!fs.existsSync(path.join(root, 'own', 'users', '3.json')));
  // what it writes, the source accepts
  const got = [...anki.learners({ root })];
  assert.deepEqual(got.map(l => l.id), ['1', '2']);
  // resumable: a second run converts nothing new and changes nothing
  const before = fs.readFileSync(path.join(root, 'own', 'users', '1.json'), 'utf8');
  r = run();
  assert.match(r.stdout, /"users": 0/);
  assert.equal(fs.readFileSync(path.join(root, 'own', 'users', '1.json'), 'utf8'), before);
  // --force converts finished users again (after the meta files arrived, say): a changed meta file shows up in the new output
  fs.rmSync(path.join(root, 'meta', 'cards-1.parquet'));
  r = spawnSync(PY, ['-I', CONVERT, '--data', root, '--force'], { encoding: 'utf8' });
  assert.match(r.stdout, /"users": 2/);
  assert.equal(out(1).note_id, null, 'converted again without the removed meta file');
  // the schema command prints names and types only
  const s = spawnSync(PY, ['-I', CONVERT, '--data', root, '--schema'], { encoding: 'utf8' });
  assert.match(s.stdout, /card_id/);
});

test('fetch.py --meta: downloads cards and decks tables under the names convert.py reads, skips finished ones, survives a failure (no network: fake downloader)', t => {
  const FETCH = fileURLToPath(new URL('./realdata/fetch.py', import.meta.url));
  const dir = fs.mkdtempSync(path.join(tmp, 'meta-'));
  const script = `
import sys, os, types
for name in ('pyarrow', 'pyarrow.parquet'): sys.modules[name] = types.ModuleType(name)
src = open(sys.argv[1]).read().replace('\\nmain()\\n', '\\n')
g = {'__name__': 'fetch_under_test'}
exec(compile(src, 'fetch.py', 'exec'), g)
urls = []
def fake(url, token):
    urls.append(url)
    if 'decks/user_id=8/' in url: raise OSError('down')
    return b'PAR1'
g['get'] = fake
d = sys.argv[2]
g['fetch_meta'](7, d, 't'); g['fetch_meta'](8, d, 't'); g['fetch_meta'](7, d, 't')
print(sorted(os.listdir(d)), len(urls))
`;
  const r = spawnSync('python3', ['-I', '-c', script, FETCH, dir], { encoding: 'utf8' });
  if (r.error) return t.skip('python3 is not available');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\['cards-7\.parquet', 'cards-8\.parquet', 'decks-7\.parquet'\] 4/);
  assert.match(fs.readFileSync(FETCH, 'utf8'), /--meta/);
});
