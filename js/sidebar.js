// The desktop sidebar (from 1024px wide; phones keep their tab bar and header).
// index.html holds the empty frame (Add cards, the four sections, the Decks list, the footer); this file fills it in:
//   Today badge    countFor(data, chosen decks or all).total: the same number as Today's Start button. Hidden at 0.
//   Decks dot      the nearest exam (examInfo) within 7 days: amber, red inside 3 days (the badgeClass rule)
//   Decks list     top-level decks in tree order: colour stripe, due count, and an exam pill within 14 days
//   Footer         goal ring + streak (as on Today), sync status (the wording of Settings), Settings, theme, collapse
// The numbers come from the same loadAll() Today uses, so nothing here reads the whole review log. Today hands over the
// data it just loaded (drawSidebar(loaded)), so opening Today costs nothing extra.
// drawSidebar() runs on start, after Review/Play rounds, after deck edits and when a sync brought changes in.
// Changing screens only moves aria-current (markCurrent), called from route() in app.js.
// Collapsed, the sidebar is a 72px icon rail; the choice is kept per device and applied from index.html's head script.

import { loadAll, countFor, answeredToday, loadStreak, goalFor } from './study-data.js';
import { streakText } from './stats-calc.js';
import { examInfo, badgeClass, countdown } from './exam.js';
import { esc, icon, ring, plural, foldOpen, saveFold, toast } from './ui.js';
import { formatInterval } from './queue.js';
import * as sync from './sync.js';
import { toggleMode, isAlwaysDark } from './themes.js';

const DESKTOP = matchMedia('(min-width: 1024px)');
const RAIL_KEY = 'study-sprint-rail';
const FOLD_KEY = 'side-decks';
const EXAM_PILL_DAYS = 14;       // an exam further away than this is only in the rail tooltip
const EXAM_DOT_DAYS = 7;
const $ = id => document.getElementById(id);
const root = document.documentElement;

const SVG = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const SUN = SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>');
const MOON = SVG('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>');
const PANEL = SVG('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M15.5 10l-2 2 2 2"/>');
const PANEL_OPEN = SVG('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M13.5 10l2 2-2 2"/>');

const short = d => (d === 0 ? 'Today' : `${d}d`);

// "Synced 2m ago", "Syncing…" or what went wrong: the one wording for Settings and the sidebar.
export function syncWording(lastSync) {
  const st = sync.lastStatus();
  const when = st.at || lastSync;
  const ago = when ? (Date.now() - when < 60000 ? 'just now' : `${formatInterval(Date.now() - when)} ago`) : '';
  const note = st.state === 'done' && st.note;          // e.g. pictures can't sync yet
  const text = st.state === 'syncing' ? (st.progress || 'Syncing…')
    : st.state === 'error' ? `Couldn't sync: ${st.error}`
    : (when ? `Synced ${ago}` : 'Not synced yet') + (note ? `. ${note}` : '');
  return { text, warn: st.state === 'error' || !!note, syncing: st.state === 'syncing' };
}

// ---------- drawing ----------
let running = false, queued = null;       // one draw at a time; a request that arrives meanwhile runs once afterwards
const shouldDraw = () => DESKTOP.matches && !document.body.classList.contains('focus') && !document.body.classList.contains('welcome');

// loaded: { data, streak, chosen } when the caller (Today) has just loaded them (chosen: the decks picked in Today's Options).
export async function drawSidebar(loaded = null) {
  if (!shouldDraw()) return;
  if (running) { queued = loaded || queued || {}; return; }
  running = true;
  try {
    let next = loaded;
    do {
      queued = null;
      await paint(next);
      next = queued && queued.data ? queued : null;
    } while (queued);
  } catch (err) {
    console.error(err);
  } finally {
    running = false;
  }
}

