// The account space limit and its messages (js/quota.js), the image size limit, the import warnings, and a check
// that the SQL files say the same numbers as the app. Run with: node tests/quota.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MB, DEFAULT_MEDIA_LIMIT, MAX_PICTURE, MAX_OCCLUSION_PICTURE, fmtSize, readUsage, level, fullMessage, warnMessage, usageLine, planUploads, pictureTooBig, importWarnings } from '../js/quota.js';

const usage = (media, limit = 180 * MB, data = 3 * MB) => ({ data, media, limit });
const file = n => ({ id: 'm' + n, data: { byteLength: n * MB } });

test('sizes are shown in plain MB and GB', () => {
  assert.equal(fmtSize(0), '0 MB');
  assert.equal(fmtSize(30 * 1024), '<0.1 MB');
  assert.equal(fmtSize(0.4 * MB), '0.4 MB');
  assert.equal(fmtSize(34.4 * MB), '34 MB');
  assert.equal(fmtSize(180 * MB), '180 MB');
  assert.equal(fmtSize(2048 * MB), '2 GB');
  assert.equal(fmtSize(undefined), '0 MB');
});

test('the default is 180 MB, five accounts fit in the free 1 GB', () => {
  assert.equal(DEFAULT_MEDIA_LIMIT, 180 * MB);
  assert.ok(5 * DEFAULT_MEDIA_LIMIT <= 1024 * MB);
});

test('my_usage() answers are read safely', () => {
  assert.deepEqual(readUsage({ data_bytes: 5, media_bytes: 6, media_limit: 7 }), { data: 5, media: 6, limit: 7 });
  assert.deepEqual(readUsage([{ data_bytes: '5', media_bytes: '6', media_limit: '7' }]), { data: 5, media: 6, limit: 7 });   // a one-row list
  assert.equal(readUsage(null), null);
  assert.equal(readUsage({ data_bytes: 5 }), null);
  assert.equal(readUsage('nope'), null);
});

test('ok below 80%, amber from 80%, full at the limit', () => {
  assert.equal(level(usage(100 * MB)), 'ok');
  assert.equal(level(usage(143 * MB)), 'ok');
  assert.equal(level(usage(144 * MB)), 'warn');
  assert.equal(level(usage(179 * MB)), 'warn');
  assert.equal(level(usage(180 * MB)), 'full');
  assert.equal(level(usage(182 * MB)), 'full');              // one file over is allowed, then it is full
  assert.equal(level(null), 'ok');
  assert.equal(level(usage(0, 0)), 'full');                  // a limit of 0 means no media at all
});

test('the account-full message', () => {
  assert.equal(fullMessage(usage(180 * MB)),
    "Your account is full: pictures and sounds use 180 MB of 180 MB. New ones are saved on this device and will sync when there's room. Remove some, or ask the account owner for more space.");
  assert.match(fullMessage(usage(182 * MB)), /use 182 MB of 180 MB/);
  assert.match(fullMessage(usage(2000 * MB, 2048 * MB)), /of 2 GB/);
});

test('the usage line under Settings → Your data', () => {
  assert.deepEqual(usageLine(usage(34 * MB, 180 * MB, 1.2 * MB)),
    { level: 'ok', text: 'In your account: data 1.2 MB · pictures and sounds 34 MB of 180 MB', detail: '' });
  const warn = usageLine(usage(150 * MB));
  assert.equal(warn.level, 'warn');
  assert.equal(warn.detail, 'Getting full. Pictures and sounds: 150 MB of 180 MB.');
  assert.equal(warnMessage(usage(150 * MB)), 'Pictures and sounds: 150 MB of 180 MB.');
  const full = usageLine(usage(180 * MB));
  assert.equal(full.level, 'full');
  assert.equal(full.detail, fullMessage(usage(180 * MB)));
  assert.equal(usageLine(null), null);
});

