// Today: the one-time note when the scheduler changed (Own took over, or went back to FSRS). It costs nothing for anyone who has not
// loaded a model file: the gate looks once and loads no Own code unless the switch is on. The note is marked as seen the moment it
// is drawn, so it never comes back after a reload; this page session keeps it up until it is dismissed.
import { esc, icon } from './ui.js';

let showing = null;      // the words on the card, while it is up

export async function drawOwnNotice(slot) {
  if (!slot?.isConnected) return false;
  if (!showing) {
    try {
      const { ownModule } = await import('./own-gate.js');
      const m = await ownModule();
      if (!m || !slot.isConnected) return false;
      const st = await m.ownStatus();
      if (st.noticePending == null || !slot.isConnected) return false;
      showing = st.scheduler === 'own' ? 'Own model now schedules your reviews' : 'Back on FSRS';
      await m.ownDismissNotice();
    } catch (err) { console.warn('Own model:', (err && err.message) || err); return false; }
  }
  if (!slot.isConnected) return false;
  slot.innerHTML = `<section class="wn" aria-labelledby="ownNoticeTitle">
    <span class="wn-icon" aria-hidden="true">${icon('bolt')}</span>
    <div class="wn-txt"><h2 id="ownNoticeTitle">${esc(showing)}</h2>
      <div class="wn-actions"><button class="btn primary small" type="button" id="ownNoticeOk">Got it</button></div></div>
    <button class="inst-x" type="button" id="ownNoticeX" aria-label="Dismiss notice">${icon('x')}</button></section>`;
  const done = () => {
    showing = null; slot.innerHTML = '';
    const next = document.getElementById('startBtn') || document.querySelector('#screen h1');
    if (next) { if (!next.matches('button, a')) next.tabIndex = -1; next.focus({ preventScroll: true }); }
  };
  slot.querySelector('#ownNoticeOk').addEventListener('click', done);
  slot.querySelector('#ownNoticeX').addEventListener('click', done);
  return true;
}
