// Pins down today's behaviour for nested blanks (not supported). Change it only on purpose. Run with: node tests/cloze-nested.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clozeBlanks } from '../js/cloze.js';

test('nested blank: the outer blank ends at the first "}}", the inner "::" splits a hint, and no inner blank is found', () => {
  assert.deepEqual(clozeBlanks('{{c1::a {{c2::b}} c}}'), [
    { index: 0, end: 17, num: '1', text: 'a {{c2', hint: 'b' },
  ]);
});
