// Accessibility round 2 (WCAG 2.2 AA): keyboard and screen-reader fixes found by the audit. Each check reads the DOM / ARIA attributes,
// document.activeElement, or presses real keys. Covers: card-type radios, practice-test ask (modal, Escape focus, keys), image-occlusion
// review wording, typed-answer result, the guided review, Suggest cards focus, the box editor, Suggest tags, Undo, and What's new.
import fs from 'node:fs';
import { chromium, realChromium } from './pw.mjs';
const APP = 'http://localhost:8123/';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const browser = await chromium.launch();
const real = await realChromium.launch();
const open = async (b = browser, opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block', ...opts });
  await ctx.route(/supabase\.co/, r => r.abort());                       // nothing leaves the page
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Could not save answer/.test(m.text())) errors.push('console ' + m.text()); });
  return p;
};
const active = p => p.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName.toLowerCase()) : ''; });
const attr = (p, sel, a) => p.getAttribute(sel, a);
// The text an aria-describedby / aria-labelledby points at.
const refText = (p, sel, a) => p.evaluate(([s, n]) => (document.querySelector(s)?.getAttribute(n) || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent.trim() ?? null), [sel, a]);
const toastSaid = p => p.evaluate(() => document.getElementById('toastLive')?.textContent || '');

async function seed(p) {
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js'), occ = await import('./js/occlusion.js'), media = await import('./js/media.js');
    const c = document.createElement('canvas'); c.width = 600; c.height = 400;
    const g = c.getContext('2d'); g.fillStyle = '#fda085'; g.fillRect(0, 0, 600, 400);
    const info = await media.addImageInfo(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'heart.png', { type: 'image/png' }), { maxSide: media.OCCLUSION_SIDE });
    const now = Date.now();
    await db.addDeckWithCards({ id: 'axB', name: 'Basic audit', color: '#5C9DFF', created: now + 1 },
      Array.from({ length: 12 }, (_, i) => ({ id: 'axBb' + i, deckId: 'axB', front: `Term ${i}`, back: `Meaning ${i}`, tags: [], created: now + i })));
    await db.addDeckWithCards({ id: 'axT', name: 'Typing audit', color: '#8b5cf6', created: now + 2 },
      [{ id: 'axT1', deckId: 'axT', front: 'Capital of France', back: 'Paris', tags: [], created: now, typeIn: true },
       { id: 'axT2', deckId: 'axT', front: 'Capital of Italy', back: 'Rome', tags: [], created: now + 1, typeIn: true }]);
    await db.saveDeck({ id: 'axO', name: 'Occlusion audit', color: '#dd5555', created: now + 4 });
    const masks = [
      { id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.1, label: 'Aorta' },
      { id: 'm2', n: 2, shape: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, label: 'Left ventricle' },
      { id: 'm3', n: 3, shape: 'ellipse', x: 0.75, y: 0.1, w: 0.2, h: 0.2, label: 'Right atrium' }];
    await db.saveNote(occ.planOcclusionSave([], { masks, header: 'Heart anatomy', w: info.width, h: info.height, image: info.id }), { deckId: 'axO', noteId: db.newId(), tags: ['anatomy'] });
  });
}

// ---------- 1. Card type radios: arrow keys walk the group, a pointer pick moves on to the field ----------
let p = await open();
await seed(p);
await p.goto(APP + '#/browse'); await p.waitForSelector('#brAdd');
await p.click('#brAdd'); await p.waitForSelector('#acForm');
await p.focus('input[name=acKind][value=basic]');
await p.keyboard.press('ArrowRight');
ok(await p.isChecked('input[name=acKind][value=cloze]') && await p.evaluate(() => document.activeElement.value) === 'cloze', 'Card type: ArrowRight picks Cloze and focus stays on the radio');
await p.keyboard.press('ArrowRight');
ok(await p.isChecked('input[name=acKind][value=occlusion]') && await p.evaluate(() => document.activeElement.name) === 'acKind', 'Card type: ArrowRight again reaches Image occlusion, focus still on the radio group');
await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
ok(await p.isChecked('input[name=acKind][value=basic]') && await p.evaluate(() => document.activeElement.value) === 'basic', 'Card type: ArrowLeft walks back to Basic');
await p.locator('input[name=acKind][value=cloze]').click({ force: true });
ok(await active(p) === 'acText', 'Card type: a mouse / touch pick still moves focus to the Cloze text');

