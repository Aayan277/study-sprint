// Design round: screenshots of the current UI and the ui2 candidates.
//   node design-previews/ui2/shoot.mjs [ui...]       ui = current | clinical | paper  (default all)
// Env: SCREENS=today,review  MODES=light,dark  SIZES=phone,desk  ACCENT=ocean  FULL=1 (full page)
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

const PHARM = [['Mechanism of action of metformin', 'Decreases hepatic gluconeogenesis; increases peripheral insulin sensitivity (AMPK activation)'], ['First-line treatment for anaphylaxis', 'IM adrenaline 0.5 mg (1:1000) into the anterolateral thigh; repeat after 5 min if needed'], ['Antidote for warfarin overdose', 'Vitamin K (phytomenadione); prothrombin complex concentrate if major bleeding'], ['ACE inhibitor side effects', 'Dry cough, hyperkalaemia, angioedema, first-dose hypotension, renal impairment'], ['Loop diuretic site of action', 'Na-K-2Cl cotransporter in the thick ascending limb of the loop of Henle'], ['Digoxin toxicity signs', 'Nausea, xanthopsia, bradyarrhythmias, hyperkalaemia'], ['Beta-blocker contraindications', 'Asthma, second/third-degree heart block, acute decompensated heart failure'], ['Mechanism of statins', 'Inhibit HMG-CoA reductase, reducing hepatic cholesterol synthesis']];
const ANAT = [['Brachial plexus roots', 'C5 to T1 ventral rami'], ['Nerve damaged in wrist drop', 'Radial nerve'], ['Contents of the carpal tunnel', 'Median nerve and nine flexor tendons (FDS x4, FDP x4, FPL)'], ['Rotator cuff muscles', 'Supraspinatus, infraspinatus, teres minor, subscapularis'], ['Blood supply of the femoral head', 'Mainly medial circumflex femoral artery'], ['Boundaries of the femoral triangle', 'Inguinal ligament, sartorius, adductor longus']];
const PATHO = [['Virchow\'s triad', 'Stasis, endothelial injury, hypercoagulability'], ['Reed-Sternberg cells', 'Hodgkin lymphoma'], ['Caseating granulomas', 'Tuberculosis'], ['Most common site of colorectal cancer', 'Rectum and sigmoid colon'], ['Hallmark of acute inflammation', 'Neutrophil infiltration']];
const MICRO = [['Gram-positive cocci in clusters', 'Staphylococcus'], ['Causative organism of syphilis', 'Treponema pallidum'], ['Rice-water stools', 'Vibrio cholerae'], ['Owl\'s eye inclusions', 'Cytomegalovirus']];

async function seed(page, theme) {
  await page.evaluate(async ({ PHARM, ANAT, PATHO, MICRO, theme }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', theme);
    await db.deleteDeck('sample');
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
    const states = cs.filter((_, i) => i % 5 !== 4).map((c, i) => ({ cardId: c.id, due: now + ((i % 9) - 3) * DAY, stability: [1, 4, 12, 30, 60, 90][i % 6], difficulty: 3 + (i % 6), elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3 + i % 4, lapses: i % 7 === 0 ? 4 : i % 3, state: i % 11 === 0 ? 1 : 2, lastReview: now - DAY }));
    await db.putMany('cardStates', states);
    const logs = [];
    for (let d = 0; d < 60; d++) {
      if (d >= 3 && d % 5 === 0) continue;
      const n = 8 + ((d * 7) % 31);
      for (let i = 0; i < n; i++) {
        const c = cs[(d * 3 + i) % cs.length];
        logs.push({ cardId: c.id, timestamp: now - d * DAY - i * 70000 - 3600000 * (d % 9) - 3600000, source: i % 4 === 0 ? 'play' : 'review', mode: 'flip', correct: (d + i) % 6 !== 0, ms: 3000 + (i % 5) * 1500, rating: [3, 3, 1, 2, 4, 3, 3][i % 7], state: 2, applied: true, reason: 'due' });
      }
    }
    await db.putMany('reviewLog', logs);
  }, { PHARM, ANAT, PATHO, MICRO, theme });
}

