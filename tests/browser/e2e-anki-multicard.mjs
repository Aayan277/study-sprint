// An Anki note type with several card layouts ("Recognition" and "Production"): every card the note has in Anki comes in, each drawn from
// its own layout, as sibling cards with their own review history. Cards whose layout draws an empty front are left out, as in Anki.
// File: anki-multicard-legacy.apkg (made up by make-files/make_apkg_verbs.py): notes inu and sakana (both cards), neko (Production front
// empty), tori (only the first card), and a Basic note.   Run with: node tests/browser/run.mjs anki-multicard
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.stack));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');

// ---------- 1. the preview ----------
await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/anki-multicard-legacy.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const found = (await page.textContent('#found')).replace(/\s+/g, ' ');
ok(found.includes('Found 7 cards'), 'five notes make seven cards (neko\'s empty Production card is left out): ' + found.slice(0, 40));
ok(found.includes('2 notes → 4 cards'), 'the preview says "2 notes → 4 cards" for the notes that bring both cards: ' + found.slice(0, 200));
ok(!found.includes('more card types'), 'no "more card types in Anki" note: the cards now come in');
const prog = (await page.textContent('#progInfo')).replace(/\s+/g, ' ');
ok(prog.includes('8 reviews on 3 cards'), 'history counts the cards that come in (neko\'s skipped card has none): ' + prog.slice(0, 40));
ok(await page.locator('.prow .badge', { hasText: 'Card type 1: part of a note' }).count() === 2 && await page.locator('.prow .badge', { hasText: 'Card type 2: part of a note' }).count() === 2, 'four rows are marked as one of a note\'s card types');
const rows = await page.locator('.prow').evaluateAll(list => list.map(r => r.querySelector('[data-side=front]').value.replace(/\n/g, ' / ') + ' => ' + r.querySelector('[data-side=back]').value.replace(/\n/g, ' / ')));
ok(rows.includes('inu / いぬ => dog / Inu ga suki.') && rows.some(r => r.startsWith('dog => inu / いぬ')), 'both layouts are drawn for inu: ' + JSON.stringify(rows.slice(0, 2)));
ok(rows.length === 7 && !rows.some(r => r.startsWith(' =>') || r.startsWith('=>')), 'seven rows, none with an empty front');
await page.screenshot({ path: SP + '/multicard-preview-375.png', fullPage: true });

// ---------- 2. what was saved ----------
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Multi'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
const saved = await page.evaluate(async () => {
  const db = await import('./js/db.js'), rv = await import('./js/reverse.js');
  const d = (await db.getDecks()).find(x => x.name === 'Multi');
  const cards = (await db.getCardsInDeck(d.id)).sort((a, b) => a.created - b.created);
  const out = [];
  for (const c of cards) out.push({ ...c, pair: rv.isPair(c), logs: (await db.getCardLogs(c.id)).map(l => [l.source, l.rating]), state: !!(await db.get('cardStates', c.id)) });
  return { id: d.id, cards: out, logs: (await db.getAll('reviewLog')).length };
});
const by = f => saved.cards.filter(f);
const inu = by(c => c.front.startsWith('inu')).concat(by(c => c.front === 'dog')), sak = by(c => c.front.startsWith('sakana') || c.front === 'fish');
ok(saved.cards.length === 7, 'seven cards saved: ' + saved.cards.length);
ok(inu.length === 2 && inu[0].noteId && inu[0].noteId === inu[1].noteId, 'inu: two cards share one noteId (siblings)');
ok(inu.map(c => c.templateOrd).join() === '0,1', 'inu: the cards know their Anki card numbers (0 and 1)');
ok(inu.every(c => !c.pair && c.reverse === undefined), 'inu: they are not taken for a reversed pair');
ok(inu[0].back === 'dog\nInu ga suki.' && inu[1].back.startsWith('inu\nいぬ'), 'inu: each card is drawn from its own layout');
ok(inu[1].backSounds?.length === 1, 'inu: the Production card has the sound its layout shows on the back');
ok(sak.length === 2 && sak[0].noteId && sak[0].noteId === sak[1].noteId && sak[0].noteId !== inu[0].noteId, 'sakana: its own pair of siblings, not linked to inu');
const neko = by(c => c.front.startsWith('neko')), tori = by(c => c.front.startsWith('tori')), basic = by(c => c.back.startsWith('Memory') || c.front === 'Memory' || c.back === 'Hippocampus');
ok(neko.length === 1 && !neko[0].noteId && neko[0].templateOrd === undefined && by(c => c.front === '').length === 0, 'neko: only its first card; the empty-front card is skipped and the card has no siblings');
ok(tori.length === 1 && !tori[0].noteId && tori[0].templateOrd === undefined, 'tori: a note with one card in Anki is one plain card');
ok(basic.length === 1 && !basic[0].noteId && basic[0].templateOrd === undefined, 'the Basic note is an ordinary card, as before');
ok(inu.concat(sak, neko, tori).every(c => c.tags.includes('vocab') && c.deckId === saved.id), 'the cards of a note share its deck and tags');

// ---------- 3. each card's own history ----------
const hist = c => c.logs.length;
ok(hist(inu[0]) === 3 && hist(inu[1]) === 3, 'inu: 3 + 3 reviews, each replayed from its own Anki card: ' + inu.map(hist));
ok(hist(neko[0]) === 2, 'neko: its first card has its 2 reviews');
ok(saved.logs === 8, 'eight reviews in all (the skipped card\'s review is not brought): ' + saved.logs);
ok(inu.every(c => c.state) && neko[0].state && !sak[0].state && !tori[0].state, 'cards with history have a schedule, the others are new');
ok(inu[1].logs.some(l => l[1] === 1) && !inu[0].logs.some(l => l[1] === 1), 'the Production card keeps its own lapse (an Again answer), the Recognition card has none');
ok(inu.concat(neko).every(c => c.logs.every(l => l[0] === 'anki')), 'history rows are marked as from Anki');

// ---------- 4. Review shows one card of a note a day ----------
await page.goto(APP + '#/review/' + saved.id); await page.waitForSelector('#flash');
const left = () => page.evaluate(() => [...document.querySelectorAll('.rv-counts span')].reduce((n, s) => n + (+s.textContent || 0), 0));
const start = await left();
ok(start === 5, 'Review has 5 cards to do, not 7: one of each sibling pair waits for tomorrow (' + start + ')');
let answered = 0;
for (let i = 0; i < 12 && !(await page.locator('.stats4').count()); i++) {
  await page.keyboard.press('Space'); await page.waitForSelector('.rv-back:not([inert])'); await page.keyboard.press('4'); answered++;
  await page.waitForFunction(() => document.querySelector('.stats4') || document.querySelector('.rv-front:not([inert])'), null, { timeout: 8000 });
}
ok(answered === 5, 'the session ends after 5 answers: ' + answered);
const today = await page.evaluate(async id => {
  const db = await import('./js/db.js');
  const d = await db.getCardsInDeck(id), seen = new Map();
  for (const c of d) { const n = (await db.getCardLogs(c.id)).filter(l => l.source === 'review').length; if (c.noteId) seen.set(c.noteId, (seen.get(c.noteId) || 0) + n); }
  return [...seen.values()];
}, saved.id);
ok(today.length === 2 && today.every(n => n === 1), 'each note with two cards had exactly one of them answered today: ' + today);

ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