// ---------- 2. Box editor: instructions, shortcuts, name, new box focused ----------
await p.locator('input[name=acKind][value=occlusion]').click({ force: true });
const png = await p.evaluate(() => { const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300; const g = cv.getContext('2d'); g.fillStyle = '#9cf'; g.fillRect(0, 0, 400, 300); return cv.toDataURL('image/png'); });
await p.waitForSelector('#acOccChoose');
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#acOccChoose')]);
await chooser.setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
await p.waitForSelector('dialog.occ-ed[open]', { timeout: 10000 }).catch(async () => { await p.click('#acOccEdit'); await p.waitForSelector('dialog.occ-ed[open]'); });
await p.waitForTimeout(400);
ok((await attr(p, '.occ-ed-stage', 'aria-label')) === 'Image, no boxes yet', 'Editor: the stage is named "Image, no boxes yet"');
await p.click('[data-tool=add]');
await p.waitForSelector('.occ-ed-mask');
ok((await active(p)) !== 'BODY' && await p.evaluate(() => document.activeElement.classList.contains('occ-ed-mask')), 'Editor: after Add box the new box has focus');
ok((await attr(p, '.occ-ed-stage', 'aria-label')) === 'Image, 1 box', 'Editor: the stage name follows the count ("Image, 1 box")');
const keys = await refText(p, '.occ-ed-mask', 'aria-describedby');
ok(keys.length === 1 && /arrow keys nudge/i.test(keys[0]) && /Alt plus arrow keys resize/i.test(keys[0]) && /L names/.test(keys[0]) && /G groups/.test(keys[0]) && /Delete removes/.test(keys[0]), 'Editor: every box is described by the keyboard instructions');
ok(/Alt\+ArrowLeft/.test(await attr(p, '.occ-ed-mask', 'aria-keyshortcuts')) && /\bDelete\b/.test(await attr(p, '.occ-ed-mask', 'aria-keyshortcuts')), 'Editor: boxes list their aria-keyshortcuts');
const before = await p.evaluate(() => document.querySelector('.occ-ed-mask').style.left);
await p.keyboard.press('ArrowRight');
ok(await p.evaluate(b => document.querySelector('.occ-ed-mask').style.left !== b, before) && await p.evaluate(() => document.activeElement.classList.contains('occ-ed-mask')), 'Editor: an arrow key nudges the new box and focus stays on it');
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
if (await p.isVisible('.occ-ed-confirm')) await p.click('[data-act=discard]');
await p.waitForTimeout(300);
await p.close();

