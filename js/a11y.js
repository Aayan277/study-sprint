// Small pure helpers for keyboard and screen-reader behaviour (no page needed, so they are unit-tested: tests/a11y-flows.test.js).

// Add or remove one id in a space-separated attribute value such as aria-describedby ("a b" + "c" → "a b c"). Pure, so it is unit-tested.
export function toggleToken(list, token, on) {
  const parts = String(list || '').split(/\s+/).filter(Boolean).filter(t => t !== token);
  if (on) parts.push(token);
  return parts.join(' ');
}

// Where the arrow keys take focus inside a toolbar of n buttons, from button i: the index to focus, or null for any other key.
// (Left/Right wrap round; Home and End go to the ends.)
export function toolbarTarget(key, i, n) {
  if (i < 0 || n < 1) return null;
  if (key === 'ArrowRight') return (i + 1) % n;
  if (key === 'ArrowLeft') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}
