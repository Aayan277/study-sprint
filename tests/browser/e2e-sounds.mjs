// Sounds on cards (item 3) and "N sounds not imported" (item B): importing from Anki, playing in Review and Play, the card editor,
// exporting to Anki and back, backups, and syncing sounds like pictures (with the old file-type list rejecting them).
import { chromium, deckMenu } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch({ autoAddCards: true })      // builds devices with cards, then signs in on purpose to merge them (pw.mjs);
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const fake = fakeSupabase();

// Sound playback is spied on: play() records which sound it was asked to play (not the silent clip that unlocks iOS), and "ends" at once.
// speechSynthesis.speak is recorded too. window.__block makes play() refuse, like a browser that wants a tap first.
const spies = () => {
  window.__plays = []; window.__speaks = []; window.__block = false; window.__blobs = new Map();
  const mk = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { const u = mk(b); window.__blobs.set(u, b); return u; };
  HTMLMediaElement.prototype.play = function () {
    if (String(this.src).startsWith('data:')) return Promise.resolve();
    if (window.__block) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    window.__plays.push(this.src);
    setTimeout(() => this.dispatchEvent(new Event('ended')), 5);
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function () {};
  // The test sounds are filler bytes, not real audio, so the browser's own decoding of them fails a moment after src is set: an error
  // that arrives at a random time against the 5 ms "ended" above, marks the ▶ being played as broken, and the next tap then does nothing.
  // That is not what is tested here (an unplayable type is tested with canPlayType below), so the page's error handler is not told
  // about decoding errors on a sound's blob: address.
  const onerror = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'onerror') || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onerror');
  Object.defineProperty(HTMLMediaElement.prototype, 'onerror', {
    configurable: true,
    get() { return onerror.get.call(this); },
    set(fn) { onerror.set.call(this, typeof fn === 'function' ? function (e) { return String(this.src).startsWith('blob:') ? undefined : fn.call(this, e); } : fn); }
  });
  try { speechSynthesis.speak = u => window.__speaks.push(u.text); } catch { /* no speech here */ }
};
async function device(name, { width = 375, height = 740, colorScheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', acceptDownloads: true, colorScheme });
  await ctx.addInitScript(spies);
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|415|422)|Sync failed|Picture sync failed|Skipped a sound|Sounds can be up to 1 MB|isn't a sound file/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const page = await device('A');
const run = (fn, arg) => page.evaluate(fn, arg);
const toastText = () => page.textContent('#toast');
// (A sound's blob: address cannot be fetched under the page's policy, so the blobs are kept when they are made.)
const playSizes = async () => run(() => window.__plays.map(u => window.__blobs.get(u)?.size));
const reset = () => run(() => { window.__plays.length = 0; window.__speaks.length = 0; window.__block = false; });
const deckRows = async name => run(async n => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
  return Promise.all((await db.getCardsInDeck(d.id)).map(async c => ({ ...c, soundInfo: await Promise.all([...(c.frontSounds || []), ...(c.backSounds || [])].map(async id => { const m = await db.getMedia(id); return m && { id, type: m.type, size: m.size, bytes: m.data.byteLength, name: m.name, uploaded: m.uploaded }; })) })));
}, name);

// Opens the Import screen's File tab. A sheet that was just closed pops its own history entry asynchronously; navigating before that
// has finished would have the pop undo the new address too, so wait for the app's navigation to be idle (and off any overlay entry) first.
const openFileTab = async pg => {
  await pg.evaluate(() => import('./js/nav.js').then(m => m.whenIdle())).catch(() => {});
  await pg.waitForFunction(() => history.state?.k !== 'ov');
  await pg.goto(APP + '#/import');
  await pg.waitForSelector('#tab-file'); await pg.click('#tab-file');
};
const soundRowTexts = [];
// ---------- 1. importing a deck with sounds (both Anki file layouts) ----------
for (const [file, deckName] of [['anki-sound-new.apkg', 'Sounds new'], ['anki-sound-legacy.apkg', 'Sounds old']]) {
  await openFileTab(page);
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (the same notes are imported more than once on purpose: as new cards each time)
  const found = await page.textContent('#found');
  ok(found.includes('Found 8 cards') || found.includes('Found 9 cards'), `${file}: ${found.slice(0, 80)}`);
  ok(found.includes('4 notes have sounds, which come along too.'), `${file}: the summary says how many notes have sounds`);
  ok(found.includes("3 sounds weren't imported: 1 is bigger than 1 MB, 1 isn't in the file, 1 is a format the app can't keep."), `${file}: the sounds not imported are counted by reason (${found.replace(/.*(\d sounds? w)/s, '$1').slice(0, 120)})`);
  ok(await page.isVisible('#soundRow') && (await page.textContent('#soundRow')).includes('Bring sounds') && /About \d+ KB\. Kept on this device, synced like pictures and kept in backups\./.test(await page.textContent('#soundRow')), `${file}: the Bring sounds switch shows the size`);
  ok(await page.isChecked('#ankiSounds'), `${file}: Bring sounds starts on`);
  soundRowTexts.push(await page.textContent('#soundInfo'));
  if (file.includes('new')) await page.screenshot({ path: SP + '/snd-import-375.png', fullPage: true });
  await page.selectOption('#deckSel', '__new'); await page.fill('#newName', deckName); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const cards = await deckRows(deckName);
  const by = f => cards.find(c => c.front === f);
  const dog = by('dog'), cat = by('cat'), hound = by('hound'), brain = by('Brain');
  ok(dog?.frontSounds?.length === 1 && !dog.backSounds && dog.soundInfo[0].type === 'audio/wav', `${file}: "dog" has its sound on the front, kept as a wav`);
  ok(dog.soundInfo[0].bytes === 4044 || dog.soundInfo[0].bytes > 1000, `${file}: the bytes were kept as they are (${dog.soundInfo[0].bytes})`);
  ok(!cat.frontSounds && cat.backSounds?.length === 2 && cat.soundInfo.map(s => s.type).join() === 'audio/wav,audio/mpeg', `${file}: "cat" has two sounds on the back, in order (wav, mp3)`);
  ok(cat.soundInfo[0].name === 'cat one.wav', `${file}: the file name is kept`);
  ok(hound.frontSounds?.[0] === dog.frontSounds[0], `${file}: the same file on two cards is stored once`);
  const paris = cards.filter(c => c.cloze);
  ok(paris.length === 1 && paris[0].frontSounds?.length === 1, `${file}: the cloze note's Text sound is on the front`);
  ok(!brain.frontSounds && !brain.backSounds, `${file}: no sound where there was none`);
  ok(['ghost', 'big', 'old'].every(f => by(f) && !by(f).frontSounds && !by(f).backSounds && !/sound:/.test(by(f).front)), `${file}: sounds that couldn't be kept leave the card without them (and without the [sound:] text)`);
  const rows = await run(async () => (await (await import('./js/db.js')).getAll('media')).filter(m => m.type.startsWith('audio/')).length);
  ok(rows === (file.includes('new') ? 4 : 8), `${file}: ${rows} sound files stored (4 per import)`);
}
ok(soundRowTexts.length === 2 && soundRowTexts[0] === soundRowTexts[1], `both Anki layouts report the same size for the sounds (${soundRowTexts[0]})`);
ok(await run(() => navigator.storage.persisted().then(p => typeof p === 'boolean')), 'storage.persist() was asked for (no prompt)');