test('uploads go until the account is at its limit, and may go over by one file', () => {
  const pending = [file(1), file(1), file(1), file(1)];
  let plan = planUploads(pending, usage(100 * MB));
  assert.equal(plan.send.length, 4);
  assert.equal(plan.held.length, 0);
  plan = planUploads(pending, usage(178.5 * MB));       // room for 2: after the second it is 180.5, so the rest wait
  assert.deepEqual(plan.send.map(m => m.id), ['m1', 'm1']);
  assert.equal(plan.held.length, 2);
  assert.equal(level(plan.usage), 'full');
  plan = planUploads(pending, usage(180 * MB));         // already full: nothing goes
  assert.equal(plan.send.length, 0);
  assert.equal(plan.held.length, 4);
  plan = planUploads([file(5), file(1)], usage(179.9 * MB));   // one big file may take it over, then the next waits
  assert.deepEqual(plan.send.map(m => m.id), ['m5']);
  assert.deepEqual(plan.held.map(m => m.id), ['m1']);
});

test('when the server cannot say how much is used, everything is tried (the server still decides)', () => {
  const plan = planUploads([file(1), file(2)], null);
  assert.equal(plan.send.length, 2);
  assert.equal(plan.held.length, 0);
});

test('a picture still over 1.5 MB after shrinking is refused (3 MB for occlusion)', () => {
  assert.equal(MAX_PICTURE, 1.5 * MB);
  assert.equal(MAX_OCCLUSION_PICTURE, 3 * MB);
  assert.equal(pictureTooBig(250 * 1024), null);
  assert.equal(pictureTooBig(1.5 * MB), null);
  assert.match(pictureTooBig(1.6 * MB), /still 1\.6 MB after shrinking it, and the limit is 1\.5 MB/);
  assert.equal(pictureTooBig(2.5 * MB, { occlusion: true }), null);
  assert.match(pictureTooBig(3.2 * MB, { occlusion: true }), /limit is 3 MB/);
});

test('import warnings: media over 200 MB, more than 50,000 reviews', () => {
  assert.deepEqual(importWarnings({}), []);
  assert.deepEqual(importWarnings({ mediaBytes: 200 * MB, reviews: 50000 }), []);        // exactly at the limits is fine
  const media = importWarnings({ mediaBytes: 340 * MB });
  assert.equal(media.length, 1);
  assert.match(media[0], /pictures and sounds take about 340 MB/);
  const reviews = importWarnings({ reviews: 120000 });
  assert.equal(reviews.length, 1);
  assert.match(reviews[0], /120,000 reviews/);
  assert.match(reviews[0], /about 61 MB/);
  assert.equal(importWarnings({ mediaBytes: 300 * MB, reviews: 60000 }).length, 2);
});

test('the SQL files say the same numbers as the app', () => {
  const read = f => fs.readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
  const limits = read('limits.sql'), setup = read('setup.sql'), media = read('media.sql');
  assert.ok(limits.includes(String(DEFAULT_MEDIA_LIMIT)), 'limits.sql default is 180 MB');
  assert.match(limits, /media_bytes_limit bigint not null default 188743680/);
  assert.equal(3145728, MAX_OCCLUSION_PICTURE);
  assert.match(limits, /file_size_limit = 3145728/);
  assert.match(media, /3145728/);
  assert.match(limits, /octet_length\(data::text\) < 65536/);
  assert.match(limits, /create or replace function public\.my_usage\(\)/);
  assert.match(limits, /create or replace function public\.delete_my_account\(\)/);
  // setup.sql: row rules use (select auth.uid()); equal timestamps are ignored; updated_at is capped at now + 1 day
  const policies = setup.match(/create policy[^;]+;/g);
  assert.equal(policies.length, 4);
  for (const p of policies) assert.ok(!/(?<!select )auth\.uid\(\)/.test(p), 'bare auth.uid() in: ' + p);
  assert.match(setup, /new\.updated_at <= old\.updated_at/);
  assert.match(setup, /least\(new\.updated_at, \(extract\(epoch from now\(\)\) \* 1000\)::bigint \+ 86400000\)/);
});
