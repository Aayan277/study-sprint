// "What's new" (js/whats-new.js): which notes a device sees, and that every release has an entry.
// Run with: node --test tests/whats-new.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareVersions, parseVersion } from '../js/app-config.js';
// (the screens' files look at the page when they load; give them a stand-in so they can load in Node)
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
const { NOTES, MAX_ITEMS, notesToShow, recentNotes } = await import('../js/whats-new.js');
const db = await import('../js/db.js');

const notes = [
  { version: '4.38', items: ['d', 'e'] },
  { version: '4.37', items: ['c'] },
  { version: '4.36', items: [] },
  { version: '4.35', items: ['a', 'b'] }
];
const show = (seen, version) => notesToShow({ seen, version, notes });

test('already seen: nothing, whatever the notes say', () => {
  assert.equal(show('4.38', '4.38'), null);
  assert.equal(show('4.40', '4.38'), null);            // a downgrade shows nothing
});
test('never recorded: only this version\'s own notes', () => {
  assert.deepEqual(show(null, '4.38'), { version: '4.38', items: ['d', 'e'] });
  assert.deepEqual(show(undefined, '4.37'), { version: '4.37', items: ['c'] });
  assert.equal(show(null, '4.36'), null);               // an entry with no items
  assert.equal(show(null, '4.39'), null);               // no entry for this version
});
test('an older version seen: the notes since then, newest first, capped', () => {
  assert.deepEqual(show('4.36', '4.38'), { version: '4.38', items: ['d', 'e', 'c'] });
  assert.deepEqual(show('4.34', '4.38').items, ['d', 'e', 'c', 'a', 'b']);
  const many = [{ version: '2.0', items: ['1', '2', '3', '4'] }, { version: '1.9', items: ['5', '6', '7'] }];
  assert.equal(notesToShow({ seen: '1.0', version: '2.0', notes: many }).items.length, MAX_ITEMS);
  assert.equal(show('4.37', '4.38').items.length, 2);
});
test('notes newer than the running version are not shown early', () => {
  assert.deepEqual(show('4.35', '4.37'), { version: '4.37', items: ['c'] });
});
test('junk is nothing', () => {
  for (const bad of ['', 'abc', '4.x', null, undefined, 5.5 && {}]) assert.equal(show('4.0', bad), null, String(bad));
  assert.deepEqual(show('junk', '4.37'), { version: '4.37', items: ['c'] });       // a junk "seen" counts as never recorded
  assert.equal(notesToShow({ seen: '4.0', version: '4.38', notes: [{ version: 'x', items: ['z'] }] }), null);
});

test('NOTES hygiene: newest first, valid and unique versions, short plain lines, and one for every release', () => {
  const seen = new Set();
  NOTES.forEach((n, i) => {
    assert.ok(parseVersion(n.version), n.version);
    assert.ok(!seen.has(n.version), 'duplicate ' + n.version); seen.add(n.version);
    if (i) assert.equal(compareVersions(NOTES[i - 1].version, n.version), 1, `${n.version} is older than the entry above`);
    assert.ok(n.items.length <= 3, n.version + ' has at most 3 items');
    for (const t of n.items) assert.ok(t.length >= 1 && t.length <= 160 && !t.includes('<'), t);
  });
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').match(/const APP_VERSION = '([^']+)'/)[1];
  assert.ok(compareVersions(NOTES[0].version, app) >= 0, `add a NOTES entry for ${app} in js/whats-new.js (items: [] if there is nothing to announce)`);
});
test('the recent list skips empty entries', () => {
  assert.equal(recentNotes(3, notes).length, 3);
  assert.ok(recentNotes(3, notes).every(n => n.items.length));
});

test('whatsNewSeen and pendingSignup stay on the device: not synced, not restored from a backup', () => {
  for (const k of ['whatsNewSeen', 'pendingSignup']) {
    assert.ok(db.LOCAL_ONLY.includes(k), k);
    assert.ok(!db.restoredSettings({ [k]: '1.0' }).hasOwnProperty(k), k + ' is dropped by a restore');
  }
  assert.equal(db.DEFAULT_SETTINGS.whatsNewSeen, null);
});
