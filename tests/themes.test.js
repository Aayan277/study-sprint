// cleanTheme: what a saved theme becomes, including the style (ui: 'original' or 'clinical').
// Run with: node --test tests/themes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// themes.js looks at the page's colour scheme when it loads; give it a stand-in so it can load in Node.
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const { cleanTheme, cleanUi, UIS, CLINICAL_NAMES, SKINS, accentTitle } = await import('../js/themes.js');

test('a theme with no style is Original (themes saved before the Clinical style existed)', () => {
  assert.deepEqual(cleanTheme({ skin: 'ocean', mode: 'light', oled: false }), { ui: 'original', skin: 'ocean', mode: 'light', oled: false });
  assert.equal(cleanTheme(null).ui, 'original');
  assert.equal(cleanTheme(undefined).ui, 'original');
});

test('clinical is kept, anything else becomes original', () => {
  assert.equal(cleanTheme({ ui: 'clinical' }).ui, 'clinical');
  assert.equal(cleanTheme({ ui: 'original' }).ui, 'original');
  for (const bad of ['Clinical', 'paper', '', 5, null, {}, ['clinical']]) assert.equal(cleanTheme({ ui: bad }).ui, 'original', String(bad));
});

test('the style does not change the other choices', () => {
  const t = cleanTheme({ ui: 'clinical', skin: 'forest', mode: 'auto', oled: true });
  assert.deepEqual(t, { ui: 'clinical', skin: 'forest', mode: 'auto', oled: true });
  // an old skin name still migrates, and a skin that was always dark stays dark, in either style
  assert.deepEqual(cleanTheme({ ui: 'clinical', skin: 'neon', mode: 'light' }), { ui: 'clinical', skin: 'violet', mode: 'dark', oled: false });
  assert.equal(cleanTheme({ ui: 'clinical', skin: 'onyx' }).oled, true);
});

test('cleaning twice changes nothing', () => {
  for (const ui of ['original', 'clinical', 'x']) {
    const once = cleanTheme({ ui, skin: 'rose', mode: 'light' });
    assert.deepEqual(cleanTheme(once), once);
  }
});

test('the two styles, and the Clinical accent names (same ids as the skins)', () => {
  assert.deepEqual(UIS, [['original', 'Original'], ['clinical', 'Clinical']]);
  assert.equal(cleanUi('clinical'), 'clinical');
  assert.deepEqual(Object.keys(CLINICAL_NAMES), Object.keys(SKINS));
  assert.deepEqual(Object.values(CLINICAL_NAMES), ['Indigo', 'Blue', 'Green', 'Rust', 'Plum']);
  assert.equal(accentTitle('clinical'), 'Accent colour');
  assert.equal(accentTitle('original'), 'Theme');
});

test('a new install follows the device (auto); a saved light or dark choice is kept', async () => {
  const { DEFAULT_SETTINGS } = await import('../js/db.js');
  assert.equal(DEFAULT_SETTINGS.theme.mode, 'auto');
  assert.equal(cleanTheme(DEFAULT_SETTINGS.theme).mode, 'auto');
  assert.equal(cleanTheme(null).mode, 'auto');
  assert.equal(cleanTheme({ mode: 'junk' }).mode, 'auto');
  assert.equal(cleanTheme({ mode: 'dark' }).mode, 'dark');
  assert.equal(cleanTheme({ mode: 'light' }).mode, 'light');
  assert.equal(cleanTheme({ skin: 'neon' }).mode, 'dark');       // always-dark skins stay dark
});
