// The service worker keeps old app files until CACHE changes, so a release that changes any app file
// without a CACHE bump would mix old and new modules on phones. Run with: node tests/sw.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash, savedHash } from './sw-hash.mjs';

test('app files changed only together with a CACHE bump', () => {
  assert.equal(savedHash(), computeHash(),
    'App files changed: bump CACHE in sw.js and update the hash with `node tests/update-sw-hash.mjs`');
});
