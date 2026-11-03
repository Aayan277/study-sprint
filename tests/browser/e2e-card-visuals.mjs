// Card visuals: the answer is the loudest thing on the back (the recap of the question is smaller, in both looks, on phone and desktop);
// a multiple-choice style back ("C. answer", blank line, explanation) leads with its first paragraph; the clinical look keeps the size
// classes (long, xlong, small recap, cloze); a cloze back has no divider above nothing; the front sits in the vertical middle of the card;
// and Play's and the Practice test's options show only the lead of such a back, never the explanation.
// Run with: node tests/browser/run.mjs card-visuals      Screenshots go to $SHOTS if it is set. Synthetic cards only.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const THEMES = { original: { ui: 'original', skin: 'indigo', mode: 'dark', oled: false }, clinical: { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false } };
const SIZES = [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]];

const STEM = 'A patient has fatigue, weight gain and cold intolerance. Biopsy shows lymphocytic infiltrate with germinal centres. Which of the following is the most likely diagnosis?';
const OPTS = '\n\nA. Graves disease\nB. Subacute thyroiditis\nC. Hashimoto thyroiditis\nD. Riedel thyroiditis\nE. Toxic adenoma';
const MC_LEAD = 'C. Hashimoto thyroiditis';
const MC_MORE = 'Autoantibodies against thyroid peroxidase destroy the gland, and the lymphocytic infiltrate with germinal centres is the classic biopsy finding, so the patient becomes hypothyroid.';
const LONG_FRONT = 'Which statement about the renal handling of sodium is correct? The proximal tubule reabsorbs most of the filtered load, while the collecting duct adjusts the final amount under aldosterone control.';
const CARDS = [
  { id: 'mc', front: STEM + OPTS, back: `${MC_LEAD}\n\n${MC_MORE}` },
  { id: 'mcshort', front: 'Which gland is enlarged in Graves disease?', back: 'The thyroid\n\nIt is overstimulated by antibodies.' },
  { id: 'term', front: 'Hippocampus', back: 'Memory' },
  { id: 'xlong', front: LONG_FRONT, back: 'Sodium' }
];
// An MC-style deck for Play and the Practice test: every explanation carries a marker that must never show up in an option.
const PLAY = Array.from({ length: 8 }, (_, i) => ({ id: 'pl' + i, front: `Synthetic question ${i}?`, back: `${'ABCDE'[i % 5]}. Option text number ${i}\n\nEXPLAIN-${i} this is a long explanation of why the option is right, which would give the answer away if shown in an option.` }));

async function open(viewport, mobile, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.stack));
  page.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push('console ' + m.text()); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async ({ CARDS, PLAY, theme }) => {
    const db = await import('./js/db.js'), cz = await import('./js/cloze.js');
    await db.setSetting('theme', theme);
    for (const c of CARDS) await db.addDeckWithCards({ id: 'd-' + c.id, name: 'Deck ' + c.id, color: '#3E63DD', created: 1 }, [{ id: c.id, deckId: 'd-' + c.id, front: c.front, back: c.back, tags: [], created: 1 }]);
    const deck = { id: 'd-cloze', name: 'Deck cloze', color: '#3E63DD', created: 1 };
    await db.saveDeck(deck);
    await db.saveNote(cz.planNoteSave([], 'The {{c1::mitochondria}} makes {{c2::ATP}} by oxidative phosphorylation'), { deckId: deck.id, noteId: 'n-cloze', tags: [] });
    await db.addDeckWithCards({ id: 'd-play', name: 'MC deck', color: '#3E63DD', created: 2 }, PLAY.map((c, i) => ({ ...c, deckId: 'd-play', tags: [], created: i })));
  }, { CARDS, PLAY, theme });
  await page.reload(); await page.waitForSelector('.deck');
  return page;
}
const show = async (p, id) => { await p.goto(APP + '#/review/d-' + id); await p.waitForSelector('#flash'); await p.waitForTimeout(450); };
const flip = async p => { await p.keyboard.press('Space'); await p.waitForSelector('.rv-back:not([inert])'); await p.waitForTimeout(450); };
const px = (p, sel) => p.locator(sel).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
const frontCentre = p => p.evaluate(() => {
  const f = document.querySelector('.rv-front'), t = document.querySelector('.rv-front .flash-front'), fr = f.getBoundingClientRect(), r = t.getBoundingClientRect();
  return ((r.top + r.bottom) / 2 - fr.top) / fr.height;
});

