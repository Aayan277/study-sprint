#!/usr/bin/env python3
"""Builds design-previews/ui4/preview.html: one self-contained page (screenshots inlined as WebP), grouped by screen,
comparing Clinical A and its three layout versions A1, A2 and A3 side by side.
Run after shoot.mjs:  python3 design-previews/ui4/build-preview.py"""
import base64, io, json, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
UIS = ['a', 'a1', 'a2', 'a3']
SCREENS = [('today', 'Today'), ('done', 'Today, all done'), ('back', 'Review, answer'), ('decks', 'Decks'), ('stats', 'Stats')]
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
                    imgs[f'{ui}-{s}-{size}-{mode}'] = webp(f, 750 if size == 'phone' else 1200)

OPTIONS = [
    {'id': 'a', 'n': 'A', 'name': 'Clinical refined', 'tag': 'Round 3, the one the owner picked',
     'pitch': 'For reference: the sidebar, a summary panel with the goal ring, decks as grouped tiles.', 'effort': ''},
    {'id': 'a1', 'n': 'A1', 'name': 'Classic', 'tag': 'A without the app-style touches',
     'pitch': 'A plain left-hand menu with words only and a thin line marking the current page. Square-ish 4px corners and no rounded pills, rings or icon buttons: the goal is a sentence and a thin bar, decks say "Study", exams are coloured text. On desktop, Today puts the goal and a table of decks in a main column and the exams in a right-hand column.',
     'effort': 'About 1.5 days on top of A. CSS only, plus the goal line (small markup change).'},
    {'id': 'a2', 'n': 'A2', 'name': 'Document', 'tag': 'Like a university portal or a journal site',
     'pitch': 'A header bar with the name and the sections as text tabs (a thin accent line along the top), and each page as a single column of text with clear headings and rules, no boxes. Today reads like a short summary followed by headed sections. Review is a printed question and answer. On phones the sections sit as a tab strip under the name.',
     'effort': 'About 2 days on top of A. CSS only, plus the goal line, but the sidebar deck list and sync status are hidden on desktop and need a new home.'},
    {'id': 'a3', 'n': 'A3', 'name': 'Two-pane', 'tag': 'Like Outlook or a reference manager',
     'pitch': 'A list pane on the left (the sections as a row of tabs, then every deck with its due count), the page on the right under a header bar. Today shows the goal as one strip and the exams as a table, since the decks are already in the pane. Review goes full width, question on the left and answer on the right. Phones show the deck list first.',
     'effort': 'About 2 to 2.5 days on top of A. CSS only, plus the goal line, but needs a real "selected deck" state in the pane and a check of long answers in the side-by-side review.'},
]

data = json.dumps(imgs)
opts = json.dumps(OPTIONS)
screens = json.dumps(SCREENS)

html = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clinical A Layouts</title>
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
.wrap{max-width:1600px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.75rem;font-weight:600;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:1.125rem;font-weight:600;margin:40px 0 12px;letter-spacing:-.01em}
p{margin:0 0 10px}
.lede{color:var(--text-2);max-width:72ch}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px;margin-top:20px}
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
.grid.phone{grid-template-columns:repeat(var(--n,4),minmax(0,1fr))}
.grid.desk{grid-template-columns:repeat(auto-fill,minmax(min(100%,600px),1fr))}
@media (max-width:1100px){.grid.phone{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.grid.phone{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:480px){.grid.phone{grid-template-columns:1fr}}
figure{margin:0;min-width:0}
figcaption{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;font-weight:600}
figcaption span{color:var(--text-2);font-weight:400;font-size:13px}
figure img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line-2);background:var(--card)}
.grid.phone figure img{max-width:375px;margin:0 auto 0 0}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}
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
  <h1>Study Sprint: three layouts for Clinical A</h1>
  <p class="lede">The owner picked A and asked for versions with different layouts, less "AI modern techy". A1, A2 and A3 use exactly A's colours, type and tokens; only the page structure changes, and all three drop the rounded pills, the goal ring and the decorative icons. Each is a real stylesheet on the live app (origin/main, v4.9), screenshotted with seeded medical decks. Every visible text node passes WCAG AA in light and dark, and no screen scrolls sideways at 375 or 1440 px wide.</p>

  <div class="opts" id="opts"></div>

  <div class="bar" role="toolbar" aria-label="What to show">
    <span class="lbl">Screen</span><div class="seg" id="segScreen"></div>
    <span class="lbl">Mode</span><div class="seg" id="segMode"></div>
    <span class="lbl">Size</span><div class="seg" id="segSize"></div>
    <span class="lbl">Show</span><div class="seg" id="segShow"></div>
  </div>
  <h2 id="scrTitle" style="margin-top:8px"></h2>
  <div class="grid phone" id="grid"></div>

  <h2>Implementation notes</h2>
  <div class="notes">
    <div class="note"><h3>Shared by A1, A2 and A3</h3><ul>
      <li><code>layout-common.css</code> (~100 lines) sits on top of A: 4px corners, no logo mark, no nav icons, exam countdowns as coloured text, "Study" / "Done" / "73% mastered" in words.</li>
      <li><b>Markup:</b> the goal ring becomes "6 of 94 done today" and a thin bar (<code>js/today.js</code>, the <code>ring()</code> call in the hero). Plus A's shared changes from round 3 (Style row, "All done for today", "Extra study").</li>
    </ul></div>
    <div class="note"><h3>DOM versus CSS only</h3><ul>
      <li><b>A1:</b> CSS only (~80 lines). The right-hand exam column is a CSS grid on the existing Today markup.</li>
      <li><b>A2:</b> CSS only (~125 lines). Moving the sidebar into a header bar is CSS, but the deck list and sync line are hidden on desktop.</li>
      <li><b>A3:</b> CSS only (~125 lines). Phones reorder Today with CSS <code>order</code>; Today's "Your decks" is hidden on desktop because the pane lists them. Review side by side uses the existing back-face markup.</li>
    </ul></div>
    <div class="note"><h3>Checks</h3><ul>
      <li>Rendered-text contrast on all 80 shots: no failures. Colour tokens are A's (0 failing pairs, <code>ui3/contrast.mjs</code>).</li>
      <li>No horizontal scroll on any shot.</li>
      <li>Shots are the first viewport (375 x 812, 1440 x 900).</li>
    </ul></div>
  </div>
</div>
<script>
const IMGS = __IMGS__;
const OPTS = __OPTS__;
const SCREENS = __SCREENS__;
const state = { screen: 'today', mode: 'light', size: 'phone', show: 'all' };
try { Object.assign(state, JSON.parse(localStorage.getItem('ui4-preview') || '{}')); } catch (e) {}
const $ = id => document.getElementById(id);
$('opts').innerHTML = OPTS.map(o => `<div class="opt${o.id === 'a1' ? ' rec' : ''}"><h3><span class="n">${o.n}</span>${o.name}${o.id === 'a1' ? '<span class="rec-badge">Recommended</span>' : ''}</h3><div class="tag">${o.tag}</div><p>${o.pitch}</p>${o.effort ? `<div class="eff"><b>Effort:</b> ${o.effort}</div>` : ''}</div>`).join('');
function seg(id, key, items) {
  $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${state[key] === v}">${l}</button>`).join('');
  $(id).onclick = e => { const b = e.target.closest('button'); if (!b) return; state[key] = b.dataset.v; try { localStorage.setItem('ui4-preview', JSON.stringify(state)); } catch (err) {} draw(); };
}
function draw() {
  seg('segScreen', 'screen', SCREENS);
  seg('segMode', 'mode', [['light', 'Light'], ['dark', 'Dark']]);
  seg('segSize', 'size', [['phone', 'Phone 375'], ['desk', 'Desktop 1440']]);
  seg('segShow', 'show', [['all', 'A + all three'], ['new', 'A1, A2, A3']]);
  const g = $('grid'); g.className = 'grid ' + state.size;
  const scr = SCREENS.find(s => s[0] === state.screen)[1];
  $('scrTitle').textContent = scr;
  const pick = { all: OPTS, new: OPTS.slice(1) }[state.show] || OPTS;
  g.style.setProperty('--n', pick.length);
  g.innerHTML = pick.map(o => {
    const src = IMGS[`${o.id}-${state.screen}-${state.size}-${state.mode}`];
    return `<figure><figcaption>${o.n} ${o.name} <span>${state.mode}</span></figcaption>${src ? `<img src="${src}" alt="${o.name} design: ${scr} screen in ${state.mode} mode" loading="lazy">` : '<p>missing</p>'}</figure>`;
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
