// Tests for js/share-deck.js (the share-or-save decision and the wording). Run with: node tests/share-deck.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canShareFile, deliver, shareText, SAVED_NOTE, APKG_TYPE, MAX_SHARE_BYTES, sharedKind } from '../js/share-logic.js';

const file = new File(['x'], 'Bio.apkg', { type: APKG_TYPE });
const data = { title: 'Bio', text: 't' };
const fail = name => Object.assign(new Error(name), { name });

test('canShareFile needs share() and canShare() to say yes for files', () => {
  assert.equal(canShareFile({ share() {}, canShare: () => true }, file), true);
  assert.equal(canShareFile({ share() {}, canShare: () => false }, file), false);
  assert.equal(canShareFile({ share() {} }, file), false);
  assert.equal(canShareFile({ canShare: () => true }, file), false);
  assert.equal(canShareFile(undefined, file), false);
  assert.equal(canShareFile({ share() {}, canShare() { throw new Error('x'); } }, file), false);
});

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const mk = (o = {}) => ({ userAgent: SAFARI, canShare: () => true, share: async () => {}, userActivation: { isActive: true }, ...o });

test('deliver: shares the file with a title (and text, except on iOS)', async () => {
  let got, saved = 0;
  assert.equal(await deliver(mk({ userAgent: CHROME, share: async d => { got = d; } }), new File(['x'], 'a.csv', { type: 'text/csv' }), data, () => saved++), 'shared');
  assert.deepEqual(Object.keys(got), ['files', 'title', 'text']);
  await deliver(mk({ share: async d => { got = d; } }), file, data, () => saved++);
  assert.deepEqual(Object.keys(got), ['files', 'title']);
  assert.equal(saved, 0);
});

test('deliver: saves the file where files cannot be shared, and over 50 MB', async () => {
  let saved = null;
  assert.equal(await deliver(mk({ canShare: () => false }), file, data, f => { saved = f; }), 'saved');
  assert.equal(saved, file);
  assert.equal(await deliver({}, file, data, () => {}), 'saved');
  const big = { name: 'Big.apkg', size: MAX_SHARE_BYTES + 1 };
  let calls = 0;
  assert.equal(await deliver(mk({ share: async () => { calls++; }, canShare: () => true }), big, data, () => {}), 'saved');
  assert.equal(calls, 0);
});

test('deliver: Chromium cannot share an .apkg, so it is saved without asking', async () => {
  let calls = 0, saved = 0;
  const nav = mk({ userAgent: CHROME, share: async () => { calls++; } });
  assert.equal(await deliver(nav, file, data, () => saved++), 'saved');
  assert.equal(calls, 0);
  // without userActivation the call is made (and a refusal is handled below)
  delete nav.userActivation;
  assert.equal(await deliver(nav, file, data, () => saved++), 'shared');
});

test('deliver: no fresh tap is asked for without calling share()', async () => {
  let calls = 0, saved = 0;
  const nav = mk({ userActivation: { isActive: false }, share: async () => { calls++; } });
  assert.equal(await deliver(nav, file, data, () => saved++), 'needs-tap');
  assert.equal(calls, 0);
  assert.equal(await deliver(nav, file, data, () => saved++, { again: true }), 'saved');       // the tap was asked for and still not fresh
  assert.equal(saved, 1);
});

test('deliver: closing is quiet, a refused file is saved, a share already open is left alone', async () => {
  let saved = 0;
  const nav = name => mk({ share: async () => { throw fail(name); } });
  assert.equal(await deliver(nav('AbortError'), file, data, () => saved++), 'cancelled');
  assert.equal(await deliver(nav('InvalidStateError'), file, data, () => saved++), 'busy');
  assert.equal(saved, 0);
  assert.equal(await deliver(nav('NotAllowedError'), file, data, () => saved++), 'saved');     // a fresh tap, refused: the browser won't take it
  assert.equal(await deliver(nav('DataError'), file, data, () => saved++), 'saved');
  assert.equal(saved, 2);
  // no userActivation to ask: one tap is asked for, and a second refusal saves
  const blind = mk({ share: async () => { throw fail('NotAllowedError'); } }); delete blind.userActivation;
  assert.equal(await deliver(blind, file, data, () => saved++), 'needs-tap');
  assert.equal(await deliver(blind, file, data, () => saved++, { again: true }), 'saved');
  assert.equal(saved, 3);
});

test('sharedKind sorts what the Share target receives', () => {
  const PK = [0x50, 0x4b, 3, 4];
  assert.equal(sharedKind({ name: 'Bio.apkg', type: 'application/zip' }), 'anki');
  assert.equal(sharedKind({ name: 'a.XLSX', type: '' }), 'excel');
  assert.equal(sharedKind({ name: 'b.json', type: 'application/json' }), 'json');
  assert.equal(sharedKind({ name: 'c.csv', type: 'application/octet-stream' }), 'text');
  assert.equal(sharedKind({ name: 'notes', type: 'text/plain' }), 'text');
  assert.equal(sharedKind({ name: 'download', type: 'application/zip' }, PK), 'anki');
  assert.equal(sharedKind({ name: 'x.bin', type: 'application/octet-stream' }, [1, 2, 3, 4]), 'unknown');
  assert.equal(sharedKind({ name: 'x', type: '' }), 'unknown');
});

test('wording', () => {
  assert.match(shareText('Bio', 3), /3 cards/);
  assert.match(SAVED_NOTE, /Add cards → File/);
});
