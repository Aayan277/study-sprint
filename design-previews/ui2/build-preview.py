#!/usr/bin/env python3
"""Builds design-previews/ui2/preview.html: one self-contained page (screenshots inlined as WebP).
Run after shoot.mjs:  python3 design-previews/ui2/build-preview.py"""
import base64, io, json, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
UIS = ['current', 'clinical', 'paper']
SCREENS = [('today', 'Today'), ('review', 'Review (answer)'), ('decks', 'Decks'), ('deck', 'Deck page'), ('stats', 'Stats'), ('settings', 'Settings')]
SIZES = ['phone', 'desk']
MODES = ['light', 'dark']

def webp(path, width):
    im = Image.open(path).convert('RGB')
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=80, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()

imgs = {}
for ui in UIS:
    for s, _ in SCREENS:
        for size in SIZES:
            for mode in MODES:
                f = os.path.join(SHOTS, f'{ui}-{s}-{size}-{mode}.png')
                if os.path.exists(f):
                    imgs[f'{ui}-{s}-{size}-{mode}'] = webp(f, 750 if size == 'phone' else 1440)

OPTIONS = [
    {'id': 'current', 'n': '0', 'name': 'Current', 'tag': 'Today\'s design, for reference',
     'pitch': 'Dark-first, Geist, violet glow, gradient hero, glowing tab indicator and edge stripes. Energetic, but reads as a "tech" product.',
     'effort': 'n/a'},
    {'id': 'clinical', 'n': '1', 'name': 'Clinical', 'tag': 'Crisp, white, compact',
     'pitch': 'White page and graphite text, the device\'s own font (SF on iPhone and Mac, Segoe on Windows), hairlines instead of glows, one blue accent kept to buttons, links and focus. Feels like a clinical reference app or Apple Reminders. Slightly denser lists, so more fits on a phone screen.',
     'effort': 'About 1 to 1.5 days: the CSS layer (done here, ~370 lines), the head-script attribute, a Settings row, accent names, and a pass over first-run, Import and Play results. No change to the layout markup.'},
    {'id': 'paper', 'n': '2', 'name': 'Paper', 'tag': 'Warm, calm, textbook',
     'pitch': 'Warm off-white paper and ink, with a serif (Source Serif 4) for card text, page titles and deck names, so cards read like a good textbook. The same calm controls as Clinical, inkier accents, a little more air around the text.',
     'effort': 'About 1.5 to 2 days: everything in Clinical, plus one webfont (~40 KB, cached by the service worker) and a check of long answers, cloze and maths in the serif.'},
]

data = json.dumps(imgs)
opts = json.dumps(OPTIONS)
screens = json.dumps(SCREENS)

html = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI 2 Options</title>
<style>
:root{
  --bg:#F6F6F4; --card:#FFFFFF; --text:#16181C; --text-2:#4B5059; --line:#E2E3E0; --line-2:#D0D2CE; --acc:#1F5FBF; --acc-on:#FFFFFF; --chip:#EFEFEC;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){--bg:#141517; --card:#1C1D20; --text:#ECEDEF; --text-2:#A8ADB6; --line:#2B2D31; --line-2:#3A3C42; --acc:#93B6F0; --acc-on:#0D1727; --chip:#25262A; color-scheme:dark}
}
:root[data-theme="dark"]{--bg:#141517; --card:#1C1D20; --text:#ECEDEF; --text-2:#A8ADB6; --line:#2B2D31; --line-2:#3A3C42; --acc:#93B6F0; --acc-on:#0D1727; --chip:#25262A; color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1360px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.75rem;font-weight:600;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:1.125rem;font-weight:600;margin:40px 0 12px;letter-spacing:-.01em}
p{margin:0 0 10px}
.lede{color:var(--text-2);max-width:72ch}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:20px}
.opt{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.opt .n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--chip);font-weight:600;font-size:13px;margin-right:8px;font-variant-numeric:tabular-nums}
.opt h3{display:flex;align-items:center;margin:0 0 2px;font-size:1.0625rem;font-weight:600}
.opt .tag{color:var(--text-2);font-size:13px;margin-bottom:10px}
.opt .eff{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;color:var(--text-2)}
.opt .eff b{color:var(--text);font-weight:600}
.opt.rec{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
.rec-badge{margin-left:auto;font-size:12px;font-weight:600;color:var(--acc)}
.bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 0;margin:28px 0 12px;background:var(--bg);border-bottom:1px solid var(--line)}
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:8px;background:var(--chip);border:1px solid var(--line)}
.seg button{border:0;background:none;color:var(--text-2);font:500 13px/1 inherit;font-family:inherit;padding:0 12px;min-height:32px;border-radius:6px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--card);color:var(--text);box-shadow:0 0 0 1px var(--line-2)}
.seg button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.lbl{font-size:12px;color:var(--text-2);font-weight:600;margin-right:-8px}
.grid{display:grid;gap:16px}
.grid.phone{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid.desk{grid-template-columns:1fr}
@media (max-width:760px){.grid.phone{grid-template-columns:1fr}}
figure{margin:0;min-width:0}
figcaption{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;font-weight:600}
figcaption span{color:var(--text-2);font-weight:400;font-size:13px}
figure img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line-2);background:var(--card)}
.grid.phone figure img{max-width:375px;margin:0 auto 0 0}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;font-size:14px}
.note h3{margin:0 0 8px;font-size:15px;font-weight:600}
.note ul{margin:0;padding-left:18px}
.note li{margin:4px 0}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--chip);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--text-2);font-weight:600}
.sw{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-1px;margin-right:6px;border:1px solid rgb(0 0 0 / .12)}
.tbl{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
  <h1>Study Sprint: a second, professional UI</h1>
  <p class="lede">The brief: more professional and plain, no big colour gradients or AI-looking effects, usable by a medical student, light and dark, and maybe accents. Below are the current design and two options, both built as real CSS layers on the running app (<code>html[data-ui="clinical"]</code> and <code>html[data-ui="paper"]</code>) and screenshotted with seeded medical decks. Every text colour passes WCAG AA in both modes and all five accents, and no screen scrolls sideways at 375 or 1440 px wide.</p>

  <div class="opts" id="opts"></div>

  <div class="bar" role="toolbar" aria-label="What to show">
    <span class="lbl">Screen</span><div class="seg" id="segScreen"></div>
    <span class="lbl">Mode</span><div class="seg" id="segMode"></div>
    <span class="lbl">Size</span><div class="seg" id="segSize"></div>
  </div>
  <div class="grid phone" id="grid"></div>

  <h2>Implementation notes</h2>
  <div class="notes">
    <div class="note"><h3>Switching</h3><ul>
      <li>Ship the layer as <code>css/ui2.css</code>, linked after <code>styles.css</code> (or appended to it). Everything is scoped under <code>html[data-ui]</code>, so Classic is untouched.</li>
      <li>Store the choice with the theme: <code>{ skin, mode, oled, ui }</code> where ui is <code>'classic' | 'clinical'</code> (or paper). <code>cleanTheme()</code> and <code>applyTheme()</code> in <code>js/themes.js</code> set or remove <code>data-ui</code> like they do <code>data-skin</code>.</li>
      <li>The head script in <code>index.html</code> reads <code>t.ui</code> from the same localStorage key and sets <code>data-ui</code> before first paint (2 lines, keep in step with <code>cleanTheme</code>), so there is no flash of the wrong style.</li>
      <li>Paper only: add <code>Source+Serif+4</code> to the Google Fonts link. Clinical needs no font at all (system stack).</li>
    </ul></div>
    <div class="note"><h3>Settings row</h3><ul>
      <li>Appearance gets a <b>Style</b> segmented control (Classic | Clinical) above Theme, as in the Settings screenshots (markup mocked in for the preview).</li>
      <li>Under the new style, "Theme" is labelled <b>Accent colour</b> and the cards become plain swatches (pure CSS; the descriptions are hidden).</li>
      <li>Accent names come from a second name table in <code>SKINS</code> picked by the style: Indigo, Blue, Green, Rust, Plum.</li>
      <li>Light / Dark / Match my device and OLED stay as they are.</li>
    </ul></div>
    <div class="note"><h3>Pure CSS vs markup tweaks</h3><ul>
      <li><b>Pure CSS:</b> Today, Review, Decks, deck page, card list, Stats, sidebar, sheets, Play, Import (the sparkle on the Claude button is removed).</li>
      <li><b>Small JS / markup:</b> the Style row, the accent names, <code>data-ui</code> in the head script and <code>applyTheme</code>, and the browser-bar colour (already read from <code>--bg</code>).</li>
      <li><b>To review when building:</b> first-run and landing (<code>.lp-*</code>, phone mock-up gradient), Play results stamp, occlusion editor, the motion effects in <code>fx.js</code> (glows are neutralised through <code>--glow</code>, but the rating pulse may want a quieter version).</li>
      <li>Logo: kept. If the lightning bolt feels too "sprint", a plain card mark is a 1-line SVG swap.</li>
    </ul></div>
    <div class="note"><h3>How accents map</h3>
      <p style="color:var(--text-2);font-size:13px">The five existing skins are remapped, so saved themes and sync keep working. Light uses a deep tone for fills and text; dark uses a mid tone for fills (white text) and a light tone for links.</p>
      <div class="tbl"><table>
        <tr><th>skin</th><th>name</th><th>light</th><th>dark fill / text</th></tr>
        <tr><td>violet</td><td>Indigo</td><td><span class="sw" style="background:#4F46BA"></span>#4F46BA</td><td><span class="sw" style="background:#5F66DC"></span><span class="sw" style="background:#ADA8F0"></span></td></tr>
        <tr><td>ocean</td><td>Blue</td><td><span class="sw" style="background:#1F5FBF"></span>#1F5FBF</td><td><span class="sw" style="background:#3B6FD4"></span><span class="sw" style="background:#93B6F0"></span></td></tr>
        <tr><td>forest</td><td>Green</td><td><span class="sw" style="background:#1D6F48"></span>#1D6F48</td><td><span class="sw" style="background:#2F7A55"></span><span class="sw" style="background:#84C7A2"></span></td></tr>
        <tr><td>ember</td><td>Rust</td><td><span class="sw" style="background:#A94A1C"></span>#A94A1C</td><td><span class="sw" style="background:#B4571F"></span><span class="sw" style="background:#E8A683"></span></td></tr>
        <tr><td>rose</td><td>Plum</td><td><span class="sw" style="background:#97366A"></span>#97366A</td><td><span class="sw" style="background:#B04C82"></span><span class="sw" style="background:#E29EC0"></span></td></tr>
      </table></div>
      <p style="color:var(--text-2);font-size:13px;margin-top:8px">Paper uses slightly inkier light tones (e.g. Blue #2A4E85). Ratings are fixed and muted: Again #B42318, Hard #975A06, Good #18794E, Easy #2457B5 (light).</p>
    </div>
  </div>
</div>
<script>
const IMGS = __IMGS__;
const OPTS = __OPTS__;
const SCREENS = __SCREENS__;
const state = { screen: 'today', mode: 'light', size: 'phone' };
try { Object.assign(state, JSON.parse(localStorage.getItem('ui2-preview') || '{}')); } catch (e) {}
const $ = id => document.getElementById(id);
$('opts').innerHTML = OPTS.map(o => `<div class="opt${o.id === 'clinical' ? ' rec' : ''}"><h3><span class="n">${o.n}</span>${o.name}${o.id === 'clinical' ? '<span class="rec-badge">Recommended</span>' : ''}</h3><div class="tag">${o.tag}</div><p>${o.pitch}</p><div class="eff"><b>Effort:</b> ${o.effort}</div></div>`).join('');
function seg(id, key, items) {
  $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${state[key] === v}">${l}</button>`).join('');
  $(id).onclick = e => { const b = e.target.closest('button'); if (!b) return; state[key] = b.dataset.v; try { localStorage.setItem('ui2-preview', JSON.stringify(state)); } catch (err) {} draw(); };
}
function draw() {
  seg('segScreen', 'screen', SCREENS);
  seg('segMode', 'mode', [['light', 'Light'], ['dark', 'Dark']]);
  seg('segSize', 'size', [['phone', 'Phone 375'], ['desk', 'Desktop 1440']]);
  const g = $('grid'); g.className = 'grid ' + state.size;
  const scr = SCREENS.find(s => s[0] === state.screen)[1];
  g.innerHTML = OPTS.map(o => {
    const src = IMGS[`${o.id}-${state.screen}-${state.size}-${state.mode}`];
    return `<figure><figcaption>${o.n}. ${o.name} <span>${scr}, ${state.mode}</span></figcaption>${src ? `<img src="${src}" alt="${o.name} design: ${scr} screen in ${state.mode} mode" loading="lazy">` : '<p>missing</p>'}</figure>`;
  }).join('');
}
draw();
</script>
</body>
</html>
'''
html = html.replace('__IMGS__', data).replace('__OPTS__', opts).replace('__SCREENS__', screens)
out = os.path.join(HERE, 'preview.html')
open(out, 'w').write(html)
print(out, round(len(html) / 1e6, 2), 'MB', len(imgs), 'images')
