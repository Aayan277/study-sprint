// The streamed backup file (db.exportAllBlob, what Settings → Export backup saves) must be the same text as
// JSON.stringify(await db.exportAll()) (apart from the time in "exported"), also across several 5,000-row pieces,
// with and without sounds, and must restore through importAll.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const r = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const bytes = n => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251)).buffer;
  const cards = Array.from({ length: 5003 }, (_, i) => ({ id: 'x' + i, deckId: 'big', front: 'Q' + i + ' é"\\', back: 'A' + i, tags: ['t'], created: i, ...(i === 7 ? { frontSounds: ['snd1'] } : {}) }));
  await db.addImport({ decks: [{ id: 'big', name: 'Big', color: '#46A758', created: 1 }], cards,
    reviewLog: Array.from({ length: 10001 }, (_, i) => ({ uid: 'u', cardId: 'x' + (i % 5003), timestamp: 1e12 + i, source: 'review', rating: 3 })) });
  await db.putMedia({ id: 'pic1', type: 'image/png', data: bytes(100), name: 'a.png' });
  await db.putMedia({ id: 'snd1', type: 'audio/mpeg', data: bytes(3000) });
  const out = {};
  for (const sounds of [true, false]) {
    const { blob, cards: nc, reviews } = await db.exportAllBlob({ sounds });
    const text = await blob.text();
    const ref = await db.exportAll({ sounds });
    const got = JSON.parse(text);
    const same = { ...got, exported: 0 }, want = { ...ref, exported: 0 };
    out[sounds] = { sameJson: JSON.stringify(same) === JSON.stringify(want), keys: Object.keys(got).join(), version: got.version, nc, reviews, nCards: ref.cards.length, nLog: ref.reviewLog.length, media: got.media.map(m => m.id).join(),
      // the text itself: the reference file with the same time
      sameText: text === JSON.stringify({ ...ref, exported: got.exported }) };
  }
  // restore the new file
  const { blob } = await db.exportAllBlob({ sounds: true });
  const data = JSON.parse(await blob.text());
  const problem = db.checkBackup(data);
  await db.importAll(data);
  out.restore = { problem, cards: (await db.getAll('cards')).length, log: (await db.getAll('reviewLog')).length };
  return out;
});
ok(r.true.sameText && r.false.sameText, 'file text equals JSON.stringify(exportAll()) with and without sounds');
ok(r.true.sameJson && r.false.sameJson, 'same data');
ok(r.true.keys === 'format,version,exported,decks,cards,cardStates,reviewLog,settings,media', 'key order: ' + r.true.keys);
ok(r.true.version === 2 && r.false.version === 1, `version 2 with sounds, 1 without (${r.true.version}, ${r.false.version})`);
ok(r.true.media === 'pic1,snd1' && r.false.media === 'pic1', 'media: ' + r.true.media + ' / ' + r.false.media);
ok(r.true.nc === r.true.nCards && r.true.reviews === r.true.nLog && r.true.reviews >= 10001, `counts ${r.true.nc} cards, ${r.true.reviews} reviews`);
ok(r.restore.problem === null && r.restore.cards >= 5003 && r.restore.log >= 10001, 'new file passes checkBackup and restores: ' + JSON.stringify(r.restore));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
