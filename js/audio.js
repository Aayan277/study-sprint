// Playing the sounds on cards (card.frontSounds / card.backSounds: ids of sounds in the media store, see media.js).
//
//   soundsHTML(ids)        a row of ▶ buttons for a side's sounds (draw it under the side's text)
//   playSounds(ids, opts)  play sounds one after another; returns true when they played, false when stopped or blocked
//   stopSound()            stop whatever is playing (the next card, Undo, leaving Review, or read-aloud starting)
//   hasSounds(card, side)  does that side ('front' or 'back') have sounds?
//   soundURL(id)           a blob: address for a sound, downloading it first if this device lacks it (null if not available)
//   autoplayBlocked(root)  the browser refused to play by itself: pulse the first ▶ and say "Tap ▶ to play"
//
// One shared <audio> element plays everything. iOS only lets a page play sounds after a tap, so the first tap anywhere
// "unlocks" that element with a silent clip, and later sounds (like auto-play on the next card) are allowed.
// The ▶ buttons work wherever they are on the page (Review, Play, the card editor, the card panel): one listener handles them all.

import * as db from './db.js';

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

const urls = new Map();          // id → { url, type }
export async function soundURL(id) {
  if (urls.has(id)) return urls.get(id).url;
  let m = await db.getMedia(id);
  if (!m) {
    // Not on this device yet (added on another device): download it from the account, if signed in.
    try { m = await (await import('./sync.js')).downloadMedia(id); } catch { m = null; }
  }
  if (!m) return null;
  const url = URL.createObjectURL(new Blob([m.data], { type: m.type }));
  urls.set(id, { url, type: m.type });
  return url;
}

let run = 0;                     // changes each time something new starts or everything stops
let finishCurrent = null;        // ends the sound that is playing now (so a stop doesn't leave a promise hanging)
let unlocked = null;

function setPlaying(id) {
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
    a.onerror = () => { markBroken(id); end(); };
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
//   onBlocked  called when the browser refused to start a sound without a tap
export async function playSounds(ids, { onBlocked } = {}) {
  stopSound();
  const mine = run;
  await unlocked?.catch(() => {});
  if (mine !== run) return false;
  for (const id of ids || []) {
    const url = await soundURL(id).catch(() => null);
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
  playSounds([b.dataset.snd], { onBlocked: () => autoplayBlocked(b.closest('.snd-row')?.parentElement || document) });
}, true);

// A ▶ whose sound this browser can't play is turned off as soon as it appears (we only know the type once we look the sound up).
async function check(btn) {
  btn.dataset.checked = '1';
  const m = await db.getMedia(btn.dataset.snd).catch(() => null);
  if (m && !canPlayType(m.type)) markBroken(btn.dataset.snd);
}
function checkAll(root) {
  root.querySelectorAll?.('.snd-btn:not([data-checked])').forEach(check);
  if (root.matches?.('.snd-btn:not([data-checked])')) check(root);
}
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && checkAll(n))))
  .observe(document.documentElement, { childList: true, subtree: true });

// Leaving the screen stops the sound.
addEventListener('hashchange', stopSound);

// iOS: the first tap or key press plays a silent clip, which lets the shared element play later without a tap.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
function unlock() {
  removeEventListener('pointerdown', unlock, true);
  removeEventListener('keydown', unlock, true);
  const a = player();
  a.muted = true;
  a.src = SILENCE;
  unlocked = Promise.resolve(a.play()).catch(() => {}).then(() => { a.pause(); a.muted = false; a.removeAttribute('src'); unlocked = null; });
}
addEventListener('pointerdown', unlock, true);
addEventListener('keydown', unlock, true);
