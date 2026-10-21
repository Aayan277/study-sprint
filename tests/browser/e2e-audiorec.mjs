// Record a sound (js/recorder.js): the mic button in the card editor records with the browser's fake microphone, saves the take like any
// picked sound, and it plays in Review, survives a reload, goes into an Anki deck and back, and syncs. Also: the microphone is let go on
// Stop / Cancel / close, a take is kept when the form is saved, and what happens when the microphone is refused or the page is not secure.
// (Headless Chromium has no AAC encoder, so only the webm path is recorded here; the mp4 choice is in tests/recorder-logic.test.js.)
import { chromium, deckMenu, sheetSettled } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch({ autoAddCards: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const fake = fakeSupabase();

// The microphone streams are kept (window.__streams) to see their tracks end. play() is recorded and then really done, so the
// recording is decoded and played by the browser; 'ended' events are counted.
const spies = () => {
  window.__streams = []; window.__plays = []; window.__ended = 0;
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = async c => { const s = await gum(c); window.__streams.push(s); return s; };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!String(this.src).startsWith('data:')) { window.__plays.push(this.src); this.addEventListener('ended', () => window.__ended++, { once: true }); }
    return play.call(this);
  };
  const mk = URL.createObjectURL.bind(URL);
  window.__blobs = new Map();
  URL.createObjectURL = b => { const u = mk(b); window.__blobs.set(u, b); return u; };
};
async function device(name, { width = 375, height = 740, colorScheme = 'dark', init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme, permissions: ['microphone'], acceptDownloads: true });
  await ctx.addInitScript(spies);
  if (init) await ctx.addInitScript(init);
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|415|422)|Sync failed|Picture sync failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const page = await device('A');
const run = (fn, arg) => page.evaluate(fn, arg);
const toastText = () => page.textContent('#toast');
const live = id => page.textContent(`#${id}Rec > .sr-only`);
const tracks = () => run(() => window.__streams.map(s => s.getTracks().map(t => t.readyState)));
const allEnded = async () => { const t = await tracks(); return t.length > 0 && t.every(s => s.every(x => x === 'ended')); };
const mediaOf = id => run(async i => { const m = await (await import('./js/db.js')).getMedia(i); return m && { type: m.type, size: m.size, name: m.name, uploaded: m.uploaded }; }, id);
const items = id => page.locator(`#${id}Snd .snd-item`);
const sndId = async (id, n = 0) => (await run(i => document.getElementById(i + 'Snd').dataset.soundIds, id)).split(',')[n];
const openAdd = async () => { await page.goto(APP + '#/deck/rec'); await page.click('#brAdd'); await page.waitForSelector('#acForm'); };
const record = async (id, ms = 1500) => { await page.click(`[data-rec=${id}]`); await page.waitForSelector(`#${id}Rec[data-state=recording]`); await page.waitForTimeout(ms); };
const stop = async id => { await page.click(`#${id}Rec [data-rec-stop]`); await page.waitForSelector(`#${id}Rec[data-state=done]`); };

await run(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]);
});
await openAdd();

