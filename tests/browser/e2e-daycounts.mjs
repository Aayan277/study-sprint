// db.getDayCounts gives the same per-day counts as counting every log row by hand, gaps and all.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const r = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const { dayStart } = await import('./js/days.js');
  const DAY = 86400000, now = Date.now();
  const empty = await db.getDayCounts();
  const logs = [];
  for (const d of [0, 1, 2, 9, 10, 400, 1200]) for (let i = 0; i <= d % 4; i++) {
    logs.push({ cardId: 'x', timestamp: now - d * DAY - i * 1000, source: 'review', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 });
  }
  await db.putMany('reviewLog', logs);
  const expected = new Map();
  for (const l of await db.getAll('reviewLog')) expected.set(dayStart(l.timestamp), (expected.get(dayStart(l.timestamp)) || 0) + 1);
  return { empty, got: await db.getDayCounts(), want: [...expected].sort((a, b) => a[0] - b[0]) };
});
ok(r.empty.length === 0, 'no answers: no days');
ok(r.got.length >= 7 && JSON.stringify(r.got) === JSON.stringify(r.want), 'same counts as counting every row: ' + r.got.length + ' days');
await browser.close();
