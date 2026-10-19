// Launch polish, sign-in side: messages a stranger can act on (which box is marked, what the words say), "Sync is optional",
// the direct way to the Sync form (#/settings/sync), the "Email confirmed" sheet, and the grammar of "Add this 1 deck".
import { chromium, realChromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch({ autoAddCards: false });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const fake = fakeSupabase({ confirmEmail: true, existingAsFakeUser: true });
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
const A = await ctx.newPage();
A.on('pageerror', e => errors.push('pageerror ' + e.stack));
A.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Failed to load resource|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|Sync failed/.test(m.text())) errors.push('console ' + m.text()); });
const fill = async (email = 'me@example.com', pw = 'secret123') => { await A.fill('#syncEmail', email); await A.fill('#syncPw', pw); };
const state = () => A.evaluate(() => ({
  text: document.querySelector('#syncErr')?.hidden ? '' : document.querySelector('#syncErr')?.textContent,
  role: document.querySelector('#syncErr')?.getAttribute('role'),
  email: document.querySelector('#syncEmail')?.getAttribute('aria-invalid') === 'true',
  pw: document.querySelector('#syncPw')?.getAttribute('aria-invalid') === 'true'
}));
const settle = async () => { await A.waitForFunction(() => !document.querySelector('#syncErr')?.hidden || document.querySelector('#sheet[open]')); };
const clear = async () => { await A.reload(); await A.waitForSelector('#syncEmail'); };

// ---- MUST 2: optional, and the direct link ----
await A.goto(APP + '#/decks'); await A.waitForSelector('.deck');
await A.goto(APP + '#/settings/sync'); await A.waitForSelector('#syncEmail');
const box = await A.textContent('#syncBox');
ok(/Optional\./.test(box) && /works fully without an account/.test(box), 'the signed-out Sync box says it is optional');
ok(/New here\? Type your email/.test(box), 'and explains how to start');
const pos = await A.evaluate(() => ({ top: document.getElementById('syncTitle').getBoundingClientRect().top, h: innerHeight, focus: document.activeElement?.id }));
ok(pos.top >= 0 && pos.top < pos.h, '#/settings/sync scrolls the Sync heading into view: ' + Math.round(pos.top));
ok(pos.focus === 'syncTitle', 'and focuses the heading, not the email box: ' + pos.focus);
ok(await A.getAttribute('.tab[data-tab="settings"], a[data-tab="settings"]', 'aria-current') === 'page', 'the Settings tab stays highlighted');
const forgot = await A.evaluate(() => document.getElementById('forgotBtn').getBoundingClientRect().height);
ok(forgot >= 24, 'Forgot password? is at least 24px tall: ' + forgot);

// ---- MUST 1: sign up, sign in, errors ----
await fill(); await A.click('#syncCreate'); await A.waitForSelector('#pendOk');
ok(/Check your email/.test(await A.textContent('#sheet')), 'sign-up shows the Check your email sheet');
await A.click('#pendOk');
await A.click('#syncForm button[type=submit]'); await settle();
let s = await state();
ok(s.text.startsWith('Confirm your email first') && s.email && !s.pw, 'sign-in before confirming: email box marked, password not: ' + s.text);
await clear(); await fill('me@example.com', 'wrongpass1'); await A.click('#syncForm button[type=submit]'); await settle();
fake.confirm('me@example.com');
await A.click('#syncForm button[type=submit]'); await settle();
s = await state();
ok(/^Wrong email or password\./.test(s.text) && s.pw && !s.email, 'wrong password: only the password box is marked: ' + s.text);
fake.setRateLimited(true);
await clear(); await fill('other@example.com'); await A.click('#syncCreate'); await settle();
s = await state();
ok(/Too many/.test(s.text) && !s.email && !s.pw && s.role === 'alert', 'rate limit: no box marked, the message is an alert: ' + s.text);
fake.setRateLimited(false);
fake.setDown(true);
await clear(); await fill(); await A.click('#syncForm button[type=submit]'); await settle();
s = await state();
ok(/Check your connection/.test(s.text) && !/safe on this device/.test(s.text) && !s.email && !s.pw, 'server down: connection words, no box marked: ' + s.text);
await ctx.setOffline(true);
await fill(); await A.click('#syncForm button[type=submit]'); await settle();
s = await state();
ok(/You’re offline/.test(s.text), 'offline: says so: ' + s.text);
await ctx.setOffline(false); fake.setDown(false);
await clear(); await fill();
await A.click('#syncCreate'); await settle();
s = await state();
ok(/already an account/.test(s.text) && s.email && !s.pw && !(await A.isVisible('#sheet[open]')), 'create account for a confirmed email: "already an account" on the email box, no sheet: ' + s.text);
await clear(); await A.fill('#syncEmail', ''); await A.click('#forgotBtn'); await settle();
s = await state();
ok(s.email && !s.pw && /Type your email/.test(s.text), 'Forgot password with no email marks only the email box');
await A.fill('#syncPw', 'x'); await fill('', 'x'); await A.click('#syncForm button[type=submit]'); await settle();
await A.click('#forgotBtn');
s = await state();
ok(s.pw === false, 'Forgot password clears an old password error');

