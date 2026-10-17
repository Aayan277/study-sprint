// Design round 4: Clinical A (ui3/a-refined.css) and three layout versions of it (ui4).
//   node design-previews/ui4/shoot.mjs [ui...]     ui = a | a1 | a2 | a3   (default all)
// Env: SCREENS=today,done,back,decks,stats (also front,deck,settings)  MODES=light,dark  SIZES=phone,desk  ACCENT=ocean
// Each version is one stylesheet (a1-classic.css, a2-document.css, a3-twopane.css; each @imports layout-common.css, which
// @imports ui3/a-refined.css), switched on with <html data-ui="clinical" data-var="a" data-lay="1|2|3">.
// Small markup changes are mocked in with MOCKS below (see NOTES.md).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realChromium as chromium } from '../../tests/browser/pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots');
const PORT = Number(process.env.PORT || 8140);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok, fail) => server.once('error', fail).listen(PORT, ok));
const URL_ = `http://localhost:${PORT}/`;
fs.mkdirSync(OUT, { recursive: true });

// ui -> [data-ui, data-var, stylesheet]
const UIS = {
  a: ['clinical', 'a', 'design-previews/ui3/a-refined.css', ''],
  a1: ['clinical', 'a', 'design-previews/ui4/a1-classic.css', '1'],
  a2: ['clinical', 'a', 'design-previews/ui4/a2-document.css', '2'],
  a3: ['clinical', 'a', 'design-previews/ui4/a3-twopane.css', '3']
};

const PHARM = [['Mechanism of action of metformin', 'Decreases hepatic gluconeogenesis; increases peripheral insulin sensitivity (AMPK activation)'], ['First-line treatment for anaphylaxis', 'IM adrenaline 0.5 mg (1:1000) into the anterolateral thigh; repeat after 5 min if needed'], ['Antidote for warfarin overdose', 'Vitamin K (phytomenadione); prothrombin complex concentrate if major bleeding'], ['ACE inhibitor side effects', 'Dry cough, hyperkalaemia, angioedema, first-dose hypotension, renal impairment'], ['Loop diuretic site of action', 'Na-K-2Cl cotransporter in the thick ascending limb of the loop of Henle'], ['Digoxin toxicity signs', 'Nausea, xanthopsia, bradyarrhythmias, hyperkalaemia'], ['Beta-blocker contraindications', 'Asthma, second/third-degree heart block, acute decompensated heart failure'], ['Mechanism of statins', 'Inhibit HMG-CoA reductase, reducing hepatic cholesterol synthesis']];
const ANAT = [['Brachial plexus roots', 'C5 to T1 ventral rami'], ['Nerve damaged in wrist drop', 'Radial nerve'], ['Contents of the carpal tunnel', 'Median nerve and nine flexor tendons (FDS x4, FDP x4, FPL)'], ['Rotator cuff muscles', 'Supraspinatus, infraspinatus, teres minor, subscapularis'], ['Blood supply of the femoral head', 'Mainly medial circumflex femoral artery'], ['Boundaries of the femoral triangle', 'Inguinal ligament, sartorius, adductor longus']];
const PATHO = [['Virchow\'s triad', 'Stasis, endothelial injury, hypercoagulability'], ['Reed-Sternberg cells', 'Hodgkin lymphoma'], ['Caseating granulomas', 'Tuberculosis'], ['Most common site of colorectal cancer', 'Rectum and sigmoid colon'], ['Hallmark of acute inflammation', 'Neutrophil infiltration']];
const MICRO = [['Gram-positive cocci in clusters', 'Staphylococcus'], ['Causative organism of syphilis', 'Treponema pallidum'], ['Rice-water stools', 'Vibrio cholerae'], ['Owl\'s eye inclusions', 'Cytomegalovirus']];

