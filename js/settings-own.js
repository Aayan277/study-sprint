// Settings → Advanced scheduling → Own model. Loaded only when that section is opened for the first time (js/settings.js), so
// nobody who never opens it downloads any Own code. Labels and numbers only: the explanation lives in js/help.js ("own-model").
// Errors, the stopped-worker warning and the data-loss confirm are the only sentences.
import { esc, toast } from './ui.js';
import { helpLink } from './help.js';

const num = n => Number(n).toLocaleString('en');
const signed = x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(3);
const POLL_MS = 1500;

// The model's own safety words are plain: nothing to translate. The one place numbers are read from the verdict.
function verdictHTML(st) {
  const v = st.verdict;
  if (v && (v.status === 'better' || v.status === 'not')) {
    const label = v.status === 'better' ? 'Better' : 'Not better';
    return `<span class="badge own-badge ${v.status === 'better' ? 'better' : ''}">${label}</span>
      <span class="own-nums mono">${signed(v.meanDiff)} (${signed(v.lo)} to ${signed(v.hi)})</span>`;
  }
  const need = (v && v.need) || { scored: { have: st.scored || 0, need: st.minScored || 1000 }, live: { have: st.records || 0, need: 300 }, days: null };
  const parts = [`${num(need.scored.have)} of ${num(need.scored.need)}`, `${num(need.live.have)} of ${num(need.live.need)}`];
  if (need.days) parts.push(`${num(need.days.have)} of ${num(need.days.need)} days`);
  return `<span class="badge own-badge">Not enough reviews yet</span><span class="own-nums mono">${parts.join(' · ')}</span>`;
}

const schedLabel = st => {
  if (!st.on) return 'FSRS';
  if (st.paused) return 'FSRS (paused)';
  if (st.memory !== 'fresh' && st.scheduler !== 'own') return st.memory === 'error' ? 'FSRS' : 'Building memory…';
  return st.scheduler === 'own' ? 'Own' : 'FSRS';
};