// ---- NICE A: Send the link again, and remembering a pending sign-up ----
{
  const f4 = fakeSupabase({ confirmEmail: true });
  const c4 = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await c4.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', f4.handle);
  const R = await c4.newPage();
  await R.goto(APP + '#/decks'); await R.waitForSelector('.deck');
  await R.goto(APP + '#/settings/sync'); await R.waitForSelector('#syncEmail');
  await R.fill('#syncEmail', 'wait@example.com'); await R.fill('#syncPw', 'secret123'); await R.click('#syncCreate'); await R.waitForSelector('#pendResend2');
  ok(f4.confirmations.length === 1, 'sign-up sent one email');
  ok(await R.isDisabled('#pendResend2') && (await R.textContent('#pendResend2')) === 'Sent ✓', 'the sheet button rests right after sign-up (the server allows one email a minute)');
  await R.click('#pendOk');
  ok(/Waiting for you to confirm\s*wait@example.com/.test((await R.textContent('#pendBox')).replace(/\s+/g, ' ')) && await R.isVisible('#pendResend'), 'the form now says it is waiting, with Send the link again');
  ok(await R.isDisabled('#pendResend'), 'the button in the form is resting too');
  // too soon: the server's own wait is shown and the button rests for that long
  await R.evaluate(() => { document.getElementById('pendResend').disabled = false; });
  await R.click('#pendResend');
  await R.waitForFunction(() => !document.querySelector('#syncErr')?.hidden);
  ok(/^Wait \d+ seconds, then try again\.$/.test(await R.textContent('#syncErr')), 'asking again too soon: "Wait N seconds": ' + await R.textContent('#syncErr'));
  ok(await R.isDisabled('#pendResend'), 'and the button rests');
  // a minute later: the sheet button closes the sheet and asks from the form (an interactive captcha could not be solved behind the sheet)
  f4.ageEmails();
  await R.goto(APP + '#/settings/sync'); await R.waitForSelector('#syncEmail');
  await R.fill('#syncPw', 'secret123'); await R.click('#syncCreate'); await R.waitForSelector('#pendResend2');
  ok(f4.confirmations.length === 2, 'Create account again sends it again');
  f4.ageEmails();
  await R.evaluate(() => { for (const id of ['pendResend2', 'pendResend']) document.getElementById(id).disabled = false; });
  await R.click('#pendResend2');
  await R.waitForFunction(() => !document.querySelector('#sheet[open]'));
  await R.waitForFunction(() => document.querySelector('#pendResend')?.textContent === 'Sent ✓');
  ok(f4.confirmations.length === 3 && f4.confirmations.at(-1).resent, 'the sheet button closes the sheet and the form button sends the email');
  await R.reload(); await R.waitForSelector('#syncEmail');
  ok(await R.inputValue('#syncEmail') === 'wait@example.com' && await R.isVisible('#pendBox'), 'after a reload the email is filled in and the waiting note is back');
  f4.ageEmails(); f4.setRateLimited(true);
  await R.click('#pendResend');
  await R.waitForFunction(() => !document.querySelector('#syncErr')?.hidden);
  ok(/Too many emails/.test(await R.textContent('#syncErr')), 'a general rate limit shows the rate-limit words: ' + await R.textContent('#syncErr'));
  f4.setRateLimited(false);
  const stored = await R.evaluate(async () => (await (await import('./js/db.js')).getSettings()).pendingSignup);
  ok(stored?.email === 'wait@example.com', 'the pending sign-up is stored on this device');
  f4.confirm('wait@example.com');
  await R.fill('#syncPw', 'secret123'); await R.click('#syncForm button[type=submit]');
  await R.waitForFunction(() => /^Synced|Signed in/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  ok(await R.evaluate(async () => (await (await import('./js/db.js')).getSettings()).pendingSignup) == null, 'signing in clears it');
  // unconfirmed sign-in offers the button too
  await c4.close();
}

// ---- MUST 3: Email confirmed ----
const f2 = fakeSupabase({ confirmEmail: true });
const c2 = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
await c2.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', f2.handle);
const B = await c2.newPage();
await B.goto(APP + '#/decks'); await B.waitForSelector('.deck');
await B.goto(APP + '#/settings/sync'); await B.waitForSelector('#syncEmail');
await B.fill('#syncEmail', 'new@example.com'); await B.fill('#syncPw', 'secret123'); await B.click('#syncCreate'); await B.waitForSelector('#pendOk'); await B.click('#pendOk');
await B.goto(f2.confirmLink('new@example.com', APP));
await B.waitForFunction(() => document.querySelector('#sheet[open] h2')?.textContent === 'Email confirmed');
ok(await B.evaluate(() => document.activeElement?.id) === 'cfSignIn', 'Email confirmed sheet: focus on Sign in');
ok(/different browser/.test(await B.textContent('#sheet')), 'and it mentions the other-browser case');
await B.click('#cfSignIn');
await B.waitForSelector('#syncEmail');
ok(new URL(B.url()).hash === '#/settings/sync', 'Sign in goes to the Sync form: ' + B.url());
ok(await B.isHidden('#pendBox') && await B.inputValue('#syncEmail') === 'new@example.com', 'after Email confirmed the form no longer says "Waiting for you to confirm", and the email is filled in');
await c2.close();

// ---- Add this 1 deck (grammar) ----
{
  const f3 = fakeSupabase();
  const c3 = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await c3.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', f3.handle);
  const D = await c3.newPage();
  await D.goto(APP + '#/decks'); await D.waitForSelector('.deck');
  // a second device's account to sign in to
  const E = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' })).newPage();
  await E.context().route('https://lakxeftzlpvydzulxrbi.supabase.co/**', f3.handle);
  await E.goto(APP + '#/settings/sync'); await E.waitForSelector('#syncEmail');
  await E.fill('#syncEmail', 'me@example.com'); await E.fill('#syncPw', 'secret123'); await E.click('#syncCreate');
  await E.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  // D: one deck with no cards, then sign in
  await D.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getDecks()) await db.deleteDeck(d.id); await db.addDeckWithCards({ id: 'solo', name: 'Solo', color: '#46A758', created: Date.now() }, []); });
  await D.goto(APP + '#/settings/sync'); await D.waitForSelector('#syncEmail');
  await D.fill('#syncEmail', 'me@example.com'); await D.fill('#syncPw', 'secret123'); await D.click('#syncForm button[type=submit]');
  await D.waitForSelector('#devAdd');
  const label = await D.textContent('#devAdd');
  ok(label === 'Add this 1 deck to your account', 'one deck: ' + label);
  ok(/New account\? Choose Add/.test(await D.textContent('#sheet')), 'the sheet says a new account is empty');
  await c3.close();
}

// ---- the welcome page's sign-in link ----
{
  const rb = await realChromium.launch({});
  const c = await rb.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const P = await c.newPage();
  await P.goto(APP);
  await P.waitForSelector('#wlSignIn');
  await P.click('#wlSignIn');
  await P.waitForSelector('#syncEmail');
  ok(new URL(P.url()).hash === '#/settings/sync', 'the welcome page Sign in link lands on the Sync form: ' + P.url());
  await rb.close();
}

await browser.close();
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
