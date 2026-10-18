// One malformed row from the server must not stop that account's sync for good (audit: DataError rolled the whole page back and the
// bookmark never moved). Bad rows are skipped, counted in a small local log, and told once in Settings → Sync; good rows on the same
// page are applied; a record's key always comes from the row id, so data naming another record can't overwrite it.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
async function device(name, fake) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const settings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const signIn = async (page, create) => {
  await settings(page);
  await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
  await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
};
const NOW = Date.now();

// ================= the audit's four cases, straight into the database =================
{
  const fake = fakeSupabase();
  const C = await device('C', fake);
  const res = await run(C, async () => {
    const db = await import('./js/db.js');
    const out = {};
    const good = n => ({ store: 'cards', id: 'ok-' + n, data: { id: 'ok-' + n, deckId: 'sample', front: 'a', back: 'b', tags: [] }, deleted: false, updated_at: Date.now(), seq: n });
    const cases = {
      noId: { store: 'cards', id: 'x1', data: { deckId: 'd', front: 'a', back: 'b' }, deleted: false, updated_at: Date.now(), seq: 11 },
      noCardId: { store: 'cardStates', id: 'x2', data: { due: 1 }, deleted: false, updated_at: Date.now(), seq: 12 },
      string: { store: 'cards', id: 'x3', data: 'oops', deleted: false, updated_at: Date.now(), seq: 13 },
      nullData: { store: 'decks', id: 'x4', data: null, deleted: false, updated_at: Date.now(), seq: 14 }
    };
    for (const [name, bad] of Object.entries(cases)) {
      try { out[name] = await db.applyRemote([good(bad.seq), bad]); } catch (e) { out[name] = 'THREW ' + e.name; }
    }
    const cards = await db.getAll('cards');
    out.saved = cards.filter(c => c.id.startsWith('ok-')).map(c => c.id).sort();
    out.log = (await db.getSettings()).syncDamaged;
    out.noGhosts = !cards.some(c => ['x1', 'x3'].includes(c.id)) && !(await db.getAll('cardStates')).some(s => s.cardId === 'x2') && !(await db.getDecks()).some(d => d.id === 'x4');
    return out;
  });
  ok(['noId', 'noCardId', 'string', 'nullData'].every(k => res[k] === 1), 'each bad row is skipped without an error, and the good row beside it is applied: ' + JSON.stringify([res.noId, res.noCardId, res.string, res.nullData]));
  ok(res.saved.length === 4, 'all four good rows were saved');
  ok(res.log?.count === 4 && res.log.items.length === 4 && res.log.items.every(i => i.store && i.id && i.why), 'the local log lists the four: ' + JSON.stringify(res.log?.items?.map(i => i.why)));
  ok(res.noGhosts, 'nothing was saved from the bad rows');
  await C.context().close();
}

// ================= through a real sync =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signIn(A, true);                                     // the account exists (with the sample deck)
  fake.inject('me@example.com', { store: 'cards', id: 'good-1', data: { id: 'good-1', deckId: 'sample', front: 'Good one', back: 'b', tags: [], created: NOW }, updated_at: NOW + 10 });
  fake.inject('me@example.com', { store: 'cards', id: 'bad-1', data: { deckId: 'sample', front: 'No id', back: 'b' }, updated_at: NOW + 11 });
  fake.inject('me@example.com', { store: 'cardStates', id: 'bad-2', data: { due: 5 }, updated_at: NOW + 12 });
  fake.inject('me@example.com', { store: 'cards', id: 'bad-3', data: 'oops', updated_at: NOW + 13 });
  fake.inject('me@example.com', { store: 'decks', id: 'bad-4', data: null, updated_at: NOW + 14 });
  // data that names ANOTHER record: the row's own id decides, the card it points at is untouched
  fake.inject('me@example.com', { store: 'cards', id: 'evil', data: { id: 'sample-0', deckId: 'sample', front: 'HACKED', back: 'b', tags: [] }, updated_at: NOW + 20 });
  fake.inject('me@example.com', { store: 'cards', id: 'good-2', data: { id: 'good-2', deckId: 'sample', front: 'Good two, after the bad ones', back: 'b', tags: [], created: NOW }, updated_at: NOW + 30 });
  const maxSeq = Math.max(...fake.userRows('me@example.com').map(r => r.seq));

  const B = await device('B', fake);
  await signIn(B, false);
  const snap = await run(B, async () => {
    const db = await import('./js/db.js');
    const cards = await db.getAll('cards');
    const s = await db.getSettings();
    return { ids: cards.map(c => c.id), sample0: cards.find(c => c.id === 'sample-0')?.front, evil: cards.find(c => c.id === 'evil'), lastSeq: s.syncState?.lastSeq, log: s.syncDamaged, onlyLocal: Object.keys(s).includes('syncDamaged') };
  });
  ok(snap.ids.includes('good-1') && snap.ids.includes('good-2'), 'good rows before and after the bad ones were applied');
  ok(!snap.ids.some(i => i.startsWith('bad-')), 'no bad row became a record');
  ok(snap.lastSeq >= maxSeq, `the bookmark moved past the bad rows (${snap.lastSeq} >= ${maxSeq}), so the sync does not get stuck`);
  ok(snap.sample0 !== 'HACKED' && snap.evil?.id === 'evil', 'a row whose data names another card gets its own id and does not overwrite that card');
  ok(snap.log?.count === 4, 'four rows were counted as damaged: ' + snap.log?.count);

  // a second sync reads the same rows again (the pull overlaps): not counted twice, and no error
  const st = await run(B, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
  const again = await run(B, async () => (await (await import('./js/db.js')).getSettings()).syncDamaged);
  ok(st.state === 'done' && again.count === 4, 'syncing again is fine and does not count them again');
  // the damaged rows are local-only: they never go to the server
  ok(!fake.userRows('me@example.com').some(r => r.id === 'syncDamaged'), 'the log stays on this device');

  // the quiet note in Settings → Sync, once
  await settings(B);
  const note = await B.textContent('#damagedNote');
  ok(/4 synced records were damaged and skipped/.test(note), 'Settings → Sync says so: ' + note.trim());
  await B.screenshot({ path: process.argv[2] + '/damaged-note.png', fullPage: true }).catch(() => {});
  await B.click('#damagedOk'); await B.waitForSelector('#damagedNote', { state: 'hidden' });
  ok(await B.isHidden('#damagedNote'), 'Dismiss hides it');
  await settings(B);
  ok(await B.isHidden('#damagedNote'), 'and it stays hidden');
  // new damage later shows again
  fake.inject('me@example.com', { store: 'cards', id: 'bad-5', data: [1], updated_at: Date.now() + 40 });
  await run(B, async () => { const s = await import('./js/sync.js'); await s.syncNow(); });
  await settings(B);
  ok(/1 synced record was damaged and skipped/.test(await B.textContent('#damagedNote')), 'a new damaged row is told again: ' + (await B.textContent('#damagedNote')).trim());
  await A.context().close(); await B.context().close();
}

ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
await browser.close();
