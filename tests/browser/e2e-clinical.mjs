// The Clinical style (Settings → Appearance → Style). Switching it, keeping it after a reload, setting it before the first paint,
// and every key screen in Clinical at phone and desktop width, light and dark: no console errors, no sideways scroll, no gradient
// or glow, text that passes AA. Also checks that Original is left alone (Today's goal line is hidden there).
// Screenshots go to <out>/clinical-<screen>-<phone|desk>-<light|dark>.png.
// Run with: node tests/browser/run.mjs clinical     (SCENES=today,review SIZES=phone MODES=dark narrow it while working on the CSS)
import { chromium, realChromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const URL = process.env.APP_URL || 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
let skippedText = 0;     // text the contrast audit does not measure (hidden, aria-hidden, disabled, KaTeX), reported at the end
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = (p, tag) => {
  p.on('pageerror', e => errors.push(`${tag} pageerror ${e.message}`));
  // KaTeX comes from a CDN: a machine with no network just shows the formula as text, which is not what is tested here.
  p.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
};

// ---------------------------------------------------------------- the data
const PHARM = [['Mechanism of action of metformin', 'Decreases hepatic gluconeogenesis; increases peripheral insulin sensitivity (AMPK activation)'], ['First-line treatment for anaphylaxis', 'IM adrenaline 0.5 mg (1:1000) into the anterolateral thigh; repeat after 5 min if needed'], ['Antidote for warfarin overdose', 'Vitamin K (phytomenadione); prothrombin complex concentrate if major bleeding'], ['ACE inhibitor side effects', 'Dry cough, hyperkalaemia, angioedema, first-dose hypotension, renal impairment'], ['Loop diuretic site of action', 'Na-K-2Cl cotransporter in the thick ascending limb of the loop of Henle'], ['Digoxin toxicity signs', 'Nausea, xanthopsia, bradyarrhythmias, hyperkalaemia'], ['Beta-blocker contraindications', 'Asthma, second/third-degree heart block, acute decompensated heart failure'], ['Mechanism of statins', 'Inhibit HMG-CoA reductase, reducing hepatic cholesterol synthesis']];
const ANAT = [['Brachial plexus roots', 'C5 to T1 ventral rami'], ['Nerve damaged in wrist drop', 'Radial nerve'], ['Contents of the carpal tunnel', 'Median nerve and nine flexor tendons (FDS x4, FDP x4, FPL)'], ['Rotator cuff muscles', 'Supraspinatus, infraspinatus, teres minor, subscapularis'], ['Blood supply of the femoral head', 'Mainly medial circumflex femoral artery'], ['Boundaries of the femoral triangle', 'Inguinal ligament, sartorius, adductor longus']];
const PATHO = [['Virchow\'s triad', 'Stasis, endothelial injury, hypercoagulability'], ['Reed-Sternberg cells', 'Hodgkin lymphoma'], ['Caseating granulomas', 'Tuberculosis'], ['Most common site of colorectal cancer', 'Rectum and sigmoid colon'], ['Hallmark of acute inflammation', 'Neutrophil infiltration']];
const MICRO = [['Gram-positive cocci in clusters', 'Staphylococcus'], ['Causative organism of syphilis', 'Treponema pallidum'], ['Rice-water stools', 'Vibrio cholerae'], ['Owl\'s eye inclusions', 'Cytomegalovirus']];

// Four decks with a month of history. done = everything already scheduled for later and today's work finished.
async function seed(page, theme, done = false) {
  await page.evaluate(async ({ PHARM, ANAT, PATHO, MICRO, theme, done }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', theme);
    for (const id of ['sample', 'pharm', 'anat', 'path', 'micro', 'cloze', 'maths', 'image', 'occ']) await db.deleteDeck(id);
    const DAY = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * DAY); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const grow = (rows, n) => Array.from({ length: n }, (_, i) => rows[i % rows.length].map((s, k) => k === 0 && i >= rows.length ? `${s} (${Math.floor(i / rows.length) + 1})` : s));
    const mk = (deckId, rows) => rows.map(([f, b], i) => ({ id: deckId + i, deckId, front: f, back: b, tags: i % 3 ? [] : ['block-b'], created: i }));
    const decks = [
      [{ id: 'pharm', name: 'Pharmacology', course: 'MED 2 · Block B', color: '#3E63DD', created: now + 1, examDate: iso(9) }, mk('pharm', grow(PHARM, 64))],
      [{ id: 'anat', name: 'Upper & Lower Limb', course: 'Anatomy', color: '#46A758', created: now + 2 }, mk('anat', grow(ANAT, 48))],
      [{ id: 'path', name: 'General Pathology', course: 'MED 2 · Block B', color: '#E5484D', created: now + 3, examDate: iso(23) }, mk('path', grow(PATHO, 40))],
      [{ id: 'micro', name: 'Microbiology', course: 'MED 2', color: '#8E4EC6', created: now + 4 }, mk('micro', grow(MICRO, 36))]
    ];
    for (const [d, c] of decks) await db.addDeckWithCards(d, c);
    const cs = await db.getAll('cards');
    const states = cs.filter((_, i) => done || i % 5 !== 4).map((c, i) => ({ cardId: c.id, due: done ? now + (1 + i % 8) * DAY + 3 * 3600000 : now + ((i % 9) - 3) * DAY, stability: [1, 4, 12, 30, 60, 90][i % 6], difficulty: 3 + (i % 6), elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3 + i % 4, lapses: i % 7 === 0 ? 4 : i % 3, state: !done && i % 11 === 0 ? 1 : 2, lastReview: now - DAY }));
    await db.putMany('cardStates', states);
    const logs = [];
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    for (let d = 0; d < 60; d++) {
      if (d >= 3 && d % 5 === 0) continue;
      const n = d === 0 ? (done ? 64 : 8) : 8 + ((d * 7) % 31);
      for (let i = 0; i < n; i++) {
        const c = cs[(d * 3 + i) % cs.length];
        const ts = d === 0 ? midnight.getTime() + (now - midnight.getTime()) * (i + 1) / (n + 1) : now - d * DAY - i * 70000 - 3600000 * (d % 9) - 3600000;
        logs.push({ cardId: c.id, timestamp: ts, source: i % 4 === 0 ? 'play' : 'review', mode: 'flip', correct: (d + i) % 6 !== 0, ms: 3000 + (i % 5) * 1500, rating: [3, 3, 1, 2, 4, 3, 3][i % 7], state: 2, applied: true, reason: 'due' });
      }
    }
    await db.putMany('reviewLog', logs);
  }, { PHARM, ANAT, PATHO, MICRO, theme, done });
}

