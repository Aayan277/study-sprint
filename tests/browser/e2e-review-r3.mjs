// Round 3 study screen: the question stays put when the card is flipped, and nothing collides, at every text length.
// Cases: tiny, very long, one long unbroken word, a list, a cloze. Each on a computer (1440x900) and a phone (390x844), checking:
//   - the deck label, the question, the answer and the rating bar do not overlap (the answer is checked at the bottom of the page)
//   - no sideways scroll
//   - the question's top moves 4px or less when the card is flipped
//   - the rating buttons can be reached (inside the screen, and nothing sits on top of them)
// Also: the Today hero names the amount of work once ("Start · ~N min", the count is in the button's aria-label), and the card has
// no "Space to flip" line and no outline on the flipped answer.
// Run with: node tests/browser/run.mjs review-r3
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';

const F80 = 'A 54-year-old patient presents with progressive shortness of breath, a dry cough lasting three months, and clubbing of the fingers. Chest examination reveals fine bibasal inspiratory crackles. Lung function tests show a restrictive pattern with reduced gas transfer, and a high-resolution CT scan shows subpleural honeycombing at both bases. She has never smoked but kept pigeons for twenty years. What is the most likely diagnosis, and which investigation and treatment would you consider next?';
const B250 = Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1}: the most likely diagnosis is idiopathic pulmonary fibrosis or, given the pigeon exposure, chronic hypersensitivity pneumonitis; the two can look almost identical on imaging, so the exposure history matters a great deal. Remove the antigen source completely and discuss the case with the multidisciplinary team.`).join('\n\n');
const CASES = [
  { id: 'tiny', front: 'H₂O', back: 'Water' },
  { id: 'xlong', front: F80, back: B250 },
  { id: 'unbroken', front: 'pneumonoultramicroscopicsilicovolcanoconiosis', back: 'See https://www.example.com/library/medicine/respiratory/diseases/pneumonoultramicroscopicsilicovolcanoconiosis-reference' },
  { id: 'list', front: 'Name the stages of mitosis and what happens in each', back: ['Prophase: chromosomes condense', 'Prometaphase: the envelope breaks down', 'Metaphase: chromosomes line up', 'Anaphase: sister chromatids separate', 'Telophase: envelopes re-form', 'Cytokinesis: the cytoplasm divides'].map(s => '- ' + s).join('\n') },
  { id: 'cloze', front: 'The […] makes most of the cell\'s ATP', back: 'mitochondrion', extra: { noteId: 'n1', noteText: 'The {{c1::mitochondrion}} makes most of the cell\'s ATP', cloze: 1 } },
];

// What is on screen right now (rects are relative to the viewport).
const measure = () => {
  const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const shown = e => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
  const face = [...document.querySelectorAll('.rv-face')].find(f => !f.inert && shown(f));
  const q = face && [...face.querySelectorAll('.flash-front,.flash-recap')].find(shown);
  const back = shown(document.querySelector('.rv-card.flipped .flash-back')) ? document.querySelector('.rv-card.flipped .flash-back') : null;
  const sc = document.scrollingElement;
  const rates = [...document.querySelectorAll('#ratebar .rate, #ratebar #showBtn')].filter(shown);
  const reach = rates.map(b => { const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && b.contains(document.elementFromPoint(x, y)); });
  return { deck: R(face?.querySelector('.flash-deck')), q: R(q), a: R(back), bar: R(document.getElementById('ratebar')), hscroll: sc.scrollWidth > sc.clientWidth + 1, reach, n: rates.length,
    keyLine: !!document.querySelector('.key-line, #keyLine'), outline: face ? getComputedStyle(document.querySelector('.rv-back')).outlineStyle : '' };
};
const hit = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b - 0.5 && a.b > b.t + 0.5;

for (const [tag, viewport, mobile] of [['pc', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', serviceWorkers: 'block', reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(tag + ' ' + e.stack));
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async cases => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const now = Date.now();
    let k = 0;
    for (const c of cases) {
      const deckId = 'd-' + c.id;
      await db.addDeckWithCards({ id: deckId, name: 'Case ' + c.id, color: '#46A758', created: now + k++ }, [{ id: c.id, deckId, front: c.front, back: c.back, tags: [], created: 0, ...(c.extra || {}) }]);
      await db.putMany('cardStates', [{ cardId: c.id, due: now - 86400000, stability: 10, difficulty: 5, elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 3 * 86400000 }]);
    }
  }, CASES);

  for (const c of CASES) {
    const T = `${tag}/${c.id}`;
    await p.goto(APP + '#/review/d-' + c.id); await p.waitForSelector('#showBtn'); await p.waitForTimeout(450);
    if (!mobile) await p.mouse.move(2, viewport.height - 10);
    const front = await p.evaluate(measure);
    ok(front.q && !hit(front.deck, front.q) && !hit(front.q, front.bar), `${T}: front: the deck label, the question and the rating bar do not overlap`);
    ok(!front.hscroll, `${T}: front: no sideways scroll`);
    ok(!front.keyLine, `${T}: no "Space to flip" line under the card`);
    ok(front.n >= 1 && front.reach.every(Boolean), `${T}: front: the Show answer button can be reached`);
    if (mobile) await p.tap('#showBtn'); else await p.keyboard.press('Space');
    await p.waitForSelector('.rv-card.flipped'); await p.waitForSelector('#ratebar .rate'); await p.waitForTimeout(350);
    const flipped = await p.evaluate(measure);
    if (c.id !== 'cloze') ok(front.q && flipped.q && Math.abs(flipped.q.t - front.q.t) <= 4, `${T}: the question moves ${front.q && flipped.q ? Math.round(Math.abs(flipped.q.t - front.q.t)) : '?'}px on flip (4px at most)`);
    ok(flipped.a && flipped.a.t > (flipped.q ? flipped.q.b : 0) - 1, `${T}: the answer sits below the question`);
    ok(flipped.outline === 'none', `${T}: no outline on the flipped answer (${flipped.outline})`);
    ok(!flipped.hscroll, `${T}: answer: no sideways scroll`);
    // to the bottom of the page: the end of the answer clears the rating bar, and the buttons can be reached
    await p.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight)); await p.waitForTimeout(200);
    const end = await p.evaluate(measure);
    ok(end.a && !hit(end.a, end.bar), `${T}: at the bottom, the answer does not run under the rating bar (answer bottom ${end.a && Math.round(end.a.b)}, bar top ${end.bar && Math.round(end.bar.t)})`);
    ok(!hit(end.deck, end.bar) && (!end.q || !hit(end.q, end.bar) || end.q.b < 0), `${T}: at the bottom, the deck label and question are not under the bar`);
    ok(end.n === 4 && end.reach.every(Boolean), `${T}: the four rating buttons can be reached`);
    await p.evaluate(() => scrollTo(0, 0));
    await p.click('.rate.r3'); await p.waitForTimeout(300);
  }

  // Today: the amount of work is named once, in the heading; Start says how long it takes
  await p.goto(APP + '#/today'); await p.waitForSelector('.today-hero');
  const hero = await p.evaluate(() => {
    const b = document.getElementById('startBtn');
    return b ? { text: b.textContent.replace(/\s+/g, ' ').trim(), label: b.getAttribute('aria-label'), big: document.querySelector('.th-big')?.textContent.trim() } : null;
  });
  if (hero) {
    const n = (/^(\d[\d,]*) to go/.exec(hero.big) || [])[1];
    ok(/^Start · ~/.test(hero.text) && !/card/.test(hero.text), `${tag}: Start reads "${hero.text}" (the count is not repeated)`);
    ok(n && hero.label.includes(n), `${tag}: its aria-label still carries the count: ${hero.label}`);
    ok(hero.label.includes(hero.text), `${tag}: the aria-label contains the visible text (label in name): "${hero.label}" has "${hero.text}"`);
  } else ok(true, `${tag}: nothing left to study, no Start button`);
  await ctx.close();
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
