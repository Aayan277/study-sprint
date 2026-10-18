// Motion pass (C1 to C5): the two Settings switches, reduced motion, confetti once a day, clean-up, and the rating latency budget.
// This file runs with motion ON (the other tests run with reduced motion, see pw.mjs), and sets reduced motion itself where it tests it.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const DAY = 86400000;
const open = async ({ reduced = false, w = 390, h = 800 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  // Every confetti canvas the page ever draws is counted as it is added, so a check never depends on catching it before it is gone.
  await ctx.addInitScript(() => {
    window.__confetti = 0;
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches?.('canvas.fx-confetti')) window.__confetti++; })
      .observe(document, { childList: true, subtree: true });
  });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  return p;
};
// A deck of n cards that are all due (so no new-card limit gets in the way).
const deck = (p, id, n) => p.evaluate(async ([id, n]) => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  await db.addDeckWithCards({ id, name: 'Deck ' + id, color: '#46A758', created: now }, Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${id} front ${i}`, back: `${id} back ${i}`, tags: [], created: i })));
  await db.putMany('cardStates', Array.from({ length: n }, (_, i) => ({ cardId: id + i, due: now - D, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D, scheduledDays: 3, elapsedDays: 3, learningSteps: 0 })));
}, [id, n]);
const today = p => p.evaluate(() => { location.hash = '#/today'; });
const startDeck = async (p, id) => { await today(p); await p.waitForSelector(`[data-start="${id}"]`); await p.click(`[data-start="${id}"]`); await p.waitForSelector('#flash'); };
// Each press waits for the app's own state before the next one: Space until the card is flipped, the rating until the next card is
// drawn (unflipped) or the finish screen is up. No clock, so a busy page cannot lose a key press.
const rateAll = async (p, n, key = '3') => {
  for (let i = 0; i < n; i++) {
    await p.keyboard.press('Space');
    await p.waitForSelector('#flash.flipped');
    await p.keyboard.press(key);
    await p.waitForFunction(() => document.querySelector('.stats4') || !document.querySelector('#flash.flipped'));
  }
  await p.waitForSelector('.stats4');
};
const setSetting = (p, k, v) => p.evaluate(([k, v]) => import('./js/db.js').then(m => m.setSetting(k, v)), [k, v]);
const fxNodes = p => p.evaluate(() => document.querySelectorAll('.fx-ghost,.fx-ring,.fx-ivl,canvas.fx-confetti').length);
// Did a confetti burst start since the last call? The finish screen starts it from a 180 ms timer, so a timer queued now for later
// can only fire after it: once that has fired, a burst either has started (and was counted) or never will. (A barrier behind the
// app's own timer, not a guess at how long the machine takes.)
const confettiSeen = async p => {
  await p.evaluate(() => new Promise(r => setTimeout(r, 400)));
  return p.evaluate(() => { const n = window.__confetti; window.__confetti = 0; return n > 0; });
};
// Wait for a state of the page (no clock): the condition is checked in the page until it holds.
const until = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 20000 });
// The settings saved in IndexedDB (the switches save after the click).
const settingsAre = (p, want) => until(p, async w => { const s = await (await import('./js/db.js')).getSettings(); return Object.entries(w).every(([k, v]) => s[k] === v); }, want);
// Press a key and wait until the card on screen is a different one (the old one was replaced).
const nextCard = async (p, press) => {
  await p.evaluate(() => { window.__card = document.getElementById('flash'); });
  await press();
  await until(p, () => { const c = document.getElementById('flash'); return !c || c !== window.__card; });
};

// ---------- the two switches ----------
let p = await open();
await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('#ratingFeedback');
ok(await p.isChecked('#ratingFeedback') && await p.isChecked('#smoothMotion'), 'Rating feedback and Smooth transitions are in Settings and on by default');
await p.waitForSelector('section:has(#ratingFeedback) h2'); await p.waitForSelector('section:has(#smoothMotion) h2');
ok(await p.$eval('#ratingFeedback', e => e.closest('section').querySelector('h2').textContent) === 'Appearance' && await p.$eval('#smoothMotion', e => e.closest('section').querySelector('h2').textContent) === 'Appearance', 'both are in the Appearance section');
ok(await p.evaluate(async () => { const m = await import('./js/sync-data.js'); return !m.SYNCED_SETTINGS.includes('ratingFeedback') && !m.SYNCED_SETTINGS.includes('smoothMotion'); }), 'they stay on this device (not synced)');
ok(await p.evaluate(() => document.documentElement.dataset.smooth) === 'on', 'smooth is on for the page');
await p.click('label:has(#ratingFeedback)'); await p.click('label:has(#smoothMotion)');
await settingsAre(p, { ratingFeedback: false, smoothMotion: false });
const saved = await p.evaluate(async () => { const s = await (await import('./js/db.js')).getSettings(); return [s.ratingFeedback, s.smoothMotion]; });
ok(saved[0] === false && saved[1] === false, 'turning them off is saved');
ok(await p.evaluate(() => document.documentElement.dataset.smooth) === 'off', 'and takes effect straight away');
await p.reload(); await p.waitForSelector('#ratingFeedback');
ok(await p.evaluate(() => document.documentElement.dataset.smooth) === 'off', 'the off switch survives a reload');
await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('#ratingFeedback');
ok(!(await p.isChecked('#ratingFeedback')) && !(await p.isChecked('#smoothMotion')), 'and shows as off');
await p.click('label:has(#ratingFeedback)'); await p.click('label:has(#smoothMotion)');
await settingsAre(p, { ratingFeedback: true, smoothMotion: true });

// ---------- C1: rating feedback ----------
await deck(p, 'a', 12);
await startDeck(p, 'a');
// The effects are short-lived, so the page itself takes the snapshot the moment the outline is added (a slow machine cannot miss it).
await p.evaluate(() => {
  window.__fxSnap = null;
  const obs = new MutationObserver(() => {
    const g = document.querySelector('.fx-ghost');
    if (!g || !document.querySelector('.fx-ring')) return;
    window.__fxSnap = { ring: true, ivl: document.querySelector('.fx-ivl')?.textContent, ghost: true, ghostId: g.querySelectorAll('[id]').length + (g.id ? 1 : 0),
      hidden: g.textContent === '' && !g.querySelector('*') && !g.matches('.rv-card,.flash,.flipped'), inert: g.getAttribute('aria-hidden') === 'true', r: g.dataset.r };
    obs.disconnect();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  window.__card = document.getElementById('flash');
});
await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
await p.keyboard.press('3');
await until(p, () => window.__fxSnap);
const fx = await p.evaluate(() => window.__fxSnap);
ok(fx.ring && fx.ghost && /^\d+[mdhw]|^<?\d/.test(fx.ivl || ''), `rating feedback on: a ring, the interval floating up (${fx.ivl}) and the old card's outline`);
ok(fx.ghostId === 0 && fx.hidden && fx.inert && fx.r === '3', 'the outline has no text, no ids and is not a copy of the card, is hidden from screen readers, and carries the rating');
await until(p, () => { const c = document.getElementById('flash'); return c && c !== window.__card; });
ok(await p.evaluate(() => { const c = document.getElementById('flash'); return !c.dataset.r && !c.closest('[data-r]') && !c.className.includes('fx-'); }), 'the next card is not tinted');
await until(p, () => !document.querySelectorAll('.fx-ghost,.fx-ring,.fx-ivl,canvas.fx-confetti').length);
ok((await fxNodes(p)) === 0, 'nothing is left in the page afterwards');
await setSetting(p, 'ratingFeedback', false);
await p.evaluate(async () => { const f = (await import('./js/fx.js')); f.configure({ ratingFeedback: false, smoothMotion: true }); });
// (the effects are made while the rating is handled, so once the next card is up there is nothing left to wait for)
await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
await nextCard(p, () => p.keyboard.press('3'));
ok((await fxNodes(p)) === 0, 'with Rating feedback off there is no ring, interval or outline');
await p.context().close();

p = await open({ reduced: true });
await deck(p, 'a', 12); await startDeck(p, 'a');
await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
await nextCard(p, () => p.keyboard.press('3'));
ok((await fxNodes(p)) === 0, 'reduced motion: no ring, interval or outline');
await rateAll(p, 11);
ok(await p.evaluate(() => !document.querySelector('.fx-count,.fx-in,.fx-ignite,canvas.fx-confetti,.fx-glow-h1')), 'reduced motion: the finish screen shows final numbers at once, no count-up, flame animation or confetti');
ok((await p.$$eval('.stats4 .v', v => v.map(x => x.textContent))).join() !== '' && await p.evaluate(() => !document.querySelector('[data-n]')), 'and there is no ticking number');
ok(await p.evaluate(() => { const i = document.querySelector('.rv-prog i'); return !i || getComputedStyle(i).transitionDuration === '0s'; }), 'the progress bar changes without a transition');
await p.context().close();

// ---------- C3: the finish screen, confetti once a day ----------
p = await open();
await deck(p, 'b', 6); await deck(p, 'c', 6); await deck(p, 'd', 3); await deck(p, 'e', 6);
await startDeck(p, 'b');
await rateAll(p, 6);
ok(await p.evaluate(() => [...document.querySelectorAll('.stats4 .v')].some(v => v.classList.contains('fx-count') && v.dataset.n !== undefined)), 'the numbers count up (the ticking value is drawn from data-n)');
ok(await confettiSeen(p), 'confetti plays when a whole queue of 5+ cards is finished');
const live = await p.evaluate(() => { const v = document.querySelector('.stats4 .v'); return { text: v.textContent, aria: !!v.closest('[aria-live]') }; });
ok(live.text === '6' && !live.aria, 'the real text is already final and the number is not in a live region: ' + live.text);
await until(p, () => !document.querySelector('.fx-count,[data-n]'));
ok(await p.evaluate(() => !document.querySelector('.fx-count,[data-n]')), 'every count-up finishes and leaves nothing behind');
await until(p, () => !document.querySelector('canvas.fx-confetti'));
ok((await fxNodes(p)) === 0, 'the canvas is removed after the burst');
await startDeck(p, 'c'); await rateAll(p, 6);
ok(!(await confettiSeen(p)), 'a second finished queue the same day has no confetti');
await startDeck(p, 'd'); await rateAll(p, 3);
ok(!(await confettiSeen(p)), 'a queue under 5 cards never has confetti');
await p.evaluate(() => localStorage.setItem('study-sprint-fx-burst', 'Mon Jan 01 2001'));
await startDeck(p, 'e'); await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
await nextCard(p, () => p.keyboard.press('3'));
await p.click('#endBtn'); await p.waitForSelector('.stats4');
ok(!(await confettiSeen(p)), 'ending early never has confetti');
await p.context().close();

// a milestone: 6 earlier days + today = 7, shown once, and it bypasses the daily limit once
p = await open();
await deck(p, 'm', 6); await deck(p, 'n', 6);
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  await db.putMany('reviewLog', Array.from({ length: 6 }, (_, i) => ({ cardId: 'm0', timestamp: now - (i + 1) * D, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true })));
  localStorage.setItem('study-sprint-fx-burst', new Date().toDateString());       // confetti already played today
});
await startDeck(p, 'm'); await rateAll(p, 6);
ok((await p.textContent('.fx-mile-tag').catch(() => '')) === 'One week', 'a 7-day streak shows the "One week" pill');
ok(await confettiSeen(p), 'and a new milestone plays confetti even though today\'s limit was used');
await until(p, () => !document.querySelector('canvas.fx-confetti'));
await startDeck(p, 'n'); await rateAll(p, 6);
ok(!(await p.$('.fx-mile-tag')) && !(await confettiSeen(p)), 'the pill and the burst do not come back for the same milestone');
await p.context().close();

