// Recording a sound for a card with the microphone. Loaded the first time the mic button in the card editor is pressed (card-editor.js).
// One recording at a time. The microphone is asked for only when Record is pressed, a new stream is opened for every take, and every
// track is stopped as soon as the take ends or is thrown away (Stop, Cancel, the sheet closing, leaving the page), so the phone's mic light goes off.
// When Stop is pressed the take goes through saveSound() like any picked sound and is added to the side's sounds; its ▶ is the usual
// sound button (audio.js), so Preview needs nothing of its own. Re-record swaps that sound for a new take, Delete takes it out.
//
//   startRecording(fieldId, { replaceId })   ask for the microphone and start (the field's id, like 'acBack')
//   stopRecording({ keep, why })             stop; with keep the take is saved and added to the field (resolves when that is done)
//   cancelRecording()                        stop and throw the take away
//   isRecording()                            is the microphone open?
// The panel (#<field>Rec) is made empty by card-editor.js and filled in here.

import { esc, toast } from './ui.js';
import { saveSound, MAX_SOUNDS, MAX_SOUND_BYTES, sizeText } from './media.js';
import { stopSound, canPlayType } from './audio.js';
import { stopSpeaking } from './speech.js';
import { readCardSounds, setCardSounds } from './card-editor.js';
import { MAX_REC_MS, REC_BITRATE, pickRecordingType, recordingName, shouldStop, tooShort, fmtClock, recordSupport, isIOS, micErrorMessage, recFailMessage, levelFrom, INSECURE_MESSAGE } from './recorder-logic.js';

let cur = null;      // the take being made: { id, panel, replaceId, stream, rec, type, chunks, bytes, startedAt, timer, raf, ctx }

const panelOf = id => document.getElementById(id + 'Rec');
const micOf = id => document.querySelector(`[data-rec="${id}"]`);
const sideOf = id => (document.getElementById(id + 'Lbl') || document.querySelector(`label[for="${id}"]`))?.textContent.trim() || 'sound';
const setAudioSession = type => { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* not everywhere */ } };

// What the panel shows. The live region stays put, so each state change is announced; the rest is drawn again.
function show(id, state, html, say = '') {
  const p = panelOf(id);
  if (!p) return;
  let live = p.querySelector(':scope > .sr-only');
  if (!live) { live = document.createElement('p'); live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); p.append(live); }
  p.querySelectorAll(':scope > :not(.sr-only)').forEach(n => n.remove());
  p.insertAdjacentHTML('afterbegin', html);
  p.dataset.state = state;
  p.hidden = false;
  p.setAttribute('aria-label', `Recording for the ${sideOf(id)}`);
  if (say) live.textContent = say;
}
function hide(id, say = '') {
  const p = panelOf(id);
  if (!p) return;
  p.querySelectorAll(':scope > :not(.sr-only)').forEach(n => n.remove());
  p.dataset.state = 'idle';
  p.hidden = true;
  const live = p.querySelector(':scope > .sr-only');
  if (live && say) live.textContent = say;
}
const mark = (id, on) => { const m = document.getElementById(id + 'RecMark'); if (m) m.dataset.soundIds = on ? 'recording' : ''; };
const press = (id, on) => micOf(id)?.setAttribute('aria-pressed', on ? 'true' : 'false');

export const isRecording = () => !!cur?.stream;

