// Tests for the "Last backup" line and nudge (js/backup-nudge.js). Run with: node tests/backup-nudge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, backupNote, NUDGE_CARDS } from '../js/backup-nudge.js';
import { isLocalOnly } from '../js/db.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 5, 1, 12);

test('agoText: today, yesterday, days, months', () => {
  assert.equal(agoText(now - 1000, now), 'today');
  assert.equal(agoText(now + DAY, now), 'today');          // a clock set back never says "in the future"
  assert.equal(agoText(now - DAY, now), 'yesterday');
  assert.equal(agoText(now - 12 * DAY, now), '12 days ago');
  assert.equal(agoText(now - 90 * DAY, now), '3 months ago');
});

test('a recent backup, or little data, gets a plain line and no nudge', () => {
  assert.deepEqual(backupNote({ lastBackup: now - 12 * DAY, cards: 500, synced: false, now }), { text: 'Last backup: 12 days ago.', nudge: false });
  assert.deepEqual(backupNote({ lastBackup: now - 30 * DAY, cards: 500, synced: false, now }), { text: 'Last backup: 30 days ago.', nudge: false });
  const few = backupNote({ lastBackup: null, cards: NUDGE_CARDS - 1, synced: false, now });
  assert.deepEqual(few, { text: 'No backup yet on this device.', nudge: false });
});

test('over 30 days (or never) with 50+ cards nudges, softer when signed in', () => {
  const old = backupNote({ lastBackup: now - 31 * DAY, cards: NUDGE_CARDS, synced: false, now });
  assert.equal(old.nudge, true);
  assert.match(old.text, /^Last backup: 31 days ago\. .*only live on this device/);
  const never = backupNote({ lastBackup: undefined, cards: 200, synced: false, now });
  assert.equal(never.nudge, true);
  assert.match(never.text, /^No backup yet on this device\./);
  const synced = backupNote({ lastBackup: null, cards: 200, synced: true, now });
  assert.equal(synced.nudge, true);
  assert.match(synced.text, /also in your sync account/);
  assert.doesNotMatch(synced.text, /only live/);
});

test('lastBackup stays on this device: not synced, not in backups', () => {
  assert.equal(isLocalOnly('lastBackup'), true);
});
