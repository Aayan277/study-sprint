// Single-key shortcuts (E, I, R, D, Z, A, X, M, -, @, 1-6, Space/Enter on the page). WCAG 2.1.4 (Character Key Shortcuts) asks for a
// way to turn them off, because speech-input and some switch users trigger them by accident. Settings → Study → "Single-key shortcuts"
// controls it. It is a per-device setting (not synced): it depends on how this device is used (a keyboard, voice control), not on the person's
// study plan. Shortcuts with Ctrl/Cmd (Ctrl+Enter to save) are not affected.

let on = true;
export function configureShortcuts(settings = {}) {
  on = settings.singleKeys !== false;
  if (typeof document !== 'undefined') document.documentElement.dataset.singleKeys = on ? 'on' : 'off';
}
export const singleKeysOn = () => on;
// A key hint such as <kbd>E</kbd> is only drawn while the shortcuts are on.
export const keyHint = html => on ? html : '';
// Take the key hints (<kbd class="key-hint">E</kbd>) and aria-keyshortcuts out of a piece of HTML while the shortcuts are off.
export const stripKeys = html => on ? html : html.replace(/ ?<kbd[^>]*>[^<]*<\/kbd>/g, '').replace(/ aria-keyshortcuts="[^"]*"/g, '').replace(/ \((?:[A-Z]|@|-|Space)\)(?=")/g, '');      // (and "Read aloud (R)" in a title)
