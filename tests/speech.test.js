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

test('maths is read as words', () => {
  assert.equal(speakableText('What is $x^2$?'), 'What is x squared ?');
  assert.equal(speakableText('Half is $\\frac{1}{2}$ and **bold**'), 'Half is 1 over 2 and bold');
  assert.equal(speakableText('Cost \\$5 and $5'), 'Cost $5 and $5');
});

test('a stepped card reads its intro and the steps shown so far', async () => {
  const { stepsSpeech } = await import('../js/speech.js');
  const p = { intro: 'Solve it', steps: ['subtract 3', 'divide by 2.'], final: 'x = 2' };
  assert.equal(stepsSpeech(p, 0), 'Solve it.');
  assert.equal(stepsSpeech(p, 1), 'Solve it.\nStep 1. subtract 3.');
  assert.equal(stepsSpeech(p, 2), 'Solve it.\nStep 1. subtract 3.\nStep 2. divide by 2.\nAnswer. x = 2.');
  assert.equal(stepsSpeech({ intro: '', steps: ['a', 'b'], final: null }, 2), 'Step 1. a.\nStep 2. b.');
});

test('an elements card reads its intro and the elements shown so far', async () => {
  const { elementsSpeech } = await import('../js/speech.js');
  const p = { intro: 'Negligence', steps: ['Duty', 'Breach.'], final: null };
  assert.equal(elementsSpeech(p, 0), 'Negligence.');
  assert.equal(elementsSpeech(p, 1), 'Negligence.\nElement 1. Duty.');
  assert.equal(elementsSpeech(p, 2), 'Negligence.\nElement 1. Duty.\nElement 2. Breach.');
  assert.equal(elementsSpeech({ intro: '', items: ['a', 'b'] }, 2), 'Element 1. a.\nElement 2. b.');
});
