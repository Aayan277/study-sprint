// WCAG contrast check of the ui2 tokens, read straight from the live page (computed custom properties), so it checks what ships.
//   node design-previews/ui2/contrast.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realChromium as chromium } from '../../tests/browser/pw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8141;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(ok => server.listen(PORT, ok));

const hex = h => { h = h.trim().replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m); return (x + .05) / (y + .05); };

// [foreground, background, minimum]
const TEXT = [['--text', '--bg', 4.5], ['--text', '--surface-1', 4.5], ['--text-2', '--surface-1', 4.5], ['--text-2', '--surface-2', 4.5], ['--text-2', '--bg', 4.5], ['--text-3', '--surface-1', 4.5], ['--text-2', '--side-bg', 4.5], ['--text-2', '--side-on', 4.5],
  ['--accent-text', '--surface-1', 4.5], ['--accent-text', '--bg', 4.5], ['--accent-text', '--side-bg', 4.5], ['--on-accent', '--accent', 4.5],
  ['--again', '--surface-1', 4.5], ['--hard', '--surface-1', 4.5], ['--good', '--surface-1', 4.5], ['--easy', '--surface-1', 4.5], ['--hard', '--bg', 4.5],
  ['--control', '--surface-1', 3], ['--accent', '--surface-1', 3], ['--line-strong', '--surface-1', 1]];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`);
await page.addStyleTag({ url: 'design-previews/ui2/ui2.css' });
let fails = 0;
for (const ui of ['clinical', 'paper']) for (const mode of ['light', 'dark']) for (const skin of ['violet', 'ocean', 'forest', 'ember', 'rose']) {
  const vals = await page.evaluate(([ui, mode, skin, names]) => {
    const r = document.documentElement;
    r.setAttribute('data-ui', ui); r.setAttribute('data-theme', mode); r.setAttribute('data-skin', skin); r.removeAttribute('data-oled');
    const cs = getComputedStyle(r);
    return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim()]));
  }, [ui, mode, skin, [...new Set(TEXT.flatMap(t => [t[0], t[1]]))]]);
  const out = [];
  for (const [f, b, min] of TEXT) {
    if (min === 1) continue;
    // only the accent pairs change with the skin; print the neutral ones once per mode
    if (skin !== 'ocean' && !/accent/.test(f + b)) continue;
    const c = ratio(vals[f], vals[b]);
    const ok = c >= min;
    if (!ok) fails++;
    out.push(`${ok ? 'ok  ' : 'FAIL'} ${f} on ${b}: ${c.toFixed(2)} (needs ${min})`);
  }
  console.log(`\n${ui} ${mode} ${skin}\n  ` + out.join('\n  '));
}
console.log(`\n${fails} failing pairs`);
await browser.close(); server.close();
