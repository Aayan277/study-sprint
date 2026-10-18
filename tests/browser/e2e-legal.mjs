// privacy.html and terms.html: saved for offline use, readable on a phone in light and dark, and linked from the
// Create account form and Settings → About. Run with: npm run test:browser legal
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fakeSupabase().handle);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });

await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncPw');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });

const note = await page.textContent('#legalNote');
ok(note.includes('By creating an account you agree to the Terms and Privacy') && note.includes('stored on Supabase servers, managed by the app’s developer'), 'sign-up form has the agreement line');
ok(await page.locator('#legalNote a[href="privacy.html"]').count() === 1 && await page.locator('#legalNote a[href="terms.html"]').count() === 1, 'it links to both pages');
ok(await page.locator('#syncCreate[aria-describedby="legalNote"]').count() === 1, 'Create account is described by the agreement line');
ok(await page.evaluate(() => document.getElementById('legalNote').compareDocumentPosition(document.getElementById('syncCreate')) & Node.DOCUMENT_POSITION_FOLLOWING) > 0, 'the agreement line comes before the buttons');
ok(await page.locator('a[data-sec="aboutTitle"]').count() === 0 && await page.locator('#aboutRow a[href="privacy.html"]').count() === 1, 'About sits at the end of Settings (no jump link; it would not fit on phones)');
ok(await page.locator('p.note.mono').count() === 0, 'no second version line in Settings');
const about = await page.textContent('#aboutRow');
ok(/Privacy/.test(about) && /Terms/.test(about) && /open an issue on the project page/.test(about) && /4\.\d+/.test(about), 'Settings About row: ' + about.replace(/\s+/g, ' ').trim());
ok(await page.locator('#aboutRow a[href="privacy.html"]:not([target])').count() === 1 && await page.locator('#aboutRow a[href="terms.html"]:not([target])').count() === 1, 'links open in the same tab');

// Offline: both pages come from the saved copy.
await ctx.setOffline(true);
for (const [file, h1] of [['privacy.html', 'Privacy'], ['terms.html', 'Terms']]) {
  await page.goto('http://localhost:8123/' + file);
  ok((await page.textContent('h1')) === h1, file + ' loads offline');
  ok(/Contact: open an issue on the project page \(please don’t post personal details there\)/.test(await page.textContent('#contact')), file + ' shows the fallback contact line');
  ok(await page.locator('#contact a[href^="https://github.com/"]').count() === 1, file + ' contact line links to the project page');
  ok(await page.locator('script:not([src])').count() === 0, file + ' has no inline scripts');
  ok(await page.locator('meta[http-equiv="Content-Security-Policy"][content*="script-src \'self\'"]').count() === 1, file + ' has a script-src self policy');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), file + ' has no sideways scroll at 320px');
}
await page.goto('http://localhost:8123/privacy.html');
for (const w of ['student developer', 'Supabase', 'Cloudflare Turnstile', 'GitHub Pages', 'jsDelivr', '30 days', 'GitHub Actions', 'Google (Gmail)', 'Google Sheets', 'region to be confirmed', '13 and over', 'Last updated']) {
  ok((await page.textContent('body')).includes(w), 'privacy mentions ' + w);
}
// Light and dark follow the app's saved choice.
await page.evaluate(() => localStorage.setItem('study-sprint-theme', JSON.stringify({ mode: 'light' })));
await page.reload();
ok(await page.getAttribute('html', 'data-theme') === 'light', 'light theme');
await page.evaluate(() => localStorage.setItem('study-sprint-theme', JSON.stringify({ mode: 'dark' })));
await page.reload();
ok(await page.getAttribute('html', 'data-theme') === 'dark', 'dark theme');
await page.click('a.back');
await page.waitForSelector('.tab, nav, #screen');
ok(new URL(page.url()).pathname === '/', 'back link returns to the app');
ok(errors.length === 0, 'no page errors ' + errors.join('|'));

// The app and the policy must not use a font service (the policy says fonts are stored with the app).
// Expected to FAIL on its own until branch b-webhard (self-hosted Geist) is merged; the release merges it first.
const indexHtml = (await import('node:fs')).readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
ok(!indexHtml.includes('fonts.googleapis'), 'index.html has no fonts.googleapis link (needs b-webhard)');
await browser.close();
