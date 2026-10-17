#!/usr/bin/env python3
"""Builds design-previews/ui3/preview.html: one self-contained page (screenshots inlined as WebP), grouped by screen,
comparing the current design, the old Clinical (ui2) and Clinical A, B and C side by side.
Run after shoot.mjs:  python3 design-previews/ui3/build-preview.py"""
import base64, io, json, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
UIS = ['current', 'clinical', 'refined', 'compact', 'calm']
SCREENS = [('today', 'Today'), ('done', 'Today, all done'), ('front', 'Review, question'), ('back', 'Review, answer'), ('decks', 'Decks'), ('deck', 'Deck page'), ('stats', 'Stats'), ('settings', 'Settings')]
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
    {'id': 'current', 'n': '0', 'name': 'Current', 'tag': 'Today\'s app, for reference',
     'pitch': 'Dark-first, violet glow, gradient hero, glowing tab indicator and coloured edge stripes.', 'effort': ''},
    {'id': 'clinical', 'n': '1', 'name': 'Old Clinical', 'tag': 'Round 2, the one the owner liked',
     'pitch': 'White page, graphite text, the device\'s own font, hairlines instead of glows, one accent. Same layout as the app.', 'effort': ''},
    {'id': 'refined', 'n': 'A', 'name': 'Clinical refined', 'tag': 'The same app, tidied up',
     'pitch': 'Clinical with the rough edges taken off. Today is one summary panel (goal ring, figures, a one-line streak, Start on the right). Exams and decks are grouped lists split by thin lines instead of separate floating boxes. White sidebar, page in a 960 px column.',
     'effort': 'About 1 to 1.5 days. CSS only, apart from the shared changes listed below.'},
    {'id': 'compact', 'n': 'B', 'name': 'Clinical compact', 'tag': 'Dense, like an EHR or UpToDate',
     'pitch': 'Information first. On desktop a top bar replaces the sidebar. Today shows Due, Learning and New next to a big Start button. Exams, Today\'s decks and the Decks screen are tables with column headers. Review labels the question and answer, with one joined Again / Hard / Good / Easy bar. Smaller type and tighter rows.',
     'effort': 'About 2.5 to 3.5 days. Adds markup (the summary strip and table headers), and the deck tree and sync status need a new place on desktop.'},
    {'id': 'calm', 'n': 'C', 'name': 'Clinical calm', 'tag': 'Lots of white space, like a textbook',
     'pitch': 'A single centred column with no boxes, just text and thin lines. On desktop the sidebar starts as a slim icon rail. Review has no card frame: the question and answer sit on the page in a book serif (card text only, using the device\'s own serif, so nothing to download), and the ratings are quiet text buttons.',
     'effort': 'About 1.5 to 2 days. CSS only, plus a one-line change so the rail starts collapsed. Needs a check of long answers, cloze, maths and images in the serif.'},
]

data = json.dumps(imgs)
opts = json.dumps(OPTIONS)
screens = json.dumps(SCREENS)

html = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clinical Variants</title>
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
.grid.phone{grid-template-columns:repeat(var(--n,5),minmax(0,1fr))}
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
  <h1>Study Sprint: three Clinical options</h1>
  <p class="lede">The owner said Clinical beat Paper, and asked for it to go further and for more options to choose from. Here are three directions, A, B and C, shown next to the current app and the round-2 Clinical. Each one is a real stylesheet running on the live app (origin/main, v4.9) and screenshotted with seeded medical decks. None of them use gradients or glows. Every text colour passes WCAG AA in light and dark with all five accents (both the colour tokens and every visible text node were checked), and no screen scrolls sideways at 375 or 1440 px wide.</p>

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
    <div class="note"><h3>Shared by A, B and C</h3><ul>
      <li>One base layer (<code>clinical-base.css</code>, ~325 lines) plus one small variant file, all scoped under <code>html[data-ui="clinical"][data-var]</code>, so Classic is untouched.</li>
      <li><b>Small JS:</b> store <code>ui</code> with the theme, set <code>data-ui</code> and <code>data-var</code> in the head script and <code>applyTheme()</code>, a <b>Style</b> row in Settings, and the accent names Indigo, Blue, Teal, Rust and Plum.</li>
      <li><b>Done state (2 strings in <code>js/today.js</code>):</b> the headline reads "All done for today", and "Custom study" becomes a secondary <code>btn ghost</code> button labelled "Extra study".</li>
    </ul></div>
    <div class="note"><h3>DOM versus CSS only</h3><ul>
      <li><b>A:</b> CSS only (~95 lines).</li>
      <li><b>B:</b> ~285 lines of CSS, plus markup: a Due / Learning / New <code>&lt;dl&gt;</code> on Today (the learning count comes from the queue), and column-header rows above Today's decks and the Decks list. Desktop moves the sidebar into a top bar with CSS alone, but the deck tree and the sync status are hidden and need a new home.</li>
      <li><b>C:</b> ~165 lines of CSS. The only JS is a default: the sidebar rail starts collapsed (<code>study-sprint-rail</code> in <code>js/sidebar.js</code>) for new Clinical C users.</li>
    </ul></div>
    <div class="note"><h3>Checks</h3><ul>
      <li>Contrast: <code>node design-previews/ui3/contrast.mjs</code> (tokens: 0 failing pairs in 30 combinations) and the shoot script's rendered-text scan (no failures).</li>
      <li>Overflow: no horizontal scroll on any of the 160 screenshots.</li>
      <li>Screens are cropped to the first viewport (375 x 812 and 1440 x 900).</li>
    </ul></div>
  </div>
</div>
<script>
const IMGS = __IMGS__;
const OPTS = __OPTS__;
const SCREENS = __SCREENS__;
const state = { screen: 'today', mode: 'light', size: 'phone', show: 'all' };
try { Object.assign(state, JSON.parse(localStorage.getItem('ui3-preview') || '{}')); } catch (e) {}
const $ = id => document.getElementById(id);
$('opts').innerHTML = OPTS.map(o => `<div class="opt${o.id === 'refined' ? ' rec' : ''}"><h3><span class="n">${o.n}</span>${o.name}${o.id === 'refined' ? '<span class="rec-badge">Recommended</span>' : ''}</h3><div class="tag">${o.tag}</div><p>${o.pitch}</p>${o.effort ? `<div class="eff"><b>Effort:</b> ${o.effort}</div>` : ''}</div>`).join('');
function seg(id, key, items) {
  $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${state[key] === v}">${l}</button>`).join('');
  $(id).onclick = e => { const b = e.target.closest('button'); if (!b) return; state[key] = b.dataset.v; try { localStorage.setItem('ui3-preview', JSON.stringify(state)); } catch (err) {} draw(); };
}
function draw() {
  seg('segScreen', 'screen', SCREENS);
  seg('segMode', 'mode', [['light', 'Light'], ['dark', 'Dark']]);
  seg('segSize', 'size', [['phone', 'Phone 375'], ['desk', 'Desktop 1440']]);
  seg('segShow', 'show', [['all', 'All five'], ['new', 'A, B, C'], ['vs', 'Old Clinical + A, B, C']]);
  const g = $('grid'); g.className = 'grid ' + state.size;
  const scr = SCREENS.find(s => s[0] === state.screen)[1];
  $('scrTitle').textContent = scr;
  const pick = { all: OPTS, new: OPTS.slice(2), vs: OPTS.slice(1) }[state.show] || OPTS;
  g.style.setProperty('--n', pick.length);
  g.innerHTML = pick.map(o => {
    const src = IMGS[`${o.id}-${state.screen}-${state.size}-${state.mode}`];
    return `<figure><figcaption>${o.n}. ${o.name} <span>${state.mode}</span></figcaption>${src ? `<img src="${src}" alt="${o.name} design: ${scr} screen in ${state.mode} mode" loading="lazy">` : '<p>missing</p>'}</figure>`;
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
