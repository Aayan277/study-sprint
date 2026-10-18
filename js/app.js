// Study Sprint: starts the app, switches between screens, and draws the Settings screen.
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML, applyCardAlign, cleanAlign, CARD_ALIGNS, UIS, accentTitle } from './themes.js';
import { renderToday } from './today.js';
import { addSampleDeck } from './sample.js';
import { entriesFrom } from './glossary.js';
const termCount = s => entriesFrom(s).length;      // (Settings → Study → Glossary shows how many terms)
import { SCHED_DEFAULTS, MAX_INTERVAL_PRESETS, FSRS_VERSION, personalRow, cleanIgnoreBefore, todayISO, parseSteps, formatSteps, parseMaxInterval, sortSteps, explainSteps, usesFsrs7 } from './sched-settings.js';
import { initPanelResize } from './panel-resize.js';
import { clearDraft } from './import-draft.js';
import { $, esc, plural, toast, openSheet, closeSheet, stashDraft, clearStashedDraft, initSheet, initTapGuard, setFocusMode, icon, foldOpen, rememberFold, showFieldError, clearFieldError } from './ui.js';
import * as sync from './sync.js';
import { takeLaunch, clearDismissals } from './study-data.js';
import { SYNCED_SETTINGS } from './sync-data.js';
import { configureShortcuts } from './shortcuts.js';
import * as fx from './fx.js';
import { initInstall, settingsRowHTML, wireSettingsRow } from './install.js';
import { settingsHTML as remindersHTML, wireSettings as wireReminders } from './reminders.js';
import { initBadge, refreshBadgeNow } from './badge.js';
import { examList } from './ics.js';
import { initSidebar, drawSidebar, drawSync as drawSideSync, markCurrent, syncWording } from './sidebar.js';
import { checkPassword, passwordOk, passwordMissing } from './password.js';
import { watchMath } from './math.js';
import { go as navGo, replace as navReplace, initNav, rewrite, releaseBack, whenIdle } from './nav.js';
import { usageLine, cardsWarning } from './quota.js';
import { backupNote } from './backup-nudge.js';
import { leftOutNote, notDownloadedLine, estimateBytes } from './lazy-media.js';
import { contactHTML, legalLinksHTML } from './legal.js';

// Shown at the bottom of Settings, so you can tell whether your phone has the newest version.
const APP_VERSION = '4.36';

let settings = { ...db.DEFAULT_SETTINGS };
initInstall();       // listens for the browser saying the app can be installed (see install.js)