// ---------- 2. the switch off, and the free-space check ----------
await openFileTab(page);
await page.setInputFiles('#fileIn', SP + '/files/anki-sound-new.apkg');
await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (the same notes are imported more than once on purpose: as new cards each time)
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
await page.uncheck('#ankiSounds');
const off = await page.textContent('#found');
ok(off.includes('Sounds are left out (Bring sounds is off).') && !off.includes('come along too') && !off.includes("weren't imported"), 'switch off: "Sounds are left out (Bring sounds is off)."');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'No sounds'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
const noSnd = await deckRows('No sounds');
ok(noSnd.length >= 7 && noSnd.every(c => !c.frontSounds && !c.backSounds), 'switch off: no card got a sound');
// Not enough free space: the switch starts off, with the numbers
const tight = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
await tight.addInitScript(() => { navigator.storage.estimate = async () => ({ usage: 99.99 * 1024 * 1024, quota: 100 * 1024 * 1024 }); });
const tp = await tight.newPage();
await openFileTab(tp);
await tp.setInputFiles('#fileIn', SP + '/files/anki-sound-new.apkg');
await tp.waitForSelector('#preview[data-guids]'); if (await tp.isVisible('#updRow')) await tp.click('#updateOld');          // (the same notes are imported more than once on purpose: as new cards each time)
await tp.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
ok(!(await tp.isChecked('#ankiSounds')) && /Not enough free space on this device for the sounds \(about [\d.]+ [KM]B needed, \d+ KB free\)\./.test(await tp.textContent('#found')), 'little free space: the switch starts off and says why');
await tight.close();

// ---------- 3. Review: play buttons, auto-play, R, blocked auto-play ----------
const ids = await run(async () => {
  const db = await import('./js/db.js'), media = await import('./js/media.js');
  const snd = async (n, name = 'a.wav', type = 'audio/wav') => (await media.saveSound({ name, type, data: new Uint8Array(n).fill(1).buffer })).id;
  const s = { f1: await snd(1001), b1: await snd(2002), b2: await snd(2003, 'b.mp3', 'audio/mpeg'), f2: await snd(3003), f3: await snd(4004), f4: await snd(5005), f5: await snd(6006), f6: await snd(7007) };
  await db.addDeckWithCards({ id: 'listen', name: 'Listen', color: '#46A758', created: Date.now() }, [
    { id: 'L1', deckId: 'listen', front: 'hear', back: 'answer', frontSounds: [s.f1], backSounds: [s.b1, s.b2], tags: [], created: 1 },
    { id: 'L2', deckId: 'listen', front: 'plain', back: 'no sound', tags: [], created: 2 },
    { id: 'L3', deckId: 'listen', front: '', back: 'sound only', frontSounds: [s.f2], tags: [], created: 3 },
    { id: 'L4', deckId: 'listen', front: 'four', back: 'x4', frontSounds: [s.f3], tags: [], created: 4 },
    { id: 'L5', deckId: 'listen', front: 'five', back: 'x5', frontSounds: [s.f4], tags: [], created: 5 },
    { id: 'L6', deckId: 'listen', front: 'six', back: 'x6', frontSounds: [s.f5], tags: [], created: 6 }
  ]);
  return s;
});
await page.goto(APP + '#/review/listen'); await page.waitForSelector('#flash');
ok((await page.textContent('.rv-front .flash-front')).includes('hear') && (await page.locator('.rv-front .snd-btn').count()) === 1, 'Review: the front shows one ▶ under its text');
ok(await page.getAttribute('.rv-front .snd-btn', 'aria-label') === 'Play sound', 'Review: the ▶ has a label');
await page.waitForFunction(() => window.__plays.length >= 1);
ok((await playSizes()).join() === '1001', `Review: the front's sound played by itself when the card appeared (${await playSizes()})`);
ok(await page.title() !== '' && (await page.getAttribute('#speakBtn', 'title')) === 'Play the sound or read aloud (R)', 'Review: the speaker button says it plays the sound');
await reset();
await page.keyboard.press('r');
await page.waitForFunction(() => window.__plays.length >= 1);
ok((await playSizes()).join() === '1001' && (await run(() => window.__speaks.length)) === 0, 'Review: R plays the sound instead of reading aloud');
await reset();
await page.click('#showBtn');
await page.waitForFunction(() => window.__plays.length >= 2);
ok((await playSizes()).join() === '2002,2003', `Review: flipping plays the back's two sounds in order (${await playSizes()})`);
ok((await page.locator('.rv-back .flash-back .snd-btn').count()) === 2 && (await page.getAttribute('.rv-back .flash-back .snd-btn >> nth=1', 'aria-label')) === 'Play sound 2 of 2', 'Review: the back shows "Play sound 1 of 2" and "2 of 2"');
ok((await page.locator('.rv-back .flash-recap .snd-btn').count()) === 1, 'Review: the question shown again on the back keeps its ▶');
await page.waitForTimeout(500);
await page.screenshot({ path: SP + '/snd-review-back-375.png' });
await reset();
await page.click('.rv-back .flash-back .snd-btn >> nth=1');
await page.waitForFunction(() => window.__plays.length >= 1);
ok((await playSizes()).join() === '2003', 'Review: tapping the second ▶ plays just that sound (and does not flip or rate)');
await page.keyboard.press('3');                       // Good
await page.waitForSelector('#showBtn');
ok((await page.textContent('.rv-front .flash-front')).includes('plain') && (await page.locator('.rv-front .snd-btn').count()) === 0, 'Review: a card without sounds shows no ▶');
await reset();
await page.keyboard.press('r');
await page.waitForFunction(() => window.__speaks.length >= 1);
ok((await run(() => window.__speaks.join('|'))) === 'plain' && (await run(() => window.__plays.length)) === 0, 'Review: R still reads aloud a side with no sound');
ok((await page.getAttribute('#speakBtn', 'title')) === 'Read aloud (R)', 'Review: and the button says so');
await page.click('#showBtn'); await page.keyboard.press('3');
await page.waitForSelector('#showBtn');
ok((await page.locator('.rv-front .snd-btn').count()) === 1 && (await page.textContent('.rv-front .flash-front')).replace(/[▶\uFE0E]/g, '').trim() === '', 'Review: a sound on a side with no text still plays (a ▶ and no text)');
// the next card stops the sound; Undo stops it too
await reset();
await run(() => { window.__stops = 0; HTMLMediaElement.prototype.pause = function () { window.__stops++; }; });
await page.click('#showBtn'); await page.keyboard.press('3');
await page.waitForSelector('#showBtn');
ok((await run(() => window.__stops)) >= 1, 'Review: moving to the next card stops the sound');
await run(() => { window.__stops = 0; });
await page.click('#undoBtn');
await page.waitForFunction(() => window.__stops >= 1, null, { timeout: 5000 }).catch(() => {});
ok((await run(() => window.__stops)) >= 1, 'Review: Undo stops the sound');
await page.waitForSelector('#showBtn');
// blocked auto-play
await run(() => { window.__block = true; });
await page.keyboard.press('Space'); await page.keyboard.press('3');   // a new card appears while the browser refuses to play by itself
await page.waitForSelector('.rv-front .snd-btn.pulse', { timeout: 5000 });
ok((await page.textContent('.rv-front .snd-hint')) === 'Tap ▶ to play', 'Review: if the browser blocks auto-play, the first ▶ pulses and the hint says "Tap ▶ to play"');
await page.waitForTimeout(500);
await page.screenshot({ path: SP + '/snd-blocked-375.png' });
await run(() => { window.__block = false; window.__plays.length = 0; });
await page.click('.rv-front .snd-btn');
await page.waitForFunction(() => window.__plays.length >= 1);
ok(true, 'Review: tapping the pulsing ▶ plays');