// ---------- 1. the button, recording, Stop ----------
ok(await page.getAttribute('[data-rec=acBack]', 'aria-label') === 'Record a sound' && await page.getAttribute('[data-rec=acBack]', 'aria-pressed') === 'false', 'the Back has a mic button: "Record a sound", not pressed');
ok((await page.locator('[data-rec]').count()) === 2, 'one mic button each for Front and Back, none for the memory hook');
await page.fill('#acFront', 'Say hello');
await page.click('[data-rec=acBack]');
await page.waitForSelector('#acBackRec[data-state=recording]');
ok(await page.getAttribute('[data-rec=acBack]', 'aria-pressed') === 'true', 'recording: the mic button is pressed');
ok((await live('acBack')).includes('Recording'), 'recording: the status says "Recording. Press Stop when you\'re done."');
ok(await run(() => document.activeElement?.matches('#acBackRec [data-rec-stop]')), 'recording: the focus is on Stop');
ok((await tracks())[0]?.every(x => x === 'live'), 'recording: the microphone is live');
ok((await page.getAttribute('#acBackRec', 'aria-label')) === 'Recording for the Back', 'recording: the group is named "Recording for the Back"');
ok(await page.getAttribute('#acBackRec [data-rec-stop]', 'aria-label') === 'Stop recording', 'recording: Stop has its name');
await page.waitForTimeout(2000);
ok(/^0:0[1-3]\s*\/ 1:00$/.test((await page.textContent('#acBackRec .rec-time')).trim()), `recording: the timer runs (${(await page.textContent('#acBackRec .rec-time')).trim()})`);
const lvl = await page.waitForFunction(() => parseFloat(document.querySelector('#acBackRec .rec-meter i')?.style.getPropertyValue('--lvl')) > 0, null, { timeout: 3000 }).then(() => true, () => false);
ok(lvl, 'recording: the level meter moves');
ok(await run(() => document.getElementById('acBackRecMark').dataset.soundIds === 'recording'), 'recording: counts as unsaved work');
await page.screenshot({ path: SP + '/rec-dark-375.png' });
await stop('acBack');
ok(await items('acBack').count() === 1, 'Stop: the take is on the Back');
ok(await allEnded(), 'Stop: every microphone track has ended');
const id1 = await sndId('acBack');
const m1 = await mediaOf(id1);
ok(m1 && /^audio\/(webm|mp4|ogg)$/.test(m1.type) && m1.size > 0 && m1.size < 1048576 && m1.name.startsWith('recording-') && m1.uploaded === false, `Stop: saved as a sound (${m1?.type}, ${m1?.size} bytes, ${m1?.name})`);
const dur = await run(async i => { const m = await (await import('./js/db.js')).getMedia(i); return (await new OfflineAudioContext(1, 1, 48000).decodeAudioData(m.data.slice(0))).duration; }, id1).catch(() => -1);
ok(dur > 1 && dur < 4.5, `Stop: the bytes decode as about 3 seconds of audio (${dur.toFixed?.(2)})`);
ok((await live('acBack')).includes('Recording added to the Back'), `Stop: announced ("${await live('acBack')}")`);
ok(await run(() => document.activeElement?.matches('#acBackRec .snd-btn')), 'Stop: the focus is on the panel\'s ▶');
ok((await page.textContent('#acBackRec')).includes('added to the Back'), 'Stop: the panel says it was added to the Back');
ok(await page.getAttribute('[data-rec=acBack]', 'aria-pressed') === 'false', 'Stop: the mic button is not pressed');

// ---------- 2. Preview, Re-record ----------
await run(() => { window.__plays.length = 0; window.__ended = 0; });
await page.click('#acBackRec .snd-btn');
await page.waitForFunction(() => window.__plays.length >= 1);
ok(!(await page.locator('#acBackRec .snd-btn.broken').count()), 'Preview: the ▶ plays and is not marked broken');
await page.waitForFunction(() => window.__ended >= 1, null, { timeout: 10000 });
ok(true, 'Preview: the recording plays to its end');
await page.click('#acBackRec [data-rec-redo]');
await page.waitForSelector('#acBackRec[data-state=recording]');
await page.waitForTimeout(1200);
await stop('acBack');
const id2 = await sndId('acBack');
ok(await items('acBack').count() === 1 && id2 && id2 !== id1, 'Re-record: still one sound on the Back, a new one in its place');

// ---------- 3. Delete, Cancel, closing ----------
await record('acFront', 1000); await stop('acFront');
ok(await items('acFront').count() === 1, 'Front: a take was added');
await page.click('#acFrontRec [data-rec-del]');
ok(await items('acFront').count() === 0 && await page.isHidden('#acFrontRec'), 'Delete: the sound is gone and the panel hidden');
ok(await run(() => document.activeElement?.matches('[data-rec=acFront]')), 'Delete: the focus is back on the mic button');
ok((await live('acFront')).includes('Recording deleted'), 'Delete: announced');
const before = (await tracks()).length;
await record('acFront', 600);
await page.click('#acFrontRec [data-rec-cancel]');
await page.waitForSelector('#acFrontRec', { state: 'hidden' });
ok((await tracks()).length === before + 1 && await allEnded() && await items('acFront').count() === 0, 'Cancel: the microphone is let go and nothing is added');
ok(await run(() => document.activeElement?.matches('[data-rec=acFront]')), 'Cancel: the focus is back on the mic button');
await record('acFront', 600);
await page.keyboard.press('Escape');
await page.waitForSelector('#acFrontRec', { state: 'hidden' });
ok(await page.isVisible('#acForm') && await allEnded(), 'Escape while recording: ends the take but not the sheet');
await record('acFront', 600);
await run(async () => (await import('./js/ui.js')).closeSheet());
await sheetSettled(page);
await page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
ok(await allEnded(), 'closing the sheet while recording: the microphone is let go');
await run(() => new Promise(r => setTimeout(r, 400)));
await openAdd();

