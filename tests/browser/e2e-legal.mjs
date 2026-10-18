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

await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncPw');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });

const note = await page.textContent('#legalNote');
ok(note.includes('By creating an account you agree to the Terms and Privacy') && note.includes('stored on a server run by the app’s developer'), 'sign-up form has the agreement line');
ok(await page.getAttribute('#legalNote a[href="privacy.html"]', 'href') === 'privacy.html' && await page.getAttribute('#legalNote a[href="terms.html"]', 'href') === 'terms.html', 'it links to both pages');
const about = await page.textContent('#aboutRow');
ok(/Privacy/.test(about) && /Terms/.test(about) && /Contact: see the project page/.test(about) && /4\.\d+/.test(about), 'Settings About row: ' + about.replace(/\s+/g, ' ').trim());
ok(await page.getAttribute('#aboutRow a[href="privacy.html"]', 'target') === null, 'links open in the same tab');

// Offline: both pages come from the saved copy.
await ctx.setOffline(true);
for (const [file, h1] of [['privacy.html', 'Privacy'], ['terms.html', 'Terms']]) {
  await page.goto('http://localhost:8123/' + file);
  ok((await page.textContent('h1')) === h1, file + ' loads offline');
  ok(/Contact: see the project page/.test(await page.textContent('#contact')), file + ' shows the fallback contact line');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), file + ' has no sideways scroll at 320px');
}
await page.goto('http://localhost:8123/privacy.html');
for (const w of ['student developer', 'Supabase', 'Cloudflare Turnstile', 'GitHub Pages', 'jsDelivr', '30 days', '13 and over', 'Last updated']) {
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
await browser.close();
