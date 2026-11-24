// Makes the pictures that sell the app, from the real screenshots in docs/screenshots/:
//   docs/hero.png          1600x800, the README header, dark
//   docs/hero-light.png    1600x800, the same in the light theme
//   icons/og-1200x630.png  the link-preview picture (index.html og:image / twitter:image)
// They are plain on purpose: a flat background in the app's own colours (css/styles.css), the app's font (Geist), one headline in one
// colour, and the screenshots shown straight with a thin border. No glow, gradient or tilt.
// Run it after readme-shots.mjs, whenever the headline or the look of the app changes:  node tests/browser/promo-images.mjs
// (It runs readme-shots.mjs itself in the light theme, into a temp folder, to get the light screenshots.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realChromium as chromium } from './pw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'docs/screenshots');
const HEADLINE = 'Flashcards that come back right before you forget.';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
const LIGHT = path.join(TMP, 'light');
execFileSync(process.execPath, [path.join(ROOT, 'tests/browser/readme-shots.mjs')], { env: { ...process.env, SHOTS_MODE: 'light', SHOTS_OUT: LIGHT }, stdio: 'inherit' });

// The app's colours, copied from css/styles.css (violet, dark and light).
const THEMES = {
  dark: { bg: '#08090C', text: '#ECEDF3', text2: '#A8ACBD', line: 'rgb(255 255 255 / .16)', shadow: '0 12px 32px -12px rgb(0 0 0 / .7)', accent: '#8F80FF', onAccent: '#0B0A1A' },
  light: { bg: '#F1F2F6', text: '#0A0C15', text2: '#464959', line: 'rgb(11 13 18 / .15)', shadow: '0 12px 32px -12px rgb(11 13 18 / .22)', accent: '#5B48E8', onAccent: '#FFFFFF' }
};
const url = f => pathToFileURL(f).href;
const font = f => `url(${url(path.join(ROOT, 'fonts', f))}) format("woff2")`;
const MARK = c => `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="11" fill="${c.accent}"/><path d="M26 9L12 27h9l-2 12 15-19h-9z" fill="${c.onAccent}"/></svg>`;

const page = (t, body, css) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Geist;font-weight:400 700;src:${font('geist-latin.woff2')}}
*{box-sizing:border-box;margin:0}
body{background:${t.bg};color:${t.text};font-family:Geist,system-ui,sans-serif;overflow:hidden;position:relative}
h1{font-weight:600;letter-spacing:-.025em;line-height:1.1;color:${t.text}}
.shot{position:absolute;display:block;border:1px solid ${t.line};border-radius:12px;box-shadow:${t.shadow};background:${t.bg}}
.brand{display:flex;align-items:center;gap:12px;font-weight:600}.brand svg{display:block}
${css}</style>${body}`;

const hero = (t, dir) => page(t, `
<h1>${HEADLINE}</h1>
<img class="shot desk" src="${url(path.join(dir, 'desktop.png'))}">
<img class="shot ph" src="${url(path.join(dir, 'today.png'))}">`, `
body{width:1600px;height:800px}
h1{position:absolute;left:0;right:0;top:70px;text-align:center;font-size:56px}
.desk{left:160px;top:210px;width:960px}
.ph{left:1160px;top:210px;width:280px;height:606px;object-fit:cover;object-position:top}`);

const og = (t, dir) => page(t, `
<div class="brand">${MARK(t)}Study Sprint</div>
<h1>${HEADLINE}</h1>
<img class="shot ph" src="${url(path.join(dir, 'today.png'))}">`, `
body{width:1200px;height:630px}
.brand{position:absolute;left:72px;top:64px;font-size:30px}.brand svg{width:44px;height:44px}
h1{position:absolute;left:72px;top:190px;width:560px;font-size:56px}
.ph{left:760px;top:64px;width:310px;height:640px;object-fit:cover;object-position:top}`);

const browser = await chromium.launch();
const out = async (name, w, h, html) => {
  const f = path.join(TMP, path.basename(name) + '.html');
  fs.writeFileSync(f, html);
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.goto(url(f));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth));
  await p.screenshot({ path: path.join(ROOT, name) });
  console.log('saved', name, w + 'x' + h);
  await p.close();
};
await out('docs/hero.png', 1600, 800, hero(THEMES.dark, SHOTS));
await out('docs/hero-light.png', 1600, 800, hero(THEMES.light, LIGHT));
await out('icons/og-1200x630.png', 1200, 630, og(THEMES.dark, SHOTS));
await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });
