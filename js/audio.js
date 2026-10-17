// Playing the sounds on cards (card.frontSounds / card.backSounds: ids of sounds in the media store, see media.js).
//
//   soundsHTML(ids)        a row of ▶ buttons for a side's sounds (draw it under the side's text)
//   playSounds(ids, opts)  play sounds one after another; returns true when they played, false when stopped or blocked
//   stopSound()            stop whatever is playing (the next card, Undo, leaving Review, or read-aloud starting)
//   hasSounds(card, side)  does that side ('front' or 'back') have sounds?
//   soundURL(id)           a blob: address for a sound, downloading it first if this device lacks it (null if not available)
//   autoplayBlocked(root)  the browser refused to play by itself: pulse the first ▶ and say "Tap ▶ to play"
//
// One shared <audio> element plays everything. iOS only lets a page start a sound inside a tap, and then lets that element play
// later without one. So the element is "unlocked" with a silent clip inside the first tap (pointer, touch, click or key: whichever
// comes first, kept listening until a play() really worked), and a ▶ tap unlocks it first if need be, then plays straight away
// when the sound's address is ready (the ▶ buttons get theirs as soon as they appear).
// The ▶ buttons work wherever they are on the page (Review, Play, the card editor, the card panel): one listener handles them all.

import * as db from './db.js';
import { stopSpeaking } from './speech.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const hasSounds = (card, side) => Array.isArray(card?.[side + 'Sounds']) && card[side + 'Sounds'].length > 0;

// ---------- the buttons ----------
export function soundsHTML(ids) {
  if (!Array.isArray(ids) || !ids.length) return '';
  return `<div class="snd-row" data-sounds="${esc(ids.join(','))}">${ids.map((id, i) =>
    `<button class="snd-btn" type="button" data-snd="${esc(id)}" aria-label="${ids.length > 1 ? `Play sound ${i + 1} of ${ids.length}` : 'Play sound'}">▶︎</button>`).join('')}</div>`;
}

// ---------- the player ----------
let el = null;
const player = () => el || (el = Object.assign(new Audio(), { preload: 'auto' }));
export const canPlayType = type => { try { return !!player().canPlayType(type); } catch { return false; } };

// Addresses of sounds, most recently used last. Only so many are kept: the oldest is let go (never the one playing).
const MAX_URLS = 30;
const urls = new Map();          // id → { url, type }
let current = null;              // the id playing now
function remember(id, m) {
  const old = urls.get(id);
  if (old) { urls.delete(id); urls.set(id, old); return old.url; }
  const url = URL.createObjectURL(new Blob([m.data], { type: m.type }));
  urls.set(id, { url, type: m.type });
  for (const [k, v] of urls) {
    if (urls.size <= MAX_URLS) break;
    if (k === current || k === id) continue;
    URL.revokeObjectURL(v.url); urls.delete(k);
  }
  return url;
}
const cached = id => { const hit = urls.get(id); if (hit) { urls.delete(id); urls.set(id, hit); } return hit?.url || null; };
export async function soundURL(id, { download = true } = {}) {
  const hit = cached(id);
  if (hit) return hit;
  let m = await db.getMedia(id);
  if (!m && download) {
    // Not on this device yet (added on another device): download it from the account, if signed in.
    try { m = await (await import('./sync.js')).downloadMedia(id); } catch { m = null; }
  }
  return m ? remember(id, m) : null;
}

let run = 0;                     // changes each time something new starts or everything stops
let finishCurrent = null;        // ends the sound that is playing now (so a stop doesn't leave a promise hanging)
let unlocked = null;             // the silent clip's promise, while it is playing
let isUnlocked = false;

function setPlaying(id) {
  current = id;
  document.querySelectorAll('.snd-btn.playing').forEach(b => b.classList.remove('playing'));
  if (id) document.querySelectorAll(`.snd-btn[data-snd="${CSS.escape(id)}"]`).forEach(b => b.classList.add('playing'));
}

export function stopSound() {
  run++;
  if (el) { try { el.pause(); } catch { /* fine */ } }
  finishCurrent?.();
  finishCurrent = null;
  setPlaying(null);
}

function playOne(url, id, mine) {
  return new Promise((resolve, reject) => {
    const a = player();
    let done = false;
    const end = () => { if (done) return; done = true; a.onended = a.onerror = null; if (finishCurrent === end) finishCurrent = null; resolve(); };
    finishCurrent = end;
    a.onended = end;
    a.onerror = () => { if (a.getAttribute('src') !== url) return; markBroken(id); end(); };      // (an error about an earlier src, like the silent clip, is not this sound's)
    a.muted = false;
    a.src = url;
    setPlaying(id);
    const p = a.play();
    if (p && p.catch) p.catch(err => {
      if (done || mine !== run) return;                      // we moved on: not a real failure
      done = true; a.onended = a.onerror = null; if (finishCurrent === end) finishCurrent = null;
      setPlaying(null);
      reject(err);
    });
  });
}