// ---------- 4. saving while recording keeps the take ----------
await page.fill('#acFront', 'Keep me');
await record('acBack', 1500);
await run(() => document.getElementById('acForm').requestSubmit());
await page.waitForFunction(() => /Card added/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 });
ok(await allEnded(), 'Add card while recording: the microphone is let go');
const kept = await run(async () => { const c = (await (await import('./js/db.js')).getAll('cards')).find(x => x.front === 'Keep me'); return c && { n: c.backSounds?.length, id: c.backSounds?.[0] }; });
ok(kept?.n === 1, 'Add card while recording: the card has the recording on its back');
ok(await page.isHidden('#acFrontRec') && await page.isHidden('#acBackRec') && await items('acBack').count() === 0, 'Add card: the form is clear for the next card');
const size1 = (await mediaOf(kept.id)).size;
await run(async () => (await import('./js/ui.js')).closeSheet());
await sheetSettled(page);

// ---------- 5. Review plays it, a reload keeps it, the editors have the button ----------
await run(async () => (await import('./js/db.js')).deleteCards(['R0']));      // (so the card made above is the only one to review)
await page.goto(APP + '#/review/rec');
await page.waitForSelector('#showBtn');
await run(() => { window.__plays.length = 0; window.__ended = 0; });
await page.click('#showBtn');
await page.waitForSelector('.rv-back .snd-btn');
ok(await page.locator('.rv-back .snd-btn').count() === 1, 'Review: the back shows a ▶ for the recording');
await page.waitForFunction(() => window.__ended >= 1, null, { timeout: 10000 });      // (it plays by itself when the card is turned over)
ok(true, 'Review: the recording plays by itself on turning the card over');
await run(() => { window.__plays.length = 0; window.__ended = 0; });
await page.click('.rv-back .snd-btn');
await page.waitForFunction(() => window.__plays.length >= 1 && window.__ended >= 1, null, { timeout: 10000 });
ok(true, 'Review: tapping ▶ plays it again to its end');
await page.keyboard.press('e');
await page.waitForSelector('#ceForm');
ok(await page.locator('[data-rec=ceFront]').count() === 1 && await page.locator('[data-rec=ceBack]').count() === 1, 'the short editor (E in Review) has the mic buttons');
await run(async () => (await import('./js/ui.js')).closeSheet());
await run(() => import('./js/nav.js').then(m => m.whenIdle()));
await page.goto(APP + '#/decks');
await page.reload(); await page.waitForSelector('.deck');
await page.goto(APP + '#/deck/rec'); await page.waitForSelector('.crow-btn');
await page.fill('#brQuery', 'Keep me').catch(() => {});
await page.locator('.crow-btn', { hasText: 'Keep me' }).first().click();
await page.waitForSelector('#ceBackSnd .snd-item');
ok(await items('ceBack').count() === 1 && (await mediaOf(await sndId('ceBack'))).size === size1, 'after a reload: the card panel lists the recording, same size');
await run(async () => (await import('./js/ui.js')).closeSheet());
await sheetSettled(page);

