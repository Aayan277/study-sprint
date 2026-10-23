// An Anki note type's own card layout: its template decides what is on the front and back, so a deck like "Japanese Verb Forms"
// (nine fields, all shown on the card) comes in as it looks in Anki, with nothing folded away. Also furigana drawn as ruby.
// Files: anki-verbs-legacy.apkg (two verb notes) and anki-verbs-mixed-legacy.apkg (the same plus a Basic note), made up by
// make-files/make_apkg_verbs.py.   Run with: node tests/browser/run.mjs anki-template
// Screenshots of the review card (dark and light, phone and computer) go to $SHOTS if it is set, else to the out folder.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const SHOTS = process.env.SHOTS || SP;
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const FRONT = ['見る', 'to see', 'Plain negative', "~ない · doesn't ~"];
const BACK = ['見ない', 'みない', 'る-verb (ichidan): drop る, add the ending', 'る-verb (ichidan)'];
// The text of an element as read without the little readings above words (so 見み る is 見る).
const baseText = (p, sel) => p.locator(sel).first().evaluate(el => { const c = el.cloneNode(true); c.querySelectorAll('rt').forEach(r => r.remove()); c.querySelectorAll('br').forEach(b => b.replaceWith('\n')); return c.textContent; });
const lines = t => t.split('\n').map(l => l.trim()).filter(Boolean);

const open = async (viewport, scheme, mobile) => {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.stack));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
};
const load = async (page, file) => {
  await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
};
const save = async (page, name) => { await page.selectOption('#deckSel', '__new'); await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 }); };
const cardsIn = (page, name) => page.evaluate(async n => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
  return (await db.getCardsInDeck(d.id)).sort((a, b) => a.created - b.created);
}, name);
const flip = async page => { await page.keyboard.press('Space'); await page.waitForSelector('.rv-back:not([inert])'); };
const closeSheet = async page => { await page.waitForTimeout(500); await page.evaluate(() => { const s = document.getElementById('sheet'); if (s?.open) s.close(); }); await page.waitForTimeout(250); };

// ---------- 1. the preview of a deck whose cards all follow their template ----------
let page = await open({ width: 375, height: 760 }, 'dark', true);
await load(page, 'anki-verbs-legacy.apkg');
const found = await page.textContent('#found');
ok(found.includes('Found 2 cards'), 'two notes make two cards: ' + found.slice(0, 50));
ok(found.includes("Cards follow the deck's own card layout."), 'the preview says the cards follow the deck\'s own layout');
ok(await page.isHidden('#cols'), 'the Front / Back column picker is hidden (it would mislead)');
ok(await page.isHidden('#fieldsRow'), 'no "Keep the other fields" switch: every field is on the card');
ok(await page.isHidden('#swapBtn'), 'and no Swap front and back');
ok(!found.includes('Other fields come along'), 'nothing is said about folded fields');
const pfront = await page.locator('.prow [data-side=front]').first().inputValue(), pback = await page.locator('.prow [data-side=back]').first().inputValue();
ok(pfront.startsWith('｜見《み》る\nto see\n') && pback.startsWith('見ない\nみない\n'), 'the first preview row has the template\'s front and back: ' + JSON.stringify(pfront.slice(0, 40)));
await page.screenshot({ path: SHOTS + '/preview-375-dark.png', fullPage: true });
await save(page, 'Verbs');

// ---------- 2. what was saved ----------
const cs = await cardsIn(page, 'Verbs');
ok(cs.length === 2, 'two cards saved');
ok(cs[0].front === '｜見《み》る\nto see\nPlain negative\n~ない · doesn\'t ~', 'front: four lines, the verb with its furigana mark: ' + JSON.stringify(cs[0].front));
ok(cs[0].back === BACK.join('\n'), 'back: the four answer lines, without the front again');
ok(cs.every(c => !c.noteFields && !c.noteExtra), 'no folded "Other fields" and no extra: every field is on the card');
ok(cs[1].front.startsWith('｜食《た》べる\nto eat\nPolite\n'), 'second card: ' + JSON.stringify(cs[1].front.split('\n')[0]));

// ---------- 3. Review: front without a click, back after the flip ----------
const deckOf = p => p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Verbs').id);
let deck = await deckOf(page);
// (each browser window starts empty, so the next ones import the deck again before they look at it)
const fresh = async (vp, scheme, mobile) => { const p = await open(vp, scheme, mobile); await load(p, 'anki-verbs-legacy.apkg'); await save(p, 'Verbs'); deck = await deckOf(p); return p; };
const shoot = async (p, tag) => { await p.waitForFunction(() => { const t = document.getElementById('toast'); return !t || t.hidden || !t.textContent.trim() || getComputedStyle(t).opacity === '0'; }, null, { timeout: 9000 }).catch(() => {}); await p.waitForTimeout(350); await p.screenshot({ path: `${SHOTS}/review-${tag}.png` }); };
const review = async (p, tag) => {
  await p.goto(APP + '#/review/' + deck); await p.waitForSelector('#flash');
  const front = await baseText(p, '.rv-front .flash-front');
  ok(JSON.stringify(lines(front)) === JSON.stringify(FRONT) || JSON.stringify(lines(front)) === JSON.stringify(['食べる', 'to eat', 'Polite', '~ます · does ~ (polite)']),
    `${tag}: the front shows the four lines with nothing to click open: ${JSON.stringify(lines(front))}`);
  ok(await p.locator('.rv-front .flash-front ruby').count() === 1 && (await p.locator('.rv-front .flash-front ruby rt').first().textContent()) === (front.startsWith('見') ? 'み' : 'た'), `${tag}: the reading is a real ruby element above the verb`);
  const rtBox = await p.locator('.rv-front .flash-front ruby rt').first().boundingBox(), baseBox = await p.locator('.rv-front .flash-front ruby').first().boundingBox();
  ok(rtBox && baseBox && rtBox.y < baseBox.y + baseBox.height / 2, `${tag}: the reading sits above the word`);
  ok(await p.locator('.rv-front .note-field, .rv-front details').count() === 0, `${tag}: no folded sections on the front`);
  await shoot(p, tag + '-front');
  await flip(p);
  const back = await baseText(p, '.rv-back .flash-back');
  ok(JSON.stringify(lines(back)) === JSON.stringify(BACK) || lines(back)[0] === '食べます', `${tag}: the back shows the answer lines after flipping: ${JSON.stringify(lines(back)).slice(0, 90)}`);
  ok(await p.locator('.rv-back .note-field, .rv-back details').count() === 0 && !(await p.textContent('.rv-back')).includes('Other fields'), `${tag}: no folded "Other fields" on the back`);
  ok((await p.locator('.rv-back .flash-recap').innerText()).includes('Plain negative') || (await p.locator('.rv-back .flash-recap').innerText()).includes('Polite'), `${tag}: the front is shown above the answer (once)`);
  ok((await p.locator('.rv-back .flash-back').innerText()).includes('Plain negative') === false, `${tag}: and not repeated in the answer`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no sideways scroll`);
  await shoot(p, tag + '-back');
};
await review(page, 'phone-dark');
await page.context().close();

page = await fresh({ width: 375, height: 760 }, 'light', true); await review(page, 'phone-light');
// ---------- 4. furigana is plain text where there is no room for ruby: the list, and the search ----------
await page.goto(APP + '#/deck/' + deck); await page.waitForSelector('.crow');
const row = (await page.locator('.crow').first().innerText()).replace(/\s+/g, ' ');
ok(row.includes('見(み)る') && !row.includes('｜'), 'the deck list shows 見(み)る as plain text: ' + row.slice(0, 60));
await page.fill('#brQuery', 'み)る'); await page.waitForTimeout(400);
ok((await page.locator('.crow').count()) === 1, 'searching finds it by the reading');
await page.context().close();

page = await fresh({ width: 1280, height: 800 }, 'dark', false); await review(page, 'desktop-dark'); await page.context().close();
page = await fresh({ width: 1280, height: 800 }, 'light', false); await review(page, 'desktop-light'); await page.context().close();

// ---------- 5. a deck with both kinds: the picker applies to the other cards only ----------
page = await open({ width: 375, height: 760 }, 'dark', true);
await load(page, 'anki-verbs-mixed-legacy.apkg');
const mixed = await page.textContent('#found');
ok(mixed.includes("2 cards follow the deck's own card layout; Front and Back above apply to the rest."), 'mixed deck: the preview says which cards follow the layout: ' + mixed.replace(/\s+/g, ' ').slice(0, 160));
ok(await page.isVisible('#cols'), 'the Front / Back picker is there for the rest');
await page.selectOption('#frontCol', '1'); await page.selectOption('#backCol', '0');
await page.waitForTimeout(200);
const rows = await page.locator('.prow').evaluateAll(list => list.map(r => r.querySelector('[data-side=front]').value + ' => ' + r.querySelector('[data-side=back]').value));
ok(rows.length === 3 && rows.some(r => r.includes('Memory')) && rows.filter(r => r.includes('Plain negative') || r.includes('Polite')).length === 2, 'the picker moved the Basic card only: ' + rows.map(r => r.replace(/\s+/g, ' ').slice(0, 25)).join(' | '));
await page.screenshot({ path: SHOTS + '/preview-mixed-375-dark.png', fullPage: true });
if (await page.isVisible('#subRow')) await page.click('#subRow');          // (everything in the one deck: easier to look at)
await save(page, 'Mixed');
const mc = await cardsIn(page, 'Mixed');
const basic = mc.find(c => c.back === 'Hippocampus');
ok(mc.length === 3 && basic?.front === 'Memory' && JSON.stringify(basic.noteFields) === JSON.stringify([{ name: 'Source', text: 'Textbook p. 12' }]), 'the Basic card follows the picker and keeps its Source as a folded field');
ok(mc.filter(c => c.front.includes('Plain negative') || c.front.includes('Polite')).length === 2, 'the verb cards ignore the picker');
await page.context().close();

ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