// done = every card already scheduled for later and today's goal met (the "All done for today" state)
async function seed(page, theme, done = false) {
  await page.evaluate(async ({ PHARM, ANAT, PATHO, MICRO, theme, done }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', theme);
    for (const id of ['sample', 'pharm', 'anat', 'path', 'micro']) await db.deleteDeck(id);
    const DAY = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * DAY); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const grow = (rows, n) => Array.from({ length: n }, (_, i) => rows[i % rows.length].map((s, k) => k === 0 && i >= rows.length ? `${s} (${Math.floor(i / rows.length) + 1})` : s));
    const mk = (deckId, rows) => rows.map(([f, b], i) => ({ id: deckId + i, deckId, front: f, back: b, tags: [], created: i }));
    const decks = [
      [{ id: 'pharm', name: 'Pharmacology', course: 'MED 2 · Block B', color: '#3E63DD', created: now + 1, examDate: iso(9) }, mk('pharm', grow(PHARM, 64))],
      [{ id: 'anat', name: 'Upper & Lower Limb', course: 'Anatomy', color: '#46A758', created: now + 2 }, mk('anat', grow(ANAT, 48))],
      [{ id: 'path', name: 'General Pathology', course: 'MED 2 · Block B', color: '#E5484D', created: now + 3, examDate: iso(23) }, mk('path', grow(PATHO, 40))],
      [{ id: 'micro', name: 'Microbiology', course: 'MED 2', color: '#8E4EC6', created: now + 4 }, mk('micro', grow(MICRO, 36))]
    ];
    for (const [d, c] of decks) await db.addDeckWithCards(d, c);
    const cs = await db.getAll('cards');
    const states = cs.filter((_, i) => done || i % 5 !== 4).map((c, i) => ({ cardId: c.id, due: done ? now + (1 + i % 8) * DAY + 3 * 3600000 : now + ((i % 9) - 3) * DAY, stability: [1, 4, 12, 30, 60, 90][i % 6], difficulty: 3 + (i % 6), elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3 + i % 4, lapses: i % 7 === 0 ? 4 : i % 3, state: !done && i % 11 === 0 ? 1 : 2, lastReview: now - DAY }));
    await db.putMany('cardStates', states);
    const logs = [];
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    for (let d = 0; d < 60; d++) {
      if (d >= 3 && d % 5 === 0) continue;
      const n = d === 0 ? (done ? 64 : 8) : 8 + ((d * 7) % 31);
      for (let i = 0; i < n; i++) {
        const c = cs[(d * 3 + i) % cs.length];
        // today's answers land between midnight and now
        const ts = d === 0 ? midnight.getTime() + (now - midnight.getTime()) * (i + 1) / (n + 1) : now - d * DAY - i * 70000 - 3600000 * (d % 9) - 3600000;
        logs.push({ cardId: c.id, timestamp: ts, source: i % 4 === 0 ? 'play' : 'review', mode: 'flip', correct: (d + i) % 6 !== 0, ms: 3000 + (i % 5) * 1500, rating: [3, 3, 1, 2, 4, 3, 3][i % 7], state: 2, applied: true, reason: 'due' });
      }
    }
    await db.putMany('reviewLog', logs);
  }, { PHARM, ANAT, PATHO, MICRO, theme, done });
}

// Proposed markup changes, mocked into the live page (what NOTES.md calls "DOM" changes). ui3 and ui4 versions.
const MOCKS = {
  // all three: the done state's extra-study button is a calm secondary button labelled "Extra study"
  common(screen) {
    const x = document.getElementById('customLink');
    if (x) { x.textContent = 'Extra study'; x.className = 'btn ghost th-extra'; }
    // the done headline reads "All done for today" (one string in js/today.js); the repeated <b> under it is hidden by CSS
    if (document.querySelector('.th-done')) { const b = document.querySelector('.th-big'); if (b) b.textContent = 'All done for today'; }
    if (screen === 'settings') {
      const th = document.getElementById('thTitle');
      if (th && !document.querySelector('.ui-seg')) {
        const row = document.createElement('div');
        row.innerHTML = '<h3 class="set-sub">Style</h3><div class="ui-seg" role="group" aria-label="Style"><button type="button" aria-pressed="false">Classic</button><button type="button" aria-pressed="true">Clinical</button></div>';
        th.before(...row.childNodes);
        th.textContent = 'Accent colour';
        const NEW = { violet: 'Indigo', ocean: 'Blue', forest: 'Teal', ember: 'Rust', rose: 'Plum' };
        document.querySelectorAll('.skin').forEach(b => { const n = b.querySelector('.nm'); if (n) n.textContent = NEW[b.dataset.skin]; });
      }
    }
  },
  // ui4 layouts: the goal ring becomes a plain line and bar ("6 of 94 done today"); the numbers are the sidebar's own
  layout(screen) {
    const hero = document.querySelector('.today-hero');
    if (!hero || hero.querySelector('.goal')) return;
    // the numbers: the desktop sidebar's "6 of 94 today", else the ring's own "6" and "/94" (phones); a met goal shows a full bar
    const m = (document.querySelector('.side-st span')?.textContent || '').match(/(\d+) of (\d+)/);
    const rb = hero.querySelector('.ring-in b'), rs = hero.querySelector('.ring-in small');
    const met = !!hero.querySelector('.th-done');
    let [n, of] = m ? [+m[1], +m[2]] : rb && rs ? [+rb.textContent, +rs.textContent.replace('/', '')] : [0, 0];
    if (met && !of) { n = of = 1; }
    const g = document.createElement('div'); g.className = 'goal';
    g.innerHTML = `<span class="goal-t">${met && !m ? 'Daily goal met' : `<b>${n}</b> of ${of} done today`}</span><span class="goal-bar" aria-hidden="true"><i style="width:${of ? Math.min(100, n / of * 100) : 0}%"></i></span>`;
    hero.querySelector('.th-text').appendChild(g);
  },
};

