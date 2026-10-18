// Tests for js/share-deck.js (the share-or-save decision and the wording). Run with: node tests/share-deck.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canShareFile, deliver, shareText, SAVED_NOTE, APKG_TYPE } from '../js/share-logic.js';

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

test('deliver: shares the file with a title and text', async () => {
  let got, saved = 0;
  const nav = { canShare: () => true, share: async d => { got = d; } };
  assert.equal(await deliver(nav, file, data, () => saved++), 'shared');
  assert.deepEqual(got, { files: [file], title: 'Bio', text: 't' });
  assert.equal(saved, 0);
});

test('deliver: saves the file where files cannot be shared', async () => {
  let saved = null;
  assert.equal(await deliver({ canShare: () => false, share: async () => {} }, file, data, f => { saved = f; }), 'saved');
  assert.equal(saved, file);
  assert.equal(await deliver({}, file, data, () => {}), 'saved');
});

test('deliver: cancelling is quiet, a missing tap is asked for, other failures save the file', async () => {
  let saved = 0;
  const nav = name => ({ canShare: () => true, share: async () => { throw fail(name); } });
  assert.equal(await deliver(nav('AbortError'), file, data, () => saved++), 'cancelled');
  assert.equal(await deliver(nav('NotAllowedError'), file, data, () => saved++), 'needs-tap');
  assert.equal(saved, 0);
  assert.equal(await deliver(nav('DataError'), file, data, () => saved++), 'saved');
  assert.equal(saved, 1);
});

test('wording', () => {
  assert.match(shareText('Bio', 3), /3 cards/);
  assert.match(SAVED_NOTE, /Add cards → File/);
});