export async function wireOwn(root) {
  const own = await import('./own-shadow.js');
  const load = await import('./own-load.js');
  root.innerHTML = `<div id="ownMain"></div><p class="err" id="ownErr" role="alert" hidden></p>`;
  const $ = id => root.querySelector('#' + id);
  let st = { loaded: false }, busy = false, timer = 0, confirming = false;

  const setError = msg => { const e = $('ownErr'); e.textContent = msg || ''; e.hidden = !msg; };
  const stopPoll = () => { clearTimeout(timer); timer = 0; };
  const poll = () => {
    stopPoll();
    if (!root.isConnected || !st.loaded || !st.on || (st.memory === 'fresh' && !st.building)) return;
    if (st.memory === 'error') return;
    timer = setTimeout(async () => { await refresh(); }, POLL_MS);
  };

  let inflight = Promise.resolve();
  const refresh = focusId => (inflight = inflight.then(() => doRefresh(focusId)));
  async function doRefresh(focusId) {
    if (!root.isConnected) return;
    try {
      st = await own.ownStatus();
      if (st.workerFailed && !$('ownErr').textContent) setError('Own stopped working, so FSRS is scheduling your reviews.');
    } catch (err) {
      console.warn('Own model:', (err && err.message) || err);
      st = { loaded: false };
      setError('Couldn’t read the Own model. FSRS is scheduling your reviews.');
    }
    draw(focusId);
    poll();
  }

  function draw(focusId) {
    const keep = focusId || (root.contains(document.activeElement) ? document.activeElement.id : '');
    const L = st.loaded;
    $('ownMain').innerHTML = `
      <div class="adv-row"><b id="ownFileLbl">Model file</b> ${helpLink('own-model', '?', 'About the Own model')}
        <div class="own-line">
          <button class="btn ghost small" type="button" id="ownLoad" ${busy ? 'disabled' : ''}>Load model file…</button>
          <input type="file" id="ownFile" accept=".own" hidden tabindex="-1" aria-label="Model file">
          ${L ? `<span class="own-name mono" id="ownName">${esc(st.name)} · ${esc(st.shortSha)}</span>` : ''}
        </div></div>
      <label class="adv-row switch-row"><span><b>Own model</b></span>
        <input id="ownOn" type="checkbox" class="switch" ${st.on ? 'checked' : ''} ${L && !busy ? '' : 'disabled'}></label>
      ${L ? `
      <div class="adv-row"><b>Scheduling</b><span class="own-line"><span id="ownSched" role="status">${esc(schedLabel(st))}</span></span>
        ${st.autoLocked ? '<span class="err own-lock" id="ownLocked">Locked on FSRS.</span>' : ''}</div>
      <div class="adv-row"><b>Verdict</b><div class="own-line" id="ownVerdict">${verdictHTML(st)}</div></div>
      <div class="adv-row"><div class="own-line">
        <button class="btn ghost small" type="button" id="ownCheck" ${st.on && !busy ? '' : 'disabled'}>Check now</button>
        <button class="btn danger small" type="button" id="ownRemove" ${busy ? 'disabled' : ''}>Remove model…</button></div>
        <div class="confirm" id="ownConfirm" role="group" aria-labelledby="ownConfirmQ" ${confirming ? '' : 'hidden'}>
          <p id="ownConfirmQ">Delete the model file and Own’s records on this device? Your cards, reviews and due dates stay.</p>
          <div class="sheet-actions"><button class="btn ghost small" type="button" id="ownNo">Cancel</button><button class="btn danger solid small" type="button" id="ownYes">Remove</button></div>
        </div></div>` : ''}`;
    wireRows();
    if (keep && $(keep) && !$(keep).disabled) $(keep).focus({ preventScroll: true });
  }

  const guard = async (fn, failText) => {
    stopPoll(); await inflight;                       // never stop the worker under a status call that is still waiting
    busy = true; draw(); setError('');
    try { await fn(); }
    catch (err) { console.warn('Own model:', (err && err.message) || err); setError(failText); }
    finally { busy = false; }
  };

  function wireRows() {
    $('ownLoad').addEventListener('click', () => $('ownFile').click());
    $('ownFile').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      await guard(async () => {
        const r = await load.loadModelFile(f);
        if (!r.ok) { setError(r.message); return; }
        const wasOn = st.on;
        await own.ownModelChanged();
        toast('Model loaded');
        if (wasOn) own.ownRebuild().catch(err => console.warn('Own model:', (err && err.message) || err));
      }, 'The model file could not be loaded.');
      await refresh('ownLoad');
    });
    $('ownOn').addEventListener('change', async e => {
      const want = e.target.checked;
      await guard(async () => {
        const r = await own.ownSetOn(want);
        if (!r || !r.ok) { setError((r && r.message) || 'Couldn’t change that. Nothing was changed.'); return; }
        toast(want ? 'Own model is watching' : 'Own model off');
      }, 'Couldn’t change that. Nothing was changed.');
      await refresh('ownOn');
    });
    if (!st.loaded) return;
    $('ownCheck').addEventListener('click', async () => {
      await guard(async () => { await own.ownCheckNow(); }, 'Couldn’t check right now. FSRS is still scheduling your reviews.');
      await refresh('ownCheck');
    });
    $('ownRemove').addEventListener('click', () => { confirming = true; $('ownConfirm').hidden = false; $('ownNo').focus(); });
    $('ownNo').addEventListener('click', () => { confirming = false; $('ownConfirm').hidden = true; $('ownRemove').focus(); });
    $('ownYes').addEventListener('click', async () => {
      confirming = false;
      await guard(async () => {
        const r = await own.ownRemoveAll();
        if (!r || !r.ok) { setError((r && r.message) || 'The model could not be removed.'); return; }
        toast('Own model removed');
      }, 'The model could not be removed.');
      await refresh('ownLoad');
    });
  }

  await refresh();
}