for (const [themeName, theme] of Object.entries(THEMES)) for (const [tag, viewport, mobile] of SIZES) {
  const T = `${tag}/${themeName}`;
  const p = await open(viewport, mobile, theme);

  // ---- term card: the recap is quieter than the answer; the front sits in the middle; the divider shows ----
  await show(p, 'term');
  const c1 = await frontCentre(p);
  ok(c1 >= .45 && c1 <= .58, `${T}: a short front sits in the vertical middle of its card (${c1.toFixed(2)})`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/term-front-${tag}-${themeName}.png` });
  await flip(p);
  const recap = await px(p, '.rv-back .flash-recap'), back = await px(p, '.rv-back .flash-back');
  ok(recap < back, `${T}: the recap (${recap}px) is smaller than the answer (${back}px)`);
  ok(await p.locator('.rv-back .flash-ans').first().evaluate(el => getComputedStyle(el, '::before').display) !== 'none', `${T}: a back with a recap keeps its divider`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/term-back-${tag}-${themeName}.png` });

  // ---- multiple-choice card: the first paragraph leads; the stem's recap is quieter than it ----
  await show(p, 'mc');
  await flip(p);
  const lead = await px(p, '.rv-back .ans-lead'), more = await px(p, '.rv-back .ans-more'), rc = await px(p, '.rv-back .flash-recap');
  ok(await p.locator('.rv-back .ans-lead').innerText() === MC_LEAD, `${T}: the lead is the first paragraph of the back`);
  ok((await p.locator('.rv-back .ans-more').innerText()).trim() === MC_MORE, `${T}: the explanation sits under it`);
  ok(rc < lead, `${T}: the stem recap (${rc}px) is smaller than the answer lead (${lead}px)`);
  ok(lead > more, `${T}: the lead (${lead}px) is larger than the explanation (${more}px)`);
  ok(await p.locator('.rv-back .flash-recap.small').count() === 1, `${T}: a long stem is a compact recap`);
  ok(await p.locator('.rv-back .flash-back').evaluate(el => el.innerText.trim().replace(/\s+/g, ' ')) === `${MC_LEAD} ${MC_MORE}`, `${T}: the back's text and order are unchanged`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${T}: no sideways scroll`);
  if (themeName === 'clinical') {
    const longPx = await px(p, '.rv-back .flash-back.long');
    ok(longPx <= (viewport.width >= 1024 ? 1.2 : 1.0625) * 16 + .01, `${T}: clinical keeps the smaller size of a long answer (${longPx}px)`);
    const small = await px(p, '.rv-back .flash-recap.small');
    ok(small <= (viewport.width >= 1024 ? 16 : 15) + .01, `${T}: clinical keeps the compact recap (${small}px)`);
  }
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/mc-back-${tag}-${themeName}.png` });
  await show(p, 'mcshort'); await flip(p);
  ok(await px(p, '.rv-back .flash-recap') < await px(p, '.rv-back .ans-lead'), `${T}: a short multiple-choice back leads too, above its recap`);

  // ---- a very long front keeps its small, even weight in both looks ----
  await show(p, 'xlong');
  const xl = await p.locator('.rv-front .flash-front.xlong').evaluate(el => ({ w: +getComputedStyle(el).fontWeight, ls: getComputedStyle(el).letterSpacing }));
  ok(xl.w === 500 && (xl.ls === 'normal' || parseFloat(xl.ls) === 0), `${T}: a very long front is weight 500 with no tight spacing (${xl.w}, ${xl.ls})`);

  // ---- cloze: no divider above nothing ----
  await show(p, 'cloze');
  await flip(p);
  ok(await p.locator('.rv-back .flash-recap').count() === 0, `${T}: a cloze back has no recap`);
  ok(await p.locator('.rv-back .flash-ans').first().evaluate(el => { const s = getComputedStyle(el, '::before'); return s.display === 'none' && getComputedStyle(el).paddingTop === '0px'; }), `${T}: a cloze back has no divider and no gap for it`);
  if (themeName === 'clinical') ok(await px(p, '.rv-back .flash-back.cloze-full') <= 28.01, `${T}: clinical cloze answer uses the clinical size (${await px(p, '.rv-back .flash-back.cloze-full')}px)`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/cloze-back-${tag}-${themeName}.png` });

  // ---- Play: an option is the lead of a back, never its explanation ----
  if (tag === 'phone') {
    await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('playPrefs', { deckId: 'd-play', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 10, qtypeByDeck: {} }); });
    await p.goto(APP + '#/play'); await p.waitForSelector('#startBtn');
    for (const sel of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']) await p.$eval(sel, el => el.click());
    await p.click('#startBtn'); await p.waitForSelector('#options .opt');
    const texts = await p.locator('#options .opt .lbl').allInnerTexts();
    ok(texts.length === 4 && texts.every(t => /^[A-E]\. Option text number \d$/.test(t.trim())), `${T}: Play options are the leads only (${JSON.stringify(texts)})`);
    ok(!texts.some(t => t.includes('EXPLAIN')), `${T}: no option contains the explanation`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/play-mc-${tag}-${themeName}.png` });
    await p.click('#quitBtn').catch(() => {});
  }
  // ---- Practice test: same ----
  if (tag === 'desktop') {
    await p.goto(APP + '#/deck/d-play'); await p.waitForSelector('#testBtn');
    await p.click('#testBtn'); await p.waitForSelector('#ptForm'); await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
    let seen = 0, leaked = 0, leads = 0; const bad = [];
    for (let i = 0; i < 8; i++) {
      const t = (await p.locator(".t-opt .lbl").allInnerTexts()).filter(x => !/^(True|False)$/.test(x.trim()));
      // (a question can ask either way round: the options are then the leads of the backs, or the fronts)
      if (t.length) { seen++; if (t.some(x => !/^(?:[A-E]\. Option text number|Synthetic question) \d\??$/.test(x.trim()))) leaked++, bad.push(t); leads += t.filter(x => /^[A-E]\. Option/.test(x.trim())).length; }
      if (!(await p.locator('#tNext').isEnabled().catch(() => false))) break;
      await p.click('#tNext');
    }
    ok(seen > 0 && leaked === 0, `${T}: Practice test options are the leads only (${seen} multiple-choice questions seen, ${leaked} with an explanation: ${JSON.stringify(bad)})`);
  }
  await p.context().close();
}
ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
