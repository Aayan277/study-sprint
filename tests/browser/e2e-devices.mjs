// Shared device: signing in must never put the last person's cards into the next person's account (audit finding), and never
// pull a stranger's cards into a new account without asking. Same account and the sample deck alone: no question.
// Uses the real browser launcher (not the one that taps "Add these cards" by itself), so the question is seen.
import { realChromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await realChromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const fake = fakeSupabase();

async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const openSettings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const fillForm = async (page, { email, create = false, pw = 'secret123' }) => {
  await openSettings(page);
  await page.fill('#syncEmail', email); await page.fill('#syncPw', pw);
  await page.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
};
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const asked = page => page.waitForSelector('#sheet[open] #sheetTitle', { timeout: 5000 }).then(() => page.textContent('#sheetTitle')).catch(() => null);
const addCards = (page, deckId, n) => run(page, async ({ deckId, n }) => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: deckId, name: deckId, color: '#46A758', created: now }, Array.from({ length: n }, (_, i) => ({ id: `${deckId}-${i}`, deckId, front: `${deckId} ${i}`, back: 'b', tags: [], created: now + i })));
}, { deckId, n });
const state = page => run(page, async () => {
  const db = await import('./js/db.js'); const s = await db.getSettings();
  return { decks: (await db.getDecks()).map(d => d.id).sort(), cards: (await db.getAll('cards')).length, user: s.syncAuth?.user?.email || null, owner: s.syncState?.userId || null };
});
const serverCards = (email, prefix) => fake.userRows(email).filter(r => r.store === 'cards' && !r.deleted && r.id.startsWith(prefix)).length;
const logins = () => fake.log.filter(l => l.includes('/auth/v1/token?grant_type=password')).length;
const logouts = () => fake.log.filter(l => l.includes('/auth/v1/logout')).length;

// ================= the sample deck alone, and the same account: no question =================
const A = await device('A');
await fillForm(A, { email: 'ann@example.com', create: true });
await waitSynced(A);
ok((await state(A)).user === 'ann@example.com', 'a device with only the sample deck creates an account without a question');
await addCards(A, 'anndeck', 4);
await run(A, async () => { await (await import('./js/sync.js')).syncNow(); });
ok(serverCards('ann@example.com', 'anndeck') === 4, "Ann's four cards are in her account");
await run(A, async () => { await (await import('./js/sync.js')).signOut({}); });          // signed out, cards kept
await fillForm(A, { email: 'ann@example.com' });
await waitSynced(A);
ok((await state(A)).user === 'ann@example.com' && !(await A.isVisible('#sheet[open]')), 'signing back in to the same account: no question');

// ================= a different account =================
await run(A, async () => { await (await import('./js/sync.js')).signOut({}); });
// (Bob's account is made on another clean device)
const Z = await device('Z');
await fillForm(Z, { email: 'bob@example.com', create: true }); await waitSynced(Z);
await addCards(Z, 'bobdeck', 2); await run(Z, async () => { await (await import('./js/sync.js')).syncNow(); });
const bobRows = fake.userRows('bob@example.com').length;
await fillForm(A, { email: 'bob@example.com' });
const title = await asked(A);
ok(title === 'This device has cards from another account', 'signing in as Bob on Ann\'s device asks first: ' + title);
const btns = await A.$$eval('#sheet button', bs => bs.map(b => b.textContent.trim()).filter(Boolean));
ok(btns.includes('Remove them and sign in') && btns.includes('Cancel') && !btns.some(t => /^Add these/.test(t)), 'with "Remove them and sign in" and "Cancel": ' + btns.join(' | '));
ok((await state(A)).user === null, 'and nobody is signed in while the question is open');
await A.click('#devCancel');
await A.waitForSelector('#sheet:not([open])', { state: 'attached' });
let st = await state(A);
ok(st.user === null && st.decks.includes('anndeck') && st.cards >= 4, "Cancel: still signed out, Ann's cards untouched");
ok(logouts() >= 1 && fake.userRows('bob@example.com').length === bobRows && serverCards('bob@example.com', 'anndeck') === 0, "and nothing of Ann's reached Bob's account");
ok(!(await A.isDisabled('#syncCreate')), 'the sign-in form works again');
await A.click('#syncForm button[type=submit]');
await A.waitForSelector('#sheet[open] #devRemove');
await A.click('#sheet .sheet-x'); await A.waitForSelector('#sheet:not([open])', { state: 'attached' });
ok((await state(A)).user === null && (await state(A)).decks.includes('anndeck'), 'closing the question counts as Cancel');
await A.click('#syncForm button[type=submit]');
await A.waitForSelector('#sheet[open] #devRemove');
await A.click('#devRemove');
await waitSynced(A);
st = await state(A);
ok(st.user === 'bob@example.com' && !st.decks.includes('anndeck') && st.decks.includes('bobdeck'), "Remove them and sign in: Ann's cards are gone, Bob's came down");
ok(serverCards('bob@example.com', 'anndeck') === 0 && serverCards('ann@example.com', 'anndeck') === 4, "Ann's cards never reached Bob's account, and Ann's own account still has them");

