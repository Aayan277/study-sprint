// The decisions behind "Record a sound" in the card editor. Pure functions (no page, no microphone), tested by tests/recorder-logic.test.js.
//   pickRecordingType(isSupported)   the first format of REC_TYPES the browser can record, or '' (its own default)
//   recordingName(type, date)        "recording-2026-10-21-0930.webm"
//   shouldStop({elapsedMs, bytes})   'time', 'size' or null: has the take reached its limit?    recStopBytes(max): the size that counts as full
//   tooShort(ms, bytes)              nothing worth keeping    fmtClock(ms): "0:07"
//   recordSupport({...})             'ok', 'insecure' (needs https) or 'unsupported' (hide the button)
//   isIOS(ua, platform, touchPoints) micErrorMessage(err, {ios, standalone}) / recFailMessage(err): the words for a failure
//   levelFrom(samples)               how loud the last moment was, 0 to 1 (the level meter)

import { soundType, soundExt } from './audio-type.js';

export const MAX_REC_MS = 60000;          // one take is at most a minute
export const REC_BITRATE = 64000;         // speech: ~0.5 MB a minute
export const MIN_REC_MS = 500;
export const CAP_REC_MS = 40000;        // a take that arrives in one piece (no chunks: Safari) stays under 1 MB at this length

// AAC in m4a plays on every phone and in Anki, so it comes first; WebM/Opus does not play on older iPhones. Plain mp4 comes after webm
// because Chrome's may hold Opus.
export const REC_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
export function pickRecordingType(isSupported) {
  for (const t of REC_TYPES) {
    try { if (isSupported(t)) return t; } catch { /* try the next */ }
  }
  return '';
}

const two = n => String(n).padStart(2, '0');
export function recordingName(type, date = new Date()) {
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
  return `recording-${stamp}.${soundExt(soundType(type) || 'audio/webm')}`;
}

// Stop a little under the limit: some browsers ignore the bitrate asked for, and the last chunk still has to fit.
export const recStopBytes = maxBytes => Math.floor(maxBytes * 0.94);
export function shouldStop({ elapsedMs, bytes, maxMs = MAX_REC_MS, maxBytes, chunks }) {
  if (elapsedMs >= maxMs) return 'time';
  if (chunks === 0 && elapsedMs >= CAP_REC_MS) return 'cap';      // still no data after 40 s (>3 s): the browser doesn't slice
  if (maxBytes && bytes >= recStopBytes(maxBytes)) return 'size';
  return null;
}
export const tooShort = (ms, bytes) => ms < MIN_REC_MS || !bytes;

// Whole seconds, rounded down ("1:00" only at the full minute).
export const fmtClock = ms => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
};

export function recordSupport({ secure, mediaDevices, recorder }) {
  if (!recorder) return 'unsupported';
  if (secure === false) return 'insecure';
  return mediaDevices ? 'ok' : 'unsupported';
}
export const isIOS = (ua = '', platform = '', touchPoints = 0) => /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);

export const INSECURE_MESSAGE = 'Recording needs a secure connection. Open the app from its https:// address to record.';
export function micErrorMessage(err, { ios = false, standalone = false } = {}) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return ios && standalone
      ? "Microphone access was turned down. The app will ask again next time you open it. If it doesn't, go to Settings › Apps › Safari › Microphone and choose Ask or Allow."
      : "Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return "No microphone found. Connect one, or check your device's sound settings.";
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is being used by another app. Close it and try again.';
  return "Couldn't start recording. Try again.";
}
// Why a finished take could not be kept (saveSound's errors, in recording words).
export function recFailMessage(err) {
  if (err?.code === 'too_big') return "That recording is over 1 MB, so it can't be kept. Record a shorter one.";
  if (/isn't a sound file/.test(err?.message || '')) return "This browser recorded in a format the app can't keep.";
  return err?.message || "Couldn't keep that recording.";
}

// Loudness of a block of samples (-1 to 1): the root-mean-square, bent so quiet speech still moves the meter.
export function levelFrom(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6);
}
