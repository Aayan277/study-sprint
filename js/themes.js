// Themes. The colors themselves live in css/styles.css;
// this file switches between them and draws the picker in Settings.
//
// A theme is four choices:
//   ui    the style of the whole app (stored on <html data-ui="...">): 'original' (the default) or 'clinical', a plain,
//         professional look (css/clinical.css, which only acts under html[data-ui="clinical"])
//   skin  which accent color set (stored on <html data-skin="...">): violet (the default), ocean, forest, ember, rose.
//         In Clinical they are shown as Indigo, Blue, Green, Rust and Plum (the ids stay the same, so saved themes keep working)
//   mode  'auto' (the default: follows the device's light/dark setting), 'light' or 'dark'.
//         The page always gets a plain data-theme="light" or "dark" (auto is worked out here).
//   oled  true = pure black page background in dark mode (<html data-oled="on">)

import * as db from './db.js';

export const SKINS = {
  violet: { name: 'Violet', note: 'Electric purple' },
  ocean:  { name: 'Ocean',  note: 'Cyan blue' },
  forest: { name: 'Forest', note: 'Emerald green' },
  ember:  { name: 'Ember',  note: 'Warm orange' },
  rose:   { name: 'Rose',   note: 'Bright pink' }
};

// The two styles. Original is the app as it always looked; Clinical is css/clinical.css.
export const UIS = [['original', 'Original'], ['clinical', 'Clinical']];
export const cleanUi = v => (UIS.some(u => u[0] === v) ? v : 'original');
// What the accents are called in Clinical (same ids as above).
export const CLINICAL_NAMES = { violet: 'Indigo', ocean: 'Blue', forest: 'Green', ember: 'Rust', rose: 'Plum' };
// The heading above the accent buttons in Settings.
export const accentTitle = ui => (ui === 'clinical' ? 'Accent colour' : 'Theme');

// Themes were renamed or dropped. Anyone who saved an old name gets the closest new one.
// Neon and Onyx were always dark, so they stay dark (and Onyx keeps its pure black).
const OLD_NAMES = {
  sumi: 'violet', ink: 'violet', onyx: 'violet', kuro: 'violet', neon: 'violet',
  sage: 'forest', matcha: 'forest',
  cobalt: 'ocean', shinkansen: 'ocean',
  blossom: 'rose', sakura: 'rose'
};
const ALWAYS_DARK = ['neon', 'onyx', 'kuro'];
export const isAlwaysDark = skin => ALWAYS_DARK.includes(skin);

// Turn whatever was saved (maybe an old theme) into a valid { ui, skin, mode, oled }.
export function cleanTheme(theme) {
  const saved = theme?.skin;
  const skin = SKINS[saved] ? saved : (OLD_NAMES[saved] || 'violet');
  let mode = ['light', 'dark', 'auto'].includes(theme?.mode) ? theme.mode : 'auto';   // (nothing saved: follow the device)
  if (ALWAYS_DARK.includes(saved)) mode = 'dark';
  const oled = theme?.oled === true || ['onyx', 'kuro'].includes(saved);
  return { ui: cleanUi(theme?.ui), skin, mode, oled };
}

// A copy of the theme is also kept in localStorage. The tiny script in index.html's <head> reads it
// before the page draws, so the app never flashes the wrong colors while the database is opening.
const QUICK_KEY = 'study-sprint-theme';
const DARK_QUERY = matchMedia('(prefers-color-scheme: dark)');
let current = null;

// css/clinical.css is only fetched when the Clinical style is on (index.html writes the link in before the first paint when the
// saved style is Clinical; this adds it when the style is switched on later, or when the saved settings turn out to say Clinical).
// Calls `whenIn` once the file is in (or failed to load: the style is switched on anyway, so the app never waits on it).
function ensureClinicalCss(whenIn) {
  let link = document.getElementById('clinicalCss');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'css/clinical.css'; link.id = 'clinicalCss';
    document.head.appendChild(link);
  }
  if (link.sheet) { whenIn(); return; }
  link.addEventListener('load', whenIn, { once: true });
  link.addEventListener('error', whenIn, { once: true });
}