// ---------- 3. Practice test: ask is modal, Escape returns focus, key hints hidden from AT ----------
p = await open();
await seed(p);
await p.goto(APP + '#/deck/axB'); await p.waitForSelector('#testBtn');
await p.click('#testBtn'); await p.waitForSelector('#ptForm');
ok((await attr(p, '#ptCounts', 'aria-labelledby')) === 'ptCountsLbl' && (await refText(p, '#ptCounts', 'aria-describedby'))[0]?.startsWith('Off:') && (await refText(p, '#ptCounts', 'aria-labelledby'))[0] === 'Count answers as reviews', 'Practice test: "Count answers as reviews" has its label and description wired to the switch');
await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
ok(await p.evaluate(() => ['tPrev', 'tFlag'].every(id => document.getElementById(id).querySelector('kbd.key-hint')?.getAttribute('aria-hidden') === 'true')) && await p.evaluate(() => document.querySelector('#tNext kbd.key-hint')?.getAttribute('aria-hidden') === 'true'), 'Practice test: the key hints on Previous, Flag and Next are aria-hidden');
ok(await attr(p, '#tPrev', 'aria-keyshortcuts') === 'P' && await attr(p, '#tFlag', 'aria-keyshortcuts') === 'F' && await attr(p, '#tNext', 'aria-keyshortcuts') === 'N', 'Practice test: Previous, Flag and Next list their aria-keyshortcuts');
await p.focus('#tSubmit'); await p.keyboard.press('Enter');
await p.waitForSelector('#tAsk:not([hidden])');
ok(await p.evaluate(() => { const a = document.getElementById('tAsk'); return a.getAttribute('role') === 'alertdialog' && a.getAttribute('aria-modal') === 'true'; }), 'Submit ask: it is an alertdialog with aria-modal');
const d = await refText(p, '#tAsk', 'aria-describedby');
ok(d.length === 1 && /not answered|flagged/.test(d[0] || ''), 'Submit ask: aria-describedby points at the detail line (' + (d[0] || '').slice(0, 40) + ')');
ok(await p.evaluate(() => {
  const stray = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(e => !e.closest('#tAsk') && !e.closest('[inert]') && !e.closest('[hidden]') && e.offsetParent !== null && e.tabIndex >= 0);
  return stray.length === 0 && !!document.querySelector('.t-hud')?.closest('[inert]') && !!document.getElementById('tLayout').closest('[inert]') && !document.getElementById('tAsk').closest('[inert]');
}), 'Submit ask: the test, the Leave bar and everything else on the page are inert while it is open');
await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
ok(await p.evaluate(() => !!document.activeElement.closest('#tAsk')), 'Submit ask: Tab stays inside the question');
await p.keyboard.press('Escape');
ok(await attr(p, '#tAsk', 'hidden') !== null && await active(p) === 'tSubmit', 'Submit ask: Escape closes it and returns focus to "Submit test" (' + await active(p) + ')');
ok(await p.evaluate(() => document.querySelectorAll('[inert]').length === 0), 'Submit ask: nothing stays inert after it closes');
// The ask never leaves the page inert: Leave, a route change while it is open, and the "another tab" question over it.
const noInert = () => p.evaluate(() => document.querySelectorAll('[inert]').length === 0);
const startTest = async () => { await p.goto(APP + '#/deck/axB'); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm'); await p.click('#ptStart'); await p.waitForSelector('#tPrompt'); };
await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
await startTest();
await p.click('#tLeave'); await p.waitForSelector('#tAskNo');
ok(await p.evaluate(() => !!document.querySelector('.t-hud')?.closest('[inert]')), 'Leave ask: the page is inert behind it');
await p.keyboard.press('Escape');
ok(await noInert(), 'Leave ask: Escape (Keep testing) releases everything');
await p.click('#tLeave'); await p.waitForSelector('#tAskYes'); await p.click('#tAskYes');
await p.waitForSelector('#testBtn');
ok(await noInert(), 'Leave ask: Leave test goes to the deck page with nothing inert');
await startTest();
await p.focus('#tSubmit'); await p.keyboard.press('Enter'); await p.waitForSelector('#tAsk:not([hidden])');
await p.evaluate(() => { location.hash = '#/decks'; });
await p.waitForSelector('.deck'); await p.waitForTimeout(2500);
ok(await noInert(), 'A route change while the ask is open leaves nothing inert');
await startTest();
await p.focus('#tSubmit'); await p.keyboard.press('Enter'); await p.waitForSelector('#tAsk:not([hidden])');
await p.evaluate(async () => { const { KEYS } = await import('./js/mock-exam-store.js'); window.dispatchEvent(new StorageEvent('storage', { key: KEYS[0] })); });
await p.waitForFunction(() => /another tab/.test(document.getElementById('tAsk').textContent));
ok(await p.evaluate(() => !!document.getElementById('tLayout').closest('[inert]') && !document.querySelector('.t-hud').closest('[inert]')), '"Another tab" over the Submit ask: only the test is inert, Leave stays usable');
await p.click('#tLeave'); await p.waitForSelector('#tAskNo'); await p.click('#tAskNo');
ok(await p.evaluate(() => /another tab/.test(document.getElementById('tAsk').textContent)), '"Another tab" question comes back after Keep testing');
await p.click('#tAskYes'); await p.waitForSelector('#tPrompt');
await p.waitForTimeout(300);
ok(await noInert(), '"Continue here" leaves nothing inert');
await p.close();

// ---------- 4. Review: typed result is described, Undo is announced, picture cards say where ----------
p = await open();
await seed(p);
await p.goto(APP + '#/review/axT'); await p.waitForSelector('#typeIn');
await p.keyboard.type('zzzz'); await p.keyboard.press('Enter');
await p.waitForSelector('.rv-back:not([hidden]) .typed');
ok(await active(p) === 'rv-face rv-back' || await p.evaluate(() => document.activeElement.classList.contains('rv-back')), 'Typed answer: focus moves to the answer region');
{ const t = await refText(p, '.rv-back', 'aria-describedby'); ok(t.length === 1 && /Not quite/.test(t[0] || ''), 'Typed answer: the answer region is described by the result ("' + (t[0] || '').slice(0, 30) + '")'); }
await p.goto(APP + '#/review/axB'); await p.waitForSelector('#flash');
await p.keyboard.press('Space'); await p.waitForSelector('.rv-back:not([hidden])');
await p.keyboard.press('3');
await p.waitForFunction(() => document.getElementById('undoBtn'), null, { timeout: 5000 });
await p.keyboard.press('z');
await p.waitForFunction(() => /^Undid rating/.test(document.getElementById('toastLive')?.textContent || ''), null, { timeout: 5000 });
ok(/^Undid rating: Term \d+$/.test(await toastSaid(p)), 'Undo (Z key): "Undid rating" with the card front is announced: ' + await toastSaid(p));
await p.keyboard.press('Space'); await p.waitForSelector('.rv-back:not([hidden])'); await p.keyboard.press('3');
await p.waitForSelector('#undoBtn'); await p.waitForTimeout(2800);
await p.click('#undoBtn');
await p.waitForFunction(() => /^Undid rating/.test(document.getElementById('toastLive')?.textContent || ''), null, { timeout: 5000 });
ok(true, 'Undo button: announces too');
await p.goto(APP + '#/review/axO'); await p.waitForSelector('.rv-front .occ-img');
const occ = await p.evaluate(() => { const f = document.querySelector('.rv-front .occ'); return { fig: f.getAttribute('aria-label'), alt: f.querySelector('img').getAttribute('alt'), ask: f.querySelector('.occ-ask').getAttribute('aria-label'), head: document.querySelector('.occ-head')?.textContent }; });
ok(/^Hidden part \d of 3, (upper|middle|lower) (left|middle|right)|^Hidden part \d of 3, centre/.test(occ.ask), 'Picture card: the asked box says where it is: "' + occ.ask + '"');
ok(!/next to|Aorta|Left ventricle|Right atrium/.test(occ.ask) && occ.ask.endsWith(': name this part'), 'Picture card: the position is given but no other card\'s label (those are answers)');
ok(occ.head === 'Heart anatomy' && !occ.fig.includes('Heart anatomy') && occ.alt === '', 'Picture card: the header is read once (the picture name and alt do not repeat it): "' + occ.fig + '"');
await p.close();

// ---------- 5. Suggest cards: focus never falls to the page ----------
p = await open();
await p.goto(APP + '#/import'); await p.waitForSelector('#pasteBox');
await p.fill('#pasteBox', 'Photosynthesis is the process by which plants convert light energy into chemical energy. The mitochondria is the powerhouse of the cell. ATP (adenosine triphosphate) is the energy currency of the cell. Osmosis is the movement of water across a semipermeable membrane. The three types of rock are igneous, sedimentary and metamorphic. The cell membrane is a lipid bilayer that controls what enters the cell. Enzymes are proteins that speed up chemical reactions. DNA stands for deoxyribonucleic acid. The Krebs cycle takes place in the mitochondrial matrix. Glycolysis is the breakdown of glucose into pyruvate.');
await p.focus('#suggestBtn'); await p.keyboard.press('Enter');
// The Suggest button hides at once; once the job has been running 300 ms Stop shows and takes the focus (or the list does, if it was quicker).
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  const a = await p.evaluate(() => { const e = document.activeElement; return e && e !== document.body ? (e.id || e.tagName) : 'BODY'; });
  if (a !== 'BODY') seen.add(a);
  if (await p.locator('.prow.sug').count()) break;
  await p.waitForTimeout(25);
}
await p.waitForTimeout(500);
const endAt = await active(p);
ok(endAt === 'pvTitle' || endAt === 'sugStop', 'Suggest cards: when the suggestions arrive focus is on the list heading (' + endAt + ')');
ok(![...seen].includes('BODY') && await p.evaluate(() => document.activeElement !== document.body), 'Suggest cards: focus is not on the page afterwards');
{ // a slow job: Stop shows after 300 ms and takes the focus (a new page: suggest mode is already on in this one)
  await p.close(); p = await open();
  await p.goto(APP + '#/import'); await p.waitForSelector('#pasteBox');
  await p.evaluate(() => { window.Worker = class { postMessage() { /* never answers */ } terminate() {} addEventListener() {} }; });
  await p.fill('#pasteBox', 'Osmosis is the movement of water across a semipermeable membrane. DNA stands for deoxyribonucleic acid. Enzymes are proteins that speed up chemical reactions. ATP is the energy currency of the cell.');
  await p.focus('#suggestBtn'); await p.keyboard.press('Enter');
  const got = await p.waitForFunction(() => document.activeElement?.id === 'sugStop', null, { timeout: 5000 }).then(() => true, () => false);
  ok(got, 'Suggest cards: while it runs, Stop has the focus');
  if (got) { await p.keyboard.press('Enter'); await p.waitForTimeout(300); ok(await p.evaluate(() => document.activeElement !== document.body), 'Suggest cards: after Stop, focus is not on the page (' + await active(p) + ')'); }
}
await p.close();