// ---------- 6. Anki deck and back ----------
await page.fill('#brQuery', '').catch(() => {});
await page.goto(APP + '#/deck/rec'); await deckMenu(page); await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
await dl.saveAs(SP + '/exports/recording.apkg');
await page.evaluate(() => import('./js/nav.js').then(m => m.whenIdle())).catch(() => {});
await page.waitForFunction(() => history.state?.k !== 'ov');
await page.goto(APP + '#/import');
await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/exports/recording.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Rec copy'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
const copy = await run(async () => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === 'Rec copy');
  const c = (await db.getCardsInDeck(d.id)).find(x => x.front === 'Keep me'); const m = c?.backSounds?.[0] && await db.getMedia(c.backSounds[0]);
  return c && { n: c.backSounds?.length, size: m?.size, type: m?.type };
});
ok(copy?.n === 1 && copy.size === size1 && copy.type === (await mediaOf(kept.id)).type, `Anki export → import: the copy has one back sound of the same size and type (${JSON.stringify(copy)})`);

// ---------- 7. sync ----------
await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *');
await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click('#syncCreate');
await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 20000 });
const uid = [...fake.users.values()][0].id;
const up = fake.files.get(`${uid}/${kept.id}`);
ok(up && up.type === (await mediaOf(kept.id)).type, `Sync: the recording goes up as its own type (${up?.type})`);

// ---------- 8. light, wide, and the phone toolbar ----------
for (const [w, h, scheme] of [[375, 740, 'light'], [1440, 900, 'dark'], [1440, 900, 'light']]) {
  const p = await device(`${w}${scheme}`, { width: w, height: h, colorScheme: scheme });
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]); });
  await p.goto(APP + '#/deck/rec'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  await p.click('[data-rec=acBack]'); await p.waitForSelector('#acBackRec[data-state=recording]');
  await p.waitForFunction(() => parseFloat(document.querySelector('#acBackRec .rec-meter i')?.style.getPropertyValue('--lvl')) > 0, null, { timeout: 4000 }).catch(() => {});
  await p.waitForTimeout(1100);
  const css = await p.evaluate(() => {
    const cs = e => getComputedStyle(document.querySelector(e));
    return { panel: cs('#acBackRec').backgroundColor, pressed: cs('[data-rec=acBack]').color, dot: cs('#acBackRec .rec-dot').backgroundColor, stop: cs('#acBackRec .rec-stop').color,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth, bar: (() => { const r = document.querySelector('#acBack').closest('.fmt-field').querySelector('.fmt-tools').getBoundingClientRect(); return [r.left, r.right]; })() };
  });
  ok(css.over <= 0 && css.dot !== css.panel && css.pressed !== css.panel, `${w}px ${scheme}: no sideways scroll, the red dot and pressed mic stand out (${css.pressed} on ${css.panel})`);
  ok(css.bar[0] >= 0 && css.bar[1] <= w, `${w}px ${scheme}: the toolbar fits the screen`);
  await p.screenshot({ path: `${SP}/rec-${scheme}-${w}.png` });
  await p.close();
}