// Small decks for the kinds of card the big seed has none of: a cloze, a maths card, a picture card, an image occlusion.
async function seedKinds(page) {
  await page.evaluate(async () => {
    const db = await import('./js/db.js'), cz = await import('./js/cloze.js'), occ = await import('./js/occlusion.js');
    const now = Date.now();
    const png = async (w, h) => {
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d');
      g.fillStyle = '#e8ecf3'; g.fillRect(0, 0, w, h); g.fillStyle = '#4a6fa5'; g.beginPath(); g.ellipse(w / 2, h / 2, w * .3, h * .3, 0, 0, 7); g.fill();
      g.fillStyle = '#222'; g.font = `${h / 8}px sans-serif`; g.fillText('Aorta', w * .08, h * .2); g.fillText('Valve', w * .6, h * .9);
      return await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer();
    };
    const media = async (id, w, h) => { const data = await png(w, h); await db.putMedia({ id, type: 'image/png', data, size: data.byteLength, created: now, uploaded: false }); };
    for (const [id, name, color] of [['cloze', 'Cloze deck', '#3E63DD'], ['maths', 'Maths deck', '#46A758'], ['image', 'Picture deck', '#E5484D'], ['occ', 'Occlusion deck', '#8E4EC6']]) await db.saveDeck({ id, name, color, created: now + 10 });
    await db.saveNote(cz.planNoteSave([], 'The {{c1::mitochondria}} makes {{c2::ATP}} by oxidative phosphorylation across the inner membrane'), { deckId: 'cloze', noteId: 'n-cloze', tags: [] });
    await db.addDeckWithCards(await db.getDeck('maths'), [{ id: 'm1', deckId: 'maths', front: 'Solve for $x$: $x^2 - 5x + 6 = 0$', back: '$x = 2$ or $x = 3$, since $(x-2)(x-3)=0$', tags: [], created: 1 }]);
    await media('img-heart', 1200, 800);
    await db.addDeckWithCards(await db.getDeck('image'), [{ id: 'i1', deckId: 'image', front: 'Name this structure', back: 'Aortic valve', frontImage: 'img-heart', tags: [], created: 1 }]);
    await media('img-occ', 1600, 1000);
    const masks = [{ id: 'm1', n: 1, shape: 'rect', x: 0.06, y: 0.08, w: 0.2, h: 0.14, label: 'Aorta' }, { id: 'm2', n: 2, shape: 'rect', x: 0.58, y: 0.8, w: 0.2, h: 0.14, label: 'Valve' }];
    await db.saveNote(occ.planOcclusionSave([], { masks, header: 'Heart anatomy', w: 1600, h: 1000, image: 'img-occ' }), { deckId: 'occ', noteId: 'n-occ', tags: [] });
  });
}

// ---------------------------------------------------------------- the checks on every screen
// All of these run in the page, on what is really drawn.
async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { overflow: document.documentElement.scrollWidth - innerWidth, gradient: [], glow: [], contrast: [], skipped: 0 };
    const visible = el => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].slice(0, 2).map(c => '.' + c).join('')}`;
    const neutral = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return true; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2]) <= 30 || (v[3] ?? 1) === 0; };
    for (const el of document.querySelectorAll('body *, html, body')) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (pseudo && (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none')) continue;
        if (!pseudo && !visible(el)) continue;
        const bg = cs.backgroundImage + ' ' + cs.maskImage + ' ' + cs.borderImageSource;
        if (/gradient/.test(bg)) out.gradient.push(name(el) + (pseudo || '') + ' ' + bg.slice(0, 70));
        if (cs.textShadow !== 'none') out.glow.push(name(el) + ' text-shadow');
        if (/blur|drop-shadow/.test(cs.filter) || (cs.backdropFilter !== 'none' && cs.backdropFilter)) out.glow.push(name(el) + ' filter ' + cs.filter + cs.backdropFilter);
        if (cs.boxShadow !== 'none') for (const sh of cs.boxShadow.split(/,(?![^(]*\))/)) {
          const col = sh.match(/rgba?\([^)]*\)|color\([^)]*\)/)?.[0] || '';
          const nums = sh.replace(col, '').trim().split(/\s+/).map(parseFloat);
          if (nums[2] >= 8 && !neutral(col)) out.glow.push(name(el) + ' box-shadow ' + sh.trim().slice(0, 60));
        }
      }
    }
    // text against the solid colour behind it: AA (4.5, or 3 for large text)
    const parse = c => { const m = c.match(/^rgba?\(([^)]+)\)/); if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; }
      const n = c.match(/^color\(srgb ([^)]+)\)/); if (n) { const v = n[1].split(/[ /]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; } return null; };
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let o = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1]; for (const l of layers.reverse()) o = o.map((v, i) => i < 3 ? v * (1 - l[3]) + l[i] * l[3] : 1); return o; };
    const bad = new Set();
    for (let walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n; (n = walker.nextNode());) {
      const el = n.parentElement; if (!n.textContent.trim() || !el) continue;
      const b = el.getBoundingClientRect(); if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      if (el.closest('[hidden],[aria-hidden="true"],.sr-only,:disabled,[aria-disabled="true"],canvas,.katex-html')) { out.skipped++; continue; }      // exempt: not shown to anyone, disabled, or drawn by KaTeX
      if (el.matches('.cap')) continue;                  // a chart's peak label sits above its bar on the card (text-2 on surface-1, covered by the token check)
      let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;     // faded text is measured as it looks, not skipped
      const fg = parse(cs.color); if (!fg) continue; fg[3] *= op; const bg = bgOf(el);
      const f = fg.map((v, i) => i < 3 ? v * fg[3] + bg[i] * (1 - fg[3]) : 1);
      const [a, c] = [lum(f), lum(bg)].sort((x, y) => y - x); const ratio = (a + .05) / (c + .05);
      const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (big ? 3 : 4.5)) bad.add(`${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 28)}" <${name(el)}>`);
    }
    out.contrast = [...bad];
    return out;
  });
  skippedText += r.skipped;
  const dup = a => [...new Set(a)].slice(0, 6);
  ok(r.overflow <= 0, `${label}: no sideways scroll${r.overflow > 0 ? ' (' + r.overflow + 'px too wide)' : ''}`);
  ok(!r.gradient.length, `${label}: no gradient${r.gradient.length ? ': ' + dup(r.gradient).join(' | ') : ''}`);
  ok(!r.glow.length, `${label}: no glow, text shadow or blur${r.glow.length ? ': ' + dup(r.glow).join(' | ') : ''}`);
  ok(!r.contrast.length, `${label}: text is AA${r.contrast.length ? ': ' + r.contrast.slice(0, 6).join(' | ') : ''}`);
}

