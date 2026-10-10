// Study Sprint: starts the app, switches between screens, and draws the Settings screen.
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML } from './themes.js';
import { renderLibrary, renderDeck } from './decks.js';
import { renderImport } from './import-screen.js';
import { SAMPLE_DECK } from './sample.js';
import { SCHED_DEFAULTS, MAX_INTERVAL_PRESETS, parseSteps, formatSteps, parseMaxInterval, sortSteps, explainSteps } from './sched-settings.js';
import { $, esc, plural, toast, openSheet, closeSheet, initSheet, initTapGuard } from './ui.js';
import { renderPlay } from './play.js';
import { renderStats } from './stats.js';
import { renderBrowseAll } from './browse.js';
import * as sync from './sync.js';
import { formatInterval } from './queue.js';
import { SYNCED_SETTINGS } from './sync-data.js';

// Shown at the bottom of Settings, so you can tell whether your phone has the newest version.
const APP_VERSION = '2.0';

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
      <div class="set-row">
        <div><b>Leech after</b><p>A card you forget this many times is a <b>leech</b>, and again every half that many after (8, 12, 16…). 0 turns this off.</p></div>
        <div class="stepper">
          <button type="button" class="icon-btn" id="leechMinus" aria-label="Fewer times">−</button>
          <input id="leech" type="number" inputmode="numeric" min="0" max="99" value="${settings.leechThreshold}" aria-label="Times forgotten before a card is a leech">
          <button type="button" class="icon-btn" id="leechPlus" aria-label="More times">+</button>
        </div>
      </div>
      <div class="set-row column">
        <div><b id="leechActLbl">When a card becomes a leech</b></div>
        <div class="chips" role="group" aria-labelledby="leechActLbl">
          <button type="button" class="tchip" data-leech="suspend" aria-pressed="${settings.leechAction === 'suspend'}">Tag it and suspend it</button>
          <button type="button" class="tchip" data-leech="tag" aria-pressed="${settings.leechAction === 'tag'}">Just tag it</button>
        </div>
        <p class="note" style="margin:0">Leeches are tagged “leech”. Find them in the card list with the Leeches filter, then rewrite or split them.</p>
      </div>
      <details class="advanced" id="advanced">
        <summary>Advanced scheduling</summary>
        <p class="note">Changes apply to future reviews. Cards already scheduled keep their dates until you next review them.</p>
        <div class="adv-row steps-editor" data-key="learningSteps" data-kind="learning">
          <label for="lsteps"><b>Learning steps</b></label>
          <span>Short gaps while a card is <b>new</b>. You see it again after each one, until it moves on to normal reviews.</span>
          <div class="steps-input">
            <input id="lsteps" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(settings.learningSteps)}" placeholder="${SCHED_DEFAULTS.learningSteps}" aria-describedby="lstepsHelp">
            <button class="btn ghost small" type="button" data-reset>Reset</button>
          </div>
          <span class="steps-hint" id="lstepsHelp">Type the gaps separated by spaces: <b>m</b> = minutes, <b>h</b> = hours, <b>d</b> = days. Default: ${SCHED_DEFAULTS.learningSteps}.</span>
          <ul class="steps-explain" aria-live="polite"></ul>
          <span class="err" hidden></span>
        </div>
        <div class="adv-row steps-editor" data-key="relearningSteps" data-kind="relearning">
          <label for="rsteps"><b>Relearning steps</b></label>
          <span>Short gaps after you <b>forget</b> a card (press Again on a normal review), before it goes back to normal reviews.</span>
          <div class="steps-input">
            <input id="rsteps" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(settings.relearningSteps)}" placeholder="${SCHED_DEFAULTS.relearningSteps}" aria-describedby="rstepsHelp">
            <button class="btn ghost small" type="button" data-reset>Reset</button>
          </div>
          <span class="steps-hint" id="rstepsHelp">Type the gaps separated by spaces: <b>m</b> = minutes, <b>h</b> = hours, <b>d</b> = days. Default: ${SCHED_DEFAULTS.relearningSteps}.</span>
          <ul class="steps-explain" aria-live="polite"></ul>
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

    <section class="section" aria-labelledby="syncTitle">
      <h2 id="syncTitle">Sync</h2>
      <div id="syncBox"></div>
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
      <p class="note"><span id="whereNote"></span> The Play timer is set on the Play screen.</p>
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
  drawSync();
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
  // Leeches: how many times forgotten (0–99, 0 = off), and suspend or just tag.
  const setLeech = v => {
    const n = Math.max(0, Math.min(99, Math.round(Number(v) || 0)));
    $('leech').value = n;
    settings.leechThreshold = n;
    db.setSetting('leechThreshold', n);
  };
  $('leech').addEventListener('change', e => setLeech(e.target.value));
  $('leechMinus').addEventListener('click', () => setLeech(settings.leechThreshold - 1));
  $('leechPlus').addEventListener('click', () => setLeech(settings.leechThreshold + 1));
  document.querySelectorAll('[data-leech]').forEach(btn => btn.addEventListener('click', () => {
    settings.leechAction = btn.dataset.leech;
    db.setSetting('leechAction', settings.leechAction);
    document.querySelectorAll('[data-leech]').forEach(x => x.setAttribute('aria-pressed', x === btn));
  }));
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

  // Learning / relearning steps: a text box like "1m 10m", with a plain-words list underneath of what
  // each step is for and what each button does. The list follows what you type; the box saves when
  // you leave it (only if it can be read). Reset puts just this box back to its default.
  el.querySelectorAll('.steps-editor').forEach(box => {
    const key = box.dataset.key, kind = box.dataset.kind;
    const input = box.querySelector('input'), err = box.querySelector('.err');
    const explain = steps => {
      box.querySelector('.steps-explain').innerHTML = explainSteps(steps, kind)
        .map(([button, what]) => `<li><b>${esc(button)}</b> → ${esc(what)}</li>`).join('');
    };
    input.addEventListener('input', () => { const r = parseSteps(input.value); if (r.steps) { explain(r.steps); err.hidden = true; } });
    input.addEventListener('change', () => {
      const r = parseSteps(input.value);
      if (r.error) { err.textContent = r.error; err.hidden = false; return; }
      err.hidden = true;
      settings[key] = formatSteps(sortSteps([...new Set(r.steps)]));   // tidy: in order, no duplicates
      input.value = settings[key];
      explain(parseSteps(settings[key]).steps);
      db.setSetting(key, settings[key]);
      toast('Saved');
    });
    box.querySelector('[data-reset]').addEventListener('click', () => {
      settings[key] = SCHED_DEFAULTS[key];
      input.value = settings[key];
      err.hidden = true;
      explain(parseSteps(settings[key]).steps);
      db.setSetting(key, settings[key]);
      toast('Reset to ' + settings[key]);
    });
    explain(parseSteps(settings[key]).steps || parseSteps(SCHED_DEFAULTS[key]).steps);
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
  const synced = !!(await sync.account());
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  const problem = db.checkBackup(data);
  if (problem) { toast(problem); return; }
  const when = data.exported ? new Date(data.exported).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an unknown date';
  openSheet(`
    <h2 id="sheetTitle">Restore this backup?</h2>
    <p style="margin:0">Backup from <b>${esc(when)}</b>: ${plural(data.decks.length, 'deck')}, ${plural(data.cards.length, 'card')}, ${plural(data.reviewLog.length, 'review')}.</p>
    <div class="confirm">
      <p>Everything on this device now is <b>replaced</b> by the backup${synced ? ', <b>and in your sync account too</b>: your other devices change to match when they sync' : ''}. Export a backup first if you want to keep it.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rbNo">Cancel</button>
        <button class="btn danger solid" type="button" id="rbYes">Replace and restore</button>
      </div>
    </div>`);
  $('rbNo').focus();
  $('rbNo').addEventListener('click', closeSheet);
  $('rbYes').addEventListener('click', async () => {
    if (synced) await sync.syncNow();          // catch up first, so everything in the account gets replaced
    await db.importAll(data, { everywhere: synced });
    if (synced) sync.syncNow();
    settings = await db.getSettings();
    settings.theme = applyTheme(settings.theme);
    closeSheet();
    toast(`Restored ${plural(data.cards.length, 'card')}`);
    location.hash = '#/decks';
  });
}

async function confirmReset() {
  if (await sync.account()) return confirmResetSynced();
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
    await wipeThisDevice();
    closeSheet();
    toast('All data reset');
    location.hash = '#/decks';
  });
}

