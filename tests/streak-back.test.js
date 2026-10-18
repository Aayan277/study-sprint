// The streak that asks the database which days had answers (lazyStreakBack) must be exactly the one that re-reads the log in
// growing windows (lazyStreak), in several time zones (some with daylight saving, one with a half-hour shift, one a quarter-hour off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./streak-back.child.mjs', import.meta.url));
for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Auckland', 'America/St_Johns', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/Sao_Paulo']) {
  test(`lazyStreakBack matches lazyStreak on random histories (${tz})`, () => {
    const r = spawnSync(process.execPath, [child], { env: { ...process.env, TZ: tz, SEED: String(tz.length * 7919) }, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    assert.match(r.stdout, /ok tz=\S+ cases=300/);
  });
}
