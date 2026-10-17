// Tests for js/audio-type.js (which kind of sound a file is). Run with: node tests/audio-type.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundType, sniffAudioType, soundExt, storedType } from '../js/audio-type.js';
import { soundNames, notesToImport } from '../js/anki.js';

const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [p])));

test('the first bytes say what a sound is', () => {
  assert.equal(sniffAudioType(bytes('ID3', 4, 0, 0)), 'audio/mpeg');
  assert.equal(sniffAudioType(bytes(0xff, 0xfb, 0x90, 0)), 'audio/mpeg');                    // an MP3 frame
  assert.equal(sniffAudioType(bytes(0xff, 0xf1, 0x50, 0x80)), 'audio/aac');                  // an AAC (ADTS) frame
  assert.equal(sniffAudioType(bytes('RIFF', 1, 2, 3, 4, 'WAVE')), 'audio/wav');
  assert.equal(sniffAudioType(bytes('OggS', 0, 2)), 'audio/ogg');
  assert.equal(sniffAudioType(bytes('fLaC', 0, 0)), 'audio/flac');
  assert.equal(sniffAudioType(bytes(0, 0, 0, 0x20, 'ftypM4A ')), 'audio/mp4');
  assert.equal(sniffAudioType(bytes(0x1a, 0x45, 0xdf, 0xa3, 1)), 'audio/webm');
  assert.equal(sniffAudioType(bytes('hello world')), null);
  assert.equal(sniffAudioType(new ArrayBuffer(2)), null);
  assert.equal(sniffAudioType(bytes('RIFF', 1, 2, 3, 4, 'AVI ')), null);                    // RIFF, but not a wav
});

test('declared types and endings: aliases are folded, parameters dropped, odd types refused', () => {
  assert.equal(soundType('audio/x-wav', 'a.bin'), 'audio/wav');
  assert.equal(soundType('audio/MPEG; charset=binary'), 'audio/mpeg');
  assert.equal(soundType('', 'Clip.M4A'), 'audio/mp4');
  assert.equal(soundType('application/octet-stream', 'x.opus'), 'audio/ogg');
  assert.equal(soundType('audio/x-ms-wma', 'x.wma'), null);
  assert.equal(soundExt('audio/mp4'), 'm4a');
});

test('a downloaded file keeps a tidy type: sniffed when the server was vague, pictures stay pictures', () => {
  assert.equal(storedType('audio/mpeg; charset=utf-8', bytes(1, 2, 3, 4)), 'audio/mpeg');
  assert.equal(storedType('application/octet-stream', bytes('OggS', 0, 0)), 'audio/ogg');
  assert.equal(storedType('image/png', bytes(1, 2, 3, 4)), 'image/png');
  assert.equal(storedType('', bytes(1, 2, 3, 4)), 'image/jpeg');                             // as before for an unknown picture
});

test('a sound name is tried as written before it is URL-decoded', () => {
  assert.deepEqual(soundNames('[sound:100%25.mp3]', { raw: true }), ['100%25.mp3']);
  assert.deepEqual(soundNames('[sound:100%25.mp3]'), ['100%.mp3']);
  const models = new Map([['b', { name: 'Basic', fields: ['Front', 'Back'], cloze: false }]]);
  const note = { id: '1', mid: 'b', fields: ['x [sound:a%20b.mp3] [sound:c%25d.mp3]', 'y'], tags: [], deck: '' };
  const media = files => ({ info: name => (files.includes(name) ? { size: 9, type: 'audio/mpeg' } : null) });
  assert.deepEqual(notesToImport([note], models, new Map(), media(['a b.mp3', 'c%25d.mp3'])).sounds[0].front, ['a b.mp3', 'c%25d.mp3']);     // the second really is called that
  assert.deepEqual(notesToImport([note], models, new Map(), media(['a b.mp3', 'c%d.mp3'])).sounds[0].front, ['a b.mp3', 'c%d.mp3']);
});