// Signed in, Reset can mean "everywhere" or "just this device".
function confirmResetSynced() {
  openSheet(`
    <h2 id="sheetTitle">Reset all data?</h2>
    <div class="confirm">
      <p><b>Everywhere</b> deletes every deck, card and review on this device <b>and in your account</b>, so your other devices delete them too when they sync. It can't be undone.</p>
      <p><b>Just this device</b> signs this device out and clears it. Your account and other devices keep everything (sign in again to get it back).</p>
      <button class="btn danger solid" type="button" id="rsAll">Delete everywhere</button>
      <button class="btn danger" type="button" id="rsHere">Just this device</button>
      <button class="btn ghost" type="button" id="rsNo">Cancel</button>
    </div>`);
  $('rsNo').focus();
  $('rsNo').addEventListener('click', closeSheet);
  $('rsAll').addEventListener('click', async () => {
    await sync.syncNow();                 // first catch up, so nothing from another device is missed
    await db.deleteEverything();
    // Study settings back to their defaults (they sync); the theme stays.
    for (const [k, v] of Object.entries(db.DEFAULT_SETTINGS)) if (SYNCED_SETTINGS.includes(k)) await db.setSetting(k, v);
    settings = { ...(await db.getSettings()), theme: settings.theme };
    await sync.syncNow();
    closeSheet();
    toast('Everything deleted on all your devices');
    location.hash = '#/decks';
  });
  $('rsHere').addEventListener('click', async () => {
    await sync.signOut({ forget: true });
    await wipeThisDevice();
    closeSheet();
    toast('This device was reset and signed out');
    location.hash = '#/decks';
  });
}

