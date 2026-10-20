// The "Finding cards… 37%" status line of Suggest cards (css/styles.css .sug-status) uses tabular figures so the changing percent does not jiggle.
// Run with: node --test tests/sug-status-css.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the Suggest cards status line (with its Stop button) has tabular figures', () => {
  const css = fs.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const rule = css.split('\n').find(l => l.startsWith('.sug-status{'));
  assert.ok(rule && /font-variant-numeric:\s*tabular-nums/.test(rule), rule);
});