// ---------- C2: the goal ring ----------
p = await open();
await deck(p, 'r', 10);
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.putMany('reviewLog', Array.from({ length: 4 }, (_, i) => ({ cardId: 'r' + i, timestamp: now - 60000 * (i + 1), source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true })));
  localStorage.setItem('study-sprint-fx-ring', JSON.stringify({ day: new Date().toDateString(), frac: 0.2, n: 2 }));
  window.__dash = [];
  new MutationObserver(m => { for (const r of m) if (r.target.classList?.contains('ring-fg')) window.__dash.push(r.target.style.strokeDasharray); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
});
await today(p); await p.waitForSelector('.today-hero .ring');
// (the fill started and ended: the start value, the end value, then the style taken off; and the number has stopped counting)
await until(p, () => window.__dash.length >= 3 && !document.querySelector('.ring-fg.fx-fill, .ring-in [data-n]'));
const dash = await p.evaluate(() => window.__dash);
const circ = await p.$eval('.ring-fg', e => +e.getAttribute('stroke-dasharray').split(' ')[1]);
ok(dash.length >= 2 && Math.abs(parseFloat(dash[0]) / circ - 0.2) < 0.01, `the ring starts from the value last shown today (${(parseFloat(dash[0]) / circ).toFixed(2)}), not from empty`);
ok(await p.$eval('.ring-in b', e => e.textContent.trim()) === '4' && await p.evaluate(() => !document.querySelector('.ring-in [data-n]')), 'the number ends on the real value with nothing left over');
ok(await p.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-fx-ring')).n) === 4, 'and the new value is remembered for next time');
// done: every card answered
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  const cs = await db.getAll('cards'); await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now + 5 * 86400000, stability: 20, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now, scheduledDays: 5, elapsedDays: 1, learningSteps: 0 })));
  localStorage.setItem('study-sprint-fx-ring', JSON.stringify({ day: new Date().toDateString(), frac: 0.5, n: 4 }));
});
await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck'); await today(p); await p.waitForSelector('.today-hero .ring');
await p.waitForSelector('.ring.fx-win');
await until(p, () => document.querySelector('.today-hero .ring')?.classList.contains('is-full') && document.querySelector('.ring-check'));
ok(await p.$eval('.today-hero .ring', e => e.classList.contains('is-full')) && await p.$('.ring-check') !== null, 'a finished goal turns green and shows the check');
await until(p, () => !document.querySelector('.today-hero .ring').classList.contains('fx-win'));
ok(await p.$eval('.today-hero .ring', e => !e.classList.contains('fx-win')), 'the celebration class is taken off afterwards');
await p.context().close();
p = await open({ reduced: true });
await deck(p, 'r', 4);
await p.evaluate(async () => { const db = await import('./js/db.js'); const now = Date.now(); const cs = await db.getAll('cards'); await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now + 5 * 86400000, stability: 20, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now, scheduledDays: 5, elapsedDays: 1, learningSteps: 0 })));
  await db.putMany('reviewLog', [{ cardId: 'r0', timestamp: now - 1000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true }]); });
