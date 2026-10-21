import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecordingType, recordingName, shouldStop, recStopBytes, tooShort, fmtClock, recordSupport, isIOS, micErrorMessage, recFailMessage, levelFrom, REC_TYPES } from '../js/recorder-logic.js';
import { soundType, sniffAudioType } from '../js/audio-type.js';

const ALLOWED = ['audio/mp4', 'audio/webm', 'audio/ogg'];      // the recording types the server's bucket takes (ALLOWED_SOUND_TYPES in db.js)
const only = (...list) => t => list.includes(t);

test('pickRecordingType: AAC first, then webm opus, plain webm, plain mp4, ogg', () => {
  assert.equal(pickRecordingType(only('audio/mp4;codecs=mp4a.40.2', 'audio/mp4')), 'audio/mp4;codecs=mp4a.40.2');         // Safari
  assert.equal(pickRecordingType(only('audio/mp4')), 'audio/mp4');                                                        // Safari that rejects the codecs string
  assert.equal(pickRecordingType(only('audio/webm;codecs=opus', 'audio/webm')), 'audio/webm;codecs=opus');                // Chrome on Linux
  assert.equal(pickRecordingType(only('audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm')), 'audio/mp4;codecs=mp4a.40.2');   // Chrome with AAC
  assert.equal(pickRecordingType(only('audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus')), 'audio/webm;codecs=opus');            // Firefox
  assert.equal(pickRecordingType(only('audio/ogg;codecs=opus')), 'audio/ogg;codecs=opus');
  assert.equal(pickRecordingType(() => false), '');
  assert.equal(pickRecordingType(() => { throw new Error('no'); }), '');
});
test('every type we pick is one the app keeps', () => {
  for (const t of REC_TYPES) assert.ok(ALLOWED.includes(soundType(t)), t);
});
test('recordingName: the ending follows the type, the date is padded', () => {
  const d = new Date(2026, 0, 5, 9, 3);
  assert.equal(recordingName('audio/webm;codecs=opus', d), 'recording-2026-01-05-0903.webm');
  assert.equal(recordingName('audio/mp4;codecs=mp4a.40.2', d), 'recording-2026-01-05-0903.m4a');
  assert.equal(recordingName('audio/ogg', d), 'recording-2026-01-05-0903.ogg');
  assert.match(recordingName('', d), /\.webm$/);
});
test('shouldStop and tooShort', () => {
  const maxBytes = 1048576;
  assert.equal(shouldStop({ elapsedMs: 59999, bytes: 10, maxBytes }), null);
  assert.equal(shouldStop({ elapsedMs: 60000, bytes: 10, maxBytes }), 'time');
  assert.equal(shouldStop({ elapsedMs: 5000, bytes: recStopBytes(maxBytes), maxBytes }), 'size');
  assert.equal(shouldStop({ elapsedMs: 5000, bytes: recStopBytes(maxBytes) - 1, maxBytes }), null);
  assert.equal(recStopBytes(1000), 940);
  assert.ok(tooShort(499, 100));
  assert.ok(tooShort(2000, 0));
  assert.ok(!tooShort(500, 1));
});
test('shouldStop: a take with no data chunk after 3 s is capped at 40 s (Safari)', () => {
  const maxBytes = 1048576;
  assert.equal(shouldStop({ elapsedMs: 39999, bytes: 0, maxBytes, chunks: 0 }), null);
  assert.equal(shouldStop({ elapsedMs: 40000, bytes: 0, maxBytes, chunks: 0 }), 'cap');
  assert.equal(shouldStop({ elapsedMs: 40000, bytes: 10, maxBytes, chunks: 3 }), null);
  assert.equal(shouldStop({ elapsedMs: 40000, bytes: 10, maxBytes }), null);
  assert.equal(shouldStop({ elapsedMs: 60000, bytes: 0, maxBytes, chunks: 0 }), 'time');
});
test('fmtClock', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(7400), '0:07');
  assert.equal(fmtClock(59999), '0:59');
  assert.equal(fmtClock(60000), '1:00');
});
test('recordSupport', () => {
  const md = {}, rec = function () {};
  assert.equal(recordSupport({ secure: true, mediaDevices: md, recorder: rec }), 'ok');
  assert.equal(recordSupport({ secure: false, mediaDevices: md, recorder: rec }), 'insecure');
  assert.equal(recordSupport({ secure: true, mediaDevices: md, recorder: undefined }), 'unsupported');
  assert.equal(recordSupport({ secure: true, mediaDevices: undefined, recorder: rec }), 'unsupported');
  assert.equal(recordSupport({ secure: false, mediaDevices: undefined, recorder: rec }), 'insecure');      // (no mediaDevices on a page that isn't https)
  assert.equal(recordSupport({ secure: false, mediaDevices: md, recorder: undefined }), 'unsupported');
});
test('isIOS', () => {
  assert.ok(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'iPhone', 5));
  assert.ok(isIOS('Mozilla/5.0 (Macintosh)', 'MacIntel', 5));
  assert.ok(!isIOS('Mozilla/5.0 (Macintosh)', 'MacIntel', 0));
  assert.ok(!isIOS('Mozilla/5.0 (X11; Linux)', 'Linux x86_64', 0));
});
test('micErrorMessage: every error name', () => {
  for (const name of ['NotAllowedError', 'SecurityError']) assert.match(micErrorMessage({ name }), /^Microphone access is blocked\./);
  for (const name of ['NotFoundError', 'OverconstrainedError']) assert.match(micErrorMessage({ name }), /^No microphone found\./);
  for (const name of ['NotReadableError', 'AbortError']) assert.match(micErrorMessage({ name }), /being used by another app/);
  assert.equal(micErrorMessage({ name: 'Weird' }), "Couldn't start recording. Try again.");
  assert.equal(micErrorMessage(null), "Couldn't start recording. Try again.");
  assert.match(micErrorMessage({ name: 'NotAllowedError' }, { ios: true, standalone: true }), /turned down.*Settings › Apps › Safari › Microphone/);
  assert.match(micErrorMessage({ name: 'NotAllowedError' }, { ios: true, standalone: false }), /^Microphone access is blocked\./);
});
test('recFailMessage', () => {
  assert.match(recFailMessage({ code: 'too_big' }), /over 1 MB/);
  assert.match(recFailMessage(new Error("That isn't a sound file the app can keep (use .mp3).")), /format the app can't keep/);
  assert.equal(recFailMessage(new Error('disk full')), 'disk full');
});
test('levelFrom: silence is 0, a loud sine is clamped to 1', () => {
  assert.equal(levelFrom(new Float32Array(512)), 0);
  assert.equal(levelFrom(new Float32Array(0)), 0);
  const sine = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 5));
  assert.equal(levelFrom(sine), 1);
  const quiet = Float32Array.from({ length: 512 }, (_, i) => 0.01 * Math.sin(i / 5));
  assert.ok(levelFrom(quiet) > 0 && levelFrom(quiet) < 1);
});
test('the save path recognises what a recorder writes', () => {
  assert.equal(sniffAudioType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])), 'audio/webm');
  assert.equal(sniffAudioType(Uint8Array.from([0, 0, 0, 28, ...'ftypmp42'].map(c => (typeof c === 'string' ? c.charCodeAt(0) : c)).concat([0, 0, 0, 0]))), 'audio/mp4');
  assert.equal(sniffAudioType(Uint8Array.from([...'OggS'].map(c => c.charCodeAt(0)).concat([0, 2, 0, 0]))), 'audio/ogg');
});
