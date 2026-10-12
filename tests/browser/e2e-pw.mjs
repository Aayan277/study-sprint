import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 320, height: 700 }, serviceWorkers: 'block' });
await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncPw');
const ticks = () => page.$$eval('#syncRules li', li => li.map(x => x.classList.contains('ok')));
ok((await ticks()).join() === 'false,false,false' && (await page.textContent('#syncRules')).includes('At least 8 characters'), 'rules listed, none met yet');
await page.fill('#syncEmail', 'new@example.com');
await page.fill('#syncPw', 'abcdefgh');
ok((await ticks()).join() === 'true,true,false', 'ticks update as you type');
await page.click('#syncCreate');
ok((await page.textContent('#syncErr')) === 'Your password needs a number.', 'create account blocked: ' + await page.textContent('#syncErr'));
ok(!fake.users.has('new@example.com'), 'nothing sent to the server');
// Show / Hide
ok(await page.getAttribute('#syncPw', 'type') === 'password', 'hidden by default');
await page.click('[data-show="syncPw"]');
ok(await page.getAttribute('#syncPw', 'type') === 'text' && (await page.textContent('[data-show="syncPw"]')) === 'Hide', 'Show reveals it');
await page.screenshot({ path: SP + '/pw-form.png' });
await page.click('[data-show="syncPw"]');
ok(await page.getAttribute('#syncPw', 'type') === 'password', 'Hide hides it again');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 320px');
// the server's own rule is explained too (e.g. if the app's rules were ever looser)
await page.evaluate(async () => { const s = await import('./js/sync.js'); try { await s.createAccount('x@example.com', 'abc'); } catch (e) { window.__err = e.message; } });
ok((await page.evaluate(() => window.__err)).includes('at least 8 characters, with a letter and a number'), "server's weak-password error explained");
// a good one
await page.fill('#syncPw', 'goodpass1'); await page.click('#syncCreate');
await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''));
ok(fake.users.get('new@example.com')?.password === 'goodpass1', 'account created with a good password');
// change password: same rules
await page.click('#pwBtn'); await page.waitForSelector('#pw1');
await page.fill('#pw1', 'short1'); await page.fill('#pw2', 'short1'); await page.click('button[type=submit][form=pwForm]');
ok((await page.textContent('#pwErr')) === 'The password needs at least 8 characters.', 'change password checks the rules: ' + await page.textContent('#pwErr'));
await page.screenshot({ path: SP + '/pw-sheet.png' });
await page.fill('#pw1', 'better2pass'); await page.fill('#pw2', 'better2pass'); await page.click('button[type=submit][form=pwForm]');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Password changed');
ok(fake.users.get('new@example.com').password === 'better2pass', 'changed');
// an older, short password can still sign in (rules only apply to new passwords)
fake.users.set('old@example.com', { id: 'user-old', password: 'abc123' });
await page.click('#signOutBtn'); await page.click('#soKeep'); await page.waitForSelector('#syncEmail');
await page.fill('#syncEmail', 'old@example.com'); await page.fill('#syncPw', 'abc123'); await page.click('#syncForm button[type=submit]');
await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''));
ok(true, 'an existing account with an older short password still signs in');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