await today(p); await p.waitForSelector('.today-hero .ring.is-full');
ok(await p.evaluate(() => { const r = document.querySelector('.today-hero .ring'); return r.classList.contains('is-full') && !r.classList.contains('fx-win') && !r.querySelector('.fx-fill') && !document.querySelector('[data-n]'); }), 'reduced motion: the ring is drawn finished and green at once');
await p.context().close();

// ---------- C4: Play ----------
p = await open();
await deck(p, 'p', 12);
await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#pCard');
const backs = await p.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cards')).flatMap(c => [[c.front, c.back], [c.back, c.front]])));
const answerQ = async right => {
  await p.waitForSelector('#options .opt:not(:disabled)');
  const prompt = (await p.textContent('#pPrompt')).trim(), opts = await p.$$eval('#options .opt .lbl', l => l.map(x => x.textContent));
  let i = opts.indexOf(backs[prompt]); if (i < 0) i = 0; if (!right) i = (i + 1) % opts.length;
  await p.keyboard.press(String(i + 1));
};
// The page notes which animation a right and a wrong answer gets the moment the card is marked (the answer is handled in one go,
// so this cannot miss it however slow the machine is; the card is marked again for the next question after a while).
await p.evaluate(() => {
  window.__anim = {};
  new MutationObserver(() => {
    const c = document.querySelector('.play-card'); if (!c) return;
    if (c.classList.contains('ok') && !window.__anim.bloom) window.__anim.bloom = getComputedStyle(c, '::after').animationName;
    if (c.classList.contains('no') && !window.__anim.shake) window.__anim.shake = getComputedStyle(c).animationName;
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
});
const comboN = n => until(p, n => document.getElementById('streakWrap')?.dataset.n === String(n), n);
const tiers = [];
for (let q = 0; q < 6; q++) { await answerQ(true); await comboN(q + 1); tiers.push(await p.$eval('#streakWrap', e => e.dataset.tier || '0')); }
ok(tiers.join() === '0,0,1,1,2,2', 'the combo pill gets a tier at x3 and x5: ' + tiers.join());
await p.evaluate(() => { window.__anim = {}; });
await answerQ(true); await comboN(7);
ok((await p.evaluate(() => window.__anim)).bloom === 'fx-bloom', 'a right answer blooms');
await answerQ(false);
ok((await p.evaluate(() => window.__anim)).shake === 'fx-shake', 'a wrong answer shakes, damped');
ok(await p.$eval('#streakWrap', e => !e.dataset.tier), 'and the combo pill resets');
await p.click('#nextBtn');
// Play on to the results: each step waits for what the screen offers next (a question to answer, a Next button, or the results).
for (let q = 0; q < 40; q++) {
  await until(p, () => document.querySelector('.stamp, #nextBtn, #options .opt:not(:disabled)'));
  if (await p.$('.stamp')) break;
  if (await p.$('#options .opt:not(:disabled)')) await answerQ(true); else await p.click('#nextBtn').catch(() => {});
}
await p.waitForSelector('.stamp');
ok(await p.evaluate(() => getComputedStyle(document.querySelector('.stamp')).animationName === 'fx-stamp' && getComputedStyle(document.querySelector('.stamp'), '::after').animationName === 'fx-ink'), 'the grade stamp slams in with an ink ring');
ok(await p.$eval('.res-n', e => /^[\d,]+$/.test(e.textContent)), 'the score keeps its real text while it counts');
await until(p, () => !document.querySelector('.fx-count,[data-n],.fx-thud'));
ok(await p.evaluate(() => !document.querySelector('.fx-count,[data-n],.fx-thud')), 'Play leaves nothing behind');
await p.context().close();

// ---------- C5: tab transitions ----------
// Counts the View Transitions a click starts. Instead of a fixed wait it waits for the app's own state: the screen was redrawn (a new
// `.view` element) and every transition that was started has finished.
const vtCalls = async (p, click) => {
  await p.evaluate(() => {
    window.__vt = 0; window.__vtDone = []; window.__oldView = document.querySelector('#screen .view');
    const o = document.startViewTransition?.bind(document);
    if (o && !window.__vtWrapped) { window.__vtWrapped = true; document.startViewTransition = cb => { window.__vt++; const t = o(cb); window.__vtDone.push(t.finished); return t; }; }
  });
  await click();
  await p.waitForFunction(() => { const v = document.querySelector('#screen .view'); return v && v !== window.__oldView; });
  await p.evaluate(() => Promise.allSettled(window.__vtDone));
  return p.evaluate(() => window.__vt);
};
p = await open();
await today(p); await p.waitForSelector('.tdeck, .today-hero');
const supported = await p.evaluate(() => !!document.startViewTransition);
if (supported) {
  ok(await vtCalls(p, () => p.click('.tab[data-tab="decks"]')) >= 1, 'a tab change uses a View Transition');
  await p.waitForFunction(() => !document.documentElement.classList.contains('vt-on') && !document.documentElement.dataset.vtDir).catch(() => {});
  ok(await p.evaluate(() => !document.documentElement.classList.contains('vt-on') && !document.documentElement.dataset.vtDir), 'and its helper class and direction are cleaned up');
  ok(await p.$eval('#screen .view h1', e => e.textContent) === 'Decks', 'the new screen is there');
  await setSetting(p, 'smoothMotion', false);
  await p.evaluate(async () => (await import('./js/fx.js')).configure({ smoothMotion: false }));
  ok(await vtCalls(p, () => p.click('.tab[data-tab="stats"]')) === 0, 'with Smooth transitions off tabs change at once');
  await p.evaluate(async () => (await import('./js/fx.js')).configure({ smoothMotion: true }));
  await deck(p, 'v', 3); await startDeck(p, 'v');
  ok(await vtCalls(p, () => p.evaluate(() => { location.hash = '#/today'; })) === 0, 'leaving a Review round is instant (no transition)');
} else console.log('PASS (skipped) this browser has no View Transitions: the fade-up fallback is used');
await p.context().close();
p = await open({ reduced: true });
await today(p); await p.waitForSelector('.today-hero');
if (supported) ok(await vtCalls(p, () => p.click('.tab[data-tab="decks"]')) === 0, 'reduced motion: tabs change at once');
await p.context().close();

// ---------- the rating budget ----------
// How long from the key press until the next card is on screen, with the effects on and with them off.
// One page, alternating: the effects are switched on and off between ratings (the app reads reduced motion live), so both series
// see the same machine load and the comparison cannot be skewed by load changing between two separate runs.
const latency = async (n = 60) => {
  const p = await open({ reduced: false });
  await deck(p, 'l', n + 2); await startDeck(p, 'l');
  const series = { on: [], off: [] };
  for (let i = 0; i < n; i++) {
    const mode = i % 2 ? 'off' : 'on';
    await p.emulateMedia({ reducedMotion: mode === 'off' ? 'reduce' : 'no-preference' });
    await p.waitForFunction(m => matchMedia('(prefers-reduced-motion: reduce)').matches === (m === 'off'), mode);
    await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
    const t = await p.evaluate(() => new Promise(res => {
      const before = document.getElementById('flash'), t0 = performance.now();
      const done = () => { const now = document.getElementById('flash'); if (now && now !== before && !now.classList.contains('flipped')) { obs.disconnect(); res(performance.now() - t0); } };
      const obs = new MutationObserver(done); obs.observe(document.getElementById('screen'), { childList: true, subtree: true });
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    }));
    if (i >= 2) series[mode].push(t);          // (the first rating of each kind is warm-up)
  }
  await p.context().close();
  const sum = a => { a = [...a].sort((x, y) => x - y); return { median: a[a.length >> 1], max: a[a.length - 1] }; };
  return { on: sum(series.on), off: sum(series.off) };
};
const { on, off } = await latency();
console.log(`INFO rating to next card: effects on median ${on.median.toFixed(1)} ms (max ${on.max.toFixed(1)}), reduced motion median ${off.median.toFixed(1)} ms (max ${off.max.toFixed(1)})`);
// (relative to the reduced-motion run measured in the same load, so a slow or throttled machine moves both alike)
// (the effects do real work on the page, and that work slows down with the machine just like the rest, so the budget is a multiple of
// the reduced-motion time plus a small constant: it catches effects that hold up the next card, not a slow machine)
const T = Number(process.env.CPU_THROTTLE) || 1;      // the CPU slowdown the run is under (see pw.mjs)
ok(on.median < 60 * T && on.median <= off.median * 2 + 20, `rating stays instant: the next card is drawn about as fast with the effects on as without, and under 60 ms x ${T} (${on.median.toFixed(1)} ms vs ${off.median.toFixed(1)} ms)`);

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
await browser.close();
