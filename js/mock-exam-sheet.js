// The Practice test setup sheet: what to be tested on, how many questions, which kinds, the time limit and the order.
// Opened from the deck page, Today's exam card (a "mock exam" in exam week) and the exam line. The test itself is mock-exam.js; the rules are
// mock-exam-logic.js. The last choices are remembered per deck, and the last few results show here so progress is visible.

import { loadAll } from './study-data.js';
import { subtreeIds, deckChoices, deckPath, effectiveDeck } from './deck-tree.js';
import { loneIds, unpaired } from './reverse.js';
import { plainText } from './format.js';
import { recallAt, examInfo, countdown } from './exam.js';
import { personalW20 } from './sched-settings.js';
import {
  COUNTS, MAX_QUESTIONS, LIMITS, KINDS, ORDERS, cleanCfg, cleanPrefs, tagChoices, narrowByTags, askable, buildTest, newRun, newState, recentResults, cleanHistory, clock
} from './mock-exam-logic.js';
import * as store from './mock-exam-store.js';
import { saveRun, inProgress, clearSaved, savePrefs } from './mock-exam-store.js';
import { go as navGo } from './nav.js';
import { openSheet, closeSheet, esc, plural, toast, $ } from './ui.js';

// The cards a test can use: visible cards (no suspended or buried ones), as plain text like Play, a card whose reverse partner is
// gone asked as an ordinary card.
const playCopy = c => ({ ...c, front: plainText(c.front), back: plainText(c.back) });
async function load() {
  const data = await loadAll();
  const lone = loneIds(data.allCards);
  return { data, cards: data.cards.map(c => playCopy(lone.has(c.id) ? unpaired(c) : c)) };
}
const poolFor = (data, cards, deckId) => { const inside = subtreeIds(data.decks, deckId); return cards.filter(c => inside.has(c.deckId)); };

// Build a test for the deck and start it: saved (so a reload resumes it) and then shown at #/test/<deck>.
// Returns false (with a message) when no question fits the choices.
export async function beginTest(deckId, cfgIn, { stay = false, data: loaded = null } = {}) {
  const { data, cards } = loaded || await load();
  const cfg = cleanCfg(cfgIn);
  const now = Date.now(), w20 = personalW20(data.settings);
  const stateOf = c => data.statesById.get(c.id);
  const { questions } = buildTest(poolFor(data, cards, deckId), cfg, {
    recallOf: c => { const st = stateOf(c); return st && st.state !== 0 ? recallAt(st, now, w20) : null; },
    lapsesOf: c => stateOf(c)?.lapses || 0
  });
  if (!questions.length) { toast('No questions fit these choices'); return false; }
  const run = newRun(cfg, questions, deckId, now);
  saveRun(run, newState(run, now));
  if (!store.persistent) toast('This browser blocks storage, so a reload would end this test.', { ms: 5000 });
  await savePrefs(deckId, cfg);
  if (!stay) navGo(`#/test/${encodeURIComponent(deckId)}`);
  return true;
}

