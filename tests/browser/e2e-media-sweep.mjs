// The 30-day wait before pictures are deleted from the account (js/media-sweep.js), with two devices and the fake server:
// a device that still uses a marked picture un-marks it, a device that still has a swept picture sends it again, and a
// retry of a picture the account already holds counts as done even when the account is full.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const SUPA = 'https://lakxeftzlpvydzulxrbi.supabase.co/**';
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  await ctx.route(SUPA, fake.handle);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name} ${e.stack}`));
  p.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422)|Picture sync failed|Sync failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  return p;
}
const run = (p, fn, arg) => p.evaluate(fn, arg);
const syncNow = p => run(p, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const waitSynced = p => p.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 20000 });
const signIn = async (p, create) => {
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck'); await p.goto(APP + '#/settings'); await p.waitForSelector('#syncEmail');
  await p.fill('#syncEmail', 'me@example.com'); await p.fill('#syncPw', 'secret123'); await p.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
  await waitSynced(p);
};
const DAY = 86400000;
// A device cut off from the server (the fake's own "down" switch would cut off everybody). Returns the way back.
const cut = async p => { const f = r => r.abort('connectionrefused'); await p.context().route(SUPA, f); return () => p.context().unroute(SUPA, f); };
// Give a card a picture (a tiny made-up file), or take it away.
const setPic = (p, card, id) => run(p, async ([card, id]) => {
  const db = await import('./js/db.js');
  const c = await db.get('cards', card);
  if (id && !(await db.getMedia(id))) await db.putMedia({ id, type: 'image/jpeg', data: new Uint8Array([255, 216, 255, id.length]).buffer, size: 4, created: 0, uploaded: false });
  const { frontImage, ...rest } = c;
  await db.saveCards([id ? { ...rest, frontImage: id } : rest]);
}, [card, id]);
const editFront = (p, card, text) => run(p, async ([card, text]) => { const db = await import('./js/db.js'); await db.saveCards([{ ...(await db.get('cards', card)), front: text }]); }, [card, text]);
const dropOld = (p, id) => run(p, async id => { const db = await import('./js/db.js'); const m = await db.getMedia(id); if (m) await db.putRemoteMedia({ ...m, created: 0 }); }, id);   // pretend it's old
const marks = p => run(p, async () => (await import('./js/db.js')).mediaMarks());
const ageMark = (p, id) => run(p, async id => {          // pretend it was marked, and first seen here, a month ago
  const m = await import('./js/media-sweep.js'), db = await import('./js/db.js');
  await db.setSetting(m.markKey(id), Date.now() - 31 * 86400000); await db.setSetting(m.seenKey(id), Date.now() - 31 * 86400000);
}, id);
const hasMedia = (p, id) => run(p, async id => !!(await (await import('./js/db.js')).getMedia(id)), id);
const file = id => fake.files.has('user-1/' + id);

const A = await device('A');
await signIn(A, true);
const B = await device('B');
await signIn(B, false);
await setPic(A, 'sample-0', 'pX'); await setPic(A, 'sample-1', 'pY');
await syncNow(A); await syncNow(B);
ok(file('pX') && file('pY') && await hasMedia(B, 'pX') && await hasMedia(B, 'pY'), 'setup: both pictures are in the account and on B');

// (a) A stops using X and marks it; B, which still uses it, un-marks it; A's month-old mark does not delete it.
let unblock = await cut(B);
await setPic(A, 'sample-0', null); await dropOld(A, 'pX');
await syncNow(A);
ok(file('pX') && 'pX' in (await marks(A)).marks, 'A: the unused picture is marked, and the account keeps it');
await editFront(B, 'sample-0', 'B edited this');           // later than A's change, so B's card (with the picture) wins
await unblock();
await syncNow(B);
ok(!('pX' in (await marks(B)).marks), 'B: it still uses the picture, so it un-marks it');
await syncNow(B);
await ageMark(A, 'pX');
await syncNow(A); await syncNow(A);
ok(file('pX'), 'A: even with a month-old mark, the picture stays (B un-marked it)');
ok(!('pX' in (await marks(A)).marks) && !('pX' in (await marks(B)).marks), 'and neither device has it marked');

// (b) B holds Y offline and still uses it; A sweeps it; B sends it again.
unblock = await cut(B);
await setPic(A, 'sample-1', null); await dropOld(A, 'pY');
await syncNow(A);
ok('pY' in (await marks(A)).marks, 'A: Y is marked');
await editFront(B, 'sample-1', 'B edited this too');
await ageMark(A, 'pY');
await syncNow(A);
ok(!file('pY') && (await marks(A)).gone.includes('pY'), 'A: after the wait, Y is deleted from the account and marked gone');
await unblock();
await syncNow(B);
ok(!(await marks(B)).gone.includes('pY'), 'B: it sends Y again and clears the mark');
await syncNow(B);
ok(file('pY'), 'B: Y is back in the account');
await syncNow(A);
ok(!(await marks(A)).gone.includes('pY'), 'A: sees the mark cleared');

// (c) A retry of a picture the account already holds, at a full account, is done (not "account is full").
const email = 'me@example.com';
for (const id of ['pZ', 'pW']) {
  await run(A, async id => (await import('./js/db.js')).putMedia({ id, type: 'image/jpeg', data: new Uint8Array([255, 216, 255, 9]).buffer, size: 4, created: Date.now(), uploaded: false }), id);
  fake.files.set('user-1/' + id, { type: 'image/jpeg', data: Buffer.from([255, 216, 255, 9]) });
}
fake.setMediaFull(true);                      // the server turns every new upload away (the "add" rule)
const st = await syncNow(A);
const up = id => run(A, async id => (await (await import('./js/db.js')).getMedia(id)).uploaded, id);
ok(await up('pZ') && await up('pW'), 'refused upload of a picture the account has: marked as sent');
ok(!st.note, 'and no "account is full" note: ' + st.note);
fake.setMediaFull(false);
fake.setLimit(email, 1);                      // now the space check itself keeps new files back
await run(A, async id => { const db = await import('./js/db.js'); const m = await db.getMedia(id); await db.putMedia({ ...m, uploaded: false }); }, 'pZ');
const st2 = await syncNow(A);
ok(await up('pZ') && !st2.note, 'kept back for lack of room, but the account has it: marked as sent, no note');

// (d) A mark whose time is ahead of this clock (another device's clock was fast): an un-mark is still stamped later, so the server takes it.
await run(A, async () => { const db = await import('./js/db.js'); await db.setSetting('mdel:pF', Date.now(), { at: Date.now() + 3 * 3600000 }); });
await syncNow(A);
const rowF = () => fake.rows.get('user-1|settings|mdel:pF');
ok(typeof rowF()?.data?.value === 'number', 'setup: a mark stamped hours ahead is on the server');
await run(A, async () => (await import('./js/db.js')).setSettings([['mdel:pF', null]]));
await syncNow(A);
ok(rowF()?.data?.value === null, 'its un-mark still wins on the server');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
