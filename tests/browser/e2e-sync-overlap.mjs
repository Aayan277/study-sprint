// Pulling re-reads a short stretch behind the bookmark, so a change the server numbered earlier but made visible later
// (several devices sending at once) is not missed. Uses the fake Supabase; the late row is put in with a number below
// the device's bookmark, like a slow transaction committing after a faster one.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const fake = fakeSupabase();
const asked = [];            // the "after" number of every pull request
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/rest/v1/sync_items' && route.request().method() === 'GET') asked.push(Number(u.searchParams.get('seq').replace('gt.', '')));
  return fake.handle(route);
});
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(`pageerror ${e.stack}`));
page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422)|Sync failed|Failed to load resource/.test(m.text())) errors.push(`console ${m.text()}`); });
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
const run = (fn, arg) => page.evaluate(fn, arg);
const syncNow = () => run(async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const state = () => run(async () => (await (await import('./js/db.js')).getSettings()).syncState);
const cardIds = () => run(async () => (await (await import('./js/db.js')).getAll('cards')).map(c => c.id));
const pending = () => run(async () => (await import('./js/sync.js')).pendingChanges());
const settle = async () => { for (let i = 0; i < 6; i++) { const l = await syncNow(); if (l.state === 'done' && !l.sent && !l.applied) return l; } return syncNow(); };

await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *');
await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click('#syncCreate');
await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
await settle();

// Two other devices' changes arrive; the one numbered 5000 becomes visible first and this device pulls it.
const uid = fake.userRows('me@example.com')[0].user_id;
const row = (id, seq, front = id) => ({ user_id: uid, store: 'cards', id, data: { id, deckId: 'sample', front, back: 'b', tags: [], created: 1 }, deleted: false, updated_at: Date.now() - 1000, seq });
const base = Math.max(...fake.userRows('me@example.com').map(r => r.seq));
fake.rows.set(`${uid}|cards|fast`, row('fast', base + 2));
await settle();
let st = await state();
ok((await cardIds()).includes('fast') && st.lastSeq === base + 2, `the fast change is pulled; the bookmark is ${st.lastSeq}`);
ok(Array.isArray(st.seqLog) && st.seqLog.length >= 1, 'a log of pulls is kept next to the bookmark');

// The slow one (numbered earlier, base + 1) becomes visible now.
fake.rows.set(`${uid}|cards|slow`, row('slow', base + 1));
const l = await syncNow();
ok((await cardIds()).includes('slow'), 'the late change, numbered below the bookmark, is picked up');
ok(l.applied === 1, 'only it counted as new: ' + l.applied);
st = await state();
ok(st.lastSeq === base + 2, 'the bookmark did not move backwards: ' + st.lastSeq);

// Rows read again are harmless: nothing counts as new or waits to be sent, and the bookmark stays put.
const before = await run(async () => { const db = await import('./js/db.js'); return JSON.stringify((await db.getAll('cards')).sort((a, b) => a.id < b.id ? -1 : 1)); });
const l2 = await syncNow();
const after = await run(async () => { const db = await import('./js/db.js'); return JSON.stringify((await db.getAll('cards')).sort((a, b) => a.id < b.id ? -1 : 1)); });
ok(l2.applied === 0 && l2.sent === 0 && await pending() === 0 && before === after, `re-read rows change nothing (applied ${l2.applied}, sent ${l2.sent}, pending ${await pending()})`);
ok((await state()).lastSeq === base + 2, 'bookmark unchanged');

// Old history: with the log reaching back well past the window, a pull only asks from the bookmark of 2+ minutes before
// the previous pull (here: the bookmark itself), so a quiet account re-reads nothing.
await run(async seq => {
  const db = await import('./js/db.js'); const s = (await db.getSettings()).syncState;
  await db.setSetting('syncState', { ...s, seqLog: [{ t: Date.now() - 20 * 60000, seq }, { t: Date.now() - 10 * 60000, seq }, { t: Date.now() - 5 * 60000, seq }] });
}, base + 2);
asked.length = 0;
await syncNow();
ok(asked.length >= 1 && asked[0] === base + 2, 'a quiet account with old history asks only after the bookmark: ' + asked.join(','));

// A deleted record and a setting that arrive late behave the same way.
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.saveCards([{ id: 'victim', deckId: 'sample', front: 'v', back: 'v', tags: [], created: Date.now() }]); });
await settle();
const top = Math.max(...fake.userRows('me@example.com').map(r => r.seq));
fake.rows.set(`${uid}|cards|after`, row('after', top + 2));
await settle();
fake.rows.set(`${uid}|cards|victim`, { ...row('victim', top + 1), data: null, deleted: true, updated_at: Date.now() + 5000 });
await syncNow();
ok(!(await cardIds()).includes('victim'), 'a delete that became visible late is applied too');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
