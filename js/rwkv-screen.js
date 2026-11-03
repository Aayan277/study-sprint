// RWKV lab: the Lab screen (#/lab). Choose the weights file, rebuild the memory from your history, turn shadow mode on, and compare the
// model's predictions with FSRS. Explanations are in Help (js/help.js, section "Lab"); the screen keeps only labels, warnings and data-loss notes.
import { $, esc, toast } from './ui.js';
import { helpLink } from './help.js';
import { getLab } from './rwkv-lab.js';

const size = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const num = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(3));
const when = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const COMPARE_HELP = 'rwkv-compare';

export async function renderLab(el) {
  const lab = getLab();
  let since = false;                    // comparison chip: false = all history
  el.innerHTML = `
    <a class="back" href="#/settings">‹ Settings</a>
    <div class="screen-head"><div><h1>RWKV lab</h1></div>
      <div class="lab-head"><span class="lab-tag">Lab build</span> ${helpLink('rwkv-lab', '?', 'About the RWKV lab')}</div></div>
    <p class="err" id="labErr" role="alert" hidden></p>

    <section class="section" aria-labelledby="labWH">
      <h2 id="labWH">Weights</h2>
      <div class="lab-row">
        <button class="btn ghost" type="button" id="labPick">Choose weights file…</button>
        <input type="file" id="labFile" accept=".bin" hidden aria-label="Weights file">
      </div>
      <p class="lab-line" id="labWInfo" hidden></p>
      <p class="lab-warn" id="labWWarn" hidden>Unknown model file</p>
      <p class="lab-warn" id="labPersist" role="status" hidden>The browser may delete lab data when space runs low.</p>
    </section>

    <section class="section" aria-labelledby="labMH">
      <h2 id="labMH">Memory state</h2>
      <p class="lab-line mono" id="labMInfo"></p>
      <p class="lab-warn" id="labMWarn" role="status" hidden></p>
      <div class="lab-row">
        <button class="btn ghost" type="button" id="labRebuild" disabled>Rebuild from history</button>
        <button class="btn ghost" type="button" id="labCancel" hidden>Cancel</button>
      </div>
      <progress id="labProg" max="1" value="0" aria-label="Rebuild progress" hidden></progress>
    </section>

    <section class="section">
      <label class="adv-row switch-row"><span><b id="labShadowLbl">Shadow mode</b> ${helpLink('rwkv-lab', '?', 'About shadow mode')}</span>
        <input id="labShadow" type="checkbox" class="switch" aria-labelledby="labShadowLbl" disabled></label>
    </section>

    <section class="section" aria-labelledby="labCH">
      <h2 id="labCH">Comparison</h2>
      <div class="chips" role="radiogroup" aria-labelledby="labCH" id="labChips">
        <label class="chip"><input type="radio" name="labSince" value="all" checked><span>All history</span></label>
        <label class="chip"><input type="radio" name="labSince" value="shadow"><span>Since shadow mode</span></label>
      </div>
      <div class="rc-table-wrap"><table class="rc-table lab-table">
        <caption class="sr-only">How well each model predicted your reviews</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">Log loss</th><th scope="col">AUC</th><th scope="col">RMSE</th><th scope="col">Reviews</th></tr></thead>
        <tbody id="labRows"></tbody></table></div>
    </section>

    <section class="section" aria-labelledby="labDH">
      <h2 id="labDH">Remove</h2>
      <button class="btn danger" type="button" id="labDelete">Remove weights and lab data</button>
      <div class="confirm" id="labConfirm" role="group" aria-labelledby="labConfirmQ" hidden>
        <p id="labConfirmQ">Remove the weights file and everything the lab has saved? Your cards and reviews are not touched.</p>
        <div class="sheet-actions"><button class="btn ghost small" type="button" id="labNo">Cancel</button><button class="btn danger solid small" type="button" id="labYes">Remove</button></div>
      </div>
    </section>`;

  const err = text => { const e = $('labErr'); e.textContent = text || ''; e.hidden = !text; };
  const show = (id, text) => { const e = $(id); if (text === null || text === undefined || text === false) { e.hidden = true; return; } if (typeof text === 'string') e.textContent = text; e.hidden = false; };

  async function refresh() {
    if (!el.isConnected) return;
    const s = await lab.status();
    if (!el.isConnected) return;
    const w = s.weights;
    show('labWInfo', w ? `${w.name} · ${size(w.size)}${w.known ? ` · Recognised: ${w.known}` : ''}` : false);
    show('labWWarn', w && !w.known ? true : false);
    show('labPersist', w && !s.persisted ? true : false);
    $('labMInfo').textContent = `${s.cards} card${s.cards === 1 ? '' : 's'}${s.rebuiltAt ? ` · rebuilt ${when(s.rebuiltAt)}` : ''}`;
    show('labMWarn', s.state === 'stale' ? (s.reason === 'interrupted' ? 'Last rebuild was interrupted' : 'Out of date: rebuild needed') : false);
    $('labRebuild').disabled = !w || s.state === 'rebuilding';
    const sw = $('labShadow');
    sw.disabled = !w; sw.checked = !!(w && s.settings.shadow);
    $('labDelete').disabled = false;
    await drawTable();
  }

  async function drawTable() {
    const rows = await lab.comparison(since);
    if (!el.isConnected) return;
    $('labRows').innerHTML = rows.map(r => `<tr><th scope="row">${esc(r.name)} ${helpLink(COMPARE_HELP, '?', `About ${r.name}`)}</th>
      <td>${num(r.logLoss)}</td><td>${num(r.auc)}</td><td>${num(r.rmse)}</td><td>${r.n}</td></tr>`).join('');
  }

  $('labPick').onclick = () => $('labFile').click();
  $('labFile').onchange = async () => {
    const file = $('labFile').files[0];
    $('labFile').value = '';
    if (!file) return;
    err('');
    const r = await lab.loadWeightsFile(file);
    if (!r.ok) { err(r.error); return; }
    await refresh();
  };

  $('labRebuild').onclick = async () => {
    err('');
    const bar = $('labProg');
    $('labRebuild').disabled = true; $('labCancel').hidden = false; $('labPick').disabled = true; $('labDelete').disabled = true;
    bar.value = 0; bar.max = 1; bar.hidden = false;
    try {
      await lab.rebuild(({ done, total }) => { bar.max = Math.max(1, total); bar.value = done; });
      toast('Rebuild finished');
    } catch (e) {
      if (!/stopped/i.test(e.message)) err(e.message);
    } finally {
      bar.hidden = true; $('labCancel').hidden = true; $('labPick').disabled = false;
      await refresh();
    }
  };
  $('labCancel').onclick = () => { lab.cancelRebuild(); };

  $('labShadow').onchange = async () => {
    $('labShadow').disabled = true;
    try { await lab.setShadow($('labShadow').checked); } catch (e) { err(e.message); }
    await refresh();
  };

  $('labChips').addEventListener('change', e => { if (e.target.name === 'labSince') { since = e.target.value === 'shadow'; drawTable(); } });

  $('labDelete').onclick = () => { $('labConfirm').hidden = false; $('labYes').focus(); };
  $('labNo').onclick = () => { $('labConfirm').hidden = true; $('labDelete').focus(); };
  $('labYes').onclick = async () => {
    try { await lab.deleteAll(); $('labConfirm').hidden = true; toast('Lab data removed'); await refresh(); } catch (e) { err(e.message); }
  };

  await refresh();
}