export async function startRecording(id, { replaceId = null } = {}) {
  if (cur) await stopRecording({ keep: true });
  const secure = window.isSecureContext !== false;
  const support = recordSupport({ secure, mediaDevices: navigator.mediaDevices?.getUserMedia, recorder: window.MediaRecorder });
  if (support === 'insecure') { toast(INSECURE_MESSAGE, { ms: 6000 }); return; }
  if (support === 'unsupported') return;
  const have = readCardSounds(id);
  if (have.length >= MAX_SOUNDS && !have.includes(replaceId)) { toast(`Up to ${MAX_SOUNDS} sounds on each side`); return; }
  stopSound(); stopSpeaking();
  const s = cur = { id, panel: panelOf(id), replaceId: have.includes(replaceId) ? replaceId : null, stream: null, rec: null, type: '', chunks: [], bytes: 0, startedAt: 0, timer: 0, raf: 0, ctx: null };
  mark(id, true); press(id, true);
  show(id, 'starting', `<span class="rec-text">Waiting for the microphone…</span>
    <button type="button" class="btn ghost small" data-rec-cancel>Cancel</button>`);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    if (cur !== s) return;            // cancelled while the browser was asking
    cur = null; mark(id, false); press(id, false); hide(id);
    toast(micErrorMessage(err, { ios: isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints), standalone: !!navigator.standalone || matchMedia('(display-mode: standalone)').matches }), { ms: 6000 });
    micOf(id)?.focus();
    return;
  }
  if (cur !== s) { stream.getTracks().forEach(t => t.stop()); return; }      // Stop, Cancel or close while the permission was pending
  s.stream = stream;
  setAudioSession('play-and-record');
  s.type = pickRecordingType(t => MediaRecorder.isTypeSupported(t));
  try { s.rec = new MediaRecorder(stream, { mimeType: s.type, audioBitsPerSecond: REC_BITRATE }); } catch { s.rec = new MediaRecorder(stream); }
  s.rec.ondataavailable = e => { if (e.data?.size) { s.chunks.push(e.data); s.bytes += e.data.size; } };
  s.rec.start(1000);          // a chunk a second, so the bytes so far can be counted
  s.startedAt = Date.now();
  stream.getAudioTracks().forEach(t => {
    t.onended = () => { if (cur !== s) return; toast('The microphone stopped. What was recorded so far is kept.'); stopRecording({ keep: true }); };
  });
  let meter = null;
  try {
    s.ctx = new AudioContext();
    s.ctx.resume?.();
    const analyser = s.ctx.createAnalyser();
    analyser.fftSize = 512;
    s.ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const draw = () => {
      if (cur !== s) return;
      analyser.getFloatTimeDomainData(buf);
      meter?.style.setProperty('--lvl', levelFrom(buf).toFixed(2));
      s.raf = requestAnimationFrame(draw);
    };
    show(id, 'recording', recordingHTML(), "Recording. Press Stop when you're done.");
    meter = panelOf(id)?.querySelector('.rec-meter i');
    draw();
  } catch {
    show(id, 'recording', recordingHTML(false), "Recording. Press Stop when you're done.");        // no level meter here
  }
  const time = panelOf(id)?.querySelector('.rec-now');
  s.timer = setInterval(() => {
    if (!s.panel.isConnected) { cancelRecording(); return; }      // the sheet was replaced
    const elapsedMs = Date.now() - s.startedAt;
    if (time) time.textContent = fmtClock(elapsedMs);
    const why = shouldStop({ elapsedMs, bytes: s.bytes, maxMs: MAX_REC_MS, maxBytes: MAX_SOUND_BYTES });
    if (why) stopRecording({ keep: true, why });
  }, 200);
  panelOf(id)?.querySelector('[data-rec-stop]')?.focus();
}
const recordingHTML = (meter = true) => `<span class="rec-dot" aria-hidden="true"></span><span class="rec-text">Recording</span>
    <span class="rec-time" aria-hidden="true"><span class="rec-now">0:00</span><span class="rec-max"> / ${fmtClock(MAX_REC_MS)}</span></span>
    ${meter ? '<span class="rec-meter" aria-hidden="true"><i></i></span>' : ''}
    <button type="button" class="btn ghost small rec-stop" data-rec-stop aria-label="Stop recording"><span aria-hidden="true">■</span> Stop</button>
    <button type="button" class="btn ghost small" data-rec-cancel>Cancel</button>`;

// Let go of the microphone and the timers.
function release(s) {
  s.stream?.getTracks().forEach(t => t.stop());
  s.stream = null;
  clearInterval(s.timer);
  cancelAnimationFrame(s.raf);
  try { s.ctx?.close(); } catch { /* already closed */ }
  setAudioSession('auto');
  if (cur?.id !== s.id) { press(s.id, false); mark(s.id, false); }
}