// ================= cards that were never in an account =================
const L = await device('L');
await addCards(L, 'local', 5);
await fillForm(L, { email: 'cat@example.com', create: true });
ok(await asked(L) === "This device has cards that aren't in an account", 'local cards and no account: asks first');
const lb = await L.$$eval('#sheet button', bs => bs.map(b => b.textContent.trim()).filter(Boolean));
ok(lb.includes('Add these 5 cards to your account') && lb.includes('Start fresh (remove them)') && lb.includes('Cancel'), 'with three choices: ' + lb.join(' | '));
ok(!fake.users.has('cat@example.com') || serverCards('cat@example.com', 'local') === 0, 'nothing was sent while asking');
await L.click('#devCancel'); await L.waitForSelector('#sheet:not([open])', { state: 'attached' });
ok((await state(L)).user === null && (await state(L)).decks.includes('local'), 'Cancel: nothing changed, still signed out');
// (Cat's account now exists from the sign-up; sign in to it from the same form)
await L.click('#syncForm button[type=submit]');
await L.waitForSelector('#sheet[open] #devFresh');
await L.click('#devFresh');
await waitSynced(L);
st = await state(L);
ok(st.user === 'cat@example.com' && !st.decks.includes('local') && serverCards('cat@example.com', 'local') === 0, 'Start fresh: the local cards are removed and not sent');
// a second device with local cards that DO get added
const M = await device('M');
await addCards(M, 'mine', 3);
await fillForm(M, { email: 'cat@example.com' });
await M.waitForSelector('#sheet[open] #devAdd');
ok((await M.textContent('#devAdd')) === 'Add these 3 cards to your account', 'the button counts the cards (not the sample deck)');
await M.click('#devAdd');
await waitSynced(M);
ok(serverCards('cat@example.com', 'mine') === 3 && (await state(M)).decks.includes('mine'), 'Add: the cards go into the account and stay on the device');

// ================= creating an account on a device that has another account's cards =================
const N = await device('N');
await fillForm(N, { email: 'dan@example.com', create: true }); await waitSynced(N);
await addCards(N, 'dandeck', 2); await run(N, async () => { await (await import('./js/sync.js')).syncNow(); });
await run(N, async () => { await (await import('./js/sync.js')).signOut({}); });
await fillForm(N, { email: 'eve@example.com', create: true });
ok(await asked(N) === 'This device has cards from another account', 'Create account on someone else\'s device asks too');
await N.click('#devCancel'); await N.waitForSelector('#sheet:not([open])', { state: 'attached' });
ok((await state(N)).user === null && serverCards('eve@example.com', 'dandeck') === 0, 'Cancel there: nothing merged');

