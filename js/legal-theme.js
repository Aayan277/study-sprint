// Used by privacy.html and terms.html (a plain script in <head>, so the page never flashes the wrong colours).
// Uses the same light or dark choice as the app (saved in this browser by the app); otherwise follows the device.
try {
  var t = JSON.parse(localStorage.getItem('study-sprint-theme') || '{}'), m = t.mode;
  if (m !== 'light' && m !== 'dark') m = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (['neon', 'onyx', 'kuro'].indexOf(t.skin) >= 0) m = 'dark';
  document.documentElement.setAttribute('data-theme', m);
} catch (e) { /* stays dark */ }
