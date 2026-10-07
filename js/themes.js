// Themes, ported from kanji-sprint. The colors themselves live in css/styles.css;
// this file switches between them and draws the picker in Settings.
//
// A theme is two choices:
//   skin  which of the 6 color sets (stored on <html data-skin="...">, Sumi is the default with no attribute)
//   mode  'auto' follows the phone's light/dark setting, or force 'light' / 'dark' (<html data-theme="...">)

export const SKINS = {
  sumi:       { name: 'Sumi', jp: '墨', k: '墨', note: 'Ink on paper', light: ['#EEF0F4','#FFFFFF','#151924','#2B45A3','#E9C3BE'], dark: ['#0E1117','#171B25','#E7E9EF','#8EA4F2','#53333A'] },
  sakura:     { name: 'Sakura', jp: '桜', k: '桜', note: 'Cherry blossom', light: ['#FBF1F2','#FFFFFF','#2A1A20','#C2426E','#F0B9C6'], dark: ['#1A1216','#24181E','#F5E8EC','#F08BAE','#5A3341'] },
  matcha:     { name: 'Matcha', jp: '抹茶', k: '茶', note: 'Green tea and paper', light: ['#EFF1E8','#FBFCF7','#1E241A','#4F7A2E','#D9C9A6'], dark: ['#11140E','#1A1F16','#E8EDE0','#9CC46E','#4A4231'] },
  shinkansen: { name: 'Shinkansen', jp: '新幹線', k: '新', note: 'Bullet-train blue', light: ['#F2F4F6','#FFFFFF','#10161F','#0B5CAD','#B9C6D6'], dark: ['#0C1117','#141B24','#E6ECF2','#5FA8F0','#2E3D50'] },
  neon:       { name: 'Neon Tokyo', jp: '東京', k: '東', note: 'Always dark', light: null, dark: ['#0B0716','#150E26','#F2EEFF','#FF3EA5','#1C4A62'] },
  kuro:       { name: 'Kuro', jp: '黒', k: '黒', note: 'Always dark, pure black', light: null, dark: ['#000000','#0D0D0D','#EDEDED','#E8E8E8','#3A1E1E'] }
};

// A copy of the theme is also kept in localStorage. The tiny script in index.html's <head> reads it
// before the page draws, so the app never flashes the wrong colors while the database is opening.
const QUICK_KEY = 'study-sprint-theme';

export function applyTheme(theme) {
  const skin = SKINS[theme?.skin] ? theme.skin : 'sumi';
  const mode = ['light', 'dark'].includes(theme?.mode) ? theme.mode : 'auto';
  const root = document.documentElement;
  if (skin === 'sumi') root.removeAttribute('data-skin'); else root.setAttribute('data-skin', skin);
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

// HTML for the 6 theme buttons. Each one shows a mini practice square in that theme's colors.
export function skinButtonsHTML(current) {
  const dark = viewerDark();
  return Object.entries(SKINS).map(([id, t]) => {
    const [bg, sheet, ink, acc, guide] = (dark || !t.light) ? t.dark : t.light;
    return `<button type="button" class="skin" data-skin="${id}" aria-pressed="${current === id}">
      <span class="pv" style="--t-bg:${bg};--t-sheet:${sheet};--t-ink:${ink};--t-acc:${acc};--t-guide:${guide}"><b lang="ja">${t.k}</b><i></i></span>
      <span style="min-width:0"><span class="nm">${t.name}<span lang="ja">${t.jp}</span></span><span class="nt">${t.note}</span></span></button>`;
  }).join('');
}