// ---------- 9. refused, no microphone, not secure, not supported ----------
for (const [name, words] of [['NotAllowedError', 'Microphone access is blocked'], ['NotFoundError', 'No microphone found'], ['NotReadableError', 'being used by another app']]) {
  const p = await device('deny', { init: new Function(`navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: '${name}' }));`) });
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]); });
  await p.goto(APP + '#/deck/rec'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  await p.click('[data-rec=acBack]');
  await p.waitForFunction(w => document.querySelector('#toast')?.textContent.includes(w), words, { timeout: 5000 }).catch(() => {});
  ok((await p.textContent('#toast')).includes(words), `refused with ${name}, the toast says "${words}"`);
  ok(await p.getAttribute('[data-rec=acBack]', 'aria-pressed') === 'false' && await p.isHidden('#acBackRec'), `refused with ${name}, the button is not pressed and the panel is hidden`);
  ok(await p.evaluate(() => document.activeElement?.matches('[data-rec=acBack]')), `refused with ${name}, the focus is back on the mic button`);
  await p.context().close();
}
{
  const p = await device('insecure', { init: new Function("Object.defineProperty(window, 'isSecureContext', { value: false });") });
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]); });
  await p.goto(APP + '#/deck/rec'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  await p.click('[data-rec=acBack]');
  await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('secure connection'), null, { timeout: 5000 }).catch(() => {});
  ok((await p.textContent('#toast')).includes('secure connection') && await p.isHidden('#acBackRec'), 'not https: the toast explains, nothing starts');
  await p.context().close();
  const q = await device('nomr', { init: new Function('delete window.MediaRecorder;') });
  await q.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]); });
  await q.goto(APP + '#/deck/rec'); await q.click('#brAdd'); await q.waitForSelector('#acForm');
  ok(await q.locator('[data-rec]').count() === 0 && await q.locator('[data-snd-add]').count() === 2, 'no MediaRecorder: no mic button (the sound button stays)');
  await q.context().close();
}
// ---------- 10. hardening: start throws, Save after Stop, a full side ----------
const seed = p => p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'rec', name: 'Rec', color: '#46A758', created: Date.now() }, [{ id: 'R0', deckId: 'rec', front: 'seed', back: 'x', tags: [], created: 1 }]); });
{
  const p = await device('startfails', { init: new Function("MediaRecorder.prototype.start = function () { throw new Error('boom'); };") });
  await seed(p);
  await p.goto(APP + '#/deck/rec'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  await p.click('[data-rec=acBack]');
  await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes("Couldn't start recording"), null, { timeout: 5000 }).catch(() => {});
  ok((await p.textContent('#toast')).includes("Couldn't start recording. Try again."), 'MediaRecorder.start throws: the toast says so');
  ok(await p.isHidden('#acBackRec') && await p.getAttribute('[data-rec=acBack]', 'aria-pressed') === 'false', 'MediaRecorder.start throws: the panel is hidden and the mic unpressed');
  const t = await p.evaluate(() => window.__streams.map(s => s.getTracks().map(x => x.readyState)));
  ok(t.length === 1 && t[0].every(x => x === 'ended'), 'MediaRecorder.start throws: the microphone track has ended');
  await p.context().close();
}
{
  await openAdd();
  await page.fill('#acFront', 'Race');
  const n0 = await run(async () => (await (await import('./js/db.js')).getAll('cards')).length);
  await record('acBack', 1200);
  await run(() => { window.__subs = 0; document.addEventListener('submit', () => window.__subs++, true); });
  await run(() => { document.querySelector('#acBackRec [data-rec-stop]').click(); document.getElementById('acForm').requestSubmit(); });
  await page.waitForFunction(() => /Card added/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const r = await run(async () => { const cs = (await (await import('./js/db.js')).getAll('cards')).filter(c => c.front === 'Race'); return { n: cs.length, s: cs[0]?.backSounds?.length, subs: window.__subs }; });
  const n1 = await run(async () => (await (await import('./js/db.js')).getAll('cards')).length);
  ok(r.n === 1 && r.s === 1 && n1 === n0 + 1, `Stop then Save at once: exactly one card, with the sound (${JSON.stringify(r)})`);
  ok(r.subs <= 3, `Stop then Save at once: the form was submitted only a few times (${r.subs})`);
  await run(async () => (await import('./js/ui.js')).closeSheet());
  await sheetSettled(page);
}
{
  await openAdd();
  await record('acBack', 1200);
  await run(async () => {
    const { saveSound } = await import('./js/media.js'); const { setCardSounds } = await import('./js/card-editor.js'); const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await saveSound({ name: `s${i}.webm`, type: 'audio/webm', data: new Uint8Array([1, 2, 3, i]).buffer })).id);
    setCardSounds('acBack', ids);
  });
  await page.click('#acBackRec [data-rec-stop]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('already has 4 sounds'), null, { timeout: 5000 }).catch(() => {});
  ok((await toastText()).includes('This side already has 4 sounds. Remove one to keep the recording.'), 'full side: Stop says the side already has 4 sounds');
  ok(await items('acBack').count() === 4 && await page.isHidden('#acBackRec') && !(await page.textContent('#acBackRec')).includes('added'), 'full side: still 4 sounds, the panel is hidden and does not say "added"');
  ok(await allEnded(), 'full side: the microphone is let go');
  await run(async () => (await import('./js/ui.js')).closeSheet());
  await sheetSettled(page);
}
ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