// Play sounds in order. Resolves true when they all played, false when stopped, missing or blocked.
// The first sound starts in the same breath as the call when its address is ready, which is what iOS wants inside a tap.
//   onBlocked  called when the browser refused to start a sound without a tap
export async function playSounds(ids, { onBlocked } = {}) {
  stopSpeaking();
  stopSound();
  const mine = run;
  if (unlocked) await unlocked.catch(() => {});
  if (mine !== run) return false;
  for (const id of ids || []) {
    const url = cached(id) || await soundURL(id).catch(() => null);
    if (mine !== run) return false;
    if (!url) { markMissing(id); continue; }
    try {
      await playOne(url, id, mine);
    } catch (err) {
      if (err?.name === 'NotAllowedError') onBlocked?.();
      else markBroken(id);
      return false;
    }
    if (mine !== run) return false;
  }
  setPlaying(null);
  return true;
}

// The browser blocked auto-play: the first ▶ pulses once and a hint says what to do.
export function autoplayBlocked(root = document) {
  const row = root.querySelector?.('.snd-row');
  const btn = row?.querySelector('.snd-btn');
  if (!btn) return;
  btn.classList.remove('pulse');
  void btn.offsetWidth;                  // restart the animation
  btn.classList.add('pulse');
  if (!row.querySelector('.snd-hint')) row.insertAdjacentHTML('beforeend', '<span class="snd-hint" role="status">Tap ▶ to play</span>');
}

const buttonsOf = id => document.querySelectorAll(`.snd-btn[data-snd="${CSS.escape(id)}"]`);
function markMissing(id) {
  buttonsOf(id).forEach(b => { b.title = 'Sound not available on this device yet'; b.classList.add('missing'); b.setAttribute('aria-disabled', 'true'); });
}
function markBroken(id) {
  buttonsOf(id).forEach(b => { b.title = "This sound can't play in this browser"; b.classList.add('missing', 'broken'); b.setAttribute('aria-disabled', 'true'); });
}

// ---------- unlocking (iOS) ----------
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'];
// Call inside a tap or key press. Does nothing once unlocked, or while a sound is playing (it had to be allowed to start that one).
function unlock() {
  if (isUnlocked || unlocked || finishCurrent) return;
  const a = player();
  a.muted = false; // not muted: some browsers allow muted play without a tap, which would look like an unlock but not be one
  a.src = SILENCE;
  let started;
  try { started = Promise.resolve(a.play()); } catch (err) { started = Promise.reject(err); }
  unlocked = started.then(() => {
    isUnlocked = true;
    GESTURES.forEach(g => removeEventListener(g, unlock, true));       // only now, when play() really worked
  }).catch(() => { /* not allowed (yet): stay listening for the next tap */ }).then(() => {
    unlocked = null;
    // Only pause: taking the src away would raise an error event later, which would land on whatever sound started in the meantime.
    if (!finishCurrent) { try { a.pause(); } catch { /* fine */ } a.muted = false; }
  });
}
GESTURES.forEach(g => addEventListener(g, unlock, true));

// ---------- wiring ----------
// A tap on any ▶ plays that one sound (a second tap on the one that's playing stops it).
document.addEventListener('click', e => {
  const b = e.target.closest?.('.snd-btn');
  if (!b) return;
  e.stopPropagation();             // (a card flips on a click: not this one)
  e.preventDefault();
  if (b.classList.contains('playing')) { stopSound(); return; }
  if (b.classList.contains('broken')) return;          // a type this browser can't play: nothing to try
  b.classList.remove('missing'); b.removeAttribute('aria-disabled'); b.removeAttribute('title');
  unlock();                        // (inside the tap, in case nothing has yet)
  playSounds([b.dataset.snd], { onBlocked: () => autoplayBlocked(b.closest('.snd-row')?.parentElement || document) });
}, true);

// A ▶ whose sound this browser can't play is turned off as soon as it appears, and its sound's address is made ready, so a tap can start it at once.
async function check(btn) {
  btn.dataset.checked = '1';
  const m = await db.getMedia(btn.dataset.snd).catch(() => null);
  if (!m) return;
  if (!canPlayType(m.type)) markBroken(btn.dataset.snd);
  else if (!cached(btn.dataset.snd)) remember(btn.dataset.snd, m);
}
function checkAll(root) {
  root.querySelectorAll?.('.snd-btn:not([data-checked])').forEach(check);
  if (root.matches?.('.snd-btn:not([data-checked])')) check(root);
}
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && checkAll(n))))
  .observe(document.documentElement, { childList: true, subtree: true });

// Leaving the screen stops the sound.
addEventListener('hashchange', stopSound);