const SCREENS = {
  today: async () => {},
  review: async p => { await p.click('#startBtn'); await p.waitForSelector('#flash, .rv-card'); await p.keyboard.press('Space'); await p.waitForSelector('.rate'); },
  decks: async p => { await p.goto(URL_ + '#/decks'); await p.waitForSelector('.deck'); },
  deck: async p => { await p.goto(URL_ + '#/deck/pharm'); await p.waitForSelector('main h1'); await p.waitForTimeout(300); },
  stats: async p => { await p.goto(URL_ + '#/stats'); await p.waitForSelector('main h1'); await p.waitForTimeout(700); },
  settings: async (p, ui) => {
    await p.goto(URL_ + '#/settings'); await p.waitForSelector('main h1');
    // Mock the proposed markup: a "Style" row above Theme, and the accents' new names (js/themes.js would do this).
    await p.evaluate(ui => {
      const th = document.getElementById('thTitle');
      const names = { classic: 'Classic', [ui]: ui[0].toUpperCase() + ui.slice(1) };
      const row = document.createElement('div');
      row.innerHTML = `<h3 class="set-sub">Style</h3><div class="ui-seg" role="group" aria-label="Style">${['classic', ui].map(k => `<button type="button" aria-pressed="${k !== 'classic' || ui === 'current'}">${names[k] || 'Clinical'}</button>`).join('')}</div>`;
      if (ui !== 'current') {
        th.before(...row.childNodes);
        th.textContent = 'Accent colour';
        const NEW = { violet: 'Indigo', ocean: 'Blue', forest: 'Green', ember: 'Rust', rose: 'Plum' };
        document.querySelectorAll('.skin').forEach(b => { b.querySelector('.nm').textContent = NEW[b.dataset.skin]; });
      }
    }, ui);
  },
  play: async p => { await p.goto(URL_ + '#/play'); await p.waitForSelector('main h1'); }
};
const SIZES = { phone: [375, 812, 2], desk: [1440, 900, 1] };
const uis = process.argv.slice(2).length ? process.argv.slice(2) : ['current', 'clinical', 'paper'];
const screens = (process.env.SCREENS || 'today,review,decks,deck,stats,settings').split(',');
const modes = (process.env.MODES || 'light,dark').split(',');
const sizes = (process.env.SIZES || 'phone,desk').split(',');
const FULL = process.env.FULL === '1';
const skinFor = ui => process.env.ACCENT || (ui === 'current' ? 'violet' : 'ocean');

const browser = await chromium.launch();
const report = [];
for (const ui of uis) for (const size of sizes) for (const mode of modes) {
  const [w, h, scale] = SIZES[size];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, serviceWorkers: 'block', reducedMotion: 'reduce', isMobile: w < 800, hasTouch: w < 800 });
  await ctx.addInitScript(([mode, ui, skin]) => {
    try { localStorage.setItem('study-sprint-skip-onboarding', '1'); localStorage.setItem('study-sprint-theme', JSON.stringify({ skin, mode })); } catch { /* fine */ }
    if (ui !== 'current') {
      if (document.documentElement) document.documentElement.setAttribute('data-ui', ui);
      const add = () => { document.documentElement.setAttribute('data-ui', ui); const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'design-previews/ui2/ui2.css'; document.head.appendChild(l); };
      if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    }
  }, [mode, ui, skinFor(ui)]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto(URL_); await page.waitForSelector('.today-hero');
  await seed(page, { skin: skinFor(ui), mode, oled: false }); await page.reload(); await page.waitForSelector('.tdeck');
  for (const s of screens) {
    if (s !== 'today') { await page.goto(URL_ + '#/today'); await page.waitForSelector('.tdeck'); }
    await SCREENS[s](page, ui);
    await page.waitForTimeout(450);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 0) report.push(`OVERFLOW ${ui} ${size} ${mode} ${s}: ${overflow}px`);
    await page.screenshot({ path: path.join(OUT, `${ui}-${s}-${size}-${mode}.png`), fullPage: FULL });
    if (s === 'review') await page.keyboard.press('Escape').catch(() => {});
  }
  await ctx.close();
  console.log('done', ui, size, mode);
}
console.log(report.join('\n') || 'no horizontal overflow');
await browser.close(); server.close();
