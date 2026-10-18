// "Install the app": the card on Today, and the Install row in Settings.
//
// - Android and desktop Chrome/Edge send a `beforeinstallprompt` event when the app can be installed. We keep it
//   (and stop the browser's own mini bar) so the install can start from our own button.
// - iPhone and iPad Safari have no such event: all we can do is show the steps (Share, then Add to Home Screen).
// - The card waits for value: it only shows once a Review session has been finished on this device, never on
//   the first paint. "Not now", the × and "Got it" hide it for good on this device.
// - Nothing shows when the app is already installed (it is running as an app: display-mode standalone).
// The two flags live in localStorage (this device only; they are not synced). Without storage the card just
// stays hidden.

import { icon } from './ui.js';

const READY = 'study-sprint-install-ready';          // a Review session has been finished on this device
const DISMISSED = 'study-sprint-install-dismissed';  // the card was closed

const get = k => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const set = k => { try { localStorage.setItem(k, '1'); } catch { /* fine without */ } };

let deferred = null;      // the browser's install prompt, kept until used

// Running as an installed app? (Chrome and others: display-mode; Safari on iPhone: navigator.standalone)
export const isInstalled = () => {
  try { return !!(matchMedia('(display-mode: standalone)').matches || navigator.standalone === true); } catch { return false; }
};
const ua = () => navigator.userAgent || '';
export const isIOS = () => /iPhone|iPad|iPod/.test(ua()) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Only Safari can add to the Home Screen (Chrome and Firefox on iPhone cannot).
const isIOSSafari = () => isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua());

// 'installed', 'prompt' (a one-tap install is ready), 'ios' (show the steps) or 'none' (this browser offers nothing).
export function installMode() {
  if (isInstalled()) return 'installed';
  if (deferred) return 'prompt';
  return isIOSSafari() ? 'ios' : 'none';
}

const changed = () => window.dispatchEvent(new Event('install-change'));

// Call once at start-up.
export function initInstall() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; changed(); });
  window.addEventListener('appinstalled', () => { deferred = null; set(DISMISSED); changed(); });
}

// A Review session was finished: from now on the card may show.
export function noteSession() { if (!get(READY)) set(READY); }

export const shouldShowCard = () => get(READY) && !get(DISMISSED) && ['prompt', 'ios'].includes(installMode());
export const dismissCard = () => { set(DISMISSED); changed(); };

// Start the browser's install. Resolves to 'accepted', 'dismissed' or 'unavailable'.
export async function install() {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null;                 // an install prompt works once
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome;
  } catch { return 'unavailable'; }
  finally { changed(); }
}

const STEPS = `Tap <span class="inst-share">${icon('share')}</span> Share, then <b>Add to Home Screen</b>.`;

// The card on Today. `slot` is the element it goes into; it empties itself when it is not needed.
export function drawCard(slot) {
  if (!slot?.isConnected) return;
  const mode = shouldShowCard() ? installMode() : '';
  if (!mode) { slot.innerHTML = ''; return; }
  const ios = mode === 'ios';
  slot.innerHTML = `<section class="inst" aria-label="Install the app">
    <img class="inst-icon" src="icons/icon-192.png" alt="" width="48" height="48">
    <div class="inst-txt"><b>${ios ? 'Add to Home Screen' : 'Install Study Sprint'}</b>
      <p>${ios ? `${STEPS} It opens in one tap and works offline.` : 'One tap to open, works offline, no app store.'}</p>
      <div class="inst-btns">${ios
        ? '<button class="btn ghost small" type="button" data-inst="no">Got it</button>'
        : `<button class="btn primary small" type="button" data-inst="go">${icon('download')} Install</button><button class="btn ghost small" type="button" data-inst="no">Not now</button>`}</div></div>
    <button class="inst-x" type="button" data-inst="no" aria-label="Dismiss">${icon('x')}</button></section>`;
  slot.querySelectorAll('[data-inst="no"]').forEach(b => b.addEventListener('click', dismissCard));
  slot.querySelector('[data-inst="go"]')?.addEventListener('click', async () => {
    const r = await install();
    if (r !== 'unavailable') dismissCard();      // installed, or said no: either way, don't ask again
  });
}

// The Install row in Settings (always there, even after the card was closed). Returns the row's inner HTML
// and wires itself when `wire(root)` is called.
export function settingsRowHTML() {
  const mode = installMode();
  const text = mode === 'installed' ? 'You are using the installed app.'
    : mode === 'prompt' ? 'Put Study Sprint on your home screen or desktop. It opens in one tap and works offline.'
    : mode === 'ios' ? `${STEPS} It opens in one tap and works offline.`
    : 'Open your browser’s menu and choose Install app or Add to Home Screen. Some browsers don’t offer this.';
  return `<div><b>Install app</b><p id="installText">${text}</p></div>
    ${mode === 'prompt' ? `<button class="btn ghost small" type="button" id="installBtn">${icon('download')} Install</button>` : ''}`;
}
export function wireSettingsRow(row) {
  row.querySelector('#installBtn')?.addEventListener('click', async () => { await install(); row.innerHTML = settingsRowHTML(); wireSettingsRow(row); });
}

// Has a Review session been finished on this device? (The reminder prompt on Today waits for the same moment: reminders.js.)
export const sessionFinished = () => get(READY);