// ---------------------------------------------------------------- 1. switching the style
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage(); watch(page, 'switch');
  await page.goto(URL + '#/settings'); await page.waitForSelector('#skins');
  const html = () => page.evaluate(() => ({ ui: document.documentElement.dataset.ui, skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme }));
  ok((await html()).ui === 'original', 'a fresh install is Original');
  ok(await page.locator('#uiChips input[name=ui]').count() === 2 && (await page.locator('#uiChips .chip').allTextContents()).join() === 'Original,Clinical', 'Settings → Appearance has Style: Original | Clinical');
  ok((await page.textContent('#thTitle')) === 'Theme' && (await page.locator('#skins .nm').allTextContents()).join() === 'Violet,Ocean,Forest,Ember,Rose', 'Original: "Theme" with Violet, Ocean, Forest, Ember, Rose');
  const originalGoal = await page.evaluate(() => { const g = document.createElement('span'); g.className = 'goal'; document.body.append(g); const d = getComputedStyle(g).display; g.remove(); return d; });
  ok(originalGoal === 'none', 'Original: the goal line is hidden');
  await page.locator('#uiChips .chip', { hasText: 'Clinical' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.ui === 'clinical');
  ok((await page.textContent('#thTitle')) === 'Accent colour' && (await page.locator('#skins .nm').allTextContents()).join() === 'Indigo,Blue,Green,Rust,Plum', 'Clinical: "Accent colour" with Indigo, Blue, Green, Rust, Plum');
  ok(await page.isChecked('#uiChips input[value=clinical]'), 'the Clinical chip is selected');
  await page.locator('#skins .skin', { hasText: 'Green' }).click();
  ok((await html()).skin === 'forest', 'choosing Green sets the forest accent');
  await page.locator('input[name=mode][value=light]').check({ force: true });
  ok((await html()).theme === 'light', 'Light still works in Clinical');
  await page.locator('input[name=mode][value=auto]').check({ force: true });
  ok(['light', 'dark'].includes((await html()).theme), 'Match my device still works in Clinical');
  const saved = await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).theme);
  ok(saved.ui === 'clinical' && saved.skin === 'forest' && saved.mode === 'auto', 'the choice is saved with the theme: ' + JSON.stringify(saved));
  ok(JSON.parse(await page.evaluate(() => localStorage.getItem('study-sprint-theme'))).ui === 'clinical', "and in the device copy the page reads before it draws");

  // Every accent works as the focus ring colour: 3:1 against the page, light and dark (WCAG 1.4.11)
  const ratios = await page.evaluate(() => {
    const root = document.documentElement, keep = ['data-ui', 'data-skin', 'data-theme'].map(a => [a, root.getAttribute(a)]);
    const hex = c => { const m = c.trim().match(/^#([0-9a-f]{6})$/i); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
    const lum = v => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; return .2126 * f(v[0]) + .7152 * f(v[1]) + .0722 * f(v[2]); };
    const out = [];
    root.setAttribute('data-ui', 'clinical');
    for (const mode of ['light', 'dark']) for (const skin of ['violet', 'ocean', 'forest', 'ember', 'rose']) {
      root.setAttribute('data-theme', mode); root.setAttribute('data-skin', skin);
      const cs = getComputedStyle(root), a = hex(cs.getPropertyValue('--accent')), bg = hex(cs.getPropertyValue('--bg')), s1 = hex(cs.getPropertyValue('--surface-1'));
      const ratio = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((p, q) => q - p); return (h + .05) / (l + .05); };
      out.push({ mode, skin, page: a && bg ? ratio(a, bg) : 0, card: a && s1 ? ratio(a, s1) : 0 });
    }
    for (const [a, v] of keep) if (v === null) root.removeAttribute(a); else root.setAttribute(a, v);
    return out;
  });
  ok(ratios.length === 10 && ratios.every(r => r.page >= 3 && r.card >= 3), 'every accent is at least 3:1 against the page and the card as a focus colour: ' + ratios.map(r => `${r.skin}/${r.mode} ${r.page.toFixed(1)}`).join(', '));

  // After a reload it is still Clinical
  await page.reload(); await page.waitForSelector('#skins');
  ok((await html()).ui === 'clinical' && await page.isChecked('#uiChips input[value=clinical]'), 'still Clinical after a reload');
  // No flash: the head script sets it before anything else runs. Block every script of the app and look at the page.
  const p2 = await ctx.newPage(); watch(p2, 'flash');
  await p2.route('**/js/**', r => r.abort());
  await p2.goto(URL + '#/today', { waitUntil: 'domcontentloaded' });
  ok(await p2.evaluate(() => document.documentElement.dataset.ui === 'clinical' && document.documentElement.dataset.skin === 'forest' && !!document.documentElement.dataset.theme), 'data-ui is already set when none of the app has run (before first paint)');
  await p2.close();
  // Back to Original: nothing of Clinical is left
  await page.locator('#uiChips .chip', { hasText: 'Original' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.ui === 'original');
  ok((await page.textContent('#thTitle')) === 'Theme' && (await page.locator('#skins .nm').allTextContents()).join() === 'Violet,Ocean,Forest,Ember,Rose', 'back to Original: "Theme" and the old names');
  // An old saved theme without ui is Original; a junk one too
  const cleaned = await page.evaluate(async () => { const t = await import('./js/themes.js'); return [t.cleanTheme({ skin: 'ocean', mode: 'light' }).ui, t.cleanTheme({ ui: 'weird' }).ui, t.cleanTheme({ ui: 'clinical' }).ui, t.cleanTheme(null).ui]; });
  ok(cleaned.join() === 'original,original,clinical,original', 'cleanTheme: no ui or an unknown one is original');
  await ctx.close();
}