export function applyTheme(theme) {
  current = cleanTheme(theme);
  const root = document.documentElement;
  // Switching to Clinical waits for its stylesheet before data-ui changes, so there is no mixed look in between.
  const ui = current.ui;
  if (ui === 'clinical' && root.getAttribute('data-ui') !== 'clinical') {
    ensureClinicalCss(() => {
      if (current.ui !== ui) return;                 // switched again meanwhile
      root.setAttribute('data-ui', ui); syncBrowserBar();
      dispatchEvent(new CustomEvent('themechange', { detail: { ...current } }));
    });
  } else root.setAttribute('data-ui', ui);
  root.setAttribute('data-skin', current.skin);
  root.setAttribute('data-theme', resolvedMode(current.mode));
  if (current.oled) root.setAttribute('data-oled', 'on'); else root.removeAttribute('data-oled');
  try { localStorage.setItem(QUICK_KEY, JSON.stringify(current)); } catch (e) { /* private mode: fine */ }
  syncBrowserBar();
  dispatchEvent(new CustomEvent('themechange', { detail: { ...current } }));       // the sidebar's toggle and Settings follow
  return { ...current };
}

// The sidebar's light/dark button. "Auto" becomes the explicit mode that is showing now, flipped.
// Saves like the Settings picker does (the device copy in localStorage and the settings store).
export function toggleMode() {
  if (!current) return null;                      // settings have not loaded yet
  if (isAlwaysDark(current.skin)) return current;  // a skin that is always dark has nothing to toggle
  const showing = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = applyTheme({ ...current, mode: showing === 'light' ? 'dark' : 'light' });
  db.setSetting('theme', next);
  return next;
}

// "Match my device" follows the device when it flips between light and dark (e.g. at sunset).
DARK_QUERY.addEventListener?.('change', () => { if (current?.mode !== 'auto') return; applyTheme(current); redrawPreviews(); });
// If Settings is open, its theme previews follow the new light/dark too.
function redrawPreviews() {
  const box = document.getElementById('skins');
  if (box && current) box.innerHTML = skinButtonsHTML(current.skin);
}

function resolvedMode(mode) {
  if (mode === 'auto') return DARK_QUERY.matches ? 'dark' : 'light';
  return mode;
}

// Color the phone's status bar / browser bar to match the page background.
export function syncBrowserBar() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
}

// HTML for the theme buttons. Each one shows a mini flashcard in that theme's colors: the preview
// carries the same data-skin / data-theme / data-oled attributes, so styles.css colors it by itself.
export function skinButtonsHTML(selected) {
  const t = document.documentElement;
  const names = t.getAttribute('data-ui') === 'clinical';
  const mode = t.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const oled = t.getAttribute('data-oled') === 'on' ? ' data-oled="on"' : '';
  return Object.entries(SKINS).map(([id, s]) =>
    `<button type="button" class="skin" data-skin="${id}" aria-pressed="${selected === id}">
      <span class="pv" aria-hidden="true" data-skin="${id}" data-theme="${mode}"${oled}><b>Aa</b></span>
      <span style="min-width:0"><span class="nm">${names ? CLINICAL_NAMES[id] : s.name}</span><span class="nt">${s.note}</span></span></button>`
  ).join('');
}

// ---------- card text alignment (Settings → Appearance) ----------
// 'auto' (short text centred, long answers left), 'center' or 'left'. Kept per device, like the theme.
// styles.css reads it from <html data-align="...">.
export const CARD_ALIGNS = [['auto', 'Auto'], ['center', 'Center'], ['left', 'Left']];
export const cleanAlign = v => (CARD_ALIGNS.some(a => a[0] === v) ? v : 'auto');
export function applyCardAlign(v) {
  const align = cleanAlign(v);
  document.documentElement.setAttribute('data-align', align);
  return align;
}