// (see 3b) records every play() with the audio session type at that moment, and stubs the Audio Session API like Safari 16.4+
const quietInit = () => {
    window.__calls = []; window.__types = [];
    const spy = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__calls.push({ src: String(this.src).slice(0, 5), muted: this.muted, type: navigator.audioSession.type }); return spy.call(this); };
    let t = 'auto';
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { get type() { return t; }, set type(v) { t = v; window.__types.push(v); } } });
    const cancel = speechSynthesis.cancel.bind(speechSynthesis);
    window.__cancels = 0; speechSynthesis.cancel = () => { window.__cancels++; return cancel(); };
  };
// ---------- 3b. opening the app must not take the phone's audio (it pauses Spotify / Apple Music) ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', colorScheme: 'dark' });
  await ctx.addInitScript(spies);
  // After the spies: record every play() (the silent unlock clip too) and stub the Audio Session API like Safari 16.4+.
  await ctx.addInitScript(quietInit);
  const q = await ctx.newPage();
  q.on('pageerror', e => errors.push(`Q pageerror ${e.stack}`));
  await q.goto(APP + '#/decks'); await q.waitForSelector('.deck');
  const calls = () => q.evaluate(() => window.__calls);
  const dataCalls = async () => (await calls()).filter(c => c.src === 'data:');
  await q.evaluate(async () => {
    const db = await import('./js/db.js'), media = await import('./js/media.js');
    const id = (await media.saveSound({ name: 'a.wav', type: 'audio/wav', data: new Uint8Array(900).fill(1).buffer })).id;
    await db.addDeckWithCards({ id: 'quiet', name: 'Quiet', color: '#46A758', created: Date.now() }, [
      { id: 'Q1', deckId: 'quiet', front: 'hear', back: 'a', frontSounds: [id], tags: [], created: 1 },
      { id: 'Q2', deckId: 'quiet', front: 'plain', back: 'b', tags: [], created: 2 }
    ]);
  });
  // tapping around screens that have no sounds
  await q.goto(APP + '#/decks'); await q.waitForSelector('.deck');
  for (const hash of ['#/stats', '#/settings', '#/decks', '#/import', '#/decks']) {
    await q.goto(APP + hash); await q.waitForTimeout(150);
    await q.mouse.click(8, 8); await q.keyboard.press('Tab');
  }
  ok((await calls()).length === 0, `opening the app and tapping around screens without sounds never calls play() (${(await calls()).length})`);
  ok((await q.evaluate(() => window.__types.length + window.__cancels + window.__speaks.length)) === 0, 'and never touches the audio session or speech');
  // a card with a sound: autoplay is tried, but the unlock waits for a tap; leaving the screen turns the listening off again
  await q.goto(APP + '#/review/quiet'); await q.waitForSelector('#flash .snd-btn');
  await q.goto(APP + '#/decks'); await q.waitForSelector('.deck'); await q.waitForTimeout(800);
  await q.evaluate(() => { window.__calls.length = 0; window.__types.length = 0; });
  await q.mouse.click(8, 8);
  ok((await dataCalls()).length === 0, 'after leaving the sound card, taps no longer unlock');
  await q.goto(APP + '#/review/quiet'); await q.waitForSelector('#flash .snd-btn'); await q.waitForTimeout(300);
  await q.evaluate(() => { window.__calls.length = 0; window.__types.length = 0; window.__plays.length = 0; });
  await q.mouse.click(8, 8);                                     // first tap on a sound card (not the ▶)
  await q.waitForFunction(() => window.__calls.some(c => c.src === 'data:'));
  const unl = (await dataCalls())[0];
  ok(unl && unl.type === 'ambient', `the first tap unlocks with a silent clip in an 'ambient' audio session (${unl?.type})`);
  await q.waitForTimeout(200);
  ok(await q.evaluate(() => window.__types.join()) === 'ambient,auto', `the session is ambient for the silent clip only, then back to auto (${await q.evaluate(() => window.__types.join())})`);
  // a real sound switches to 'transient' and back
  await q.evaluate(() => { window.__calls.length = 0; window.__types.length = 0; window.__plays.length = 0; });
  await q.click('#flash .rv-front .snd-btn');
  await q.waitForFunction(() => window.__plays.length >= 1);
  await q.waitForTimeout(200);
  const real = (await calls()).filter(c => c.src !== 'data:');
  ok(real.length >= 1 && real.every(c => c.type === 'auto') && !(await q.evaluate(() => window.__types.some(t => t !== 'auto'))), `a real card sound plays in the 'auto' session, never ambient or transient, so the silent switch cannot mute it (${real.map(c => c.type)})`);
  // autoplay after the unlock: opening another deck's sound card plays it by itself
  await q.goto(APP + '#/decks'); await q.waitForSelector('.deck');
  await q.evaluate(async () => {
    const db = await import('./js/db.js'), media = await import('./js/media.js');
    const id = (await media.saveSound({ name: 'c.wav', type: 'audio/wav', data: new Uint8Array(910).fill(1).buffer })).id;
    await db.addDeckWithCards({ id: 'quiet2', name: 'Quiet two', color: '#46A758', created: Date.now() }, [{ id: 'Q9', deckId: 'quiet2', front: 'again', back: 'z', frontSounds: [id], tags: [], created: 1 }]);
    window.__plays.length = 0;
  });
  await q.goto(APP + '#/review/quiet2'); await q.waitForSelector('#flash .snd-btn');
  await q.waitForFunction(() => window.__plays.length >= 1, null, { timeout: 5000 });
  ok(true, 'once unlocked, a card with sounds still plays by itself');
  await ctx.close();
}