// ---------- 6. Suggest tags: the Cards buttons are named for their tag ----------
p = await open();
{ const BIO = JSON.parse(fs.readFileSync(new URL('../fixtures/autotag/biology-mixed.json', import.meta.url), 'utf8')).cards.filter(c => !c.cloze && !c.reverse);
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.goto(APP + '#/import'); await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', BIO.map(c => `${c.front} - ${c.back}`).join('\n'));
  await p.waitForSelector('#preview:not([hidden])');
  await p.selectOption('#deckSel', '__new'); await p.fill('#newName', 'Bio tags');
  await p.click('#saveBtn'); await p.waitForSelector('.crow');
  await p.click('#deckMore'); await p.click('#autoTag'); await p.waitForSelector('.tag-sugs li', { timeout: 30000 }); }
{ const names = await p.evaluate(() => [...document.querySelectorAll('.tag-sugs li')].map(li => ({ tag: li.querySelector('.tag-name').value, label: li.querySelector('button[aria-controls]').getAttribute('aria-label') })));
  ok(names.length > 1 && names.every(n => n.label === 'Cards tagged ' + n.tag) && new Set(names.map(n => n.label)).size === names.length, 'Suggest tags: every Cards button is named "Cards tagged <tag>" (' + names.length + ' rows)');
  await p.fill('.tag-sugs li:first-child .tag-name', 'renamed-tag');
  ok(await attr(p, '.tag-sugs li:first-child button[aria-controls]', 'aria-label') === 'Cards tagged renamed-tag', 'Suggest tags: renaming the tag renames its Cards button too');
  await p.fill('.tag-sugs li:first-child .tag-name', '   ');
  ok(await attr(p, '.tag-sugs li:first-child button[aria-controls]', 'aria-label') === 'Cards tagged with no name', 'Suggest tags: an empty name is described, not blank'); }
