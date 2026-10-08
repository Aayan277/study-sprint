// Study Sprint: starts the app, switches between screens, and draws the Settings screen.
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML } from './themes.js';
import { renderLibrary, renderDeck } from './decks.js';
import { renderImport } from './import-screen.js';
import { SAMPLE_DECK } from './sample.js';
import { SCHED_DEFAULTS, MAX_INTERVAL_PRESETS, parseSteps, formatSteps, parseMaxInterval, stepShort, stepWords, sortSteps, explainSteps } from './sched-settings.js';
import { $, esc, plural, toast, openSheet, closeSheet, initSheet, initTapGuard } from './ui.js';
import { renderPlay } from './play.js';
import { renderStats } from './stats.js';

// Shown at the bottom of Settings, so you can tell whether your phone has the newest version.
const APP_VERSION = '1.2';

let settings = { ...db.DEFAULT_SETTINGS };

// ---------- settings ----------
async function renderSettings(el) {
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const { skin, mode } = settings.theme;
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">SETTINGS</span><h1>Settings</h1></div></div>

    <section class="section" aria-labelledby="thTitle">
      <h2 id="thTitle">Theme</h2>
      <div class="skins" id="skins">${skinButtonsHTML(skin)}</div>
    </section>

    <section class="section" aria-labelledby="apTitle">
      <h2 id="apTitle">Light or dark</h2>
      <div class="chips" role="radiogroup" aria-labelledby="apTitle">
        ${[['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
          `<label class="chip"><input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <p class="note">Neon and Onyx are always dark.</p>
    </section>

    <section class="section" aria-labelledby="studyTitle">
      <h2 id="studyTitle">Study</h2>
      <div class="set-row">
        <div><b>New cards per day</b><p>Across all decks. Due reviews are never limited.</p></div>
        <div class="stepper">
          <button type="button" class="icon-btn" id="npdMinus" aria-label="Fewer new cards">−</button>
          <input id="npd" type="number" inputmode="numeric" min="0" max="999" value="${settings.newPerDay}" aria-label="New cards per day">
          <button type="button" class="icon-btn" id="npdPlus" aria-label="More new cards">+</button>
        </div>
      </div>
      <div class="set-row column">
        <div><b>Target retention: <span id="retOut" class="mono">${Math.round(settings.targetRetention * 100)}%</span></b>
          <p>How likely you should be to remember a card when it comes back. Higher means you remember more but review more often. 90% suits most people.</p></div>
        <input id="ret" type="range" min="80" max="97" step="1" value="${Math.round(settings.targetRetention * 100)}" aria-label="Target retention">
      </div>
      <details class="advanced" id="advanced">
        <summary>Advanced scheduling</summary>
        <p class="note">Changes apply to future reviews. Cards already scheduled keep their dates until you next review them.</p>
        <div class="adv-row steps-editor" data-key="learningSteps" data-kind="learning" role="group" aria-labelledby="lstepsTitle">
          <b id="lstepsTitle">Learning steps</b>
          <span>Short gaps while a card is <b>new</b>. You see it again after each one, until it moves on to normal reviews.</span>
          <div class="step-chips"></div>
          <ul class="steps-explain"></ul>
          <div class="step-add">
            <span>Add a step:</span>
            <input type="number" inputmode="numeric" min="1" max="999" value="1" aria-label="How long">
            <select aria-label="Unit"><option value="m">minutes</option><option value="h" selected>hours</option><option value="d">days</option></select>
            <button class="btn ghost small" type="button">Add</button>
          </div>
          <span class="err" hidden></span>
        </div>
        <div class="adv-row steps-editor" data-key="relearningSteps" data-kind="relearning" role="group" aria-labelledby="rstepsTitle">
          <b id="rstepsTitle">Relearning steps</b>
          <span>Short gaps after you <b>forget</b> a card (press Again on a normal review), before it goes back to normal reviews.</span>
          <div class="step-chips"></div>
          <ul class="steps-explain"></ul>
          <div class="step-add">
            <span>Add a step:</span>
            <input type="number" inputmode="numeric" min="1" max="999" value="1" aria-label="How long">
            <select aria-label="Unit"><option value="m">minutes</option><option value="h" selected>hours</option><option value="d">days</option></select>
            <button class="btn ghost small" type="button">Add</button>
          </div>
          <span class="err" hidden></span>
        </div>
        <div class="adv-row"><b id="maxLabel">Maximum interval</b>
          <span>The longest a card can go without being shown. Lower it before an exam so nothing drifts too far out.</span>
          <div class="chips" role="group" aria-labelledby="maxLabel">${MAX_INTERVAL_PRESETS.map(([d, l]) =>
            `<button type="button" class="tchip" data-max="${d}" aria-pressed="${settings.maxInterval === d}">${l}</button>`).join('')}</div>
          <label class="inline-num"><input id="maxDays" type="number" inputmode="numeric" min="1" max="36500" value="${settings.maxInterval}" aria-label="Maximum interval in days"> days</label>
          <span class="err" id="maxErr" hidden></span></div>
        <label class="adv-row switch-row"><span><b>Spread out due dates</b>
          <span>Adds a little randomness to longer gaps so cards added together don't all come due on the same day.</span></span>
          <input id="fuzz" type="checkbox" class="switch" ${settings.fuzz ? 'checked' : ''}></label>
        <button class="btn ghost small" type="button" id="schedReset">Reset to defaults</button>
      </details>
    </section>

    <section class="section" aria-labelledby="dataTitle">
      <h2 id="dataTitle">Your data</h2>
      <div class="set-row">
        <div><b>Storage</b><p>${persisted
          ? 'Saved permanently on this device.'
          : 'Saved on this device. Install the app to your home screen so the browser keeps it safe.'}</p></div>
      </div>
      <div class="set-row">
        <div><b>Back up</b><p>Save everything (decks, cards, progress, settings) to one file. Keep it somewhere safe, or use it to move your data to another device.
          ${settings.lastBackup ? `Last backup: ${esc(new Date(settings.lastBackup).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}.` : 'No backup yet.'}</p></div>
        <button class="btn ghost small" type="button" id="exportBtn">Export backup</button>
      </div>
      <div class="set-row">
        <div><b>Restore</b><p>Load a backup file. It replaces everything on this device.</p></div>
        <label class="btn ghost small file-btn">Import backup<input type="file" id="importIn" accept=".json,application/json"></label>
      </div>
      <div class="set-row">
        <div><b>Reset all data</b><p>Deletes every deck, card and review. Your theme is kept.</p></div>
        <button class="btn danger small" type="button" id="resetBtn">Reset…</button>
      </div>
      <p class="note">Your data lives only in this browser. The Play timer is set on the Play screen.</p>
    </section>

    <p class="note mono">Study Sprint ${APP_VERSION}</p>`;

  $('skins').addEventListener('click', e => {
    const b = e.target.closest('.skin'); if (!b) return;
    saveTheme({ ...settings.theme, skin: b.dataset.skin });
    el.querySelectorAll('.skin').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  el.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
    saveTheme({ ...settings.theme, mode: r.value });
    $('skins').innerHTML = skinButtonsHTML(settings.theme.skin); // previews switch between light and dark versions
  }));
  $('resetBtn').addEventListener('click', confirmReset);
  $('exportBtn').addEventListener('click', exportBackup);
  $('importIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) confirmRestore(f); });

  // New cards per day: typed or changed with − / +, kept between 0 and 999.
  const setNpd = v => {
    const n = Math.max(0, Math.min(999, Math.round(Number(v) || 0)));
    $('npd').value = n;
    settings.newPerDay = n;
    db.setSetting('newPerDay', n);
  };
  $('npd').addEventListener('change', e => setNpd(e.target.value));
  $('npdMinus').addEventListener('click', () => setNpd(settings.newPerDay - 5));
  $('npdPlus').addEventListener('click', () => setNpd(settings.newPerDay + 5));
  $('ret').addEventListener('input', e => { $('retOut').textContent = `${e.target.value}%`; });
  $('ret').addEventListener('change', e => {
    settings.targetRetention = Number(e.target.value) / 100;
    db.setSetting('targetRetention', settings.targetRetention);
  });
  wireAdvanced(el);
}

// Advanced scheduling: each box is checked when you leave it, and only saved if it makes sense.
function wireAdvanced(el) {
  const showErr = (id, msg) => { $(id).textContent = msg || ''; $(id).hidden = !msg; };

  // Learning / relearning steps: each step is a chip you can remove, plus an "Add a step" row.
  // A sentence above them says what the steps do, so there are no codes to learn.
  el.querySelectorAll('.steps-editor').forEach(box => {
    const key = box.dataset.key, kind = box.dataset.kind;
    const err = box.querySelector('.err');
    const current = () => parseSteps(settings[key]).steps || parseSteps(SCHED_DEFAULTS[key]).steps;
    const draw = () => {
      const steps = current();
      box.querySelector('.step-chips').innerHTML = steps.length
        ? steps.map((s, i) => `<span class="step-chip"><small>Step ${i + 1}</small>${esc(stepShort(s))}<button type="button" data-i="${i}" aria-label="Remove step ${i + 1} (${esc(stepWords(s))})">×</button></span>`).join('')
        : '<span class="muted small">No steps</span>';
      // What each button does with these steps, in plain words.
      box.querySelector('.steps-explain').innerHTML = explainSteps(steps, kind)
        .map(([button, what]) => `<li><b>${esc(button)}</b> → ${esc(what)}</li>`).join('');
    };
    const save = steps => {
      settings[key] = formatSteps(sortSteps([...new Set(steps)]));   // in order, no duplicates
      db.setSetting(key, settings[key]);
      err.hidden = true;
      draw();
    };
    box.querySelector('.step-chips').addEventListener('click', e => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      save(current().filter((_, i) => i !== +b.dataset.i));
    });
    box.querySelector('.step-add button').addEventListener('click', () => {
      const n = box.querySelector('.step-add input').value, unit = box.querySelector('.step-add select').value;
      const r = parseSteps(`${current().join(' ')} ${n}${unit}`);
      if (r.error) {
        err.textContent = /too long|10 steps/.test(r.error) ? r.error : 'Enter a whole number, 1 or more.';
        err.hidden = false;
        return;
      }
      save(r.steps);
    });
    draw();
  });
  const setMax = days => {
    const r = parseMaxInterval(days);
    if (r.error) { showErr('maxErr', r.error); return; }
    showErr('maxErr', '');
    settings.maxInterval = r.days;
    $('maxDays').value = r.days;
    el.querySelectorAll('[data-max]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.max === r.days)));
    db.setSetting('maxInterval', r.days);
    toast('Saved');
  };
  el.querySelectorAll('[data-max]').forEach(b => b.addEventListener('click', () => setMax(+b.dataset.max)));
  $('maxDays').addEventListener('change', e => setMax(e.target.value));
  $('fuzz').addEventListener('change', e => { settings.fuzz = e.target.checked; db.setSetting('fuzz', settings.fuzz); });
  $('schedReset').addEventListener('click', async () => {
    for (const [k, v] of Object.entries(SCHED_DEFAULTS)) { settings[k] = v; await db.setSetting(k, v); }
    await renderSettings($('screen'));
    $('advanced').open = true;
    toast('Scheduling reset to defaults');
  });
}

function saveTheme(theme) {
  settings.theme = applyTheme(theme);
  db.setSetting('theme', settings.theme);
}

// ---------- backup ----------
async function exportBackup() {
  const data = await db.exportAll();
  const d = new Date();
  const name = `study-sprint-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  // On phones, the share sheet is the reliable way to save a file ("Save to Files", Drive, email...).
  // On computers, download it like any other file.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Study Sprint backup' });
    } catch (err) {
      if (err.name === 'AbortError') return;      // closed the share sheet: nothing saved
      downloadFile(file);
    }
  } else {
    downloadFile(file);
  }
  settings.lastBackup = Date.now();
  await db.setSetting('lastBackup', settings.lastBackup);
  toast(`Backup saved: ${plural(data.cards.length, 'card')}, ${plural(data.reviewLog.length, 'review')}`);
  if (currentRoute === 'settings') renderSettings($('screen'));
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function confirmRestore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  const problem = db.checkBackup(data);
  if (problem) { toast(problem); return; }
  const when = data.exported ? new Date(data.exported).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an unknown date';
  openSheet(`
    <h2 id="sheetTitle">Restore this backup?</h2>
    <p style="margin:0">Backup from <b>${esc(when)}</b>: ${plural(data.decks.length, 'deck')}, ${plural(data.cards.length, 'card')}, ${plural(data.reviewLog.length, 'review')}.</p>
    <div class="confirm">
      <p>Everything on this device now is <b>replaced</b> by the backup. Export a backup first if you want to keep it.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rbNo">Cancel</button>
        <button class="btn danger solid" type="button" id="rbYes">Replace and restore</button>
      </div>
    </div>`);
  $('rbNo').focus();
  $('rbNo').addEventListener('click', closeSheet);
  $('rbYes').addEventListener('click', async () => {
    await db.importAll(data);
    settings = await db.getSettings();
    settings.theme = applyTheme(settings.theme);
    closeSheet();
    toast(`Restored ${plural(data.cards.length, 'card')}`);
    location.hash = '#/decks';
  });
}

function confirmReset() {
  openSheet(`
    <h2 id="sheetTitle">Reset all data?</h2>
    <div class="confirm">
      <p>This deletes <b>every deck, card and review</b> on this device. It can't be undone.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rsNo">Cancel</button>
        <button class="btn danger solid" type="button" id="rsYes">Delete everything</button>
      </div>
    </div>`);
  $('rsNo').focus();
  $('rsNo').addEventListener('click', closeSheet);
  $('rsYes').addEventListener('click', async () => {
    const theme = settings.theme;
    await db.resetAll();
    await db.setSetting('theme', theme);
    settings = { ...db.DEFAULT_SETTINGS, theme };
    await seedSampleDeck();
    closeSheet();
    toast('All data reset');
    location.hash = '#/decks';
  });
}

// ---------- first run ----------
// Add the sample deck once. A saved flag stops it coming back after you delete it.
async function seedSampleDeck() {
  if (settings.seeded) return;
  const deckId = db.newId();
  const now = Date.now();
  await db.addDeckWithCards(
    { id: deckId, name: SAMPLE_DECK.name, course: SAMPLE_DECK.course, color: SAMPLE_DECK.color, created: now },
    // created + i keeps the cards in their original order.
    SAMPLE_DECK.cards.map(([front, back], i) => ({ id: db.newId(), deckId, front, back, tags: [], created: now + i }))
  );
  settings.seeded = true;
  await db.setSetting('seeded', true);
}

// ---------- navigation ----------
const ROUTES = {
  // Loaded on demand: Review needs the FSRS library from the internet (saved for offline after the first time),
  // and the rest of the app shouldn't have to wait for it.
  review: async (el, deckId) => (await import('./review.js')).renderReview(el, deckId),
  play: el => renderPlay(el),
  decks: el => renderLibrary(el),
  deck: (el, id) => renderDeck(el, id),
  import: (el, deckId) => renderImport(el, deckId),
  stats: el => renderStats(el),
  settings: el => renderSettings(el)
};

// Remembered so the gear can take you back to where you were.
let currentRoute = null;     // name of the screen showing now, e.g. 'decks'
let beforeSettings = null;   // address of the screen you were on before opening Settings

async function route() {
  const [, name = 'decks', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  if (name === 'settings' && currentRoute && currentRoute !== 'settings') beforeSettings = beforeSettings || lastHash;
  if (name !== 'settings') beforeSettings = null;
  currentRoute = name;
  lastHash = location.hash;
  // The gear doubles as a close button while Settings is open.
  $('gearBtn').setAttribute('aria-label', name === 'settings' ? 'Close settings' : 'Settings');
  const render = ROUTES[name] || ROUTES.decks;
  // Highlight the right tab. A deck's page and the import screen count as the Decks tab.
  const tab = name === 'deck' || name === 'import' ? 'decks' : name;
  document.querySelectorAll('[data-tab]').forEach(t => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  closeSheet();
  // Each visit to a screen draws into a fresh box. If you switch screens while one is still loading,
  // the old one finishes into its own box, which is no longer on the page, so it can't draw over the new one.
  const el = document.createElement('div');
  el.className = 'view';
  $('screen').replaceChildren(el);
  scrollTo(0, 0);
  try {
    await render(el, arg && decodeURIComponent(arg));
  } catch (err) {
    if (!el.isConnected) return;          // a screen you already left: ignore
    console.error(err);
    el.innerHTML = `<div class="empty"><b>Something went wrong.</b><br>${esc(err.message || err)}</div>`;
  }
  if (el.isConnected) scrollTo(0, 0);
}

let lastHash = '#/decks';

// Tapping the gear while Settings is open closes it and returns to the previous screen.
function wireGear() {
  $('gearBtn').addEventListener('click', e => {
    if (currentRoute !== 'settings') return;           // not open: the link opens Settings as normal
    e.preventDefault();
    if (beforeSettings) history.back();                 // came from another screen: step back to it
    else location.hash = '#/decks';                     // opened straight onto Settings: go to Decks
  });
}

// ---------- start up ----------
async function start() {
  initSheet();
  initTapGuard();
  wireGear();
  try {
    settings = await db.getSettings();
  } catch (err) {
    $('screen').innerHTML = `<div class="empty"><b>Couldn't open storage.</b><br>${esc(err.message)}<br>Private browsing can block it. Try a normal tab.</div>`;
    return;
  }
  settings.theme = applyTheme(settings.theme);
  await seedSampleDeck();
  // Opening the app with no "#/..." in the address shows the deck library.
  if (!location.hash) history.replaceState(null, '', '#/decks');
  addEventListener('hashchange', route);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBrowserBar);
  await route();

  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
}

// Offline support and "Add to Home Screen" need the service worker.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
  // When a new version has installed, reload once so it shows straight away
  // (instead of only after closing and reopening the app a second time).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;   // first ever install: nothing old to replace
    reloaded = true;
    location.reload();
  });
}

start();
