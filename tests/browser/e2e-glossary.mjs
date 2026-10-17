// Round 3, item 12: your own glossary (Settings sheet, Add / Paste a list, underlines and the popover in Review, the front-answer
// rule, sync of terms, a 2,000-term time budget).
// Run with: node tests/browser/run.mjs glossary
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h, scheme) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async scheme => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'T', name: 'Biology', color: '#5B48E8', created: Date.now() }, [
      { id: 'c1', deckId: 'T', front: 'Where is the energy currency ATP made?', back: 'In the mitochondria, by ATP synthase', tags: [], created: 1 },
      { id: 'c2', deckId: 'T', front: 'What does osmosis move?', back: 'Water. Osmosis needs no ATP.', tags: [], created: 2 }]);
    await db.setSetting('reviewTyping', false);
    await db.setSetting('theme', (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: scheme }));
  }, scheme);
  return p;
};
const sideways = (p, w, tag) => w > 800 || p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));
const terms = p => p.$$eval('.rv-face:not([inert]) .gl-term', b => b.map(x => x.textContent));
const allTerms = p => p.$$eval('.gl-term', b => b.map(x => x.textContent));

for (const [w, h, scheme] of [[375, 780, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${scheme}`;
  const p = await open(w, h, scheme);

  // ---------- Review with an empty glossary: nothing underlined, the module is not loaded ----------
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  ok(await p.locator('.gl-term').count() === 0, `${tag}: no glossary, no underlines`);

  // ---------- Settings: the row, the empty text ----------
  await p.goto('about:blank'); await p.goto(URL + '#/settings'); await p.waitForSelector('#glossBtn');
  ok(/Define a term once and it’s underlined on every card/.test(await p.textContent('#glossSub')), `${tag}: Settings → Study → Glossary shows the empty text`);
  ok(await p.locator('#glossaryUnderline').isChecked(), `${tag}: "Glossary underlines" is on by default`);
  await p.click('#glossBtn'); await p.waitForSelector('#glAdd');
  ok(/Define a term once/.test(await p.textContent('#glCount')), `${tag}: the sheet shows the empty text`);

  // ---------- add a term ----------
  await p.click('#glAdd'); await p.waitForSelector('#glTerm');
  await p.fill('#glTerm', 'ATP');
  await p.fill('#glAlias', 'adenosine triphosphate');
  await p.fill('#glDef', 'The cell’s **energy currency**.');
  await p.screenshot({ path: `${SP}/glossary-form-${w}-${scheme}.png` });
  await p.click('#glForm button[type=submit], button[type=submit][form=glForm]');
  await p.waitForSelector('#glList .gl-row');
  ok(await p.locator('#glList .gl-row').count() === 1 && /1 term\b/.test(await p.textContent('#glCount')), `${tag}: the term is in the list`);
  const stored = await p.evaluate(async () => { const s = await (await import('./js/db.js')).getSettings(); return Object.entries(s).filter(([k]) => k.startsWith('gloss:')); });
  ok(stored.length === 1 && stored[0][1].term === 'ATP' && stored[0][1].aliases[0] === 'adenosine triphosphate', `${tag}: stored as a gloss:<id> setting`);
  // a duplicate spelling is warned about
  await p.click('#glAdd'); await p.waitForSelector('#glTerm');
  await p.fill('#glTerm', 'atp');
  ok(/“atp” is already a term/.test(await p.textContent('#glWarn')), `${tag}: the form warns about a spelling that is already a term`);
  await p.click('#glCancel'); await p.waitForSelector('#glList');

  // ---------- paste a list ----------
  await p.click('#glPaste'); await p.waitForSelector('#glPasteIn');
  await p.fill('#glPasteIn', 'ATP - already here\nOsmosis - water moving across a membrane\nMitochondria - the cell’s power plants\nLonely line');
  const info = await p.textContent('#glPasteInfo');
  ok(/Adds 2 terms\. 1 is already in your glossary and stays as it is\./.test(info), `${tag}: preview "${info.trim()}"`);
  await p.click('#glPasteGo'); await p.waitForSelector('#glList .gl-row');
  ok(await p.locator('#glList .gl-row').count() === 3, `${tag}: three terms after the paste`);
  await p.fill('#glSearch', 'mito');
  ok(await p.locator('#glList .gl-row').count() === 1, `${tag}: search narrows the list`);
  await p.screenshot({ path: `${SP}/glossary-list-${w}-${scheme}.png` });
  await sideways(p, w, tag + ' sheet');
  // delete takes two taps
  await p.click('[data-gl-del]');
  ok(await p.locator('#glList .gl-row').count() === 1, `${tag}: the first tap on Delete only asks`);
  await p.click('[data-gl-del]');
  await p.waitForFunction(() => document.querySelectorAll('#glList .gl-row').length === 0);
  await p.fill('#glSearch', '');
  ok(await p.locator('#glList .gl-row').count() === 2, `${tag}: deleted`);
  await p.keyboard.press('Escape');

  // ---------- Review: underlines, popover, no flip ----------
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  await p.waitForSelector('.rv-back .gl-term', { state: 'attached' });
  const frontTerms = await p.$$eval('.rv-front .gl-term', b => b.map(x => x.textContent));
  ok(frontTerms.length === 0, `${tag}: on the front, ATP is not underlined because the answer has it (${frontTerms.join()})`);
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  ok((await terms(p)).join() === 'ATP', `${tag}: on the back, ATP is underlined once`);
  ok(await p.$eval('.rv-face:not([inert]) .gl-term', b => /dotted/.test(getComputedStyle(b).textDecorationStyle)), `${tag}: with a dotted underline`);
  await p.screenshot({ path: `${SP}/glossary-back-${w}-${scheme}.png` });
  await p.click('.rv-face:not([inert]) .gl-term');
  await p.waitForSelector('.gl-pop');
  ok(/ATP/.test(await p.textContent('.gl-pop-t')) && /energy currency/.test(await p.textContent('.gl-pop-d')) && await p.locator('.gl-pop-d b').count() === 1, `${tag}: the popover shows the term and its definition`);
  await p.screenshot({ path: `${SP}/glossary-pop-${w}-${scheme}.png` });
  await sideways(p, w, tag + ' popover');
  ok(await p.evaluate(() => { const r = document.querySelector('.gl-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), `${tag}: the popover is on screen`);
  ok(await p.locator('.rate').count() === 4 && await p.locator('#flash.flipped').count() === 1, `${tag}: the card did not turn over`);
  await p.keyboard.press('Escape');
  ok(await p.locator('.gl-pop').count() === 0, `${tag}: Escape closes the popover`);
  ok(await p.evaluate(() => document.activeElement?.classList.contains('gl-term')), `${tag}: and the focus returns to the term`);
  await p.keyboard.press('Enter');                 // Enter on the focused term opens it
  await p.waitForSelector('.gl-pop');
  await p.mouse.click(5, 5);
  ok(await p.locator('.gl-pop').count() === 0, `${tag}: a tap outside closes it`);
  await p.click('.rate.r3');
  // second card: osmosis is on the front, and ATP is in the answer (not on the front)
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('osmosis'));
  ok((await terms(p)).join() === '', `${tag}: osmosis is in the answer too, so it is not underlined on the front (${(await terms(p)).join()})`);
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  ok((await terms(p)).join() === 'Osmosis,ATP' || (await terms(p)).join() === 'ATP,Osmosis', `${tag}: the back underlines each term once (${(await terms(p)).join()})`);
  // the device switch turns it off
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('glossaryUnderline', false); });
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  ok(await p.locator('.gl-term').count() === 0, `${tag}: "Glossary underlines" off = no underlines`);
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('glossaryUnderline', true); });

  // ---------- quick add from the card menu ----------
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  await p.click('#moreBtn'); await p.waitForSelector('[data-go=glossary]');
  await p.click('[data-go=glossary]'); await p.waitForSelector('#glTerm');
  ok(/Add term/.test(await p.textContent('#sheetTitle')), `${tag}: "Add to glossary" opens the form`);
  await p.fill('#glTerm', 'Synthase'); await p.fill('#glDef', 'An enzyme that builds something.');
  await p.click('button[type=submit][form=glForm]');
  await p.waitForFunction(() => !document.getElementById('sheet').open);
  ok(await p.evaluate(async () => Object.entries(await (await import('./js/db.js')).getSettings()).filter(([k, v]) => k.startsWith('gloss:') && v).length) === 3, `${tag}: quick add saved a third term`);

  // ---------- sync: terms travel as settings ----------
  const sync = await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const ch = await db.localChangesSince(0);
    const keys = ch.settings.map(s => s.key).filter(k => k.startsWith('gloss:'));
    const key = keys[0];
    // a newer copy from another device wins; an older one does not; a deleted (null) one counts
    const now = Date.now();
    await db.applyRemote([{ store: 'settings', id: key, data: { value: { term: 'FromElsewhere', aliases: [], def: 'x', at: now } }, deleted: false, updated_at: now + 5000 }]);
    const afterNew = (await db.getSettings())[key]?.term;
    await db.applyRemote([{ store: 'settings', id: key, data: { value: { term: 'Stale', aliases: [], def: 'x', at: 1 } }, deleted: false, updated_at: now + 1 }]);
    const afterOld = (await db.getSettings())[key]?.term;
    await db.applyRemote([{ store: 'settings', id: 'gloss:remote1', data: { value: { term: 'Brand new', aliases: [], def: 'd', at: now } }, deleted: false, updated_at: now + 6000 },
      { store: 'settings', id: 'gloss:broken', data: { value: { nonsense: true } }, deleted: false, updated_at: now + 6000 }]);
    const s = await db.getSettings();
    await db.applyRemote([{ store: 'settings', id: 'gloss:remote1', data: { value: null }, deleted: false, updated_at: now + 9000 }]);
    return { n: keys.length, afterNew, afterOld, added: s['gloss:remote1']?.term, broken: s['gloss:broken'], deleted: (await db.getSettings())['gloss:remote1'] };
  });
  ok(sync.n === 4, `${tag}: localChangesSince sends the three terms and the deleted one (${sync.n})`);
  ok(sync.afterNew === 'FromElsewhere' && sync.afterOld === 'FromElsewhere', `${tag}: the newest copy of a term wins`);
  ok(sync.added === 'Brand new' && sync.broken === null && sync.deleted === null, `${tag}: a new term from another device arrives, a broken one is stored as deleted, a delete wins when newer`);

  // ---------- hyphenated terms ----------
  const hy = await p.evaluate(async () => {
    const g = await import('./js/glossary.js'), v = await import('./js/glossary-view.js');
    const es = ['X-ray', 'T-cell', 'beta-blocker', 'C++', '(a)', 'x.y', '$', '?'].map((t, i) => ({ id: 'h' + i, term: t, aliases: [], def: 'd', at: i }));
    const root = document.createElement('div');
    root.innerHTML = '<p>An X-ray, a T-cell and a beta-blocker with C++ and (a) and x.y and $ and ?</p>';
    document.body.append(root);
    const n = v.underline(root, g.buildMatcher(es));
    const got = [...root.querySelectorAll('.gl-term')].map(b => b.textContent);
    root.remove();
    return { n, got };
  });
  ok(hy.n === 8 && hy.got[0] === 'X-ray' && hy.got[2] === 'beta-blocker', `${tag}: hyphenated and regex-special terms are underlined (${hy.got.join(' | ')})`);

  // ---------- restore everywhere ----------
  const rest = await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const before = await db.exportAll();
    // the account holds terms 'old1' (not in the backup) and the backup has 2,001 terms, one of them broken, one deleted
    await db.setSetting('gloss:old1', { term: 'Old', aliases: [], def: '', at: 1 });
    const settings = { ...before.settings };
    for (let i = 0; i < 2001; i++) settings['gloss:b' + i] = { term: 'Back' + i, aliases: [], def: '', at: i };
    settings['gloss:broken'] = { nonsense: 1 };
    settings['gloss:gone'] = null;
    await db.importAll({ ...before, settings }, { everywhere: true });
    const after = await db.getSettings();
    const times = after._times || {};
    const kept = Object.entries(after).filter(([k, v]) => k.startsWith('gloss:b') && v).length;
    return { kept, old: after['gloss:old1'], oldTime: times['gloss:old1'] > 0, broken: 'gloss:broken' in after, brokenNull: after['gloss:broken'] === null, goneNull: after['gloss:gone'] === null, goneTimed: times['gloss:gone'] > 0 };
  });
  ok(rest.kept === 2001, `${tag}: a restore keeps all ${rest.kept} terms of the backup (no 2,000 cap)`);
  ok(rest.old === null && rest.oldTime, `${tag}: restore everywhere deletes a term the backup does not have at all`);
  ok(!rest.broken && rest.goneNull && rest.goneTimed, `${tag}: a broken term of the backup is dropped, not turned into a delete; a deleted one stays deleted`);

  await p.close();
}

// ---------- 2,000 terms: a time budget ----------
{
  const p = await open(1440, 900, 'light');
  const t = await p.evaluate(async () => {
    const db = await import('./js/db.js'), g = await import('./js/glossary.js');
    const s = {};
    for (let i = 0; i < 2000; i++) s[`gloss:t${i}`] = { term: `termino${i} palabra${i % 9}`, aliases: [], def: 'd', at: i };
    s['gloss:atp'] = { term: 'mitochondria', aliases: [], def: 'd', at: 5000 };
    const m = g.buildMatcher(g.entriesFrom(s));
    const text = 'The mitochondria are the power plants. '.repeat(8) + 'termino1999 palabra1';
    g.findTerms(text, m);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) g.findTerms(text, m);
    return (performance.now() - t0) / 10;
  });
  ok(t < 20, `2,000 terms: ${t.toFixed(1)} ms per card (budget 20 ms)`);
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