export async function stopRecording({ keep = true, why = null, quiet = false } = {}) {
  const s = cur;
  if (!s) return;
  cur = null;
  const { id } = s;
  if (s.rec && s.rec.state !== 'inactive') {
    const stopped = new Promise(done => { s.rec.addEventListener('stop', done, { once: true }); setTimeout(done, 2000); });
    try { s.rec.stop(); } catch { /* already stopped */ }
    await stopped;               // the last chunk arrives just before this
  }
  release(s);
  const ms = Date.now() - s.startedAt;
  const side = sideOf(id);
  if (!keep || !s.rec) {
    hide(id, 'Recording cancelled.');
    if (!quiet) micOf(id)?.focus();
    return;
  }
  if (tooShort(ms, s.bytes)) {
    const msg = 'That was too short to keep. Record for at least half a second.';
    hide(id, msg); toast(msg);
    if (!quiet) micOf(id)?.focus();
    return;
  }
  try {
    const blob = new Blob(s.chunks, { type: s.rec.mimeType || s.type || s.chunks[0]?.type || '' });
    const saved = await saveSound({ name: recordingName(blob.type), type: blob.type, data: await blob.arrayBuffer() });
    const ids = readCardSounds(id);
    const at = ids.indexOf(s.replaceId);
    setCardSounds(id, at >= 0 ? ids.map((x, i) => (i === at ? saved.id : x)) : [...ids, saved.id]);
    const added = why === 'time' ? `Stopped at 1 minute, the longest a recording can be. Added to the ${side}.`
      : why === 'size' ? `Stopped at the 1 MB size limit. Added to the ${side}.`
      : `Recording added to the ${side}: ${Math.max(1, Math.round(ms / 1000))} seconds.`;
    if (!cur || cur.id !== id) {      // (not when the next take on this side has already begun)
      show(id, 'done', `<button type="button" class="snd-btn" data-snd="${esc(saved.id)}" aria-label="Play the recording">▶︎</button>
        <span class="rec-text">Recording · ${fmtClock(ms)} · ${sizeText(saved.size)} · added to the ${esc(side)}</span>
        <button type="button" class="btn ghost small" data-rec-redo>Re-record</button>
        <button type="button" class="btn ghost small" data-rec-del>Delete</button>`, added);
      panelOf(id).dataset.sid = saved.id;
      if (!quiet) panelOf(id).querySelector('.snd-btn')?.focus();
    }
    if (!canPlayType(saved.type)) toast("This browser can't play this recording. Other devices may.");
  } catch (err) {
    console.error(err);
    hide(id);
    toast(recFailMessage(err), { ms: 6000 });
  }
}
export function cancelRecording() { stopRecording({ keep: false, quiet: true }); }

// ---------- the panel's buttons, and everything that ends a take ----------
document.addEventListener('click', e => {
  const panel = e.target.closest?.('.rec-panel');
  const id = panel?.id.replace(/Rec$/, '');
  if (e.target.closest('[data-rec-stop]')) stopRecording();
  else if (e.target.closest('[data-rec-cancel]')) stopRecording({ keep: false });
  else if (e.target.closest('[data-rec-redo]')) startRecording(id, { replaceId: panel.dataset.sid });
  else if (e.target.closest('[data-rec-del]')) {
    setCardSounds(id, readCardSounds(id).filter(x => x !== panel.dataset.sid));
    hide(id, 'Recording deleted.');          // (the bytes are left to db.cleanMedia, like any sound taken off a card)
    micOf(id)?.focus();
  }
  // A sound taken off with its own Remove button is no longer the panel's recording.
  const rm = e.target.closest?.('[data-snd-remove]');
  if (rm) document.querySelectorAll('.rec-panel[data-state="done"]').forEach(p => { if (p.dataset.sid === rm.dataset.sid) hide(p.id.replace(/Rec$/, '')); });
});
// Escape ends the take (not the sheet around it).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !cur || !e.target.closest?.('.rec-panel')) return;
  e.preventDefault(); e.stopPropagation();
  stopRecording({ keep: false });
}, true);
document.addEventListener('sheet-closing', cancelRecording);
document.getElementById('sheet')?.addEventListener('close', cancelRecording);
addEventListener('hashchange', cancelRecording);
addEventListener('pagehide', cancelRecording);
// A page in the background may be frozen (iOS) and lose the microphone: keep what there is.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopRecording({ keep: true, quiet: true }); });