// A card with sounds only on the back, a ▶ tapped as the first thing in Play, and a screen that draws its ▶ late.
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', colorScheme: 'dark' });
  await ctx.addInitScript(spies);
  await ctx.addInitScript(quietInit);
  const q = await ctx.newPage();
  q.on('pageerror', e => errors.push(`R pageerror ${e.stack}`));
  await q.goto(APP + '#/decks'); await q.waitForSelector('.deck');
  const data = () => q.evaluate(() => window.__calls.filter(c => c.src === 'data:'));
  await q.evaluate(async () => {
    const db = await import('./js/db.js'), media = await import('./js/media.js');
    const snd = async n => (await media.saveSound({ name: 'e.wav', type: 'audio/wav', data: new Uint8Array(n).fill(1).buffer })).id;
    await db.addDeckWithCards({ id: 'backonly', name: 'Back only', color: '#46A758', created: Date.now() }, [{ id: 'B1', deckId: 'backonly', front: 'q', back: 'a', backSounds: [await snd(920)], tags: [], created: 1 }]);
    await db.addDeckWithCards({ id: 'pl', name: 'Play deck', color: '#46A758', created: Date.now() }, [
      { id: 'P1', deckId: 'pl', front: 'p1', back: 'b1', frontSounds: [await snd(930)], tags: [], created: 1 },
      { id: 'P2', deckId: 'pl', front: 'p2', back: 'b2', frontSounds: [await snd(940)], tags: [], created: 2 }]);
  });
  await q.goto(APP + '#/review/backonly'); await q.waitForSelector('#showBtn');
  await q.waitForFunction(() => document.querySelector('.snd-btn'));
  await q.waitForTimeout(300);
  await q.mouse.click(8, 8);                                  // a tap that is not on the card or the ▶
  await q.waitForFunction(() => window.__calls.some(c => c.src === 'data:'), null, { timeout: 5000 }).catch(() => {});
  ok((await data()).length === 1 && (await data())[0].type === 'ambient', 'a card with sounds only on the back arms the unlock before the flip tap');
  // Play: a ▶ tapped as the first thing unlocks and plays (fresh page, so nothing was unlocked before)
  await q.goto(APP + '#/decks'); await q.reload(); await q.waitForSelector('.deck');
  await q.evaluate(async () => { window.__calls.length = 0; await (await import('./js/db.js')).setSetting('playPrefs', { deckId: 'pl', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 10, qtypeByDeck: {} }); });
  ok((await data()).length === 0, 'a reload starts with nothing unlocked and no play() calls');
  await q.goto(APP + '#/play'); await q.waitForSelector('#startBtn'); await q.click('#startBtn'); await q.waitForSelector('#pCard');
  const btn = await q.waitForSelector('#pPrompt .snd-btn', { timeout: 10000 }).catch(() => null);
  if (!btn) ok(false, 'Play shows a ▶ for a card with sounds');
  else {
    await q.evaluate(() => { window.__plays.length = 0; });
    await q.click('#pPrompt .snd-btn');
    await q.waitForFunction(() => window.__plays.length >= 1);
    const d = await data();
    ok(d.length === 1 && d[0].type === 'ambient' && (await q.evaluate(() => window.__types.join())) === 'ambient,auto', 'a ▶ tap in Play unlocks (ambient, then auto) and plays the sound');
  }
  // a ▶ drawn late (slow render) on a screen that was disarmed: it arms again
  await q.goto(APP + '#/decks'); await q.reload(); await q.waitForSelector('.deck');
  await q.waitForTimeout(800);
  await q.evaluate(() => { window.__calls.length = 0; const d = document.createElement('div'); d.innerHTML = '<button class="snd-btn" data-snd="nope">▶︎</button>'; document.body.append(d); });
  await q.waitForTimeout(100);
  await q.mouse.click(8, 8);
  await q.waitForFunction(() => window.__calls.some(c => c.src === 'data:'), null, { timeout: 5000 }).catch(() => {});
  ok((await data()).length === 1, 'a ▶ that appears later arms the unlock');
  await ctx.close();
}