// ---------------------------------------------------------------- 2. a brand-new install in Clinical (first run)
{
  for (const [size, w, h] of [['phone', 375, 812], ['desk', 1440, 900]]) for (const mode of ['light', 'dark']) {
    if (process.env.SCENES && !process.env.SCENES.includes('welcome')) continue;
    if (process.env.SIZES && !process.env.SIZES.includes(size)) continue;
    if (process.env.MODES && !process.env.MODES.includes(mode)) continue;
    const ctx = await realChromium.launch().then(b => b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: size === 'phone' ? 2 : 1, isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block', reducedMotion: 'reduce' }));
    await ctx.addInitScript(m => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode: m })); } catch { /* fine */ } }, mode);
    const page = await ctx.newPage(); watch(page, 'welcome');
    await page.goto(URL); await page.waitForSelector('#wlNext');
    await page.evaluate(async m => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui: 'clinical', skin: 'ocean', mode: m, oled: false }); }, mode);
    await page.reload(); await page.waitForSelector('#wlNext');
    await page.waitForTimeout(250);
    ok(await page.evaluate(() => document.documentElement.dataset.ui === 'clinical'), `first run (${size} ${mode}) opens in Clinical`);
    await page.screenshot({ path: `${SP}/clinical-welcome-${size}-${mode}.png` });
    await audit(page, `first run ${size} ${mode}`);
    // step through: name form, how to add cards
    await page.click('#wlNext'); await page.waitForSelector('#wlForm');
    await page.fill('#wlName', 'Cell Biology');
    await page.screenshot({ path: `${SP}/clinical-welcome2-${size}-${mode}.png` });
    await audit(page, `first run form ${size} ${mode}`);
    await page.click('#wlForm button[type=submit]'); await page.waitForSelector('#wlSample');
    await page.screenshot({ path: `${SP}/clinical-welcome3-${size}-${mode}.png` });
    await audit(page, `first run choices ${size} ${mode}`);
    await ctx.browser().close();
  }
}

// ---------------------------------------------------------------- 3. every screen
const SIZES = { phone: [375, 812, 2], desk: [1440, 900, 1] };
const only = k => process.env[k] ? new Set(process.env[k].split(',')) : null;
const wantScene = only('SCENES'), wantSize = only('SIZES'), wantMode = only('MODES');
const flip = async p => { await p.keyboard.press('Space'); await p.waitForSelector('.rate'); };

// Tab to the first element matching `sel` and check its focus ring is really drawn: it has an outline, and the ring (outline plus offset)
// stays inside whatever clips it (the grouped lists use overflow:hidden).
async function focusRing(page, sel, what) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  let hit = false;
  for (let i = 0; i < 80 && !hit; i++) { await page.keyboard.press('Tab'); hit = await page.evaluate(s => !!document.activeElement?.matches(s), sel); }
  ok(hit, `${what}: reachable with Tab`);
  const r = await page.evaluate(() => {
    const el = document.activeElement, cs = getComputedStyle(el), b = el.getBoundingClientRect();
    const w = parseFloat(cs.outlineWidth) || 0, off = parseFloat(cs.outlineOffset) || 0, grow = w + off;     // how far the ring reaches beyond the box (negative: inside)
    let clip = null; for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) if (getComputedStyle(e).overflow !== 'visible') { clip = e; break; }
    const c = clip ? clip.getBoundingClientRect() : { left: 0, top: -1e9, right: innerWidth, bottom: 1e9 };
    return { style: cs.outlineStyle, w, off, clipped: !!clip, inside: b.left - grow >= c.left - .5 && b.right + grow <= c.right + .5 && b.top - grow >= c.top - .5 && b.bottom + grow <= c.bottom + .5 };
  });
  ok(r.style !== 'none' && r.w >= 2, `${what}: focus shows an outline (${r.style} ${r.w}px)`);
  ok(r.inside, `${what}: the focus ring is inside the box that clips it${r.clipped ? '' : ' (nothing clips it)'}`);
}