// ---------- settings ----------
async function renderSettings(el) {
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  // Personal parameters row (Advanced scheduling): the saved weights, and a cheap count of the log (never the whole log).
  // "Last backup: 12 days ago", and a quiet nudge when it has been a month and there is a lot to lose (js/backup-nudge.js).
  const backup = backupNote({ lastBackup: settings.lastBackup, cards: await db.count('cards'), synced: !!(await sync.account()) });
  const decks = await db.getDecks();
  const personal = personalRow((await db.getSettings()).fsrsParams, await db.count('reviewLog'));
  // FSRS-7 (beta) is on: your own tuning is for FSRS-6 and is not used (see docs/design/fsrs7-plan.md, "Optimizer"). The row says so.
  if (usesFsrs7(settings)) Object.assign(personal, { using: false, canOptimize: false, why: 'Your FSRS-6 tuning is kept for when you switch back.', status: 'Personal tuning for FSRS-7 is coming; using standard FSRS-7 settings.' });
  // The reads above take a moment. If this box left the page meanwhile (you went to another screen, which drew into a fresh box),
  // there is nothing to draw into: the wiring below looks elements up on the page and would find none.
  if (!el.isConnected) return;
  const { ui, skin, mode, oled } = settings.theme;
  el.innerHTML = `
    <div class="screen-head"><div><h1>Settings</h1></div></div>
    <nav class="set-nav" id="setNav" aria-label="Jump to a section">
      <a href="#appearTitle" data-sec="appearTitle">Appearance</a><a href="#studyTitle" data-sec="studyTitle">Study</a><a href="#syncTitle" data-sec="syncTitle">Sync</a><a href="#dataTitle" data-sec="dataTitle">Your data</a><a href="#aboutTitle" data-sec="aboutTitle">About</a>
    </nav>

    <section class="section" aria-labelledby="appearTitle">
      <h2 id="appearTitle">Appearance</h2>
      <h3 class="set-sub" id="uiTitle">Style</h3>
      <div class="chips" role="radiogroup" aria-labelledby="uiTitle" id="uiChips">
        ${UIS.map(([v, l]) => `<label class="chip"><input type="radio" name="ui" value="${v}" ${ui === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <h3 class="set-sub" id="thTitle">${accentTitle(ui)}</h3>
      <div class="skins" id="skins">${skinButtonsHTML(skin)}</div>
      <h3 class="set-sub" id="apTitle">Light or dark</h3>
      <div class="chips" role="radiogroup" aria-labelledby="apTitle">
        ${[['dark', 'Dark'], ['light', 'Light'], ['auto', 'Match my device']].map(([v, l]) =>
          `<label class="chip"><input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <label class="adv-row switch-row"><span><b>OLED black</b>
        <span>A pure black page in dark mode, to save battery on OLED screens.</span></span>
        <input id="oled" type="checkbox" class="switch" ${oled ? 'checked' : ''}></label>
      <div class="set-row column">
        <div><b id="alignLbl">Card text alignment</b><p>Auto centres short text and left-aligns long answers. This device only.</p></div>
        <div class="chips" role="radiogroup" aria-labelledby="alignLbl" id="alignChips">
          ${CARD_ALIGNS.map(([v, l]) => `<label class="chip"><input type="radio" name="cardAlign" value="${v}" ${cleanAlign(settings.cardAlign) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
      </div>
      <label class="adv-row switch-row"><span><b>Compact deck list</b>
        <span>Search and sort your decks, with subdecks folded under their course. This device only.</span></span>
        <input id="compactDecks" type="checkbox" class="switch" ${settings.compactDecks !== false ? 'checked' : ''}></label>
      <label class="adv-row switch-row"><span><b>Rating feedback</b>
        <span>A coloured pulse and the new interval appear when you rate a card. This device only.</span></span>
        <input id="ratingFeedback" type="checkbox" class="switch" ${settings.ratingFeedback !== false ? 'checked' : ''}></label>
      <label class="adv-row switch-row"><span><b>Smooth transitions</b>
        <span>Screens slide and pop-up sheets spring open. Turn it off for instant changes. This device only.</span></span>
        <input id="smoothMotion" type="checkbox" class="switch" ${settings.smoothMotion !== false ? 'checked' : ''}></label>
      <label class="adv-row switch-row"><span><b>Exam readiness in Stats</b>
        <span>Pick a course in Stats to see how ready you are for its exam. This device only.</span></span>
        <input id="statsReadiness" type="checkbox" class="switch" ${settings.statsReadiness !== false ? 'checked' : ''}></label>
      <label class="adv-row switch-row"><span><b>Glossary underlines</b>
        <span>Terms from your glossary are underlined on Review cards. This device only.</span></span>
        <input id="glossaryUnderline" type="checkbox" class="switch" ${settings.glossaryUnderline !== false ? 'checked' : ''}></label>
    </section>

    <section class="section" aria-labelledby="studyTitle">
      <h2 id="studyTitle">Study</h2>
      <div class="set-row">
        <div><b>New cards per day</b><p>Across all decks. A deck can have its own limit too (Edit deck).</p></div>
        <div class="stepper">
          <button type="button" class="icon-btn" id="npdMinus" aria-label="Fewer new cards">−</button>
          <input id="npd" type="number" inputmode="numeric" min="0" max="999" value="${settings.newPerDay}" aria-label="New cards per day">
          <button type="button" class="icon-btn" id="npdPlus" aria-label="More new cards">+</button>
        </div>
      </div>
      <div class="set-row">
        <div><b>Reviews per day</b><p>The most reviews shown in a day, across all decks. Blank means no limit, which suits FSRS best.</p></div>
        <input id="rpd" class="num-box" type="number" inputmode="numeric" min="1" max="9999" placeholder="No limit" value="${Number.isFinite(settings.reviewLimit) ? settings.reviewLimit : ''}" aria-label="Reviews per day (blank for no limit)">
      </div>
      <label class="adv-row switch-row"><span><b>Single-key shortcuts</b>
        <span>Press E, I, R, D, Z, A, X, M, -, @ and 1 to 6 on the keyboard to act on a card. Turn off if voice control or a switch triggers them by accident (Space and Enter still work on the focused card). This device only.</span></span>
        <input id="singleKeys" type="checkbox" class="switch" ${settings.singleKeys !== false ? 'checked' : ''}></label>
      <label class="adv-row switch-row"><span><b>Count Play answers as reviews</b>
        <span>Off: Play is practice only and doesn't change when cards are due, stats or streaks.</span></span>
        <input id="playCounts" type="checkbox" class="switch" ${settings.playCountsAsReviews === true ? 'checked' : ''}></label>
      <div class="set-row column">
        <div><b>Target retention: <span id="retOut" class="mono">${Math.round(settings.targetRetention * 100)}%</span></b>
          <p>How likely you are to remember a card when it comes back. Higher means more reviews. 90% suits most people.</p></div>
        <input id="ret" type="range" min="75" max="97" step="1" value="${Math.round(settings.targetRetention * 100)}" aria-label="Target retention">
        <div><button class="btn ghost small" type="button" id="retHelp">Help me choose</button></div>
      </div>
      <div class="set-row">
        <div><b>Glossary</b><p id="glossSub">${termCount(settings) ? `${termCount(settings)} term${termCount(settings) === 1 ? '' : 's'}` : 'Define a term once and it’s underlined on every card, with its definition a tap away.'}</p></div>
        <button class="btn ghost small" type="button" id="glossBtn">Open</button>
      </div>
      ${remindersHTML({ time: settings.reminderTime || '19:00', exams: examList(decks).length, badgeOn: settings.appBadge === true })}
      <details class="advanced" id="advanced" ${foldOpen('settings-advanced') ? 'open' : ''}>
        <summary>Advanced scheduling<span class="adv-sub">Steps, maximum interval, easy days, Play timer, leeches</span></summary>
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
          <span class="err" role="alert" hidden></span>
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
          <span class="err" role="alert" hidden></span>
        </div>
        <div class="adv-row"><b id="maxLabel">Maximum interval</b>
          <span>The longest a card can go without being shown. Lower it before an exam so nothing drifts too far out.</span>
          <div class="chips" role="group" aria-labelledby="maxLabel">${MAX_INTERVAL_PRESETS.map(([d, l]) =>
            `<button type="button" class="tchip" data-max="${d}" aria-pressed="${settings.maxInterval === d}">${l}</button>`).join('')}</div>
          <label class="inline-num"><input id="maxDays" type="number" inputmode="numeric" min="1" max="36500" value="${settings.maxInterval}" aria-label="Maximum interval in days"> days</label>
          <span class="err" id="maxErr" role="alert" hidden></span></div>
        <label class="adv-row switch-row"><span><b>Spread out due dates</b>
          <span>Moves longer gaps by a day or so (within what FSRS allows) onto the least busy days, so reviews don't pile up on one day.</span></span>
          <input id="fuzz" type="checkbox" class="switch" ${settings.fuzz ? 'checked' : ''}></label>
        <div class="adv-row" id="fsrsRow"><b id="fsrsLbl">Scheduler</b>
          <span id="fsrsHint">FSRS-7 models short-term memory better (same-day repeats, cramming). Beta: off by default. Your cards keep their history; switching back is safe.</span>
          <div class="chips" role="radiogroup" aria-labelledby="fsrsLbl" aria-describedby="fsrsHint" id="fsrsChips">
            ${[[6, 'FSRS-6 (standard)'], [7, 'FSRS-7 (beta)']].map(([v, l]) => `<label class="chip"><input type="radio" name="fsrsVersion" value="${v}" ${(usesFsrs7(settings) ? 7 : 6) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
          </div>
        </div>
        <div class="adv-row opt-row" id="optRow"><b id="optLbl">Personal parameters</b>
          <span id="optStatus">${esc(personal.status)}</span>
          <div class="opt-actions">
            <button class="btn ghost small" type="button" id="optOpen" ${personal.canOptimize ? '' : 'disabled'} aria-describedby="optStatus${personal.canOptimize ? '' : ' optWhy'}">Optimize…</button>
            <button class="btn ghost small" type="button" id="healthOpen">Check how well it fits you</button>
            ${personal.using ? '<button class="link" type="button" id="optReset">Reset to default</button>' : ''}
          </div>
          ${personal.canOptimize ? '' : `<span class="steps-hint" id="optWhy">${esc(personal.why)}</span>`}
          <div class="confirm" id="optConfirm" role="group" aria-labelledby="optConfirmQ" hidden>
            <p id="optConfirmQ">Go back to the standard settings? Your cards keep their dates.</p>
            <div class="sheet-actions"><button class="btn ghost small" type="button" id="optNo">Cancel</button><button class="btn danger solid small" type="button" id="optYes">Reset</button></div>
          </div>
        </div>
        <div class="adv-row" id="ignoreRow"><label for="ignoreBefore"><b>Ignore reviews before</b></label>
          <span id="ignoreHint">Reviews before this date are ignored when tuning. Use it if your early history is messy (e.g. an old Anki import).</span>
          <div class="steps-input">
            <input id="ignoreBefore" type="date" max="${todayISO()}" value="${esc(settings.ignoreBefore || '')}" aria-describedby="ignoreHint ignoreHint2">
            <button class="btn ghost small" type="button" id="ignoreClear" ${settings.ignoreBefore ? '' : 'hidden'}>Clear</button>
          </div>
          <span class="steps-hint" id="ignoreHint2">Applies to Optimize and “Check how well it fits you”. Cards first studied before the date are skipped too, since their start is unknown.</span></div>
        <div class="adv-row"><b id="easyLbl">Easy days</b>
          <span>Give busy days fewer reviews. Reduced days get about half; Minimum days as few as possible. Needs “Spread out due dates”.</span>
          <div class="easy-days" role="group" aria-labelledby="easyLbl">${[1, 2, 3, 4, 5, 6, 0].map(d => `
            <label class="easy-day"><span>${esc(new Date(2026, 0, 4 + d).toLocaleDateString(undefined, { weekday: 'short' }))}</span>
              <select data-easy="${d}" aria-label="${esc(new Date(2026, 0, 4 + d).toLocaleDateString(undefined, { weekday: 'long' }))}">
                ${[['normal', 'Normal'], ['reduced', 'Reduced'], ['minimum', 'Minimum']].map(([v, l]) => `<option value="${v}" ${(settings.easyDays?.[d] || 'normal') === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>`).join('')}
          </div></div>
        <div class="adv-row"><b id="timerLbl">Play timer</b>
          <span>The default time per question in Play, in seconds. The Play screen has the same slider.</span>
          <div class="stepper">
            <button type="button" class="icon-btn" id="timerMinus" aria-label="Shorter timer">−</button>
            <input id="timerSec" type="number" inputmode="numeric" min="3" max="20" value="${settings.timer}" aria-labelledby="timerLbl">
            <button type="button" class="icon-btn" id="timerPlus" aria-label="Longer timer">+</button>
          </div></div>
        <div class="adv-row"><b>Leech after</b>
          <span>A card you forget this many times is a <b>leech</b>, and again every half that many after (8, 12, 16…). 0 turns this off.</span>
          <div class="stepper">
            <button type="button" class="icon-btn" id="leechMinus" aria-label="Fewer times">−</button>
            <input id="leech" type="number" inputmode="numeric" min="0" max="99" value="${settings.leechThreshold}" aria-label="Times forgotten before a card is a leech">
            <button type="button" class="icon-btn" id="leechPlus" aria-label="More times">+</button>
          </div></div>
        <div class="adv-row"><b id="leechActLbl">When a card becomes a leech</b>
          <div class="chips" role="group" aria-labelledby="leechActLbl">
            <button type="button" class="tchip" data-leech="suspend" aria-pressed="${settings.leechAction === 'suspend'}">Tag it and suspend it</button>
            <button type="button" class="tchip" data-leech="tag" aria-pressed="${settings.leechAction === 'tag'}">Just tag it</button>
          </div>
          <span>Leeches are tagged “leech”. Find them in the card list with the Leeches filter, then rewrite or split them.</span></div>
        <button class="btn ghost small" type="button" id="schedReset">Reset to defaults</button>
      </details>
    </section>

    <section class="section" aria-labelledby="syncTitle">
      <h2 id="syncTitle">Sync</h2>
      <div id="syncBox"></div>
    </section>

    <section class="section" aria-labelledby="dataTitle">
      <h2 id="dataTitle">Your data</h2>
      <div class="set-row" id="installRow">${settingsRowHTML()}</div>
      <div class="set-row">
        <div><b>Storage</b><p>${persisted
          ? 'Saved permanently on this device.'
          : 'Saved on this device. Install the app to your home screen so the browser keeps it safe.'}</p>
          <p class="note" id="mediaLine"></p></div>
      </div>
      <div class="set-row" id="usageRow" hidden>
        <div><b>Account space</b><p class="usage-line" id="usageLine"></p><p class="note" id="usageNote" hidden></p><p class="note usage-line warn" id="cardsNote" hidden></p></div>
      </div>
      <div class="set-row">
        <div><b>Back up</b><p>Save everything (decks, cards, progress, settings) to one file. Keep it somewhere safe, or use it to move your data to another device.</p>
          <p class="note ${backup.nudge ? 'usage-line warn' : ''}" id="backupNote">${esc(backup.text)}</p></div>
        <button class="btn ghost small" type="button" id="exportBtn">Export backup</button>
      </div>
      <label class="adv-row switch-row" id="bkSoundsRow" hidden><span><b id="bkSoundsTitle">Include sounds</b>
        <span id="bkSoundsInfo"></span></span>
        <input id="bkSounds" type="checkbox" class="switch"></label>
      <div class="set-row">
        <div><b>Restore</b><p>Load a backup file. It replaces everything on this device.</p></div>
        <label class="btn ghost small file-btn">Import backup<input type="file" id="importIn" accept=".json,application/json"></label>
      </div>
      <p class="note"><span id="whereNote"></span></p>
      <details class="danger-zone" id="dangerZone">
        <summary>Danger zone</summary>
        <div class="set-row">
          <div><b>Reset all data</b><p>Deletes every deck, card and review. Your theme and card text setting are kept.</p></div>
          <button class="btn danger small" type="button" id="resetBtn">Reset…</button>
        </div>
      </details>
    </section>

    <section class="section" aria-labelledby="aboutTitle">
      <h2 id="aboutTitle">About</h2>
      <div class="set-row" id="aboutRow">
        <div><b>Study Sprint ${APP_VERSION}</b>
          <p><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a> · Contact: ${contactHTML()}</p></div>
      </div>
    </section>`;

  wireSettingsRow($('installRow'));
  wireReminders(el, { decks, settings });
  // The jump links scroll their section into view (the hash is the app's route, so no real anchor jump).
  $('setNav').addEventListener('click', e => {
    const a = e.target.closest('a[data-sec]'); if (!a) return;
    e.preventDefault();
    $(a.dataset.sec).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  $('skins').addEventListener('click', e => {
    const b = e.target.closest('.skin'); if (!b) return;
    saveTheme({ ...settings.theme, skin: b.dataset.skin });
    el.querySelectorAll('.skin').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  // The previews are redrawn after a light/dark or OLED change, so they show the new look
  const redrawSkins = () => { $('skins').innerHTML = skinButtonsHTML(settings.theme.skin); };
  // Original or Clinical: the whole look changes at once. The heading, these chips and the accent buttons are updated by the
  // 'themechange' listener in start-up below (applyTheme fires it): keep the two in step when adding a style-dependent control.
  el.querySelectorAll('input[name="ui"]').forEach(r => r.addEventListener('change', () => {
    saveTheme({ ...settings.theme, ui: r.value });
  }));
  el.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
    saveTheme({ ...settings.theme, mode: r.value });
    redrawSkins();
  }));
  el.querySelectorAll('input[name="cardAlign"]').forEach(r => r.addEventListener('change', () => {
    settings.cardAlign = applyCardAlign(r.value);
    db.setSetting('cardAlign', settings.cardAlign);          // this device only: it is not one of the synced settings
  }));
  // These two are per device too (not in SYNCED_SETTINGS): Decks and Stats read them when they are drawn.
  for (const key of ['compactDecks', 'statsReadiness', 'ratingFeedback', 'smoothMotion', 'singleKeys']) {
    $(key).addEventListener('change', e => { settings[key] = e.target.checked; db.setSetting(key, e.target.checked); fx.configure(settings); configureShortcuts(settings); });
  }
  $('glossaryUnderline').addEventListener('change', e => { settings.glossaryUnderline = e.target.checked; db.setSetting('glossaryUnderline', e.target.checked).then(() => dispatchEvent(new Event('glossary-changed'))); });
  $('glossBtn').addEventListener('click', () => import('./glossary-sheet.js').then(m => m.openGlossary()).catch(err => console.error(err)));
  const glossCount = async () => { const n = termCount(await db.getSettings()); if ($('glossSub')) $('glossSub').textContent = n ? `${n} term${n === 1 ? '' : 's'}` : 'Define a term once and it’s underlined on every card, with its definition a tap away.'; };
  addEventListener('glossary-changed', glossCount);
  $('oled').addEventListener('change', e => {
    saveTheme({ ...settings.theme, oled: e.target.checked });
    redrawSkins();
  });
  drawSync();
  $('resetBtn').addEventListener('click', confirmReset);
  $('exportBtn').addEventListener('click', exportBackup);
  fillMediaInfo();
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
  // Play: practice only (default) or counted as reviews. Synced, so every device plays the same way.
  $('playCounts').addEventListener('change', e => { settings.playCountsAsReviews = e.target.checked; db.setSetting('playCountsAsReviews', e.target.checked); });
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
  // Play timer: the same setting as the slider on the Play screen (3 to 20 seconds).
  const setTimer = v => {
    const n = Math.max(3, Math.min(20, Math.round(Number(v) || settings.timer)));
    $('timerSec').value = n;
    settings.timer = n;
    db.setSetting('timer', n);
  };
  $('timerSec').addEventListener('change', e => setTimer(e.target.value));
  $('timerMinus').addEventListener('click', () => setTimer(settings.timer - 1));
  $('timerPlus').addEventListener('click', () => setTimer(settings.timer + 1));
  // Reviews per day: blank = no limit.
  $('rpd').addEventListener('change', e => {
    const v = e.target.value.trim();
    settings.reviewLimit = v ? Math.max(1, Math.min(9999, Math.round(Number(v) || 1))) : null;
    e.target.value = settings.reviewLimit ?? '';
    db.setSetting('reviewLimit', settings.reviewLimit);
  });
  el.querySelectorAll('[data-easy]').forEach(sel => sel.addEventListener('change', () => {
    const week = [...(settings.easyDays || db.DEFAULT_SETTINGS.easyDays)];
    week[+sel.dataset.easy] = sel.value;
    settings.easyDays = week;
    db.setSetting('easyDays', week);
  }));
  $('ret').addEventListener('input', e => { $('retOut').textContent = `${e.target.value}%`; });
  $('ret').addEventListener('change', e => {
    settings.targetRetention = Number(e.target.value) / 100;
    db.setSetting('targetRetention', settings.targetRetention);
  });
  $('retHelp').addEventListener('click', async () => {
    try {
      (await import('./retention-sheet.js')).openRetentionSheet({
        deckId: '',
        current: () => Math.round(settings.targetRetention * 100),
        onPick: pct => {
          settings.targetRetention = pct / 100;
          db.setSetting('targetRetention', settings.targetRetention);
          $('ret').value = pct; $('retOut').textContent = `${pct}%`;
          toast(`Target retention is now ${pct}%`);
        }
      });
    } catch (err) { console.error(err); toast("Couldn't open that. Check your connection and try again."); }
  });
  rememberFold($('advanced'), 'settings-advanced');
  wireAdvanced(el);
}

// Advanced scheduling: each box is checked when you leave it, and only saved if it makes sense.
function wireAdvanced(el) {

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
    input.addEventListener('input', () => { const r = parseSteps(input.value); if (r.steps) { explain(r.steps); clearFieldError(input, err); } });
    input.addEventListener('change', () => {
      const r = parseSteps(input.value);
      if (r.error) { showFieldError(input, err, r.error, { focus: false, clearOnInput: false }); return; }      // (checked as you leave the box: pulling the cursor back would trap it)
      clearFieldError(input, err);
      settings[key] = formatSteps(sortSteps([...new Set(r.steps)]));   // tidy: in order, no duplicates
      input.value = settings[key];
      explain(parseSteps(settings[key]).steps);
      db.setSetting(key, settings[key]);
      toast('Saved');
    });
    box.querySelector('[data-reset]').addEventListener('click', () => {
      settings[key] = SCHED_DEFAULTS[key];
      input.value = settings[key];
      clearFieldError(input, err);
      explain(parseSteps(settings[key]).steps);
      db.setSetting(key, settings[key]);
      toast('Reset to ' + settings[key]);
    });
    explain(parseSteps(settings[key]).steps || parseSteps(SCHED_DEFAULTS[key]).steps);
  });

  const setMax = days => {
    const r = parseMaxInterval(days);
    if (r.error) { showFieldError($('maxDays'), $('maxErr'), r.error, { focus: false, clearOnInput: false }); return; }
    clearFieldError($('maxDays'), $('maxErr'));
    settings.maxInterval = r.days;
    $('maxDays').value = r.days;
    el.querySelectorAll('[data-max]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.max === r.days)));
    db.setSetting('maxInterval', r.days);
    toast('Saved');
  };
  el.querySelectorAll('[data-max]').forEach(b => b.addEventListener('click', () => setMax(+b.dataset.max)));
  $('maxDays').addEventListener('change', e => setMax(e.target.value));
  $('maxDays').addEventListener('input', e => { if (!parseMaxInterval(e.target.value).error) clearFieldError($('maxDays'), $('maxErr')); });      // (checked again as you type)
  $('fuzz').addEventListener('change', e => { settings.fuzz = e.target.checked; db.setSetting('fuzz', settings.fuzz); });
  // Personal parameters: the sheet fits your own FSRS weights (optimize-sheet.js, loaded when first opened).
  const redrawAdvanced = async () => {
    if (currentRoute !== 'settings') return;
    await renderSettings($('screen'));
    $('advanced').open = true;
  };
  // Scheduler: FSRS-6 or FSRS-7 (beta). Synced; cards keep their history and both memories (srs7.js), so switching back is safe.
  el.querySelectorAll('input[name="fsrsVersion"]').forEach(r => r.addEventListener('change', async () => {
    settings.fsrsVersion = +r.value === 7 ? 7 : 6;
    await db.setSetting('fsrsVersion', settings.fsrsVersion);
    toast(settings.fsrsVersion === 7 ? 'FSRS-7 (beta) is on' : 'Back to FSRS-6');
    await redrawAdvanced();
    $('fsrsChips').querySelector('input:checked')?.focus();
  }));
  $('optOpen').addEventListener('click', async () => {
    try { (await import('./optimize-sheet.js')).openOptimizeSheet({ changed: redrawAdvanced }); }
    catch (err) { console.error(err); toast("Couldn't open that. Check your connection and try again."); }
  });
  $('healthOpen').addEventListener('click', async () => {
    try { (await import('./health-sheet.js')).openHealthSheet(); }
    catch (err) { console.error(err); toast("Couldn't open that. Check your connection and try again."); }
  });
  $('ignoreBefore').addEventListener('change', e => {
    const v = cleanIgnoreBefore(e.target.value);
    e.target.value = v || '';
    settings.ignoreBefore = v;
    $('ignoreClear').hidden = !v;
    db.setSetting('ignoreBefore', v);
    toast(v ? `Reviews before ${v} are ignored when tuning` : 'Using all your reviews');
  });
  $('ignoreClear').addEventListener('click', () => {
    $('ignoreBefore').value = ''; settings.ignoreBefore = null; $('ignoreClear').hidden = true;
    db.setSetting('ignoreBefore', null);
    toast('Using all your reviews');
  });
  $('optReset')?.addEventListener('click', () => {
    $('optConfirm').hidden = false;
    $('optReset').hidden = true;
    $('optNo').focus();
  });
  $('optNo').addEventListener('click', () => { $('optConfirm').hidden = true; $('optReset') && ($('optReset').hidden = false); $('optReset')?.focus(); });
  $('optYes').addEventListener('click', async () => {
    // Saved as { w: null }, not deleted: a stamped value syncs to your other devices, a missing one does not.
    await db.setSetting('fsrsParams', { w: null, at: Date.now(), version: FSRS_VERSION });
    await redrawAdvanced();
    toast('Back to the standard settings');
  });
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
// How much room pictures and sounds take here (Storage row), and the backup's "Include sounds" switch: on up to 150 MB of sounds.
const BIG_BACKUP = 150 * 1024 * 1024;
async function fillMediaInfo() {
  try {
    const [{ sizeText }, totals, est] = await Promise.all([import('./media.js'), db.mediaTotals(), navigator.storage?.estimate?.().catch(() => null)]);
    if (!$('mediaLine')) return;                       // moved to another screen meanwhile
    const free = est?.quota ? ` · about ${sizeText(Math.max(0, est.quota - (est.usage || 0)))} free` : '';
    const size = n => (n ? sizeText(n) : '0 KB');
    const lack = await sync.missingMedia().catch(() => null);
    if (!$('mediaLine')) return;
    $('mediaLine').textContent = `On this device: pictures ${size(totals.pictures)} · sounds ${size(totals.sounds)}${free}.${lack ? ' ' + notDownloadedLine({ pictures: lack.pictures.length, sounds: lack.sounds.length }) : ''}`;
    $('bkSoundsRow').hidden = !totals.sounds;
    if (totals.sounds) {
      $('bkSoundsTitle').textContent = `Include sounds (${sizeText(totals.sounds)})`;
      $('bkSounds').checked = totals.sounds <= BIG_BACKUP;
      $('bkSoundsInfo').textContent = totals.sounds <= BIG_BACKUP ? 'Pictures are always included. Turn this off for a smaller file.' : 'Very large backups can fail on phones.';
    }
  } catch (err) { console.error(err); }
}
async function exportBackup() {
  // (The switch only shows when there are sounds; without it, everything is included.)
  const withSounds = $('bkSoundsRow')?.hidden ? true : $('bkSounds').checked;
  // Pictures and sounds this device hasn't downloaded yet (they load when a card needs them) would be missing from the file:
  // fetch them first. What can't be fetched is said before saving, and a second tap saves without it.
  const btn = $('exportBtn');
  let leftOut = 0;
  // (A device that never signed in has no account to fetch from: nothing to try and nothing to nag about.)
  const synced = !!(await sync.account().catch(() => null)) || !!(await db.getSettings()).syncState?.userId;
  const lack = synced ? await sync.missingMedia({ sounds: withSounds }) : { pictures: [], sounds: [] };
  if (lack.pictures.length + lack.sounds.length) {
    btn.disabled = true;
    let r;
    try {
      r = await sync.downloadAllMedia({ sounds: withSounds, onProgress: (n, t) => { if ($('backupNote')) $('backupNote').textContent = `Downloading pictures and sounds first: ${n} of ${t}…`; } });
    } finally { btn.disabled = false; }
    leftOut = r.left.length + r.gone.length;
    if (leftOut && btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Export without them';
      if ($('backupNote')) { $('backupNote').className = 'note usage-line warn'; $('backupNote').textContent = leftOutNote(leftOut, r.reason, r.gone.length); }
      return;
    }
  }
  const { blob, cards: cardCount, reviews: reviewCount } = await db.exportAllBlob({ sounds: withSounds });
  const d = new Date();
  const name = `study-sprint-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([blob], name, { type: 'application/json' });
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
  toast(`Backup saved: ${plural(cardCount, 'card')}, ${plural(reviewCount, 'review')}${leftOut ? `. ${leftOut} ${leftOut === 1 ? 'picture or sound' : 'pictures and sounds'} not included` : ''}`);
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
  // Glossary terms on this device that the backup does not have would be removed too: say so.
  const lostTerms = entriesFrom(await db.getSettings()).filter(t => !Object.hasOwn(data.settings || {}, `gloss:${t.id}`)).length;
  const when = data.exported ? new Date(data.exported).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an unknown date';
  openSheet(`
    <h2 id="sheetTitle">Restore this backup?</h2>
    <p style="margin:0">Backup from <b>${esc(when)}</b>: ${plural(data.decks.length, 'deck')}, ${plural(data.cards.length, 'card')}, ${plural(data.reviewLog.length, 'review')}.</p>
    <div class="confirm">
      <p>Everything on this device now is <b>replaced</b> by the backup${synced ? ', <b>and in your sync account too</b>: your other devices change to match when they sync' : ''}. Export a backup first if you want to keep it.</p>
      ${lostTerms ? `<p>This also removes ${plural(lostTerms, 'glossary term')} that ${lostTerms === 1 ? 'is' : 'are'} not in the backup.</p>` : ''}
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rbNo">Cancel</button>
        <button class="btn danger solid" type="button" id="rbYes">Replace and restore</button>
      </div>
    </div>`);
  $('rbNo').focus();
  $('rbNo').addEventListener('click', closeSheet);
  $('rbYes').addEventListener('click', async () => {
    try {
      // Catch up first, so everything in the account gets replaced. If another window holds the sync, stop: going on could lose its changes.
      // (Any other failure, such as being offline, goes on as before: the backup is applied here and sent when there's a connection.)
      if (synced && ['busy', 'skipped'].includes((await sync.syncNow()).reason)) { closeSheet(); toast('Another window is syncing. Try again in a moment. Nothing was changed.'); return; }
      await db.importAll(data, { everywhere: synced });
    } catch (e) {
      console.error(e);
      closeSheet();
      toast(e?.noSpace ? `${e.message} Nothing was changed.` : "Couldn't restore that backup. Nothing was changed.");
      return;
    }
    if (synced) sync.syncNow();
    settings = await db.getSettings();
    settings.theme = applyTheme(settings.theme);
    applyCardAlign(settings.cardAlign);
    fx.configure(settings); configureShortcuts(settings);
    closeSheet();
    toast(`Restored ${plural(data.cards.length, 'card')}`);
    drawSidebar();
    navGo('#/decks');
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
  // Files this device never downloaded can't be sent from here: say so (another device that holds them has to do its own re-upload).
  sync.missingMedia().then(l => {
    const n = l.pictures.length + l.sounds.length;
    if (n && $('rsLack')) { $('rsLack').hidden = false; $('rsLack').textContent = `${n.toLocaleString()} ${n === 1 ? 'picture or sound isn' : 'pictures and sounds aren'}'t on this device and can't be re-sent from here. If another device holds ${n === 1 ? 'it' : 'them'}, re-upload from that device too.`; }
  }).catch(() => {});
  $('rsYes').addEventListener('click', async () => {
    await wipeThisDevice();
    closeSheet();
    toast('All data reset');
    drawSidebar();
    navGo('#/decks');
  });
}

// Signed in, Reset can mean "everywhere" or "just this device".
function confirmResetSynced() {
  openSheet(`
    <h2 id="sheetTitle">Reset all data?</h2>
    <div class="confirm">
      <p><b>Everywhere</b> deletes every deck, card and review on this device <b>and in your account</b>, so your other devices delete them too when they sync. It can't be undone.</p>
      <p><b>Just this device</b> signs this device out and clears it. Your account and other devices keep everything (sign in again to get it back).</p>
      <div class="sheet-actions stack">
        <button class="btn danger solid" type="button" id="rsAll">Delete everywhere</button>
        <button class="btn danger" type="button" id="rsHere">Just this device</button>
        <button class="btn ghost" type="button" id="rsNo">Cancel</button>
      </div>
    </div>`);
  $('rsNo').focus();
  $('rsNo').addEventListener('click', closeSheet);
  $('rsAll').addEventListener('click', async () => {
    // First catch up, so nothing from another device is missed. Stops if another window holds the sync (as with restore).
    const caught = await sync.syncNow();
    if (!caught.ok) {
      closeSheet();
      toast(caught.reason === 'error' ? "Couldn't sync first, so cards from your other devices might be missed. Connect to the internet and try again. Nothing was deleted." : 'Another window is syncing. Try again in a moment. Nothing was deleted.');
      return;
    }
    await db.deleteEverything();
    refreshBadgeNow();            // nothing is due any more: the app icon's number goes
    // Study settings back to their defaults (they sync); the theme stays.
    for (const [k, v] of Object.entries(db.DEFAULT_SETTINGS)) if (SYNCED_SETTINGS.includes(k)) await db.setSetting(k, v);
    settings = { ...(await db.getSettings()), theme: settings.theme };
    await sync.syncNow();
    closeSheet();
    toast('Everything deleted on all your devices');
    drawSidebar();
    navGo('#/decks');
  });
  $('rsHere').addEventListener('click', async () => {
    await sync.signOut({ forget: true });
    await wipeThisDevice();
    closeSheet();
    toast('This device was reset and signed out');
    drawSidebar();
    navGo('#/decks');
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
  drawUsage();
  if (!acct) {
    box.innerHTML = `
      <p class="note" style="margin-top:0">Keep your decks, cards and progress the same on all your devices: sign in with the same account on each one. Anyone can make an account; each account only ever sees its own data.</p>
      <form id="syncForm" novalidate>
        <label class="field"><span>Email</span>
          <input id="syncEmail" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
        ${passwordField('syncPw', 'Password', 'current-password')}
        <p class="pw-rules-title">New accounts need:</p>
        ${rulesList('syncRules')}
        <div id="captchaBox" hidden></div>
        <p class="err" id="syncErr" role="alert" hidden></p>
        <p class="note" id="legalNote">By creating an account you agree to the ${legalLinksHTML()}. Your cards are stored on Supabase servers, managed by the app’s developer.</p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" id="syncCreate" aria-describedby="legalNote">Create account</button>
          <button class="btn primary" type="submit">Sign in</button>
        </div>
      </form>
      <p class="note">First time? Use <b>Create account</b> once (we email you a link to confirm it), then <b>Sign in</b> on your other devices.
        <button class="link" type="button" id="forgotBtn" style="padding:0 2px;min-height:0">Forgot password?</button></p>`;
    const go = async create => {
      const email = $('syncEmail').value.trim(), pw = $('syncPw').value;
      const err = $('syncErr'), emailF = $('syncEmail'), pwF = $('syncPw');
      clearFieldError(emailF, err); clearFieldError(pwF, err);
      pwF.autocomplete = create ? 'new-password' : 'current-password';      // a new account's password is saved as new, not filled from an old one
      if (!/^\S+@\S+\.\S+$/.test(email)) { showFieldError(emailF, err, 'Type your email address.'); return; }
      // New accounts follow the password rules; signing in doesn't check them (older passwords still work).
      if (!pw) { showFieldError(pwF, err, 'Type your password.'); return; }
      if (create && !passwordOk(pw)) { showFieldError(pwF, err, `Your password needs ${passwordMissing(pw)}.`); return; }
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        // With a captcha set up (sync-config.js), the "are you a person?" box comes first; its token goes with the request.
        const captcha = await captchaToken();
        const made = await (create ? sync.createAccount(email, pw, captcha) : sync.signIn(email, pw, captcha));
        if (made?.pending) {                  // Supabase emailed a confirmation link: nobody is signed in yet
          box.querySelectorAll('button').forEach(b => { b.disabled = false; });
          openSheet(`
            <h2 id="sheetTitle">Check your email</h2>
            <p>We sent a link to <b>${esc(email)}</b>. Open it to confirm your account, then come back here and <b>sign in</b> with your email and password.</p>
            <p class="note">No email after a few minutes? Look in your spam folder, or tap Create account again to send it again.</p>
            <div class="sheet-actions"><button class="btn primary" type="button" id="pendOk">OK</button></div>`);
          $('pendOk').addEventListener('click', closeSheet);
          return;
        }
        toast(create ? 'Account created. Syncing…' : 'Signed in. Syncing…');
        drawSync();
      } catch (e) {
        box.querySelectorAll('button').forEach(b => { b.disabled = false; });
        showFieldError(pwF, err, e.message);          // (a refused sign-in: the password is the likeliest thing to fix)
      }
    };
    wireRules('syncPw', 'syncRules');
    $('syncForm').addEventListener('submit', e => { e.preventDefault(); go(false); });
    $('syncCreate').addEventListener('click', () => go(true));
    // The password box is told which kind of password it holds as soon as a button is aimed at (focus or press), not only when the form is sent.
    const kind = v => () => { $('syncPw').autocomplete = v; };
    for (const [btn, v] of [[$('syncCreate'), 'new-password'], [$('syncForm').querySelector('button[type=submit]'), 'current-password']]) {
      for (const ev of ['focus', 'pointerdown']) btn.addEventListener(ev, kind(v));
    }
    $('forgotBtn').addEventListener('click', async () => {
      const email = $('syncEmail').value.trim(), err = $('syncErr');
      if (!/^\S+@\S+\.\S+$/.test(email)) { showFieldError($('syncEmail'), err, 'Type your email above first, then tap Forgot password.'); return; }
      try {
        clearFieldError($('syncEmail'), err);
        await sync.sendPasswordReset(email, await captchaToken());
        openSheet(`
          <h2 id="sheetTitle">Check your email</h2>
          <p>If there's an account for <b>${esc(email)}</b>, Supabase has sent it a password reset link.</p>
          <p class="note">Open the link: it opens Study Sprint in your browser, where you can set a new password. Then sign in with it on each of your devices (including the home-screen app).</p>
          <div class="sheet-actions"><button class="btn primary" type="button" id="fpOk">OK</button></div>`);
        $('fpOk').addEventListener('click', closeSheet);
      } catch (e) { showFieldError($('syncEmail'), err, e.message); }
    });
    return;
  }
  box.innerHTML = `
    <div class="set-row">
      <div><b>Signed in</b><p>${esc(acct.email)}<br><span id="syncStatus"></span></p></div>
      <button class="btn ghost small" type="button" id="syncNowBtn">Sync now</button>
    </div>
    <label class="adv-row switch-row" id="keepAllRow"><span><b>Keep all pictures and sounds on this device</b>
      <span>Off: a picture or sound downloads the first time a card needs it, which saves your mobile data and the account's monthly download allowance. On: this device downloads all of them while syncing, so every card works offline (best on Wi-Fi), and it keeps a full copy in case your account ever loses them.</span></span>
      <input id="keepAllMedia" type="checkbox" class="switch" ${settings.keepAllMedia ? 'checked' : ''}></label>
    <div class="set-row">
      <div><b>Re-upload everything</b><p>Only if your synced data was lost or restored on the server. Sends everything on this device again.</p></div>
      <button class="btn ghost small" type="button" id="resendBtn">Re-upload…</button>
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
      <div><b>Delete my account</b><p>Permanently deletes your account and everything stored in it on the server. Your devices keep their own copy.</p></div>
      <button class="btn danger small" type="button" id="delAcctBtn">Delete my account</button>
    </div>
    <div class="set-row">
      <div><b>Delete my synced data</b><p>Removes your cards, progress, settings, pictures and sounds from the server. Your account (your email address) stays until you use Delete my account. Your devices keep their own copy.</p></div>
      <button class="btn danger small" type="button" id="delServerBtn">Delete…</button>
    </div>`;
  showSyncStatus(acct.lastSync);
  $('syncNowBtn').addEventListener('click', () => sync.syncNow({ retry: true }));
  $('pwBtn').addEventListener('click', () => openPasswordSheet({ title: 'Change password', save: pw => sync.changePassword(pw), done: 'Password changed' }));
  $('keepAllMedia').addEventListener('change', async e => {
    settings.keepAllMedia = e.target.checked;
    await db.setSetting('keepAllMedia', e.target.checked);          // this device only (db.js LOCAL_ONLY)
    if (e.target.checked) sync.syncNow({ retry: true });
  });
  $('resendBtn').addEventListener('click', confirmResend);
  $('signOutBtn').addEventListener('click', confirmSignOut);
  $('delServerBtn').addEventListener('click', confirmDeleteServer);
  $('delAcctBtn').addEventListener('click', confirmDeleteAccount);
}

// Settings → Your data → "In your account: data … · pictures and sounds … of …" (only when signed in, and the
// server has supabase/limits.sql). Amber from 80%, with the full message once the account is full.
async function drawUsage() {
  const row = $('usageRow');
  if (!row) return;
  const u = (await sync.account()) ? usageLine(await sync.usage()) : null;
  if (!row.isConnected) return;
  row.hidden = !u;
  if (!u) return;
  $('usageLine').textContent = u.text;
  $('usageLine').className = 'usage-line ' + u.level;
  $('usageNote').hidden = !u.detail;
  $('usageNote').textContent = u.detail;
  $('usageNote').className = 'note usage-line ' + u.level;
  // 50,000 cards or more: a heads-up that stays here (nothing is blocked).
  const big = cardsWarning(await db.count('cards'));
  if (!row.isConnected) return;
  $('cardsNote').hidden = !big;
  $('cardsNote').textContent = big || '';
}

// A fresh "are you a person?" token, or undefined when the project has no captcha set up. (captcha.js only loads
// when it's needed.)
async function captchaToken() {
  const { captchaOn, askCaptcha } = await import('./captcha.js');
  return captchaOn() ? askCaptcha($('captchaBox')) : undefined;
}

// A password box with a Show / Hide button (handy on phones).
function passwordField(id, label, autocomplete) {
  return `<label class="field"><span>${esc(label)}</span>
    <span class="pw-wrap"><input id="${id}" type="password" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false">
      <button type="button" class="pw-show" data-show="${id}" aria-label="Show password" aria-pressed="false">Show</button></span></label>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-show]');
  if (!b) return;
  e.preventDefault();
  const input = $(b.dataset.show), showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  b.textContent = showing ? 'Show' : 'Hide';
  b.setAttribute('aria-pressed', String(!showing));
  b.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

// The password rules as a checklist that ticks off as you type (see password.js).
const rulesList = id => `<ul class="pw-rules" id="${id}" aria-live="polite"></ul>`;
function wireRules(inputId, listId) {
  const draw = () => {
    $(listId).innerHTML = checkPassword($(inputId).value).map(r =>
      `<li class="${r.ok ? 'ok' : ''}"><span aria-hidden="true">${icon(r.ok ? 'check' : 'circle')}</span> ${esc(r.label)}<span class="sr-only">${r.ok ? ' (done)' : ''}</span></li>`).join('');
  };
  $(inputId).addEventListener('input', draw);
  draw();
}

// A sheet asking for a new password (twice). save(pw) does the work; done is the message afterwards.
function openPasswordSheet({ title, intro = '', save, done }) {
  openSheet(`
    <h2 id="sheetTitle">${esc(title)}</h2>
    ${intro}
    <form id="pwForm" novalidate>
      ${passwordField('pw1', 'New password', 'new-password')}
      ${rulesList('pwRules')}
      ${passwordField('pw2', 'Type it again', 'new-password')}
      <p class="err" id="pwErr" role="alert" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="pwCancel">Cancel</button>
        <button class="btn primary" type="submit">Save password</button>
      </div>
    </form>`);
  $('pwCancel').addEventListener('click', closeSheet);
  wireRules('pw1', 'pwRules');
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('pw1').value, err = $('pwErr');
    clearFieldError($('pw1'), err); clearFieldError($('pw2'), err);
    if (!passwordOk(pw)) { showFieldError($('pw1'), err, `The password needs ${passwordMissing(pw)}.`); return; }
    if (pw !== $('pw2').value) { showFieldError($('pw2'), err, "The two passwords don't match."); return; }
    const btn = e.submitter || [...$('pwForm').elements].find(b => b.type === 'submit');   // the footer's button lives outside the form but is linked to it
    btn.disabled = true;
    try {
      await save(pw);
      closeSheet();
      toast(typeof done === 'function' ? done() : done);
      if (currentRoute === 'settings') drawSync();
    } catch (ex) { btn.disabled = false; showFieldError($('pw1'), err, ex.message); }
  });
}

// Sign out: keep this device's copy, or remove it (e.g. on a shared computer).
async function confirmSignOut() {
  openSheet(`
    <h2 id="sheetTitle">Sign out?</h2>
    <p>This device stops syncing. Your account and your other devices keep everything.</p>
    <p class="note" id="soNote">Checking for changes that haven't synced yet…</p>
    <div class="confirm">
      <div class="sheet-actions stack">
        <button class="btn primary" type="button" id="soKeep">Sign out, keep data on this device</button>
        <button class="btn danger" type="button" id="soRemove">Sign out and remove it from this device</button>
        <button class="btn ghost" type="button" id="soNo">Cancel</button>
      </div>
    </div>`);
  $('soNo').addEventListener('click', closeSheet);
  // Pictures and sounds this device hasn't downloaded yet (they load when a card needs them) can't be had once signed out: get them first.
  $('soKeep').addEventListener('click', async () => {
    const btn = $('soKeep');
    if (btn.dataset.armed !== '1') {
      const lack = await sync.missingMedia().catch(() => null);
      if (lack && lack.pictures.length + lack.sounds.length) {
        btn.disabled = true;
        let r;
        try { r = await sync.downloadAllMedia({ onProgress: (n, t) => { if ($('soNote')) $('soNote').textContent = `Downloading pictures and sounds first: ${n} of ${t}…`; } }); } finally { btn.disabled = false; }
        const n = r.left.length + r.gone.length;
        if (n) {
          btn.dataset.armed = '1';
          if ($('soNote')) $('soNote').innerHTML = `<span class="warn">${n.toLocaleString()} ${n === 1 ? 'picture or sound' : 'pictures and sounds'} from your cards ${n === 1 ? "isn't" : "aren't"} on this device yet and couldn't be downloaded now, so ${n === 1 ? 'it' : 'they'} won't show here after signing out.</span> Tap again to sign out anyway.`;
          return;
        }
      }
    }
    await sync.signOut(); clearDraft(); closeSheet(); toast('Signed out'); drawSync();
  });
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
    drawSidebar();
    navGo('#/decks');
  });
  // Send anything waiting first, so signing out loses nothing.
  const caught = await sync.syncNow();
  const pending = await sync.pendingChanges().catch(() => 0);
  if ($('soNote') && !armed) $('soNote').textContent = caught.reason === 'busy' ? 'Another window is syncing. Close it, or try again in a moment, before signing out.' : pending ? `${plural(pending, 'change')} couldn't sync yet (are you offline?).` : 'Everything here is synced.';
}

// Send everything on this device to the server again (sync.resendEverything). Safe: it never deletes anything or replaces newer data.
function confirmResend() {
  openSheet(`
    <h2 id="sheetTitle">Re-upload everything from this device?</h2>
    <div class="confirm">
      <p>Use this only if the sync server <b>lost your data</b> or was <b>restored from an older copy</b>, so your cards are missing online even though they are here. Normally you never need it.</p>
      <p class="note">This device sends all of its decks, cards, progress, settings, pictures and sounds again, which can take a while and uses data. Nothing is deleted, and newer changes already on the server are kept. Your other devices don't send anything by themselves: do this on each of your devices, starting with the one you used most recently.</p>
      <p class="note warn" id="rsLack" hidden></p>
      <p class="err" id="rsErr" role="alert" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rsNo">Cancel</button>
        <button class="btn primary" type="button" id="rsYes">Re-upload everything</button>
      </div>
    </div>`);
  $('rsNo').focus();
  $('rsNo').addEventListener('click', closeSheet);
  $('rsYes').addEventListener('click', async () => {
    $('rsYes').disabled = true; clearFieldError(null, $('rsErr'));
    try {
      await sync.resendEverything();        // only starts it; the sync line under Settings → Sync shows progress and any problem
      closeSheet();
      toast('Re-uploading everything from this device…');
    } catch (e) { $('rsYes').disabled = false; showFieldError(null, $('rsErr'), e.message); }
  });
}

// Delete everything in the account on the server (devices keep their copy). Signs this device out.
function confirmDeleteServer() {
  openSheet(`
    <h2 id="sheetTitle">Delete your synced data?</h2>
    <div class="confirm">
      <p>This removes your <b>decks, cards, progress, settings, pictures and sounds from the server</b>. It can't be undone. Your account (your email address) stays until you use Delete my account.</p>
      <p class="note">This device and your other devices keep their own copy of the cards. Of the pictures and sounds, each device keeps only those it has already downloaded: on a device that doesn't hold them all, turn on <b>Keep all pictures and sounds on this device</b> (Settings > Sync) and let it sync first. This device is signed out; sign out on your other devices too, or they'll start sending their changes again. (To remove the account itself, use Delete my account.)</p>
      <p class="note" id="dsNote" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="dsNo">Cancel</button>
        <button class="btn danger solid" type="button" id="dsYes">Delete from server</button>
      </div>
    </div>`);
  $('dsNo').focus();
  $('dsNo').addEventListener('click', closeSheet);
  wireSafeDelete({ yes: 'dsYes', note: 'dsNote', label: 'Delete from server', call: o => sync.deleteServerData(o),
    done: () => { closeSheet(); toast('Your synced data was deleted from the server'); drawSync(); }, fail: msg => toast(msg) });
}

// Delete my synced data / Delete my account, which leave this device holding its own copy: the pictures and sounds it hasn't downloaded
// yet (they load when a card needs them) are saved here first, so the account's deletion doesn't lose them. The first tap says how many
// (when there are any); the second downloads, then deletes. If some can't be downloaded, a further tap deletes anyway. Closing the sheet
// cancels the download, and nothing is deleted.
function wireSafeDelete({ yes, note, label, call, done, fail, ready = () => true }) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  document.addEventListener('sheet-closing', stop, { once: true });
  $('sheet').addEventListener('close', stop, { once: true });
  const live = () => !!$('sheet')?.open && !ac.signal.aborted;
  const text = t => { const b = $(yes); if (b) b.textContent = t; };
  const say = (msg, warn) => { const n = $(note); if (n) { n.hidden = !msg; n.className = warn ? 'note warn' : 'note'; n.textContent = msg || ''; } };
  let step = 0;                                // 0 first tap, 1 download then delete, 2 delete anyway
  $(yes).addEventListener('click', async () => {
    if (!ready()) return;
    if ($('daErr')) clearFieldError(null, $('daErr'));
    $(yes).disabled = true;
    try {
      if (step === 0) {
        const lack = await sync.missingMedia().catch(() => null);
        const n = lack ? lack.pictures.length + lack.sounds.length : 0;
        step = 1;
        if (n) {
          const { sizeText } = await import('./media.js');
          say(`This device will first download ${n.toLocaleString()} ${n === 1 ? 'picture or sound' : 'pictures and sounds'} (about ${sizeText(estimateBytes({ pictures: lack.pictures.length, sounds: lack.sounds.length }))}) so it keeps ${n === 1 ? 'it' : 'them'}. That can take a while and uses data (best on Wi-Fi).`);
          text('Download, then delete');
          $(yes).disabled = false;
          return;
        }
      }
      await call({ signal: ac.signal, isLive: live, anyway: step === 2, onProgress: (n, t) => text(`Saving pictures here first: ${n} of ${t}`) });
      done();
    } catch (e) {
      if (ac.signal.aborted || e.code === 'cancelled') return;
      const b = $(yes);
      if (!b) return;
      b.disabled = false;
      if (e.code === 'media_left') { step = 2; say(`${e.message.replace(' Nothing was deleted.', '')} Tap Delete anyway to delete without them.`, true); text('Delete anyway'); return; }
      text(label);
      fail(e.message);
    }
  });
}

// Delete the account itself. A typed confirmation: the button stays off until the box says DELETE.
function confirmDeleteAccount() {
  openSheet(`
    <h2 id="sheetTitle">Delete your account?</h2>
    <div class="confirm">
      <p>This permanently deletes your <b>account</b> and <b>everything stored in it on the server</b>: decks, cards, progress, settings, pictures and sounds, and your sign-in. It can't be undone, and you'd need to make a new account to sync again.</p>
      <p class="note"><b>Your data on this device is kept.</b> This device is signed out afterwards. Your other devices keep their own copies of the cards too, but can no longer sync, and keep only the pictures and sounds they have already downloaded (turn on <b>Keep all pictures and sounds on this device</b> in Settings > Sync there first if you want every file).</p>
      <label class="field"><span>Type DELETE to confirm</span>
        <input id="daText" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <p class="note" id="daNote" hidden></p>
      <p class="err" id="daErr" role="alert" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="daNo">Cancel</button>
        <button class="btn danger solid" type="button" id="daYes" disabled>Delete my account</button>
      </div>
    </div>`);
  $('daText').focus();
  $('daNo').addEventListener('click', closeSheet);
  $('daText').addEventListener('input', () => { if ($('daYes').textContent === 'Delete my account') $('daYes').disabled = $('daText').value.trim() !== 'DELETE'; });
  wireSafeDelete({ yes: 'daYes', note: 'daNote', label: 'Delete my account', ready: () => $('daText')?.value.trim() === 'DELETE', call: o => sync.deleteAccount(o),
    done: () => { closeSheet(); toast('Your account was deleted. Your data is still on this device.'); drawSync(); },
    fail: msg => { const e = $('daErr'); if (e) showFieldError(null, e, msg); } });
}

// Back to a fresh start on this device (keeps the theme): used by Reset and by signing out with Remove.
async function wipeThisDevice() {
  clearStashedDraft();            // unsaved card edits kept from leaving a screen
  clearDraft();                   // pasted text on the Import screen belongs to the data that was just wiped
  const { theme, cardAlign, compactDecks, statsReadiness, ratingFeedback, smoothMotion, singleKeys, appBadge, reminderTime } = settings;
  await db.resetAll();
  clearDismissals();              // "not confused" pairs and the catch-up banner's "Not today" belong to the data that was just wiped
  await db.setSetting('theme', theme);
  await db.setSetting('cardAlign', cardAlign);
  await db.setSetting('compactDecks', compactDecks);
  await db.setSetting('statsReadiness', statsReadiness);
  await db.setSetting('ratingFeedback', ratingFeedback);
  await db.setSetting('smoothMotion', smoothMotion);
  await db.setSetting('singleKeys', singleKeys !== false);
  await db.setSetting('appBadge', appBadge === true);
  await db.setSetting('reminderTime', reminderTime || '19:00');
  settings = { ...db.DEFAULT_SETTINGS, theme, cardAlign, compactDecks, statsReadiness, ratingFeedback, smoothMotion, singleKeys, appBadge, reminderTime };
  await markOnboarded();          // someone resetting has seen the first-run start
  await seedSampleDeck();
  refreshBadgeNow();              // the number on the app icon follows the fresh data
}

// "Synced 2m ago", "Syncing…" or what went wrong.
function showSyncStatus(lastSync) {
  const el = $('syncStatus');
  if (!el) return;
  const w = syncWording(lastSync);          // the same wording as the sidebar's sync line
  el.className = w.warn ? 'warn' : 'muted';
  el.textContent = w.text;
  if ($('syncNowBtn')) $('syncNowBtn').disabled = w.syncing;
}

// Stats is slow to draw, so changes from other devices redraw it once after things settle (not once per sync),
// and only while it's showing: if the page is hidden, it redraws when you come back.
let statsTimer = null, statsStale = false;
function redrawStatsSoon() {
  clearTimeout(statsTimer);
  if (document.hidden) { statsStale = true; return; }
  statsTimer = setTimeout(async () => {
    if (currentRoute !== 'stats') return;
    // While Stats is being edited the same box is drawn again (edit mode, the scroll and a held card survive); otherwise a fresh screen.
    try { if ((await lazy('./stats.js')).softRefresh()) return; } catch { /* fall back to a fresh draw */ }
    if (currentRoute === 'stats') route();
  }, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && statsStale) { statsStale = false; if (currentRoute === 'stats') redrawStatsSoon(); }
});

let warnedStale = false;
// After each sync: keep Settings up to date, and redraw the screen if changes came in from another device.
addEventListener('sync', async e => {
  const { state, applied } = e.detail;
  drawSideSync();          // the sidebar's sync line (a draw of the whole sidebar follows below when changes came in)
  if (currentRoute === 'settings') { if (state === 'signed-out') drawSync(); else { showSyncStatus(); if (state === 'done') drawUsage(); } }
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
  if (currentRoute !== 'today' || busy) drawSidebar();          // (Today hands its own fresh data over when it redraws, unless a sheet or field keeps it from)
  if (busy) return;
  if (currentRoute === 'stats') redrawStatsSoon();
  else if (['today', 'decks', 'deck', 'browse'].includes(currentRoute)) route();
  else if (currentRoute === 'settings') {
    // Redraw Settings in place (keeping your scroll position) so synced study settings show.
    const view = $('screen').querySelector('.view'), y = scrollY;
    if (view) { await renderSettings(view); scrollTo(0, y); }
  }
});

// ---------- first run ----------
// A brand-new install (no decks, cards or reviews, and never opened before) starts with the short
// first-run start in js/onboarding.js instead of a filled-in sample. Anyone with data never sees it.
// To skip it (the browser tests do): set localStorage 'study-sprint-skip-onboarding' to '1', or open the app
// with ?skipOnboarding in the address. Skipping this way adds the sample deck, like the app always used to.
function skipFlag() {
  try { if (localStorage.getItem('study-sprint-skip-onboarding') === '1') return true; } catch { /* no storage: fine */ }
  // The address flag is for local testing only, so a stray link can't switch the first run off on the live site.
  return ['localhost', '127.0.0.1'].includes(location.hostname) && /[?&]skipOnboarding\b/.test(location.search);
}

// Settle what a start-up looks like. Returns true if the first-run start should show.
async function checkFirstRun() {
  if (settings.onboarded) return false;
  // Upgrades: anyone who opened the app before has `seeded` set (the old first-run flag) or has data.
  const hasData = settings.seeded || (await db.getDecks()).length || (await db.getAll('cards')).length || (await db.getAll('reviewLog')).length;
  if (hasData) { await markOnboarded(); return false; }
  if (skipFlag()) { await seedSampleDeck(); await markOnboarded(); return false; }
  return true;
}
async function markOnboarded() {
  if (settings.onboarded) return;
  settings.onboarded = true;
  await db.setSetting('onboarded', true);
}

// Add the sample deck once. A saved flag stops it coming back after you delete it
// (`again`: the person asked for it, e.g. "Try the sample deck" in the first-run start).
async function seedSampleDeck(again = false) {
  if (settings.seeded && !again) return;
  await addSampleDeck();
  settings.seeded = true;
  await db.setSetting('seeded', true);
}

// ---------- navigation ----------
// Loads a screen's file. A failed import() is remembered by the browser until the page reloads (even once you are back online), so after a
// failure the file is asked for again under a new address (?r=...) the next time: the screen can load without pressing Reload.
const busted = new Map();
const lazy = path => import(busted.has(path) ? `${path}?r=${busted.get(path)}` : path).catch(err => { busted.set(path, Date.now()); throw err; });
const ROUTES = {
  // Today is the home screen, so it loads with the app. Every other screen is loaded the first time it is
  // opened (the service worker has them saved, so that is quick), which keeps the first load small.
  // Review also needs the FSRS library from the internet (saved for offline after the first time).
  today: el => renderToday(el),
  welcome: async (el, arg) => (await lazy('./onboarding.js')).renderWelcome(el, arg, { seedSample: () => seedSampleDeck(true), finish: markOnboarded }),
  review: async (el, deckId) => (await lazy('./review.js')).renderReview(el, deckId),
  play: async el => (await lazy('./play.js')).renderPlay(el),
  decks: async (el, arg) => (await lazy('./decks.js')).renderLibrary(el, arg === 'starters'),
  deck: async (el, id) => (await lazy('./decks.js')).renderDeck(el, id),
  browse: async (el, arg) => (await lazy('./browse.js')).renderBrowseAll(el, arg),
  import: async (el, deckId) => (await lazy('./import-screen.js')).renderImport(el, deckId),
  stats: async el => (await lazy('./stats.js')).renderStats(el),
  settings: el => renderSettings(el)
};

// Remembered so the gear can take you back to where you were.
let currentRoute = null;     // name of the screen showing now, e.g. 'decks'
let beforeSettings = null;   // address of the screen you were on before opening Settings

async function route() {
  const resetLink = takeResetLink();      // opened from a password reset email? (see below)
  const [, name = 'today', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  if (name === 'settings' && currentRoute && currentRoute !== 'settings') beforeSettings = beforeSettings || lastHash;
  if (name !== 'settings') beforeSettings = null;
  // Once the start is done, #/welcome goes to Today. Still allowed: the guided review that follows it, and
  // #/welcome/again (the "How it works" link on an empty Today screen), which shows the pitch again.
  if (name === 'welcome' && settings.onboarded && !/^(review\/|again$)/.test(arg || '')) { navReplace('#/today'); return; }
  // Walking out of the first-run start any other way (a link, the back button) counts as skipping it.
  if (currentRoute === 'welcome' && name !== 'welcome') markOnboarded();
  if (name !== 'review') takeLaunch();     // a session handed over to Review that never got there (e.g. it failed to load) must not start later
  const prevRoute = currentRoute;
  currentRoute = name;
  lastHash = location.hash;
  document.body.classList.toggle('welcome', name === 'welcome');       // the first-run start hides the tabs
  // The gear (phones) and the sidebar's Settings link (desktop) double as a close button while Settings is open.
  document.querySelectorAll('a[data-tab="settings"]').forEach(a => a.setAttribute('aria-label', name === 'settings' ? 'Close settings' : 'Settings'));
  const render = ROUTES[name] || ROUTES.today;
  // Highlight the right tab. A deck's page and the import screen count as the Decks tab.
  // (A running Review session counts as Today.)
  const tab = name === 'deck' || name === 'import' || name === 'browse' ? 'decks' : name === 'review' ? 'today' : name;
  document.querySelectorAll('[data-tab]').forEach(t => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  markCurrent();                // the deck page open now, in the sidebar's list
  // After a Review or Play round, or an import, the sidebar's counts are out of date (Today hands over its own fresh data).
  // (A round that finished has already redrawn it; one left half-way, or an import, has not.)
  const sidebarStale = name !== prevRoute && name !== 'today'
    && (prevRoute === 'import' || (['review', 'play'].includes(prevRoute) && document.body.classList.contains('focus')));
  releaseBack();                // a session's hold on the back gesture ends when you leave it (a running one asks again as it redraws)
  stashDraft();             // unsaved edits in a card panel are kept for when it is opened again
  closeSheet();
  setFocusMode(false);          // a running Review or Play round turns it back on (see ui.js)
  if (sidebarStale) drawSidebar();
  // Each visit to a screen draws into a fresh box. If you switch screens while one is still loading,
  // the old one finishes into its own box, which is no longer on the page, so it can't draw over the new one.
  const el = document.createElement('div');
  el.className = 'view' + fx.enterClass();      // a short fade-up where View Transitions are missing
  $('screen').replaceChildren(el);
  // Which screen this is, for the desktop layout (some screens use the full width: see styles.css).
  $('screen').dataset.route = ROUTES[name] ? name : 'today';
  scrollTo(0, 0);
  try {
    await render(el, arg && decodeURIComponent(arg));
  } catch (err) {
    if (!el.isConnected) return;          // a screen you already left: ignore
    console.error(err);
    setFocusMode(false);                  // a round that failed to draw must not leave the header and tabs hidden
    // A screen's file that couldn't be loaded (offline, or a half-finished update) gets a plain message and a way out.
    if (/dynamically imported module|importing a module script/i.test(err.message)) {
      el.innerHTML = `<div class="empty"><b>Couldn't load this screen.</b><br>Check your connection and reload.<br><button class="btn" type="button" data-reload>Reload</button></div>`;
      el.querySelector('[data-reload]').onclick = () => location.reload();
      // Back online while this message is still showing: load the screen again by itself.
      addEventListener('online', () => { if (el.isConnected) route(); }, { once: true });
      return;
    }
    el.innerHTML = `<div class="empty"><b>Something went wrong.</b><br>${esc(err.message || err)}</div>`;
  }
  if (el.isConnected) { scrollTo(0, 0); announceScreen(el, name); }
  if (resetLink) showResetLink(resetLink);
}

// Tell screen readers the screen changed: the page title follows the screen (a deck shows its own name) and
// focus moves to the screen's main heading.
const SCREEN_NAMES = { today: 'Today', decks: 'Decks', deck: 'Deck', browse: 'All cards', import: 'Add cards', review: 'Review', play: 'Play', stats: 'Stats', settings: 'Settings', welcome: 'Welcome' };
let firstScreen = true;
function announceScreen(el, name) {
  const h1 = el.querySelector('h1');
  const title = name === 'welcome' ? SCREEN_NAMES.welcome : h1?.textContent.trim() || SCREEN_NAMES[name] || 'Today';
  document.title = `${title} · Study Sprint`;
  const first = firstScreen;
  firstScreen = false;
  // Not on the very first load, and not during a Review or Play round (they manage focus themselves).
  if (first || !h1 || document.body.classList.contains('focus')) return;
  h1.tabIndex = -1;
  // Next frame, not now: focusing makes the browser work out the whole new screen's layout on the spot (50-130 ms on a phone);
  // a frame later it has done that for the paint anyway. (Skipped if the screen was already replaced.)
  // Only if nothing has taken focus in the meantime (the person tapped or typed, a sheet opened) and Review/Play haven't started.
  const before = document.activeElement;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (h1.isConnected && (now === before || now === document.body) && !document.body.classList.contains('focus')) h1.focus({ preventScroll: true });
  });
}

let lastHash = '#/today';

// Tapping the gear while Settings is open closes it and returns to the previous screen.
// (The gear in the phone header and the Settings link in the desktop sidebar both count.)
function wireGear() {
  // Tapping the Play tab on a Play screen that is already showing (e.g. the results) starts a fresh setup:
  // the address does not change, so there is no hashchange to do it.
  document.addEventListener('click', e => {
    if (!e.target.closest('a[data-tab="play"]') || e.defaultPrevented) return;
    if (currentRoute === 'play' && location.hash === '#/play') { e.preventDefault(); route(); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('a[data-tab="settings"]') || e.defaultPrevented) return;
    if (currentRoute !== 'settings') return;           // not open: the link opens Settings as normal
    e.preventDefault();
    navGo(beforeSettings || '#/today');                    // back to the screen you opened Settings from (or home)
  });
}

// ---------- password reset links ----------
// A "reset your password" email opens the app with a sign-in after the # (see parseAuthLink in sync-merge.js).
// Take it out of the address straight away (and keep it for this tab, in case the app reloads to update).
function takeResetLink() {
  const link = sync.recoveryFromLink();
  if (!link) return null;
  rewrite('#/settings');
  if (link.session) { try { sessionStorage.setItem('resetLink', JSON.stringify(link)); } catch { /* fine without */ } }
  return link;
}
function keptResetLink() {
  try { return JSON.parse(sessionStorage.getItem('resetLink') || 'null'); } catch { return null; }
}
let resetShown = false;
async function showResetLink(link) {
  resetShown = true;
  const forget = () => { try { sessionStorage.removeItem('resetLink'); } catch { /* ignore */ } };
  if (link.error) { forget(); toast(link.error); return; }
  if (link.confirmed) { toast('Email confirmed. Now sign in with your email and password.'); return; }
  // Show whose account the link is for, and refuse a link for a different account than this device's.
  let user;
  try { user = await sync.lookUpResetLink(link.session); } catch (err) {
    if (err.code !== 'offline') forget();   // offline: keep the link for this tab, so reopening the app tries again
    toast(err.message);
    return;
  }
  let result;
  openPasswordSheet({
    title: 'Set a new password',
    intro: `<p class="note" style="margin-top:0">Set a new password for <b>${esc(user.email)}</b>. Then use it to sign in on your other devices.</p>`,
    save: async pw => { result = await sync.finishPasswordReset(link.session, pw); forget(); },
    done: () => result.signedIn ? 'Password saved. You\'re signed in.'
      : `Password saved for ${result.email}. To sync this device with that account, sign in from Settings → Sync.`
  });
  // Cancelling just closes it; the link can't be used again after that.
  $('pwCancel')?.addEventListener('click', forget);
}

// ---------- start up ----------
// Pictures and sounds no card uses any more are removed once a day, when the browser has nothing else to do, after the first screen is up.
// (Signed in, syncing does this, and removes them from the account too.) Nothing to do with no pictures or sounds on the device. The
// one-hour wait for new files (db.cleanMedia) is unchanged. The time of the last tidy is kept on this device only (db.LOCAL_ONLY).
const MEDIA_TIDY_EVERY = 24 * 3600 * 1000;
async function tidyMedia(now = Date.now()) {
  if (Number.isFinite(settings.mediaCleanedAt) && now - settings.mediaCleanedAt < MEDIA_TIDY_EVERY && now >= settings.mediaCleanedAt) return false;
  if (await sync.account()) return false;
  if (!(await db.count('media'))) return false;       // (not noted: the first picture added is looked at on the next start)
  await db.cleanMedia(now);
  settings.mediaCleanedAt = now;
  await db.setSetting('mediaCleanedAt', now);
  return true;
}
function tidyMediaWhenIdle() {
  const run = () => tidyMedia().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 15000 });
  else setTimeout(run, 3000);
}

async function start() {
  initSheet();
  initPanelResize();
  initTapGuard();
  wireGear();
  initSidebar({ version: APP_VERSION });
  watchMath();       // draws the maths on cards (js/math.js) wherever it appears
  // "Skip to page" moves focus to the page without touching the address (a #screen hash would be read as a route).
  document.querySelector('.skip')?.addEventListener('click', e => { e.preventDefault(); $('screen').focus({ preventScroll: true }); });
  // Theme changes from the sidebar's toggle (or anywhere else): keep the settings copy and the open Settings screen in step.
  addEventListener('themechange', e => {
    settings.theme = e.detail;
    const r = document.querySelector(`input[name="mode"][value="${e.detail.mode}"]`);
    if (r) r.checked = true;
    const u = document.querySelector(`input[name="ui"][value="${e.detail.ui}"]`);
    if (u) u.checked = true;
    const h = $('thTitle'); if (h) h.textContent = accentTitle(e.detail.ui);          // "Theme" in Original, "Accent colour" in Clinical
    const s = $('skins'); if (s) s.innerHTML = skinButtonsHTML(e.detail.skin);      // Settings' previews follow the new style and light/dark
  });
  try {
    settings = await db.getSettings();
  } catch (err) {
    $('screen').innerHTML = `<div class="empty"><b>Couldn't open storage.</b><br>${esc(err.message)}<br>Private browsing can block it. Try a normal tab.</div>`;
    return;
  }
  settings.theme = applyTheme(settings.theme);
  applyCardAlign(settings.cardAlign);
  fx.configure(settings); configureShortcuts(settings);
  const firstRun = await checkFirstRun();
  sync.startAutoSync();      // does nothing until you sign in (Settings → Sync)
  // Opening the app with no "#/..." in the address shows Today.
  if (!location.hash) history.replaceState(null, '', '#/today');      // (initNav, below, tags the entry)
  // A brand-new install opens on the first-run start (but a link to somewhere else is respected).
  if (firstRun && /^#\/today\/?$/.test(location.hash)) history.replaceState(null, '', '#/welcome');
  // Changing tab slides (View Transitions) unless Smooth transitions is off, motion is reduced or a round is running.
  initNav();         // tabs replace history, sheets and sessions hold the back gesture (js/nav.js)
  addEventListener('hashchange', () => fx.transition(route, currentRoute, (location.hash.match(/^#\/([a-z]+)/) || [, 'today'])[1]));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBrowserBar);
  await route();
  initBadge();          // the due count on the app icon, when the person turned it on (badge.js)
  if (currentRoute !== 'today') drawSidebar();      // Today does it with the data it has just loaded
  tidyMediaWhenIdle();
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
    // Not while nav is stepping through history (a reload then can be cancelled); and once more if the page is still here a second later.
    const reload = () => whenIdle().then(() => location.reload());
    reload();
    setTimeout(reload, 1000);
  });
}

start();