// ---------- 4. the deck option "Play sounds automatically" ----------
await page.goto(APP + '#/deck/listen'); await deckMenu(page); await page.click('#editDeck');
await page.waitForSelector('#deckSoundAuto');
ok((await page.textContent('#sheet')).includes('Play sounds automatically') && (await page.textContent('#sheet')).includes("In Review: the front's sounds when a card appears, the back's when you flip."), 'Edit deck: "Play sounds automatically" with its description');
ok(await page.isChecked('#deckSoundAuto'), 'Edit deck: on by default');
await page.screenshot({ path: SP + '/snd-deckopt-375.png' });
await page.uncheck('#deckSoundAuto'); await page.evaluate(() => document.getElementById('deckForm').requestSubmit()); await page.waitForSelector('#sheet', { state: 'hidden' });
ok((await run(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.id === 'listen').soundAuto)) === false, 'Edit deck: off is saved as soundAuto false');
await reset();
await page.goto(APP + '#/review/listen'); await page.waitForSelector('#flash');
await page.waitForTimeout(400);
ok((await run(() => window.__plays.length)) === 0 && (await run(() => window.__speaks.length)) === 0, 'with it off: nothing plays by itself, and nothing is read aloud for that side either');
await page.keyboard.press('r');
await page.waitForFunction(() => window.__plays.length >= 1);
ok(true, 'with it off: R still plays the sound');
await run(async () => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.id === 'listen'); await db.saveDeck({ ...d, soundAuto: true }); });

// ---------- 5. Play shows a ▶ and never plays by itself ----------
await run(async () => { const db = await import('./js/db.js'); await db.setSetting('playPrefs', { deckId: 'listen', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 10, qtypeByDeck: {} }); });
await page.goto(APP + '#/play'); await page.waitForSelector('#startBtn');
await reset();
await page.click('#startBtn'); await page.waitForSelector('#pCard');
let sawBtn = false;
for (let i = 0; i < 6 && !sawBtn; i++) {
  await page.waitForFunction(() => document.querySelector('#pPrompt'));
  sawBtn = (await page.locator('#pPrompt .snd-btn').count()) > 0;
  if (!sawBtn) { await page.keyboard.press('1'); await page.waitForSelector('.fb'); await page.keyboard.press('Enter'); }
}
ok(sawBtn, 'Play: a ▶ shows next to the prompt when the asked side has sounds');
ok((await run(() => window.__plays.length)) === 0, 'Play: sounds never play by themselves');
await page.screenshot({ path: SP + '/snd-play-375.png' });
await page.click('#pPrompt .snd-btn');
await page.waitForFunction(() => window.__plays.length >= 1);
ok(true, 'Play: tapping ▶ plays the sound');
await page.click('#quitBtn');