await p.close();

// ---------- 7. What's new sheet ----------
p = await open();
await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
await p.evaluate(async () => (await import('./js/whats-new.js')).openWhatsNewSheet());
await p.waitForSelector('#newOk');
ok((await p.textContent('#newOk')).trim() === 'Got it', 'What\'s new: the bottom button says "Got it" (the corner X is the Close)');
{ const s = await p.evaluate(() => { const e = document.querySelector('#sheet .sheet-in'); return { tab: e.getAttribute('tabindex'), role: e.getAttribute('role'), name: e.getAttribute('aria-label') }; });
  ok(s.tab === '0' && s.role === 'region' && s.name === 'Release notes', 'What\'s new: the scrolling area is a focusable, named region'); }
ok(await p.evaluate(() => [...document.querySelectorAll('#sheet button')].filter(b => (b.getAttribute('aria-label') || b.textContent).trim() === 'Close').length === 1), 'What\'s new: only one button is called Close');
await p.click('#newOk');
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(true, 'What\'s new: Got it closes the sheet');
await p.close();

// ---------- 8. Guided review on a fresh install ----------
p = await open(real);
await p.goto(APP); await p.waitForSelector('#wlNext');
await p.click('#wlNext'); await p.waitForSelector('#wlName');
await p.fill('#wlName', 'Cell Biology'); await p.keyboard.press('Enter');
await p.waitForSelector('#wlSample'); await p.click('#wlSample');
await p.waitForSelector('.guide #coach');
await p.evaluate(() => { window.__coach = document.getElementById('coach'); });
ok(await p.evaluate(() => document.getElementById('coach').getAttribute('role') === 'status'), 'Guided review: #coach is a status region');
{ const fl = await p.evaluate(() => { const f = document.getElementById('flash'); return { role: f.getAttribute('aria-labelledby'), name: document.getElementById(f.getAttribute('aria-labelledby'))?.textContent.trim(), tab: f.getAttribute('tabindex') }; });
  ok(fl.name && fl.name.length > 0 && fl.tab === '0', 'Guided review: the card is named by its question ("' + (fl.name || '').slice(0, 30) + '") and can be focused'); }