const startReview = async p => { await p.click('#startBtn'); await p.waitForSelector('#flash, .rv-card'); await p.waitForTimeout(250); };
const SCREENS = {
  today: async () => {},
  done: async () => {},
  front: startReview,
  back: async p => { await startReview(p); await p.keyboard.press('Space'); await p.waitForSelector('.rate'); },
  decks: async p => { await p.goto(URL_ + '#/decks'); await p.waitForSelector('.deck'); },
  deck: async p => { await p.goto(URL_ + '#/deck/pharm'); await p.waitForSelector('main h1'); await p.waitForTimeout(300); },
  stats: async p => { await p.goto(URL_ + '#/stats'); await p.waitForSelector('main h1'); await p.waitForTimeout(700); },
  settings: async p => { await p.goto(URL_ + '#/settings'); await p.waitForSelector('main h1'); },
  play: async p => { await p.goto(URL_ + '#/play'); await p.waitForSelector('main h1'); }
};
const SIZES = { phone: [375, 812, 2], desk: [1440, 900, 1] };
const uis = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(UIS);
const screens = (process.env.SCREENS || 'today,done,back,decks,stats').split(',');
const modes = (process.env.MODES || 'light,dark').split(',');
const sizes = (process.env.SIZES || 'phone,desk').split(',');
const FULL = process.env.FULL === '1';
const skinFor = () => process.env.ACCENT || 'ocean';

const browser = await chromium.launch();
const report = [];
for (const ui of uis) for (const size of sizes) for (const mode of modes) {
  const [w, h, scale] = SIZES[size];
  const cfg = UIS[ui];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, serviceWorkers: 'block', reducedMotion: 'reduce', isMobile: w < 800, hasTouch: w < 800 });
  await ctx.addInitScript(([mode, cfg, skin]) => {
    try { localStorage.setItem('study-sprint-skip-onboarding', '1'); localStorage.setItem('study-sprint-theme', JSON.stringify({ skin, mode })); } catch { /* fine */ }
    try { localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ }
    if (cfg) {
      const set = () => { const r = document.documentElement; r.setAttribute('data-ui', cfg[0]); if (cfg[1]) r.setAttribute('data-var', cfg[1]); if (cfg[3]) r.setAttribute('data-lay', cfg[3]); };
      if (document.documentElement) set();
      const add = () => { set(); const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = cfg[2]; document.head.appendChild(l); };
      if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    }
  }, [mode, cfg, skinFor(ui)]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto(URL_); await page.waitForSelector('.today-hero');
  const theme = { skin: skinFor(ui), mode, oled: false };
  await seed(page, theme); await page.reload(); await page.waitForSelector('.tdeck', { state: 'attached' });
  let isDone = false;
  for (const s of screens) {
    if (s === 'done' && !isDone) { await seed(page, theme, true); isDone = true; }
    if (s !== 'done' && isDone) { await seed(page, theme, false); isDone = false; }
    await page.goto(URL_ + '#/decks'); await page.goto(URL_ + '#/today'); await page.waitForSelector('.tdeck', { state: 'attached' });
    await SCREENS[s](page);
    if (cfg && cfg[1]) {
      await page.evaluate(MOCKS.common, s);
      if (cfg[3]) await page.evaluate(MOCKS.layout, s);
    }
    await page.mouse.move(1, 1);
    await page.waitForTimeout(450);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 0) report.push(`OVERFLOW ${ui} ${size} ${mode} ${s}: ${overflow}px`);
    // rendered-text AA check: every visible text node's colour against the first solid background behind it
    const low = await page.evaluate(() => {
      const parse = c => { const m = c.match(/^rgba?\(([^)]+)\)/); if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; }
        const n = c.match(/^color\(srgb ([^)]+)\)/); if (n) { const v = n[1].split(/[ /]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; } return null; };
      const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let out = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1]; for (const l of layers.reverse()) out = out.map((v, i) => i < 3 ? v * (1 - l[3]) + l[i] * l[3] : 1); return out; };
      const bad = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        const el = n.parentElement; if (!n.textContent.trim() || !el) continue;
        const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[hidden],[aria-hidden="true"]:not(.tbl-head),.sr-only,:disabled,[aria-disabled="true"]')) continue;
        if (el.matches('.cap')) continue; // chart peak label: absolutely placed above its bar, on the card (text-2 on surface-1, checked in contrast.mjs)
        let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity; if (op < .99) continue;
        const fg = parse(cs.color); if (!fg) continue; const bg = bgOf(el);
        const f = fg.map((v, i) => i < 3 ? v * fg[3] + bg[i] * (1 - fg[3]) : 1);
        const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x); const ratio = (a + .05) / (b + .05);
        const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
        if (ratio < (big ? 3 : 4.5)) bad.add(`${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 30)}" <${el.tagName.toLowerCase()}.${[...el.classList].join('.')}>`);
      }
      return [...bad];
    });
    for (const l of low) report.push(`LOW-CONTRAST ${ui} ${size} ${mode} ${s}: ${l}`);
    await page.screenshot({ path: path.join(OUT, `${ui}-${s}-${size}-${mode}.png`), fullPage: FULL });
    if (s === 'front' || s === 'back') { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(150); }
  }
  await ctx.close();
  console.log('done', ui, size, mode);
}
console.log(report.join('\n') || 'no horizontal overflow, no low-contrast text');
await browser.close(); server.close();