// ---------- 6. the card editor ----------
await page.goto(APP + '#/deck/listen'); await page.waitForSelector('.crow');
ok((await page.locator('.crow .snd-mark').count()) === 5 && (await page.getAttribute('.crow .snd-mark >> nth=0', 'aria-label')) === 'Has sound', 'Card list: a ♪ mark on the rows with sounds (5 of 6)');
await page.screenshot({ path: SP + '/snd-list-375.png' });
await page.click('#brAdd');
await page.waitForSelector('#acForm');
ok((await page.getAttribute('[data-snd-add=acFront]', 'aria-label')) === 'Add a sound' && (await page.getAttribute('[data-snd-add=acFront]', 'title')) === 'Add a sound', 'Editor: a music-note button "Add a sound" next to the picture button');
ok((await page.getAttribute('#acFrontSndFile', 'accept')) === 'audio/*', 'Editor: it opens a file picker for audio');
const wav = n => ({ name: 'clip.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(n, 1) });
await page.setInputFiles('#acFrontSndFile', wav(24 * 1024));
await page.waitForSelector('#acFrontSnd .snd-item');
const rowText = (await page.textContent('#acFrontSnd .snd-item')).replace(/\s+/g, ' ').trim();
ok(/Sound 1 · 24 KB/.test(rowText) && rowText.includes('Remove'), `Editor: the sound shows as "▶ Sound 1 · 24 KB · Remove" (${rowText})`);
await page.fill('#acBack', 'the back');
ok((await page.getAttribute('button[type=submit][form=acForm], #acForm button[type=submit]', 'aria-disabled')) === 'false', 'Editor: a front with only a sound is enough to add');
await page.click('#acFrontSnd .snd-btn');
await page.waitForFunction(() => window.__plays.length >= 2);
ok(true, 'Editor: ▶ plays the sound before saving');
// too big
await page.setInputFiles('#acBackSndFile', { name: 'long.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(1_200_044, 1) });
await page.waitForFunction(() => /Sounds can be up to 1 MB/.test(document.querySelector('#toast')?.textContent || ''));
ok((await toastText()).includes('That sound is 1.1 MB. Sounds can be up to 1 MB: shorten it or save it at a lower quality.') && (await page.locator('#acBackSnd .snd-item').count()) === 0, 'Editor: too big → "That sound is 1.1 MB. Sounds can be up to 1 MB: shorten it or save it at a lower quality."');
// a browser that can't play ogg
await run(() => { const real = HTMLAudioElement.prototype.canPlayType; HTMLAudioElement.prototype.canPlayType = function (t) { return /ogg/.test(t) ? '' : real.call(this, t); }; });
await page.setInputFiles('#acBackSndFile', { name: 'voice.ogg', mimeType: 'audio/ogg', buffer: Buffer.alloc(900, 2) });
await page.waitForSelector('#acBackSnd .snd-item');
await page.waitForFunction(() => /can't play/.test(document.querySelector('#toast')?.textContent || ''));
ok((await toastText()).includes("This browser can't play .ogg files. Other devices may.") && (await page.locator('#acBackSnd .snd-item').count()) === 1, 'Editor: an unplayable type is saved anyway, with "This browser can\'t play .ogg files. Other devices may."');
await page.waitForFunction(() => document.querySelector('#acBackSnd .snd-btn')?.getAttribute('aria-disabled') === 'true');   // (the app checks each new ▶ a moment after it appears)
ok((await page.getAttribute('#acBackSnd .snd-btn', 'title')) === "This sound can't play in this browser" && (await page.getAttribute('#acBackSnd .snd-btn', 'aria-disabled')) === 'true', 'Editor: its ▶ is turned off with "This sound can\'t play in this browser"');
// not a sound
await page.setInputFiles('#acBackSndFile', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
await page.waitForFunction(() => /isn't a sound file/.test(document.querySelector('#toast')?.textContent || ''));
ok(true, 'Editor: a file that is not a sound is refused in plain words');
// at most four
for (let i = 0; i < 4; i++) await page.setInputFiles('#acFrontSndFile', { name: `n${i}.wav`, mimeType: 'audio/wav', buffer: Buffer.alloc(100 + i, 3) });
await page.waitForFunction(() => document.querySelectorAll('#acFrontSnd .snd-item').length === 4);
await page.waitForTimeout(150);
ok((await page.locator('#acFrontSnd .snd-item').count()) === 4 && (await page.textContent('#acFrontSnd')).includes('Up to 4 sounds on each side'), 'Editor: at most 4 per side ("Up to 4 sounds on each side")');
await page.click('[data-snd-add=acFront]');
ok((await toastText()).includes('Up to 4 sounds on each side'), 'Editor: the add button says so too');
await page.screenshot({ path: SP + '/snd-editor-375.png' });
await page.click('#acFrontSnd [data-snd-remove] >> nth=3'); await page.click('#acFrontSnd [data-snd-remove] >> nth=2');
ok((await page.locator('#acFrontSnd .snd-item').count()) === 2, 'Editor: Remove takes a sound out');
await page.evaluate(() => document.getElementById('acForm').requestSubmit());
await page.waitForFunction(() => /Card added/.test(document.querySelector('#toast')?.textContent || ''));
const added = await run(async () => { const c = (await (await import('./js/db.js')).getAll('cards')).find(x => x.back === 'the back'); return { f: c.frontSounds?.length, b: c.backSounds?.length }; });
ok(added.f === 2 && added.b === 1, `Editor: the card was saved with 2 sounds on the front and 1 on the back (${JSON.stringify(added)})`);
ok((await page.locator('#acFrontSnd .snd-item').count()) === 0 && (await page.locator('#acBackSnd .snd-item').count()) === 0, 'Editor: the form is clear for the next card');
await page.click('#acDone');
// edit and remove
await page.fill('#brQuery', 'the back');
await page.waitForFunction(() => document.querySelectorAll('.crow').length === 1);
await page.click('.crow-btn >> nth=0');
await page.waitForSelector('#ceFrontSnd .snd-item');
ok((await page.locator('#ceFrontSnd .snd-item').count()) === 2 && (await page.locator('#ceBackSnd .snd-item').count()) === 1, 'Card panel: it shows the card\'s sounds with play buttons');
await page.click('#ceFrontSnd [data-snd-remove] >> nth=1'); await page.click('#ceBackSnd [data-snd-remove]');
await page.evaluate(() => document.getElementById('ceForm').requestSubmit());
await page.waitForFunction(() => /Saved/.test(document.querySelector('#toast')?.textContent || ''));
const edited = await run(async () => { const c = (await (await import('./js/db.js')).getAll('cards')).find(x => x.back === 'the back'); return { f: c.frontSounds?.length, hasBack: 'backSounds' in c }; });
ok(edited.f === 1 && !edited.hasBack, `Card panel: removing sounds saves (front ${edited.f}, no empty back list: ${!edited.hasBack})`);

await page.goto(APP + '#/decks'); await page.waitForSelector('.deck'); await page.goto(APP + '#/deck/listen');
await page.fill('#brQuery', ''); await page.waitForFunction(() => document.querySelectorAll('.crow').length === 7);      // (the list remembers the search: clear it)
// ---------- 7. export to Anki and back ----------
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
const sid = await run(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Sounds new').id);
await page.goto(APP + '#/deck/' + sid); await deckMenu(page); await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
ok((await page.textContent('#sheet')).includes('Sounds go in the Anki deck (a spreadsheet can only hold text).'), 'Export: the sheet says sounds go in the Anki deck, not the spreadsheet');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
await dl.saveAs(SP + '/exports/with-sounds.apkg');
await openFileTab(page);
await page.setInputFiles('#fileIn', SP + '/exports/with-sounds.apkg');
await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (the same notes are imported more than once on purpose: as new cards each time)
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const again = await page.textContent('#found');
ok(again.includes('4 notes have sounds, which come along too.') && !again.includes("weren't imported"), `Export → import: the sounds are still there (${again.slice(0, 140)})`);
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Round trip'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 }).catch(async e => { console.log('FAIL round trip save: ' + (await toastText()) + ' ' + page.url()); console.log((await page.textContent('main')).slice(0, 600)); await page.screenshot({ path: SP + '/dbg-trip.png' }); throw e; });
const trip = await deckRows('Round trip'), orig = await deckRows('Sounds new');
const tdog = trip.find(c => c.front === 'dog'), odog = orig.find(c => c.front === 'dog'), tcat = trip.find(c => c.front === 'cat'), ocat = orig.find(c => c.front === 'cat');
ok(tdog?.frontSounds?.length === 1 && tdog.soundInfo[0].bytes === odog.soundInfo[0].bytes && tdog.soundInfo[0].type === 'audio/wav', 'Export → import: "dog" has the same sound on the front');
ok(tcat?.backSounds?.length === 2 && tcat.soundInfo.map(s => s.bytes).join() === ocat.soundInfo.map(s => s.bytes).join() && tcat.soundInfo.map(s => s.type).join() === 'audio/wav,audio/mpeg', 'Export → import: "cat" has the same two sounds on the back, in order');
ok(trip.filter(c => c.cloze).every(c => c.frontSounds?.length === 1), 'Export → import: the cloze note keeps its sound');

// ---------- 8. backups with and without sounds ----------
const bk = await run(async () => {
  const db = await import('./js/db.js');
  const withS = await db.exportAll(), without = await db.exportAll({ sounds: false });
  return { v: withS.version, audio: withS.media.filter(m => m.type.startsWith('audio/')).length, named: withS.media.some(m => m.name === 'cat one.wav'), ok: db.checkBackup(withS),
    v2: without.version, audio2: without.media.filter(m => m.type.startsWith('audio/')).length, ok2: db.checkBackup(without), cards2: without.cards.filter(c => c.frontSounds || c.backSounds).length > 0 };
});
ok(bk.v === 2 && bk.audio > 0 && bk.named && bk.ok === null, `Backup with sounds: version 2, ${bk.audio} sounds, file names kept, checks out`);
ok(bk.v2 === 1 && bk.audio2 === 0 && bk.ok2 === null && bk.cards2, `Backup without sounds: version 1, no sounds in it (cards still list them), checks out`);
await page.goto(APP + '#/settings'); await page.waitForSelector('#bkSoundsRow:not([hidden])');
ok(/Include sounds \(\d+(\.\d)? [KM]B\)/.test(await page.textContent('#bkSoundsTitle')) && await page.isChecked('#bkSounds'), `Settings: "Include sounds (…)" is on for a small total (${await page.textContent('#bkSoundsTitle')})`);
await page.waitForFunction(() => /On this device: pictures .* · sounds .*free/.test(document.querySelector('#mediaLine')?.textContent || ''));
ok(true, 'Settings → Your data: ' + await page.textContent('#mediaLine'));
await page.screenshot({ path: SP + '/snd-settings-375.png', fullPage: true });
await page.uncheck('#bkSounds');
const [bdl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exportBtn')]);
await bdl.saveAs(SP + '/exports/no-sounds.json');
const fs = await import('node:fs');
const noSounds = JSON.parse(fs.readFileSync(SP + '/exports/no-sounds.json', 'utf8'));
ok(noSounds.version === 1 && !noSounds.media.some(m => m.type.startsWith('audio/')), 'Settings: switching "Include sounds" off leaves them out of the file');
// restore a backup with sounds
const restored = await run(async () => {
  const db = await import('./js/db.js');
  const data = await db.exportAll();
  const before = (await db.getAll('media')).filter(m => m.type.startsWith('audio/')).map(m => [m.id, m.data.byteLength]).sort();
  await db.resetAll();
  const gone = (await db.getAll('media')).length;
  await db.importAll(JSON.parse(JSON.stringify(data)));
  const after = (await db.getAll('media')).filter(m => m.type.startsWith('audio/')).map(m => [m.id, m.data.byteLength]).sort();
  return { gone, same: JSON.stringify(before) === JSON.stringify(after), n: after.length };
});
ok(restored.gone === 0 && restored.same && restored.n > 4, `Restore: the sounds come back byte for byte (${restored.n})`);
// not enough room: the restore fails as a whole and says so
const noRoom = await run(async () => {
  const db = await import('./js/db.js');
  const data = await db.exportAll();
  const cards = (await db.getAll('cards')).length;
  const realPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { if (this.name === 'media') throw new DOMException('full', 'QuotaExceededError'); return realPut.call(this, v, k); };
  let err = null;
  try { await db.importAll(JSON.parse(JSON.stringify(data))); } catch (e) { err = { msg: e.message, noSpace: e.noSpace }; }
  IDBObjectStore.prototype.put = realPut;
  return { err, cards: (await db.getAll('cards')).length === cards };
});
ok(noRoom.err?.noSpace && noRoom.err.msg === 'Not enough space on this device to restore this backup.' && noRoom.cards, 'Restore with no room: "Not enough space on this device to restore this backup." and everything stays as it was');

// ---------- 8b. book-keeping: nothing needs to read every file's bytes ----------
const book = await run(async () => {
  const db = await import('./js/db.js'), media = await import('./js/media.js');
  const kind = m => (m.type.startsWith('audio/') ? 'sounds' : 'pictures');
  const actual = async () => { const out = { pictures: 0, sounds: 0 }; for (const id of await db.mediaKeys()) { const m = await db.getMedia(id); out[kind(m)] += m.size; } return out; };
  const t1 = await db.mediaTotals(), a1 = await actual();
  const s = await media.saveSound({ name: 't.wav', type: 'audio/wav', data: new Uint8Array(777).fill(1).buffer });
  const t2 = await db.mediaTotals();
  const pending = (await db.mediaToUpload()).map(m => m.id);
  const removedFresh = await db.cleanMedia(Date.now());                      // too new: kept (its card may not be saved yet)
  const stillThere = !!(await db.getMedia(s.id));
  await db.putMedia({ ...(await db.getMedia(s.id)), created: Date.now() - 2 * 3600000, uploaded: true });
  const pendingAfter = (await db.mediaToUpload()).map(m => m.id);
  const removedOld = await db.cleanMedia(Date.now());                        // old, unused and on the server: removed, and listed so the server can drop it
  const gone = !(await db.getMedia(s.id));
  const t3 = await db.mediaTotals(), a3 = await actual();
  // A backup without sounds never reads the sounds' bytes
  const cards = await db.getAll('cards');
  const soundIds = new Set(cards.flatMap(c => [...(c.frontSounds || []), ...(c.backSounds || [])]));
  const asked = [];
  const realGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (k) { if (this.name === 'media') asked.push(k); return realGet.call(this, k); };
  const bk = await db.exportAll({ sounds: false });
  IDBObjectStore.prototype.get = realGet;
  return { same1: JSON.stringify(t1) === JSON.stringify(a1), same2: t2.sounds === t1.sounds + 777, pending: pending.includes(s.id), removedFresh: removedFresh.includes(s.id), stillThere,
    pendingAfter: pendingAfter.includes(s.id), removedOld: removedOld.includes(s.id), gone, same3: JSON.stringify(t3) === JSON.stringify(a3) && t3.sounds === t1.sounds,
    readSound: asked.some(k => soundIds.has(k)), exported: !bk.media.some(m => m.type.startsWith('audio/')) };
});
ok(book.same1 && book.same2 && book.same3, 'Book-keeping: the totals record matches the real sizes, and follows an add and a removal');
ok(book.pending && !book.pendingAfter, 'Book-keeping: a new sound is listed to upload, and is not once it is marked uploaded');
ok(!book.removedFresh && book.stillThere, 'Clean-up: a sound added in the last hour is kept even if no card uses it');
ok(book.removedOld && book.gone, 'Clean-up: an old unused sound is removed and listed for the server');
ok(book.exported && !book.readSound, "A backup without sounds never read a sound's bytes");

// ---------- 9. sync: sounds like pictures, and a server that still has the old file-type list ----------
fake.setAudio(false);
const A = await device('sync A');
const B = await device('sync B');
const seed = await A.evaluate(async () => {
  const db = await import('./js/db.js'), media = await import('./js/media.js');
  const snd = async (n, name = 's.wav', type = 'audio/wav') => (await media.saveSound({ name, type, data: new Uint8Array(n).fill(7).buffer })).id;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)).buffer;
  const pic = await media.saveImage('image/png', png);
  const s1 = await snd(1500), s2 = await snd(2500, 'x.mp3', 'audio/mpeg');
  await db.addDeckWithCards({ id: 'sy', name: 'Synced words', color: '#46A758', created: Date.now() }, [
    { id: 'sy1', deckId: 'sy', front: 'a', back: 'b', frontImage: pic, frontSounds: [s1], tags: [], created: 1 },
    { id: 'sy2', deckId: 'sy', front: 'c', back: 'd', backSounds: [s2], tags: [], created: 2 }
  ]);
  return { pic, s1, s2 };
});
await A.goto(APP + '#/settings'); await A.waitForSelector('#syncBox > *');
await A.fill('#syncEmail', 'me@example.com'); await A.fill('#syncPw', 'secret123'); await A.click('#syncCreate');
await A.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
ok(fake.files.has(`${[...fake.users.values()][0].id}/${seed.pic}`), 'Sync with the old file-type list: the picture still goes up');
ok(![...fake.files.keys()].some(k => k.endsWith(seed.s1) || k.endsWith(seed.s2)), 'Sync with the old file-type list: the sounds are turned away');
await A.waitForFunction(() => /Sounds can.t sync yet/.test(document.querySelector('#syncBox')?.textContent || ''));
const note = await A.textContent('#syncBox');
ok(note.includes('Sounds can’t sync yet: run the new supabase/media.sql in your Supabase project (see docs/sync-setup.md). Pictures and everything else are syncing.'), 'Sync: the note says what to do, and that pictures and the rest are syncing');
await A.screenshot({ path: SP + '/snd-sync-note-375.png', fullPage: true });
const blocked = await A.evaluate(async ([a, b]) => { const db = await import('./js/db.js'); return [await db.getMedia(a), await db.getMedia(b)].map(m => [m.uploaded, m.blocked]); }, [seed.s1, seed.s2]);
ok(blocked.every(([up, bl]) => up === false && bl === 'type'), 'Sync: the sounds stay not-uploaded and marked blocked (type)');
const tries = fake.uploads.length;
await A.evaluate(async () => { const s = await import('./js/sync.js'); await s.syncNow(); });
ok(fake.uploads.length === tries, 'Sync: a blocked sound is not sent again on the next ordinary sync');
// the owner re-runs media.sql, then Sync now
fake.setAudio(true);
await A.evaluate(() => { document.querySelector('#syncNowBtn').click(); });
await A.waitForFunction(() => !/Sounds can.t sync yet/.test(document.querySelector('#syncBox')?.textContent || '') && /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const uid = [...fake.users.values()][0].id;
ok(fake.files.has(`${uid}/${seed.s1}`) && fake.files.get(`${uid}/${seed.s2}`).type === 'audio/mpeg', 'Sync now after the new media.sql: the sounds go up, the note goes away');
const ab = await A.evaluate(async id => (await (await import('./js/db.js')).getMedia(id)), seed.s1);
ok(ab.uploaded === true && !('blocked' in ab), 'Sync: the sound is marked uploaded and not blocked any more');
// a second device downloads them
await B.goto(APP + '#/settings'); await B.waitForSelector('#syncBox > *');
await B.fill('#syncEmail', 'me@example.com'); await B.fill('#syncPw', 'secret123'); await B.click('#syncForm button[type=submit]');
await B.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
await B.waitForFunction(async ([a, b]) => { const db = await import('./js/db.js'); return !!(await db.getMedia(a)) && !!(await db.getMedia(b)); }, [seed.s1, seed.s2], { timeout: 15000 });
const got = await B.evaluate(async ([a, b, p]) => { const db = await import('./js/db.js'); const [x, y, z] = await Promise.all([a, b, p].map(id => db.getMedia(id))); return [x.type, x.data.byteLength, y.type, y.data.byteLength, z.type]; }, [seed.s1, seed.s2, seed.pic]);
ok(got.join() === 'audio/wav,1500,audio/mpeg,2500,image/png', `Sync: the other device downloads the sounds (and the picture): ${got}`);
await B.goto(APP + '#/review/sy'); await B.waitForSelector('#flash');
ok((await B.locator('.rv-front .snd-btn').count()) === 1, 'Sync: and the other device plays them from Review');

// ---------- 10. wide screen, light ----------
const wide = await device('wide', { width: 1440, height: 900, colorScheme: 'light' });
await wide.evaluate(async () => {
  const db = await import('./js/db.js'), media = await import('./js/media.js');
  const snd = async n => (await media.saveSound({ name: 'a.wav', type: 'audio/wav', data: new Uint8Array(n).fill(1).buffer })).id;
  await db.addDeckWithCards({ id: 'listen', name: 'Listen', color: '#46A758', created: Date.now() }, [
    { id: 'W1', deckId: 'listen', front: 'hear', back: 'answer', frontSounds: [await snd(1001)], backSounds: [await snd(2002), await snd(2003)], tags: [], created: 1 }]);
});
await wide.evaluate(async () => { const th = (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: 'light' }); await (await import('./js/db.js')).setSetting('theme', th); });
await wide.goto(APP + '#/review/listen'); await wide.waitForSelector('#flash'); await wide.waitForTimeout(500);
await wide.screenshot({ path: SP + '/snd-review-front-1440-light.png' });
await wide.click('#showBtn'); await wide.waitForTimeout(500);
await wide.waitForSelector('.rv-back .flash-back .snd-btn');
await wide.screenshot({ path: SP + '/snd-review-1440-light.png' });
ok(await wide.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 1440');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 375');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