// ---------- sync ----------
// The Sync section of Settings: sign in or create an account, or (signed in) the sync status.
async function drawSync() {
  const box = $('syncBox');
  if (!box) return;
  const acct = await sync.account();
  if (!box.isConnected) return;       // Settings was redrawn meanwhile: that drawing handles it
  $('whereNote').textContent = acct ? 'Your data is saved in this browser and synced to your account.'
    : 'Your data is saved in this browser only (sign in to Sync above to share it between devices).';
  if (!acct) {
    box.innerHTML = `
      <p class="note" style="margin-top:0">Keep your decks, cards and progress the same on all your devices: sign in with the same account on each one.</p>
      <form id="syncForm" novalidate>
        <label class="field"><span>Email</span>
          <input id="syncEmail" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Password</span>
          <input id="syncPw" type="password" autocomplete="current-password" minlength="6" required></label>
        <p class="err" id="syncErr" hidden></p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" id="syncCreate">Create account</button>
          <button class="btn primary" type="submit">Sign in</button>
        </div>
      </form>
      <p class="note">First time? Use <b>Create account</b> once, then <b>Sign in</b> on your other devices.
        <button class="link" type="button" id="forgotBtn" style="padding:0 2px;min-height:0">Forgot password?</button></p>`;
    const go = async create => {
      const email = $('syncEmail').value.trim(), pw = $('syncPw').value;
      const err = $('syncErr');
      err.hidden = true;
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Type your email address.'; err.hidden = false; return; }
      if (pw.length < 6) { err.textContent = 'The password needs at least 6 characters.'; err.hidden = false; return; }
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await (create ? sync.createAccount(email, pw) : sync.signIn(email, pw));
        toast(create ? 'Account created. Syncing…' : 'Signed in. Syncing…');
        drawSync();
      } catch (e) {
        err.textContent = e.message; err.hidden = false;
        box.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    };
    $('syncForm').addEventListener('submit', e => { e.preventDefault(); go(false); });
    $('syncCreate').addEventListener('click', () => go(true));
    $('forgotBtn').addEventListener('click', async () => {
      const email = $('syncEmail').value.trim(), err = $('syncErr');
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Type your email above first, then tap Forgot password.'; err.hidden = false; $('syncEmail').focus(); return; }
      try {
        await sync.sendPasswordReset(email);
        err.hidden = true;
        openSheet(`
          <h2 id="sheetTitle">Check your email</h2>
          <p>If there's an account for <b>${esc(email)}</b>, Supabase has sent it a password reset link.</p>
          <p class="note">Open the link: it opens Study Sprint in your browser, where you can set a new password. Then sign in with it on each of your devices (including the home-screen app).</p>
          <button class="btn primary" type="button" id="fpOk">OK</button>`);
        $('fpOk').addEventListener('click', closeSheet);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    return;
  }
  box.innerHTML = `
    <div class="set-row">
      <div><b>Signed in</b><p>${esc(acct.email)}<br><span id="syncStatus"></span></p></div>
      <button class="btn ghost small" type="button" id="syncNowBtn">Sync now</button>
    </div>
    <div class="set-row">
      <div><b>Password</b><p>Change the password you sign in with.</p></div>
      <button class="btn ghost small" type="button" id="pwBtn">Change…</button>
    </div>
    <div class="set-row">
      <div><b>Sign out</b><p>Stops syncing on this device. You choose whether to keep this device's copy.</p></div>
      <button class="btn ghost small" type="button" id="signOutBtn">Sign out…</button>
    </div>
    <div class="set-row">
      <div><b>Delete my synced data</b><p>Removes everything stored in your account on the server. Your devices keep their own copy.</p></div>
      <button class="btn danger small" type="button" id="delServerBtn">Delete…</button>
    </div>`;
  showSyncStatus(acct.lastSync);
  $('syncNowBtn').addEventListener('click', () => sync.syncNow());
  $('pwBtn').addEventListener('click', () => openPasswordSheet({ title: 'Change password', save: pw => sync.changePassword(pw), done: 'Password changed' }));
  $('signOutBtn').addEventListener('click', confirmSignOut);
  $('delServerBtn').addEventListener('click', confirmDeleteServer);
}

// A sheet asking for a new password (twice). save(pw) does the work; done is the message afterwards.
function openPasswordSheet({ title, intro = '', save, done }) {
  openSheet(`
    <h2 id="sheetTitle">${esc(title)}</h2>
    ${intro}
    <form id="pwForm" novalidate>
      <label class="field"><span>New password</span><input id="pw1" type="password" autocomplete="new-password" minlength="6"></label>
      <label class="field"><span>Type it again</span><input id="pw2" type="password" autocomplete="new-password" minlength="6"></label>
      <p class="err" id="pwErr" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="pwCancel">Cancel</button>
        <button class="btn primary" type="submit">Save password</button>
      </div>
    </form>`);
  $('pwCancel').addEventListener('click', closeSheet);
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('pw1').value, err = $('pwErr');
    err.hidden = true;
    if (pw.length < 6) { err.textContent = 'Use at least 6 characters.'; err.hidden = false; return; }
    if (pw !== $('pw2').value) { err.textContent = "The two passwords don't match."; err.hidden = false; return; }
    const btn = e.submitter || $('pwForm').querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await save(pw);
      closeSheet();
      toast(done);
      if (currentRoute === 'settings') drawSync();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
}

// Sign out: keep this device's copy, or remove it (e.g. on a shared computer).
async function confirmSignOut() {
  openSheet(`
    <h2 id="sheetTitle">Sign out?</h2>
    <p>This device stops syncing. Your account and your other devices keep everything.</p>
    <p class="note" id="soNote">Checking for changes that haven't synced yet…</p>
    <div class="confirm">
      <button class="btn primary" type="button" id="soKeep">Sign out, keep data on this device</button>
      <button class="btn danger" type="button" id="soRemove">Sign out and remove it from this device</button>
      <button class="btn ghost" type="button" id="soNo">Cancel</button>
    </div>`);
  $('soNo').addEventListener('click', closeSheet);
  $('soKeep').addEventListener('click', async () => { await sync.signOut(); closeSheet(); toast('Signed out'); drawSync(); });
  let armed = false;
  $('soRemove').addEventListener('click', async () => {
    const pending = await sync.pendingChanges().catch(() => 0);
    if (pending && !armed) {             // a second tap confirms losing them
      armed = true;
      $('soNote').innerHTML = `<span class="warn">${plural(pending, 'change')} on this device ${pending === 1 ? "hasn't" : "haven't"} synced yet and would be lost.</span> Tap Remove again to remove anyway, or go back and Sync now first.`;
      return;
    }
    await sync.signOut({ forget: true });
    await wipeThisDevice();
    closeSheet();
    toast('Signed out and removed from this device');
    location.hash = '#/decks';
  });
  // Send anything waiting first, so signing out loses nothing.
  await sync.syncNow();
  const pending = await sync.pendingChanges().catch(() => 0);
  if ($('soNote') && !armed) $('soNote').textContent = pending ? `${plural(pending, 'change')} couldn't sync yet (are you offline?).` : 'Everything here is synced.';
}

// Delete everything in the account on the server (devices keep their copy). Signs this device out.
function confirmDeleteServer() {
  openSheet(`
    <h2 id="sheetTitle">Delete your synced data?</h2>
    <div class="confirm">
      <p>This removes <b>everything stored in your account on the server</b>: decks, cards, progress and settings. It can't be undone.</p>
      <p class="note">This device and your other devices keep their own copy. This device is signed out; sign out on your other devices too, or they'll start sending their changes again. (To remove the account itself, delete the user in Supabase → Authentication → Users.)</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="dsNo">Cancel</button>
        <button class="btn danger solid" type="button" id="dsYes">Delete from server</button>
      </div>
    </div>`);
  $('dsNo').focus();
  $('dsNo').addEventListener('click', closeSheet);
  $('dsYes').addEventListener('click', async () => {
    $('dsYes').disabled = true;
    try {
      await sync.deleteServerData();
      closeSheet();
      toast('Your synced data was deleted from the server');
      drawSync();
    } catch (e) { toast(e.message); $('dsYes').disabled = false; }
  });
}

// Back to a fresh start on this device (keeps the theme): used by Reset and by signing out with Remove.
async function wipeThisDevice() {
  const theme = settings.theme;
  await db.resetAll();
  await db.setSetting('theme', theme);
  settings = { ...db.DEFAULT_SETTINGS, theme };
  await seedSampleDeck();
}

// "Synced 2m ago", "Syncing…" or what went wrong.
function showSyncStatus(lastSync) {
  const el = $('syncStatus');
  if (!el) return;
  const st = sync.lastStatus();
  const when = st.at || lastSync;
  const ago = when ? (Date.now() - when < 60000 ? 'just now' : `${formatInterval(Date.now() - when)} ago`) : '';
  el.className = st.state === 'error' ? 'warn' : 'muted';
  el.textContent = st.state === 'syncing' ? (st.progress || 'Syncing…')
    : st.state === 'error' ? `Couldn't sync: ${st.error}`
    : when ? `Synced ${ago}` : 'Not synced yet';
  if ($('syncNowBtn')) $('syncNowBtn').disabled = st.state === 'syncing';
}

let warnedStale = false;
// After each sync: keep Settings up to date, and redraw the screen if changes came in from another device.
addEventListener('sync', async e => {
  const { state, applied } = e.detail;
  if (currentRoute === 'settings') { if (state === 'signed-out') drawSync(); else showSyncStatus(); }
  if (state === 'signed-out' && e.detail.error) toast(e.detail.error);
  if (state === 'error' && !warnedStale) {
    // Failing for days (e.g. the free Supabase project paused): say so once per visit.
    const acct = await sync.account();
    const days = acct?.lastSync ? Math.floor((Date.now() - acct.lastSync) / 86400000) : 0;
    if (days >= 3) { warnedStale = true; toast(`Sync hasn't worked for ${days} days. See Settings → Sync.`); }
  }
  if (state !== 'done' || !applied) return;
  settings = { ...(await db.getSettings()), theme: settings.theme };     // study settings may have changed
  const busy = document.getElementById('sheet')?.open || document.activeElement?.matches?.('input, textarea, select');
  if (busy) return;
  if (['decks', 'deck', 'browse', 'stats'].includes(currentRoute)) route();
  else if (currentRoute === 'settings') {
    // Redraw Settings in place (keeping your scroll position) so synced study settings show.
    const view = $('screen').querySelector('.view'), y = scrollY;
    if (view) { await renderSettings(view); scrollTo(0, y); }
  }
});

// ---------- first run ----------
// Add the sample deck once. A saved flag stops it coming back after you delete it.
async function seedSampleDeck() {
  if (settings.seeded) return;
  // Fixed ids (not random), so the sample deck added on two devices is the same deck once they sync.
  const deckId = 'sample';
  const now = Date.now();
  await db.addDeckWithCards(
    { id: deckId, name: SAMPLE_DECK.name, course: SAMPLE_DECK.course, color: SAMPLE_DECK.color, created: now },
    // created + i keeps the cards in their original order.
    SAMPLE_DECK.cards.map(([front, back], i) => ({ id: `sample-${i}`, deckId, front, back, tags: [], created: now + i })),
    { at: 1 }
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
  browse: el => renderBrowseAll(el),
  import: (el, deckId) => renderImport(el, deckId),
  stats: el => renderStats(el),
  settings: el => renderSettings(el)
};

// Remembered so the gear can take you back to where you were.
let currentRoute = null;     // name of the screen showing now, e.g. 'decks'
let beforeSettings = null;   // address of the screen you were on before opening Settings

async function route() {
  const resetLink = takeResetLink();      // opened from a password reset email? (see below)
  const [, name = 'decks', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  if (name === 'settings' && currentRoute && currentRoute !== 'settings') beforeSettings = beforeSettings || lastHash;
  if (name !== 'settings') beforeSettings = null;
  currentRoute = name;
  lastHash = location.hash;
  // The gear doubles as a close button while Settings is open.
  $('gearBtn').setAttribute('aria-label', name === 'settings' ? 'Close settings' : 'Settings');
  const render = ROUTES[name] || ROUTES.decks;
  // Highlight the right tab. A deck's page and the import screen count as the Decks tab.
  const tab = name === 'deck' || name === 'import' || name === 'browse' ? 'decks' : name;
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
  if (resetLink) showResetLink(resetLink);
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

// ---------- password reset links ----------
// A "reset your password" email opens the app with a sign-in after the # (see parseAuthLink in sync-merge.js).
// Take it out of the address straight away (and keep it for this tab, in case the app reloads to update).
function takeResetLink() {
  const link = sync.recoveryFromLink();
  if (!link) return null;
  history.replaceState(null, '', location.pathname + '#/settings');
  if (link.session) { try { sessionStorage.setItem('resetLink', JSON.stringify(link)); } catch { /* fine without */ } }
  return link;
}
function keptResetLink() {
  try { return JSON.parse(sessionStorage.getItem('resetLink') || 'null'); } catch { return null; }
}
let resetShown = false;
function showResetLink(link) {
  resetShown = true;
  const forget = () => { try { sessionStorage.removeItem('resetLink'); } catch { /* ignore */ } };
  if (link.error) { forget(); toast(link.error); return; }
  openPasswordSheet({
    title: 'Set a new password',
    intro: '<p class="note" style="margin-top:0">You opened a password reset link. Choose a new password, then use it to sign in on your other devices.</p>',
    save: async pw => { await sync.finishPasswordReset(link.session, pw); forget(); },
    done: 'Password saved. You\'re signed in.'
  });
  // Cancelling just closes it; the link can't be used again after that.
  $('pwCancel')?.addEventListener('click', forget);
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
  sync.startAutoSync();      // does nothing until you sign in (Settings → Sync)
  // Opening the app with no "#/..." in the address shows the deck library.
  if (!location.hash) history.replaceState(null, '', '#/decks');
  addEventListener('hashchange', route);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBrowserBar);
  await route();
  // Reloaded (e.g. to update) while a reset link was waiting for a new password: show it again.
  if (!resetShown) { const kept = keptResetLink(); if (kept) showResetLink(kept); }

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
