// Makes the screenshots the README and the app manifest use, from the real app (Violet Dark, with a realistic set of courses):
//   docs/screenshots/{today,review,play,stats,decks,import}.png   phone shots, 750x1624 (375x812 at 2x)
//   docs/screenshots/desktop.png                                   a computer shot, 1440x900
// Run it again whenever the look of the app changes:  node tests/browser/readme-shots.mjs
// (docs/hero.png and docs/hero-light.png, the pictures at the top of the README, are designed pictures, not made here.)
// It serves the app itself on http://localhost:8125 (change with PORT=...) and needs Playwright, like the browser tests.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realChromium as chromium } from './pw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/screenshots');
const PORT = Number(process.env.PORT || 8125);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
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

const BIO = [['Mitochondria', 'Organelle that produces ATP through cellular respiration'], ['Ribosome', 'Site of protein synthesis; reads mRNA'], ['Nucleus', 'Membrane-bound organelle containing the genome'], ['Golgi apparatus', 'Modifies, sorts and packages proteins for secretion'], ['Lysosome', 'Vesicle with digestive enzymes that break down waste'], ['Endoplasmic reticulum', 'Network of membranes: rough ER makes proteins, smooth ER makes lipids'], ['Cell membrane', 'Phospholipid bilayer controlling what enters and leaves the cell'], ['Osmosis', 'Diffusion of water across a semi-permeable membrane'], ['Mitosis', 'Cell division producing two identical diploid cells'], ['Meiosis', 'Division producing four genetically different haploid gametes'], ['Apoptosis', 'Programmed cell death'], ['Glycolysis', 'Breakdown of glucose to pyruvate in the cytoplasm']];
const ECON = [['Opportunity cost', 'Value of the next best alternative given up'], ['Elasticity', 'Responsiveness of quantity demanded to a change in price'], ['GDP', 'Total market value of final goods and services produced in a year'], ['Inflation', 'Sustained rise in the general price level'], ['Monopoly', 'Market with a single seller and high barriers to entry'], ['Marginal cost', 'Cost of producing one more unit'], ['Comparative advantage', 'Ability to produce at a lower opportunity cost than others'], ['Externality', 'Cost or benefit affecting a third party not in the transaction']];
const SPAN = [['el perro', 'the dog'], ['la biblioteca', 'the library'], ['aprender', 'to learn'], ['el examen', 'the exam'], ['la ciudad', 'the city'], ['escribir', 'to write']];
const NEURO = [['Neuron', 'Basic cell of the nervous system that transmits electrical and chemical signals'], ['Axon', 'Long projection that carries impulses away from the cell body'], ['Dendrite', 'Branch that receives signals from other neurons'], ['Myelin', 'Fatty insulating sheath that speeds conduction'], ['Glia', 'Support cells: astrocytes, oligodendrocytes, microglia']];

// Courses with an exam coming up, some history, and a due pile: what a student three weeks in looks like.
async function seed(page) {
  await page.evaluate(async ({ BIO, ECON, SPAN, NEURO }) => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const DAY = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * DAY); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const grow = (rows, n) => Array.from({ length: n }, (_, i) => rows[i % rows.length].map((s, k) => k === 0 && i >= rows.length ? `${s} (${Math.floor(i / rows.length) + 1})` : s));
    const mk = (deckId, rows) => rows.map(([f, b], i) => ({ id: deckId + i, deckId, front: f, back: b, tags: [], created: i }));
    const decks = [
      [{ id: 'bio', name: 'Cell Biology', course: 'BIOL 201', color: '#46A758', created: now + 1, examDate: iso(9) }, mk('bio', grow(BIO, 60))],
      [{ id: 'econ', name: 'Microeconomics', course: 'ECON 101', color: '#3E63DD', created: now + 2 }, mk('econ', grow(ECON, 48))],
      [{ id: 'neuro', name: 'Neuroscience', course: 'PSYC 240', color: '#8E4EC6', created: now + 3, examDate: iso(23) }, mk('neuro', grow(NEURO, 30))],
      [{ id: 'span', name: 'Spanish B1 Vocabulary', course: 'SPAN 210', color: '#F76B15', created: now + 4 }, mk('span', grow(SPAN, 36))]
    ];
    for (const [d, c] of decks) await db.addDeckWithCards(d, c);
    const cs = await db.getAll('cards');
    const states = cs.filter((_, i) => i % 5 !== 4).map((c, i) => ({ cardId: c.id, due: now + ((i % 9) - 3) * DAY, stability: [1, 4, 12, 30, 60, 90][i % 6], difficulty: 3 + (i % 6), elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3 + i % 4, lapses: i % 7 === 0 ? 4 : i % 3, state: i % 11 === 0 ? 1 : 2, lastReview: now - DAY }));
    await db.putMany('cardStates', states);
    const logs = [];
    for (let d = 0; d < 45; d++) {
      if (d >= 3 && d % 5 === 0) continue;
      const n = 8 + ((d * 7) % 31);
      for (let i = 0; i < n; i++) {
        const c = cs[(d * 3 + i) % cs.length];
        logs.push({ cardId: c.id, timestamp: now - d * DAY - i * 70000 - 3600000 * (d % 9) - 3600000, source: i % 4 === 0 ? 'play' : 'review', mode: 'flip', correct: (d + i) % 6 !== 0, ms: 3000 + (i % 5) * 1500, rating: [3, 3, 1, 2, 4, 3, 3][i % 7], state: 2, applied: true, reason: 'due' });
      }
    }
    await db.putMany('reviewLog', logs);
  }, { BIO, ECON, SPAN, NEURO });
}

const browser = await chromium.launch();
const shoot = async (name, w, h, scale, go) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, serviceWorkers: 'block', colorScheme: 'dark', reducedMotion: 'reduce', isMobile: w < 800, hasTouch: w < 800 });
  await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); localStorage.setItem('study-sprint-theme', JSON.stringify({ skin: 'violet', mode: 'dark' })); } catch { /* fine */ } });
  const page = await ctx.newPage();
  await page.goto(URL_); await page.waitForSelector('.today-hero');
  await seed(page); await page.reload(); await page.waitForSelector('.tdeck');
  await go(page);
  await page.waitForTimeout(500);                       // let fonts and the goal ring settle
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('saved docs/screenshots/' + name + '.png', w * scale + 'x' + h * scale);
  await ctx.close();
};
const PHONE = [375, 812, 2];
await shoot('today', ...PHONE, async () => {});
await shoot('review', ...PHONE, async p => {
  await p.click('#startBtn'); await p.waitForSelector('#flash, .rv-card');
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
});
await shoot('play', ...PHONE, async p => { await p.goto(URL_ + '#/play'); await p.waitForSelector('main h1'); });
await shoot('stats', ...PHONE, async p => { await p.goto(URL_ + '#/stats'); await p.waitForSelector('main h1'); await p.waitForTimeout(600); });
await shoot('decks', ...PHONE, async p => { await p.goto(URL_ + '#/decks'); await p.waitForSelector('.deck'); });
await shoot('import', ...PHONE, async p => {
  await p.goto(URL_ + '#/import'); await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', 'Mitochondria - Makes ATP for the cell\nRibosome - Builds proteins\nNucleus - Holds the DNA\nGolgi apparatus - Packs proteins for export\nLysosome - Digests waste');
  await p.waitForSelector('#saveBtn:not([disabled])');
});
await shoot('desktop', 1440, 900, 1, async () => {});
await browser.close(); server.close();
