// Themes. The colors themselves live in css/styles.css;
// this file switches between them and draws the picker in Settings.
//
// A theme is two choices:
//   skin  which of the 6 color sets (stored on <html data-skin="...">, Ink is the default with no attribute)
//   mode  'auto' follows the device's light/dark setting, or force 'light' / 'dark' (<html data-theme="...">)

// Colors listed for the picker previews: [background, card, text, accent]
export const SKINS = {
  ink:     { name: 'Ink', note: 'Navy ink on paper', light: ['#EEF0F4','#FFFFFF','#151924','#2B45A3'], dark: ['#0E1117','#171B25','#E7E9EF','#8EA4F2'] },
  blossom: { name: 'Blossom', note: 'Soft pink', light: ['#FBF1F2','#FFFFFF','#2A1A20','#C2426E'], dark: ['#1A1216','#24181E','#F5E8EC','#F08BAE'] },
  sage:    { name: 'Sage', note: 'Green and cream', light: ['#EFF1E8','#FBFCF7','#1E241A','#4F7A2E'], dark: ['#11140E','#1A1F16','#E8EDE0','#9CC46E'] },
  cobalt:  { name: 'Cobalt', note: 'Bright blue', light: ['#F2F4F6','#FFFFFF','#10161F','#0B5CAD'], dark: ['#0C1117','#141B24','#E6ECF2','#5FA8F0'] },
  neon:    { name: 'Neon', note: 'Always dark', light: null, dark: ['#0B0716','#150E26','#F2EEFF','#FF3EA5'] },
  onyx:    { name: 'Onyx', note: 'Always dark, pure black', light: null, dark: ['#000000','#0D0D0D','#EDEDED','#E8E8E8'] }
};

// Themes were renamed once. Anyone who saved an old name gets the matching new one.
const OLD_NAMES = { sumi: 'ink', sakura: 'blossom', matcha: 'sage', shinkansen: 'cobalt', kuro: 'onyx' };

// A copy of the theme is also kept in localStorage. The tiny script in index.html's <head> reads it
// before the page draws, so the app never flashes the wrong colors while the database is opening.
const QUICK_KEY = 'study-sprint-theme';

export function applyTheme(theme) {
  const name = OLD_NAMES[theme?.skin] || theme?.skin;
  const skin = SKINS[name] ? name : 'ink';
  const mode = ['light', 'dark'].includes(theme?.mode) ? theme.mode : 'auto';
  const root = document.documentElement;
  if (skin === 'ink') root.removeAttribute('data-skin'); else root.setAttribute('data-skin', skin);
  if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
  try { localStorage.setItem(QUICK_KEY, JSON.stringify({ skin, mode })); } catch (e) { /* private mode: fine */ }
  syncBrowserBar();
  return { skin, mode };
}

// Color the phone's status bar / browser bar to match the page background.
export function syncBrowserBar() {
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', paper));
}

// Is the page currently showing dark colors?
function viewerDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

// HTML for the 6 theme buttons. Each one shows a mini flashcard in that theme's colors.
export function skinButtonsHTML(current) {
  const dark = viewerDark();
  return Object.entries(SKINS).map(([id, t]) => {
    const [bg, sheet, ink, acc] = (dark || !t.light) ? t.dark : t.light;
    return `<button type="button" class="skin" data-skin="${id}" aria-pressed="${current === id}">
      <span class="pv" aria-hidden="true" style="--t-bg:${bg};--t-sheet:${sheet};--t-ink:${ink};--t-acc:${acc}"><b>Aa</b></span>
      <span style="min-width:0"><span class="nm">${t.name}</span><span class="nt">${t.note}</span></span></button>`;
  }).join('');
}
