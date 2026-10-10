// Tests for js/speech.js (reading cards aloud). Run with: node tests/speech.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, speakableText } from '../js/speech.js';

test('language from the writing system', () => {
  assert.equal(detectLang('ねこ'), 'ja-JP');
  assert.equal(detectLang('日本語を勉強する'), 'ja-JP');        // kanji with kana: Japanese
  assert.equal(detectLang('学习'), 'zh-CN');                    // Chinese characters only
  assert.equal(detectLang('안녕하세요'), 'ko-KR');
  assert.equal(detectLang('привет'), 'ru-RU');
  assert.equal(detectLang('Mitochondria'), 'en-US');
  assert.equal(detectLang('Bonjour', 'fr-FR'), 'fr-FR');        // Latin script: the device's language
});

test('what gets read out', () => {
  assert.equal(speakableText('The **cell** has:\n- a *nucleus*\n- ribosomes'), 'The cell has: a nucleus ribosomes');
});