// The setup sheet for a deck. mock: opened as a mock exam (exam week). onStart: what to do after a test was built, instead of going to it.
export async function openTestSheet(deckId, { mock = false, onStart = null } = {}) {
  const loaded = await load();
  const { data, cards } = loaded;
  const choices = deckChoices(data.decks);
  if (!choices.length) { toast('Add a deck first'); return; }
  const prefs = cleanPrefs(data.settings.testPrefs);
  const history = cleanHistory(data.settings.testHistory);
  let id = choices.some(d => d.id === deckId) ? deckId : (choices.find(d => poolFor(data, cards, d.id).length) || choices[0]).id;
  let cfg = cleanCfg(prefs[id]);
  let pool = [], tags = [], perKind = {};

  const prepare = () => {
    pool = poolFor(data, cards, id);
    tags = tagChoices(pool);
    cfg.tags = cfg.tags.filter(t => tags.some(x => x.tag === t));
    // Which question types the deck can make at all (true or false and multiple choice need 4 different answers).
    perKind = Object.fromEntries(Object.keys(KINDS).map(k => [k, askable(pool, { ...cfg, kinds: [k], tags: [] }).able.length]));
    // (A kind this deck cannot make stays in the saved choices, shown off, so it comes back when cards that fit are added.)
    if (!cfg.kinds.some(k => perKind[k])) cfg.kinds = [...new Set([...cfg.kinds, ...Object.keys(KINDS).filter(k => perKind[k])])];
  };

  const draw = () => {
    prepare();
    const saved = inProgress();
    const recent = recentResults(history, id, 4);
    const exam = examInfo(effectiveDeck(data.decks, id));
    const radio = (name, value, label, checked, extra = '') =>
      `<label class="chip"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${extra}><span>${label}</span></label>`;
    openSheet(`
      <h2 id="sheetTitle">${mock ? 'Mock exam' : 'Practice test'}</h2>
      <form class="sheet-in pt-form" id="ptForm" style="padding:0" novalidate>
        <p class="note" style="margin:0">${mock && exam ? `${esc(countdown(exam))}. ` : ''}A calm mock exam: one question at a time, and no answers shown until you submit. It uses your own cards.</p>
        ${saved ? `<div class="pt-resume" role="group" aria-label="Test in progress">
          <p><b>A test is in progress</b> (${esc(deckPath(data.decks, saved.run.deckId))}, question ${saved.state.i + 1} of ${saved.run.questions.length}). Starting a new one replaces it.</p>
          <div class="pt-resume-b"><button class="btn primary small" type="button" id="ptResume">Resume</button><button class="btn ghost small" type="button" id="ptDiscard">Discard</button></div></div>` : ''}
        <label class="field"><span>Deck <small>(its subdecks are included)</small></span>
          <select id="ptDeck" class="select">${choices.map(d => `<option value="${esc(d.id)}" ${d.id === id ? 'selected' : ''}>${esc(d.label)} (${poolFor(data, cards, d.id).length})</option>`).join('')}</select></label>
        ${tags.length > 1 ? `<fieldset><legend>Only these tags <small>(optional)</small></legend>
          <div class="chips" role="group" aria-label="Narrow by tag">${tags.map(t => `<button type="button" class="tchip" data-tag="${esc(t.tag)}" aria-pressed="${cfg.tags.includes(t.tag)}">${esc(t.label)} <small>${t.n}</small></button>`).join('')}</div></fieldset>` : ''}
        <fieldset><legend>Questions</legend>
          <div class="chips">${COUNTS.map(n => radio('count', n, n === 'all' ? `All <small>(up to ${MAX_QUESTIONS})</small>` : n, cfg.count === n)).join('')}</div></fieldset>
        <fieldset><legend>Question types <small>(all on: a mix)</small></legend>
          <div class="chips">${Object.entries(KINDS).map(([k, label]) => `<label class="chip"><input type="checkbox" name="kind" value="${k}" ${cfg.kinds.includes(k) && perKind[k] ? 'checked' : ''} ${perKind[k] ? '' : 'disabled'}><span>${label}</span></label>`).join('')}</div>
          <p class="note" id="ptKindNote"></p></fieldset>
        <div class="settings">
          <fieldset><legend>Time limit</legend>
            <div class="chips">${LIMITS.map(m => radio('limit', m, m ? `${m} min` : 'Off', cfg.limit === m)).join('')}
              ${cfg.limit && !LIMITS.includes(cfg.limit) ? radio('limit', cfg.limit, `${cfg.limit} min`, true) : ''}</div></fieldset>
          <fieldset><legend>Order</legend>
            <div class="chips">${Object.entries(ORDERS).map(([k, label]) => radio('order', k, label, cfg.order === k)).join('')}</div>
            <p class="note" id="ptOrderNote" ${cfg.order === 'weak' ? '' : 'hidden'}>The cards you are least likely to remember now come first. Cards you have not studied yet come last.</p></fieldset>
        </div>
        <label class="adv-row switch-row"><span><b id="ptCountsLbl">Count answers as reviews</b>
          <span id="ptCountsHelp">Off: a practice test changes nothing in your schedule or stats. On: answers count like Play answers do when Play counts as reviews (due cards are graded, missed cards come back sooner).</span></span>
          <input id="ptCounts" type="checkbox" class="switch" aria-labelledby="ptCountsLbl" aria-describedby="ptCountsHelp" ${cfg.counts ? 'checked' : ''}></label>
        <p class="pt-note" id="ptNote" role="status" aria-live="polite"></p>
        ${recent.length ? `<section class="pt-hist" aria-label="Recent results"><h3>Recent results</h3><ul>${recent.map(r => `<li><span>${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span><b class="mono">${r.pct}%</b><span class="mono">${r.correct}/${r.total}</span>${r.secs ? `<span class="mono">${clock(r.secs * 1000)}</span>` : ''}</li>`).join('')}</ul></section>` : ''}
        <div class="sheet-actions"><button class="btn ghost" type="button" id="ptCancel">Cancel</button><button class="btn primary" type="submit" id="ptStart">Start test</button></div>
      </form>`);
    refresh();
    wire();
  };

  // What the choices add up to: the note and the Start button.
  const refresh = () => {
    const narrowed = narrowByTags(pool, cfg.tags);
    const { able } = askable(narrowed, { ...cfg, tags: [] });
    const n = cfg.count === 'all' ? Math.min(able.length, MAX_QUESTIONS) : Math.min(cfg.count, able.length);
    $('ptNote').textContent = able.length
      ? `${plural(n, 'question')} from ${plural(able.length, 'card')}${cfg.limit ? `, ${cfg.limit} minutes` : ', no time limit'}.${narrowed.length > able.length ? ` ${narrowed.length - able.length} cards can't be asked with these question types.` : ''}`
      : 'No cards fit these choices. Try another deck, other tags or more question types.';
    $('ptStart').disabled = !able.length;
    const off = Object.keys(KINDS).filter(k => !perKind[k]);
    $('ptKindNote').textContent = off.length ? `${off.map(k => KINDS[k]).join(' and ')} ${off.length > 1 ? 'need' : 'needs'} cards that fit (multiple choice and true or false need 4 different answers in the deck).` : '';
    $('ptKindNote').hidden = !off.length;
  };

  const read = () => {
    const f = $('ptForm');
    const checked = [...f.querySelectorAll('input[name=kind]:checked')].map(i => i.value);
    const kinds = checked.length ? [...checked, ...cfg.kinds.filter(k => !perKind[k])] : [];
    const get = name => f.querySelector(`input[name=${name}]:checked`)?.value;
    cfg = cleanCfg({
      count: get('count') === 'all' ? 'all' : +get('count'), kinds: kinds.length ? kinds : cfg.kinds, limit: +get('limit'), order: get('order'),
      counts: $('ptCounts').checked, tags: [...f.querySelectorAll('[data-tag][aria-pressed=true]')].map(b => b.dataset.tag)
    });
    if (!checked.length) f.querySelectorAll('input[name=kind]').forEach(i => { i.checked = cfg.kinds.includes(i.value) && !i.disabled; });       // at least one stays on
  };

  const wire = () => {
    $('ptDeck').addEventListener('change', e => { id = e.target.value; cfg = cleanCfg(prefs[id]); draw(); $('ptDeck').focus(); });
    $('ptForm').addEventListener('change', e => {
      if (e.target.id === 'ptDeck') return;
      read();
      $('ptOrderNote').hidden = cfg.order !== 'weak';
      refresh();
    });
    $('ptForm').addEventListener('click', e => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      read(); refresh();
    });
    $('ptCancel').addEventListener('click', closeSheet);
    $('ptResume')?.addEventListener('click', () => { const s = inProgress(); closeSheet(); if (s) navGo(`#/test/${encodeURIComponent(s.run.deckId)}`); });
    $('ptDiscard')?.addEventListener('click', () => { clearSaved(); draw(); });
    $('ptForm').addEventListener('submit', async e => {
      e.preventDefault();
      read();
      $('ptStart').disabled = true;
      prefs[id] = cfg;
      const started = await beginTest(id, cfg, { stay: !!onStart, data: loaded });
      if (!started) { $('ptStart').disabled = false; return; }
      closeSheet();
      onStart?.(id);
    });
  };

  draw();
}