async function paint(loaded) {
  const data = loaded?.data || await loadAll({ history: true });
  const streak = loaded?.streak || await loadStreak(data.history, data);
  if (!shouldDraw()) return;
  const allIds = data.decks.map(d => d.id);
  const chosen = loaded?.chosen || data.settings.reviewDecks.filter(id => allIds.includes(id));
  const total = countFor(data, chosen.length ? chosen : allIds).total;
  const answered = answeredToday(data, chosen);          // the same decks as Today's ring
  const goal = goalFor(data.settings, answered, total);

  // Today badge
  const badge = $('sideBadge');
  badge.hidden = !total;
  badge.innerHTML = total ? `<span aria-hidden="true">${total}</span><span class="sr-only"> ${plural(total, 'card')} to study</span>` : '';
  const todayTab = document.querySelector('.tab[data-tab="today"]');
  todayTab.dataset.tip = total ? `Today · ${total} to study` : 'Today';

  // Decks dot: the nearest exam of any deck, when it is close
  const exams = data.decks.map(d => ({ d, info: examInfo(d) })).filter(x => x.info).sort((a, b) => a.info.daysLeft - b.info.daysLeft);
  const near = exams.find(x => x.info.daysLeft <= EXAM_DOT_DAYS);
  const dot = $('sideDot');
  dot.hidden = !near;
  dot.className = 'side-dot' + (near && badgeClass(near.info).includes('soon') ? ' soon' : '');
  dot.innerHTML = near ? `<span class="sr-only">, ${esc(near.d.name)}: ${countdown(near.info).toLowerCase()}</span>` : '';
  const decksTab = document.querySelector('.tab[data-tab="decks"]');
  decksTab.dataset.tip = near ? `Decks · ${near.d.name}: ${countdown(near.info).toLowerCase()}` : 'Decks';

  // The deck list (top-level decks, in tree order)
  const list = $('sideList');
  const keep = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const scroll = list.scrollTop;
  const top = data.decks.filter(d => !data.depth.get(d.id));
  list.innerHTML = top.map(d => {
    const due = countFor(data, [d.id]).due, info = examInfo(d);
    const show = info && info.daysLeft <= EXAM_PILL_DAYS;
    const soon = show && badgeClass(info).includes('soon');
    const label = [d.name, plural(due, 'card') + ' due', info ? countdown(info).toLowerCase() : ''].filter(Boolean).join(', ');
    const tip = [d.name, `${due} due`, info ? short(info.daysLeft) : ''].filter(Boolean).join(' · ');
    return `<a class="side-deck" data-key="${esc(d.id)}" href="#/deck/${esc(d.id)}" style="--deck:${esc(d.color)}" aria-label="${esc(label)}" data-tip="${esc(tip)}"${show ? ` data-exam="${soon ? 'soon' : 'on'}"` : ''}>
      <span class="side-name">${esc(d.name)}</span>
      ${show ? `<span class="side-exam${soon ? ' soon' : ''}" aria-hidden="true">${short(info.daysLeft)}</span>` : ''}
      <span class="side-due${due ? '' : ' zero'}" aria-hidden="true">${due}</span></a>`;
  }).join('') + `<button class="side-deck side-new" data-key="new" type="button" data-tip="New deck">${icon('plus')}<span class="side-name">New deck</span></button>`;
  list.scrollTop = scroll;
  if (keep) list.querySelector(`[data-key="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
  markCurrent();
  fadeList();

  // Footer: goal ring and streak
  const st = $('sideStreak');
  st.className = 'side-streak' + (streak.studiedToday ? ' kept' : '');
  // A streak freeze: "freeze ready" (none used this week) or "freeze used Tue"; a snowflake while one was used in the last 7 days.
  const { sub } = streakText(streak);
  const usedRecently = streak.week.some(d => d.frozen);
  const note = !streak.days ? '' : streak.freeze.usedOn ? ', ' + sub[0].toLowerCase() + sub.slice(1) : ', freeze ready';
  st.setAttribute('aria-label', `${streak.days}-day streak${note}. ${answered} of ${goal} cards today`);
  st.dataset.tip = `${streak.days}-day streak${note ? ' · ' + note.slice(2) : ''} · ${answered} of ${goal} today`;
  st.innerHTML = `${ring(goal ? answered / goal : 0, 30, 3, icon('flame'))}
    <span class="side-st"><b>${streak.days}-day streak${usedRecently ? icon('snow', 'side-snow') : ''}</b><span>${answered} of ${goal} today</span></span>`;
  await drawSync();
}

// The sync line: from the account and the last sync result. Cheap: also runs on every sync event.
export async function drawSync() {
  const el = $('sideSync');
  if (!el || !DESKTOP.matches) return;
  const acct = await sync.account();
  const w = acct ? syncWording(acct.lastSync) : null;
  el.className = 'side-sync' + (!acct ? ' out' : w.warn ? ' warn' : '');
  el.innerHTML = `<i aria-hidden="true"></i><span>${esc(acct ? w.text : 'Sign in to sync')}</span>`;
  el.title = acct ? w.text : '';
  el.dataset.tip = acct ? w.text : 'Sign in to sync';
  // In the rail the sync line is hidden: a dot on the Settings icon says something needs a look.
  const set = $('sideSet'), warn = !!(acct && w.warn);
  set?.classList.toggle('warn', warn);
  if (set) set.dataset.tip = warn ? `Settings · ${w.text}` : 'Settings';
}

// The deck page open now gets aria-current (the other links are marked by route() through data-tab).
export function markCurrent() {
  const here = (location.hash.match(/^#\/deck\/([^/]+)/) || [])[1];
  const id = here && decodeURIComponent(here);
  document.querySelectorAll('#sideList .side-deck[data-key]').forEach(a => {
    if (a.dataset.key === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // On a deck page the deck row is the page; the Decks tab is only the section it belongs to.
  const decksTab = document.querySelector('.tab[data-tab="decks"]');
  if (id && decksTab) decksTab.setAttribute('aria-current', 'true');
}

// A fade at the foot of the list while there is more to scroll to.
function fadeList() {
  const list = $('sideList');
  list.classList.toggle('more', list.scrollHeight - list.scrollTop - list.clientHeight > 2);
}

// ---------- the theme toggle, collapse toggle and folding ----------
function drawModeButton() {
  const b = $('sideMode');
  const dark = root.getAttribute('data-theme') !== 'light';
  b.innerHTML = dark ? SUN : MOON;
  b.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  const locked = isAlwaysDark(root.getAttribute('data-skin'));
  b.dataset.tip = locked ? 'This skin is always dark' : `${dark ? 'Light' : 'Dark'} mode`;
  if (locked) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
}

const railOn = () => root.getAttribute('data-rail') === 'on';
function drawRailButton() {
  const b = $('sideCollapse'), on = railOn();
  b.innerHTML = on ? PANEL_OPEN : PANEL;
  b.setAttribute('aria-expanded', String(!on));
  b.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
  b.dataset.tip = on ? 'Expand sidebar' : 'Collapse sidebar';
}
function setRail(on) {
  if (on) root.setAttribute('data-rail', 'on'); else root.removeAttribute('data-rail');
  try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch { /* private mode: fine */ }
  drawRailButton();
  hideTip();
}

// The DOM order is the keyboard order, so on desktop the sidebar comes before the page (on phones the tab bar stays after it).
function placeNav() {
  const nav = document.querySelector('nav.tabs'), main = $('screen');
  if (!nav || !main) return;
  const focused = nav.contains(document.activeElement) ? document.activeElement : null;      // moving a node drops focus
  if (DESKTOP.matches) main.before(nav); else main.after(nav);
  focused?.focus({ preventScroll: true });
}

// ---------- tooltips for the rail (names are hidden there) ----------
let tip = null;
function hideTip() { if (tip) tip.hidden = true; }
function showTip(el) {
  if (!railOn() || !DESKTOP.matches || !el.dataset.tip) return;
  tip ||= Object.assign(document.createElement('div'), { className: 'side-tip', hidden: true });
  if (!tip.isConnected) { tip.setAttribute('aria-hidden', 'true'); document.body.append(tip); }     // the links already carry their names
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${r.right + 12}px`;
  tip.style.top = `${r.top + r.height / 2 - tip.offsetHeight / 2}px`;
}

// version: the app version shown next to Settings.
export function initSidebar({ version = '' } = {}) {
  const nav = document.querySelector('nav.tabs');
  if (!nav) return;
  $('sideVer').textContent = `v${version}`;
  for (const t of nav.querySelectorAll('.tab')) t.dataset.tip ||= t.textContent.trim();
  placeNav();
  drawModeButton();
  drawRailButton();
  DESKTOP.addEventListener('change', () => { placeNav(); hideTip(); if (DESKTOP.matches) drawSidebar(); });

  $('sideMode').addEventListener('click', () => toggleMode());
  addEventListener('themechange', drawModeButton);
  $('sideCollapse').addEventListener('click', () => setRail(!railOn()));

  // The Decks heading folds the list (remembered on this device, like the other folds).
  const head = $('sideDecksH'), box = document.querySelector('.side-decks');
  const fold = open => { box.classList.toggle('folded', !open); head.setAttribute('aria-expanded', String(open)); };
  fold(foldOpen(FOLD_KEY, true));
  head.addEventListener('click', () => { const open = head.getAttribute('aria-expanded') !== 'true'; fold(open); saveFold(FOLD_KEY, open); fadeList(); });

  // + New deck: the deck editor is loaded the first time it is needed.
  $('sideList').addEventListener('click', async e => {
    if (!e.target.closest('.side-new')) return;
    try {
      const { openDeckEditor } = await import('./decks.js');
      openDeckEditor(null, saved => { location.hash = `#/deck/${saved.id}`; });
    } catch { toast("Couldn't open the deck editor. Check your connection and try again."); }
  });
  $('sideList').addEventListener('scroll', () => { fadeList(); hideTip(); }, { passive: true });
  addEventListener('resize', fadeList);

  nav.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (el) showTip(el); });
  nav.addEventListener('pointerout', hideTip);
  nav.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el) showTip(el); });
  nav.addEventListener('focusout', hideTip);
  addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
}