ok(/Space/.test(await p.textContent('#coach')) && /Space/.test(await p.textContent('.flash-hint')), 'Guided review: the hints mention the keyboard (Space)');
{ const g = await p.evaluate(() => { const f = document.getElementById('flash').getBoundingClientRect(), r = document.getElementById('ratebar').getBoundingClientRect(), w = getComputedStyle(document.querySelector('.welcome')); return { gap: Math.round(r.top - f.bottom), want: Math.round(parseFloat(w.rowGap || w.gap) + parseFloat(getComputedStyle(document.getElementById('flash')).marginBottom)) }; });
  ok(g.want > 0 && g.gap === g.want, 'Guided review: the gap between the card and the button bar is the .welcome gap plus the card margin (' + g.gap + ' vs ' + g.want + ')'); }
const text1 = await p.textContent('#coach');
await p.focus('#flash'); await p.keyboard.press('Space');
await p.waitForSelector('#ratebar .rate');
ok(await p.evaluate(() => window.__coach === document.getElementById('coach') && window.__coach.isConnected), 'Guided review: the same #coach element stays in the page after the flip (only its text changes)');
ok((await p.textContent('#coach')) !== text1 && /rate how well/i.test(await p.textContent('#coach')), 'Guided review: the coach text moved on to step 2');
{ const b = await p.evaluate(() => { const r = document.querySelector('.rv-back'); return { role: r.getAttribute('role'), name: r.getAttribute('aria-label'), focused: document.activeElement === r }; });
  ok(b.role === 'region' && b.name === 'Answer' && b.focused, 'Guided review: the answer is a region named "Answer" and has focus'); }
{ const labels = await p.evaluate(() => [...document.querySelectorAll('#ratebar .rate')].map(b => b.getAttribute('aria-label')));
  ok(labels.length === 4 && labels.every((l, i) => l.startsWith(['Again', 'Hard', 'Good', 'Easy'][i] + ', next review in ')), 'Guided review: rating buttons say when the card comes back: ' + labels[2]); }
await p.keyboard.press('3');
await p.waitForSelector('.flash-front');
ok(await p.evaluate(() => window.__coach === document.getElementById('coach')) && /Read the question/.test(await p.textContent('#coach')) && await p.evaluate(() => document.getElementById('flash').getAttribute('aria-labelledby') === 'gQ'), 'Guided review: the next card keeps the same #coach and goes back to step 1');
ok(await p.evaluate(() => document.getElementById('coach').getAttribute('aria-atomic') === 'true'), 'Guided review: #coach is atomic');
await p.close();

await browser.close(); await real.close();
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