// ================= a device that belongs to another account, with no cards of its own =================
{
  const signOutKeep = page => run(page, async () => { await (await import('./js/sync.js')).signOut({}); });
  // only defaults: the next person signs in without a question
  const Y = await device('Y');
  await fillForm(Y, { email: 'fay@example.com', create: true }); await waitSynced(Y);
  await signOutKeep(Y);
  await fillForm(Y, { email: 'gus@example.com', create: true });
  await waitSynced(Y);
  ok((await state(Y)).user === 'gus@example.com', 'an account\'s device holding only defaults: the next person signs in without a question');
  // a changed synced setting is the previous person's
  const S = await device('S');
  await fillForm(S, { email: 'hal@example.com', create: true }); await waitSynced(S);
  await run(S, async () => { await (await import('./js/db.js')).setSetting('newPerDay', 35); await (await import('./js/sync.js')).syncNow(); });
  await signOutKeep(S);
  await fillForm(S, { email: 'ida@example.com', create: true });
  ok(await asked(S) === 'This device has cards from another account', 'no cards, but the previous person\'s study settings are there: asks');
  ok((await S.textContent('#sheet')).includes('progress and settings'), 'and says it is progress and settings');
  await S.click('#devCancel'); await S.waitForSelector('#sheet:not([open])', { state: 'attached' });
  ok((await state(S)).user === null, 'Cancel: nothing signed in');
  // a review of a sample card is the previous person's progress
  const V = await device('V');
  await fillForm(V, { email: 'jon@example.com', create: true }); await waitSynced(V);
  await run(V, async () => {
    const db = await import('./js/db.js');
    await db.saveReview({ cardId: 'sample-0', due: Date.now() + 86400000, stability: 2, difficulty: 5, reps: 1, lapses: 0, state: 2 }, { cardId: 'sample-0', timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 0 });
  });
  await signOutKeep(V);
  await fillForm(V, { email: 'kim@example.com', create: true });
  ok(await asked(V) === 'This device has cards from another account', 'a review of a sample card counts: asks');
  await V.click('#devCancel'); await V.waitForSelector('#sheet:not([open])', { state: 'attached' });
  // a card added to the sample deck is the previous person's card
  const W = await device('W');
  await fillForm(W, { email: 'lee@example.com', create: true }); await waitSynced(W);
  await run(W, async () => { await (await import('./js/db.js')).saveCards([{ id: 'mine-in-sample', deckId: 'sample', front: 'q', back: 'a', tags: [], created: Date.now() }]); });
  await signOutKeep(W);
  await fillForm(W, { email: 'max@example.com', create: true });
  ok(await asked(W) === 'This device has cards from another account', 'a card added to the sample deck counts: asks');
  await W.click('#devCancel'); await W.waitForSelector('#sheet:not([open])', { state: 'attached' });
}
ok(fake.log.some(l => l.includes('/auth/v1/logout')) && fake.log.filter(l => l.includes('/auth/v1/logout')).every(l => l.endsWith('?scope=local')), 'every sign-out (Cancel included) is scope=local, so the person\'s other devices stay signed in');

// ================= code path without the screen: never merges silently =================
const code = await run(N, async () => {
  const sync = await import('./js/sync.js');
  const v = await sync.deviceVerdict('someone-else');
  return v;
});
ok(code.kind === 'other' && code.cards === 2, 'the check itself says "other account" with the card count: ' + JSON.stringify(code));
const direct = await run(N, async () => {
  const sync = await import('./js/sync.js');
  try { await sync.signIn('eve@example.com', 'secret123', undefined); return 'signed in'; } catch (e) { return e.code; }
});
ok(direct === 'cancelled' && (await state(N)).user === null, 'with no one to ask, a sign-in on such a device is cancelled, not merged');

// ================= reset link for another account on a device with cards =================
const R = await device('R');
await addCards(R, 'rdeck', 2);
await R.goto(fake.recoveryLink('ann@example.com', APP));
await R.waitForSelector('#sheet[open] #pwForm');
await R.fill('#pw1', 'newpass456'); await R.fill('#pw2', 'newpass456'); await R.click('button[type=submit][form=pwForm]');
await R.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Password saved'));
st = await state(R);
ok(st.user === null && serverCards('ann@example.com', 'rdeck') === 0 && /sign in from Settings/.test(await R.textContent('#toast')), "a reset link for Ann on a device with other cards saves the password but does not sign in or send anything");

ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
await browser.close();