// Each scene: set the page up, then it is shot and audited. `data` says which seed it needs.
const SCENES = [
  { n: 'today', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('.tdeck'); } },
  { n: 'collapsed', desktop: true, run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#sideCollapse'); await p.click('#sideCollapse'); await p.waitForFunction(() => document.documentElement.dataset.rail === 'on'); await p.$eval('#sideCollapse', b => b.blur()); },
    after: async p => { await p.evaluate(() => localStorage.setItem('study-sprint-rail', '0')); await p.reload(); await p.waitForSelector('.tdeck'); await p.waitForFunction(() => document.documentElement.dataset.rail !== 'on'); } },
  { n: 'focus-today', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('.tdeck'); await focusRing(p, '.tdeck', 'a Today deck row'); } },
  { n: 'focus-decks', run: async p => { await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await focusRing(p, '.decks .deck-open, .decks .deck-go', 'a Decks row'); } },
  { n: 'focus-exam', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('.exam-row'); await focusRing(p, '.exams a, .exams button', 'an exam row'); } },
  { n: 'done', data: 'done', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('.th-done'); } },
  { n: 'today-sheet', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('[data-addexam]'); await p.click('[data-addexam]'); await p.waitForSelector('dialog[open]'); }, after: p => p.keyboard.press('Escape') },
  { n: 'options', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#optBtn'); await p.click('#optBtn'); await p.waitForSelector('dialog[open]'); }, after: p => p.keyboard.press('Escape') },
  { n: 'streak', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#streakBtn'); await p.click('#streakBtn'); await p.waitForSelector('dialog[open]'); }, after: p => p.keyboard.press('Escape') },
  { n: 'review-front', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.waitForTimeout(250); }, after: p => p.goto(URL + '#/today') },
  { n: 'review', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); await flip(p); await p.waitForTimeout(250); }, after: p => p.goto(URL + '#/today') },
  { n: 'review-scratch', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#scratchBtn'); await p.click('#scratchBtn'); await p.waitForSelector('.scratch-tools, canvas.scratch'); await p.waitForTimeout(250); }, after: p => p.goto(URL + '#/today') },
  { n: 'decks', run: async p => { await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); } },
  { n: 'deck', run: async p => { await p.goto(URL + '#/deck/pharm'); await p.waitForSelector('.crow'); await p.waitForTimeout(300); } },
  { n: 'deck-menu', run: async p => { await p.goto(URL + '#/deck/pharm'); await p.waitForSelector('#deckMore'); await p.click('#deckMore'); await p.waitForSelector('#deckMenu:not([hidden])'); }, after: p => p.keyboard.press('Escape') },
  { n: 'browse', run: async p => { await p.goto(URL + '#/browse'); await p.waitForSelector('.crow'); await p.waitForTimeout(250); } },
  { n: 'card-editor', run: async p => { await p.goto(URL + '#/deck/pharm'); await p.waitForSelector('.crow'); await p.locator('.crow').first().click(); await p.waitForSelector('#ceFront'); await p.waitForTimeout(250); }, after: p => p.keyboard.press('Escape') },
  { n: 'add-card', run: async p => { await p.goto(URL + '#/deck/pharm'); await p.waitForSelector('#brAdd'); await p.click('#brAdd'); await p.waitForSelector('#acForm'); await p.waitForTimeout(250); }, after: p => p.keyboard.press('Escape') },
  { n: 'deck-editor', run: async p => { await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.click('#newDeck'); await p.waitForSelector('dialog[open] #sheetTitle'); }, after: p => p.keyboard.press('Escape') },
  { n: 'import', run: async p => { await p.goto(URL + '#/import'); await p.waitForSelector('#pasteBox'); await p.fill('#pasteBox', 'Question one\tAnswer one\nQuestion two\tAnswer two'); await p.waitForTimeout(400); } },
  { n: 'stats', run: async p => { await p.goto(URL + '#/stats'); await p.waitForSelector('main h1'); await p.waitForTimeout(800); } },
  { n: 'settings', run: async p => { await p.goto(URL + '#/settings'); await p.waitForSelector('#skins'); } },
  { n: 'settings-more', run: async p => { await p.goto(URL + '#/settings'); await p.waitForSelector('#skins'); await p.locator('#studyTitle').scrollIntoViewIfNeeded(); await p.waitForTimeout(150); } },
  { n: 'play', run: async p => { await p.goto(URL + '#/play'); await p.waitForSelector('#startBtn'); } },
  { n: 'play-round', run: async p => { await p.goto(URL + '#/play'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#pCard'); await p.waitForTimeout(250); }, after: async p => { await p.goto(URL + '#/today'); } },
  { n: 'play-correct', run: async p => { await p.goto(URL + '#/play'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#pCard'); await p.keyboard.press('1'); await p.waitForSelector('.fb'); await p.waitForTimeout(250); }, after: async p => { await p.goto(URL + '#/today'); } },
  { n: 'play-results', run: async p => {
      await p.goto(URL + '#/play'); await p.waitForSelector('#startBtn');
      for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
      const backs = await p.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cards')).map(c => [c.front, c.back])));
      await p.click('#startBtn'); await p.waitForSelector('#pCard');
      for (let i = 0; i < 10; i++) {
        await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
        const prompt = (await p.textContent('#pPrompt')).trim();
        const right = await p.evaluate(a => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent.trim() === a), backs[prompt]);
        await p.keyboard.press(String(((i < 7 ? Math.max(right, 0) : (right + 1) % 4) % 4) + 1));
        await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
      }
      await p.waitForSelector('.res-head'); await p.waitForTimeout(500);
    }, after: p => p.goto(URL + '#/today') },
  { n: 'cloze', data: 'kinds', run: async p => { await p.goto(URL + '#/review/cloze'); await p.waitForSelector('#flash'); await p.waitForTimeout(250); }, after: p => p.goto(URL + '#/today') },
  { n: 'cloze-back', data: 'kinds', run: async p => { await p.goto(URL + '#/review/cloze'); await p.waitForSelector('#flash'); await flip(p); await p.waitForTimeout(250); }, after: p => p.goto(URL + '#/today') },
  { n: 'maths', data: 'kinds', run: async p => { await p.goto(URL + '#/review/maths'); await p.waitForSelector('#flash'); await flip(p); await p.waitForTimeout(900); }, after: p => p.goto(URL + '#/today') },
  { n: 'image', data: 'kinds', run: async p => { await p.goto(URL + '#/review/image'); await p.waitForSelector('#flash img'); await flip(p); await p.waitForTimeout(300); }, after: p => p.goto(URL + '#/today') },
  { n: 'occlusion', data: 'kinds', run: async p => { await p.goto(URL + '#/review/occ'); await p.waitForSelector('.occ-img[src]'); await p.waitForTimeout(400); }, after: p => p.goto(URL + '#/today') },
  { n: 'occlusion-back', data: 'kinds', run: async p => { await p.goto(URL + '#/review/occ'); await p.waitForSelector('.occ-img[src]'); await flip(p); await p.waitForTimeout(400); }, after: p => p.goto(URL + '#/today') },
  { n: 'occlusion-editor', data: 'kinds', run: async p => { await p.goto(URL + '#/deck/occ'); await p.waitForSelector('.crow'); await p.locator('.crow').first().click();
      await p.click('[data-occ-edit]'); await p.waitForSelector('dialog.occ-ed[open] .occ-ed-mask'); await p.waitForTimeout(600); }, after: p => p.keyboard.press('Escape') },
  { n: 'toast', run: async p => { await p.goto(URL + '#/today'); await p.waitForSelector('.tdeck'); await p.evaluate(async () => (await import('./js/ui.js')).toast('Saved. Three new cards a day.')); await p.waitForSelector('#toast:not([hidden])'); await p.waitForTimeout(200); } },
];

for (const [size, [w, h, scale]] of Object.entries(SIZES)) for (const mode of ['light', 'dark']) {
  if (wantSize && !wantSize.has(size) || wantMode && !wantMode.has(mode)) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, isMobile: w < 800, hasTouch: w < 800, serviceWorkers: 'block' });
  await ctx.addInitScript(([mode]) => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode })); localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ } }, [mode]);
  const page = await ctx.newPage(); watch(page, `${size} ${mode}`);
  await page.goto(URL); await page.waitForSelector('.today-hero');
  const theme = { ui: 'clinical', skin: 'ocean', mode, oled: false };
  await seed(page, theme); await page.reload(); await page.waitForSelector('.tdeck', { state: 'attached' });
  ok(await page.evaluate(() => document.documentElement.dataset.ui === 'clinical'), `${size} ${mode}: running in Clinical`);
  let have = 'normal';
  for (const sc of SCENES) {
    if (wantScene && !wantScene.has(sc.n)) continue;
    if (sc.desktop && size !== 'desk') continue;
    const need = sc.data || 'normal';
    if (need !== have) {
      if (have === 'kinds') { /* kinds decks stay; the big seed is rebuilt only for 'done' */ }
      if (need === 'done') { await seed(page, theme, true); }
      else if (need === 'kinds') { await page.evaluate(async () => { /* make sure Today is not in the way */ }); await seedKinds(page); }
      else if (have === 'done') { await seed(page, theme, false); }
      have = need === 'kinds' ? 'kinds' : need;
      await page.goto(URL + '#/decks'); await page.waitForSelector('.deck', { state: 'attached' }).catch(() => {});
    }
    try { await sc.run(page); } catch (e) { if (sc.optional) continue; ok(false, `${size} ${mode} ${sc.n}: could not be set up (${e.message.split('\n')[0]})`); await page.goto(URL + '#/today').catch(() => {}); continue; }
    await page.mouse.move(1, 1);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SP}/clinical-${sc.n}-${size}-${mode}.png` });
    await audit(page, `${sc.n} ${size} ${mode}`);
    if (sc.after) await sc.after(page);
    await page.waitForTimeout(100);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- 4. wide desktop layout (owner's desktop review)
// Pages are centred next to the sidebar, Today's Options button lines up with the content under it, the "Add exam date"
// chips wrap instead of being cut off, and the sidebar footer is always fully on screen.
for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440]]) for (const mode of ['light', 'dark']) {
  if (wantSize && !wantSize.has('desk') || wantMode && !wantMode.has(mode) || wantScene && !wantScene.has('wide')) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(m => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode: m })); localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ } }, mode);
  const page = await ctx.newPage(); watch(page, `wide ${w} ${mode}`);
  await page.goto(URL); await page.waitForSelector('.today-hero');
  await seed(page, { ui: 'clinical', skin: 'ocean', mode, oled: false });
  // courses with long names and no exam date, so the "Add exam date" row has more than fits on one line
  await page.evaluate(async () => {
    const db = await import('./js/db.js'), now = Date.now();
    for (const [id, name] of [['long1', 'Intro to Psychology (sample deck) with a long name'], ['long2', 'Microbiology and Infectious Diseases, Part Two'], ['long3', 'Upper & Lower Limb Anatomy — Muscles, Nerves and Blood Supply']])
      await db.addDeckWithCards({ id, name, color: '#F76B15', created: now + 50 }, [{ id: id + 'c', deckId: id, front: 'Q', back: 'A', tags: [], created: 1 }]);
    // two subdecks under Pharmacology, so its page has a Subdecks card
    for (const [id, name] of [['sub1', 'Cardiovascular drugs'], ['sub2', 'Antimicrobials']])
      await db.addDeckWithCards({ id, name, parentId: 'pharm', color: '#3E63DD', created: now + 60 }, [{ id: id + 'c', deckId: id, front: 'Q', back: 'A', tags: [], created: 1 }]);
  });
  await page.reload(); await page.waitForSelector('.tdeck', { state: 'attached' });
  const tag = `wide ${w}×${h} ${mode}`;
  const layout = () => page.evaluate(() => {
    const main = document.querySelector('main'), view = main.querySelector(':scope > .view'), mb = main.getBoundingClientRect(), vb = view.getBoundingClientRect(), cs = getComputedStyle(main);
    const inner = [mb.left + parseFloat(cs.paddingLeft), mb.right - parseFloat(cs.paddingRight)];
    const head = view.querySelector(':scope > .screen-head');
    const right = Math.max(...[...view.children].filter(c => c !== head && c.getBoundingClientRect().width).map(c => c.getBoundingClientRect().right));
    const opt = document.getElementById('optBtn')?.getBoundingClientRect();
    const ea = document.querySelector('.exam-add');
    const foot = document.querySelector('.side-foot').getBoundingClientRect();
    const footLast = Math.max(...[...document.querySelectorAll('.side-foot *')].map(e => e.getBoundingClientRect().bottom));
    const side = document.querySelector('.today-side')?.getBoundingClientRect(), hero = document.querySelector('.today-hero')?.getBoundingClientRect();
    return { side: side && side.width ? [Math.round(side.left), Math.round(side.top)] : null, hero: hero && [Math.round(hero.right), Math.round(hero.top)], gapL: Math.round(vb.left - inner[0]), gapR: Math.round(inner[1] - vb.right), right: Math.round(right), opt: opt && Math.round(opt.right), chips: ea && [ea.scrollWidth, ea.clientWidth],
      chipsCut: ea ? [...ea.querySelectorAll('.exam-chip')].some(c => c.getBoundingClientRect().right > ea.getBoundingClientRect().right + 1) : false,
      foot: [Math.round(foot.top), Math.round(Math.max(foot.bottom, footLast)), innerHeight], hscroll: document.documentElement.scrollWidth - innerWidth };
  });
  for (const [route, sel] of [['today', '.tdeck'], ['decks', '.deck'], ['deck/pharm', '.crow'], ['stats', 'main h1'], ['settings', '#skins'], ['play', '#startBtn']]) {
    await page.goto(URL + '#/' + route); await page.waitForSelector(sel); await page.waitForTimeout(150);
    const r = await layout();
    ok(Math.abs(r.gapL - r.gapR) <= 2, `${tag} ${route}: the page is centred next to the sidebar (${r.gapL}px left, ${r.gapR}px right)`);
    if (w >= 1920) ok(r.gapL > 0, `${tag} ${route}: the page is narrower than the space next to the sidebar, so the centring is real (${r.gapL}px each side)`);
    ok(r.hscroll <= 0, `${tag} ${route}: no sideways scroll`);
    if (route === 'today') {
      ok(r.opt && Math.abs(r.opt - r.right) <= 1, `${tag}: Options lines up with the right edge of the content under it (${r.opt} vs ${r.right})`);
      if (w >= 1280) ok(r.side && r.hero && r.side[0] > r.hero[0] && Math.abs(r.side[1] - r.hero[1]) < 40, `${tag}: exams sit in a column to the right of the day's work (side ${r.side}, hero right/top ${r.hero})`);
      ok(r.chips && r.chips[0] <= r.chips[1] && !r.chipsCut, `${tag}: the "Add exam date" chips are not cut off (scrollWidth ${r.chips?.[0]} ≤ clientWidth ${r.chips?.[1]})`);
      if (w === 1440) await page.screenshot({ path: `${SP}/clinical-wide-today-${w}-${mode}.png` });
    }
    if (w === 1440 && route === 'today') ok(r.foot[0] >= 0 && r.foot[1] <= r.foot[2], `${tag}: the sidebar footer is fully in the window (${r.foot[0]}-${r.foot[1]} of ${r.foot[2]})`);
  }
  if (w === 1920) {
    // Settings at a wide size: the in-page confirm's buttons are their own size, and switches sit beside their labels
    await page.goto(URL + '#/settings'); await page.waitForSelector('#advanced');
    await page.evaluate(() => { document.getElementById('advanced').open = true; document.getElementById('optConfirm').hidden = false; });
    const st = await page.evaluate(() => { const v = document.querySelector('main > .view').getBoundingClientRect(); const sw = [...document.querySelectorAll('#advanced .switch')].map(e => e.getBoundingClientRect().right);
      return { btns: ['optNo', 'optYes'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().width)), sw: Math.max(...sw), viewW: Math.round(v.width), viewR: Math.round(v.right) }; });
    ok(st.btns.every(x => x > 0 && x <= 200), `${tag}: the in-page confirm's buttons are not stretched (${st.btns.join(', ')}px)`);
    ok(st.viewW <= 980 && st.sw <= st.viewR + 1, `${tag}: Settings is a readable column (${st.viewW}px) and its switches sit inside it`);
    // Every control in a Settings row is within about 120px of its label: the gap between the control's box and the box of
    // the nearest label text in the same row (the row's name, or a select's own day name). Text boxes come from a Range,
    // so a description that wraps across the row does not count as "next to" a switch at the far edge.
    await page.evaluate(() => { for (const d of document.querySelectorAll('main details')) d.open = true; });
    const far = await page.evaluate(() => {
      const textBox = el => { const r = document.createRange(); r.selectNodeContents(el); const rs = [...r.getClientRects()].filter(x => x.width && x.height);
        return rs.length ? { left: Math.min(...rs.map(x => x.left)), right: Math.max(...rs.map(x => x.right)), top: Math.min(...rs.map(x => x.top)), bottom: Math.max(...rs.map(x => x.bottom)) } : null; };
      const gap = (a, b) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
      const out = []; let rows = 0, controls = 0;
      for (const row of document.querySelectorAll('main .set-row, main .adv-row')) {
        if (!row.getClientRects().length || row.closest('[hidden]')) continue;
        rows++;
        const labels = [...row.querySelectorAll('b, label > span:first-child, .easy-day > span, .confirm > p')].map(textBox).filter(Boolean);
        for (const c of row.querySelectorAll('input.switch, .stepper, .num-box, select, .steps-input input, button.btn, label.btn')) {
          const b = c.getBoundingClientRect(); if (!b.width || c.closest('[hidden]')) continue;
          controls++;
          const d = Math.min(...labels.map(l => gap(b, l)));
          if (!(d <= 120)) out.push(`${(row.querySelector('b')?.textContent || '?').trim().slice(0, 24)}: ${c.id || c.className} ${Math.round(d)}px`);
        }
      }
      return { out, rows, controls };
    });
    ok(far.rows >= 20 && far.controls >= 25, `${tag}: the Settings check measured ${far.rows} rows and ${far.controls} controls`);
    ok(!far.out.length, `${tag}: every Settings control is within 120px of its label${far.out.length ? ': ' + far.out.slice(0, 6).join(' | ') : ''}`);
    // the in-page confirm sits under its question, not at the far edge of a full-width box
    await page.evaluate(() => { document.getElementById('optConfirm').hidden = false; });
    const cf = await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('optConfirmQ')); const q = r.getBoundingClientRect();
      return { q: [q.width, q.height], btns: ['optNo', 'optYes'].map(id => { const y = document.getElementById(id).getBoundingClientRect();
        return { w: y.width, dx: Math.round(Math.max(0, y.left - q.right, q.left - y.right)), dy: Math.round(y.top - q.bottom) }; }) }; });
    // each button is under the question (starts below it, at most 40px down) or on its line, and at most 120px across from its text
    ok(cf.q[0] > 0 && cf.btns.every(b => b.w > 0 && b.dx <= 120 && b.dy <= 40), `${tag}: the confirm's buttons are next to its question (${JSON.stringify(cf.btns)})`);
    // "Couldn't load this screen": the Reload button is an ordinary button, not the browser's grey face
    const rl = await page.evaluate(() => { const el = document.querySelector('main > .view'); el.innerHTML = '<div class="empty"><b>Could not load this screen.</b><br><button class="btn" type="button" data-reload>Reload</button></div>';
      const b = getComputedStyle(el.querySelector('[data-reload]')), probe = document.createElement('i'); probe.style.background = 'var(--surface-1)'; document.body.append(probe); const s1 = getComputedStyle(probe).backgroundColor; probe.remove(); return [b.backgroundColor, s1]; });
    ok(rl[0] === rl[1], `${tag}: the Reload button on a failed screen has the card colour (${rl[0]})`);
  }
  // The deck page from 1600px: name, buttons and counts on the left, the Subdecks card above the cards on the right, and the
  // counts panel stays in view while the cards scroll
  if (w >= 1600) {
    await page.goto(URL + '#/deck/pharm'); await page.waitForSelector('.crow'); await page.waitForSelector('.subdecks-page'); await page.waitForTimeout(150);
    const box = sel => page.evaluate(s => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; }, sel);
    const [head, sum, sub, list] = [await box('main > .view > .screen-head'), await box('main > .view > .deck-summary'), await box('main > .view > .subdecks-page'), await box('#browser')];
    ok(head && sum && sub && list && sub.w > 0 && list.w > 0, `${tag} deck page: header, counts, subdecks and cards are all there`);
    ok(head.r <= list.l && sum.r <= list.l && sum.t >= head.b - 1, `${tag} deck page: name, buttons and counts in the left column (head ${head.l}-${head.r}, counts ${sum.l}-${sum.r}, cards from ${list.l})`);
    ok(sub.l === list.l && sub.b <= list.t + 1 && sub.t < 200, `${tag} deck page: the Subdecks card is at the top of the right column, above the cards (subdecks ${sub.t}-${sub.b}, cards from ${list.t})`);
    const stick = await page.evaluate(async () => { const s = document.querySelector('main > .view > .deck-summary'); scrollTo(0, 1500); await new Promise(r => setTimeout(r, 200));
      const b = s.getBoundingClientRect(); const y = scrollY; scrollTo(0, 0); return { pos: getComputedStyle(s).position, top: Math.round(b.top), bottom: Math.round(b.bottom), y, h: innerHeight }; });
    ok(stick.pos === 'sticky' && stick.y > 0 && stick.top >= 0 && stick.bottom <= stick.h, `${tag} deck page: the counts panel stays in view when the cards are scrolled (${JSON.stringify(stick)})`);
  }
  // No exam dates at all: Today is one column, and Options still sits over its right edge
  await page.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getAll('decks')) if (d.examDate) await db.saveDeck({ ...d, examDate: null }); });
  await page.goto(URL + '#/decks'); await page.waitForSelector('.deck'); await page.goto(URL + '#/today'); await page.waitForSelector('.tdeck'); await page.waitForTimeout(150);
  { const r = await layout(); ok(!await page.$('.exams') && r.opt && Math.abs(r.opt - r.right) <= 1 && Math.abs(r.gapL - r.gapR) <= 2, `${tag}: with no exams, Options lines up with the content (${r.opt} vs ${r.right}) and the page is centred`); }
  // A short window: the footer still shows whole (the deck list gives way, or the menu scrolls)
  if (w === 1440) {
    await page.setViewportSize({ width: 1440, height: 520 }); await page.goto(URL + '#/today'); await page.waitForSelector('.tdeck');
    const r = await layout();
    ok(r.foot[0] >= 0 && r.foot[1] <= r.foot[2], `${tag}: at 1440×520 the sidebar footer is still fully in the window (${r.foot[0]}-${r.foot[1]} of ${r.foot[2]})`);
  }
  await ctx.close();
}

console.log(`info: the contrast audit left out ${skippedText} text nodes that are hidden from users (aria-hidden, disabled, KaTeX); all other visible text was measured, faded text included`);
ok(!errors.length, 'no console errors on any screen' + (errors.length ? ': ' + [...new Set(errors)].slice(0, 5).join(' | ') : ''));
await browser.close();
