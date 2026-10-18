// The front / back boxes for editing a card, with B / I / • (bold, italic, bullet list) buttons.
// Formatting is saved as simple marks in the text (see format.js), whichever box is used:
//   phones and tablets   a plain text box, the buttons add the marks, and a preview shows the result
//   computers            a Word-style box: text looks bold while you type (Ctrl/⌘+B, Ctrl/⌘+I), and is
//                        turned back into marks when saved
// Usage: put cardTextField(...) in the form's HTML, then read it with readCardText(id) / clear it with
// setCardText(id, ''). The buttons and shortcuts are wired once, below, for every box.

import { formatHTML, htmlToMarks, toggleWrap, toggleBullets, hasFormatting } from './format.js';
import { hasMath, wrapMath, maskMath } from './math.js';
import { parseSteps, joinSteps, stepsRoundTrip, parseElements, joinElements, elementsRoundTrip } from './steps.js';
import { esc, toast } from './ui.js';
import { toolbarTarget } from './a11y.js';
import { addImage, addImageInfo, imgHTML, OCCLUSION_SIDE, saveSound, MAX_SOUNDS, sizeText } from './media.js';
import { canPlayType } from './audio.js';
import * as db from './db.js';
import { renderCloze, makesText, wrapBlank, nextNumber, lastNumber, wordAt, clozeNumbers, planNoteSave } from './cloze.js';
import { occlusionHTML, groupsOf, groupIndex, occLabel, MAX_HEADER, MAX_LABEL } from './occlusion.js';

const RICH = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');

//   image: the side's picture (a media id), shown under the box with Remove; the toolbar's picture
//          button adds or replaces it. Read it back with readCardImage(id).
//   images: false leaves out the picture button and the sound button (cloze text and Extra have none)
//   Sounds are shown in a row under the box (up to 4 on each side). Fill it with setCardSounds(id, ids) and read it back with
//   readCardSounds(id).
//   cloze: true makes it the text of a cloze note (the [...] buttons and the preview work on it: see below)
export function cardTextField(id, label, value = '', { rows = 2, placeholder = '', image = null, images = true, cloze = false } = {}) {
  const pics = !images ? '' : `<div class="img-row" id="${id}Img" data-media-id="${esc(image || '')}">${pictureHTML(id, image)}</div>
      <input type="file" id="${id}File" accept="image/*" hidden data-img-file="${id}">
      <div class="snd-edit" id="${id}Snd" data-sound-ids=""></div>
      <input type="file" id="${id}SndFile" accept="audio/*" multiple hidden data-snd-file="${id}">`;
  const tools = `<span class="fmt-tools" role="toolbar" aria-label="Formatting">
      <button type="button" data-fmt="bold" data-for="${id}" aria-label="Bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" tabindex="-1" data-fmt="italic" data-for="${id}" aria-label="Italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" tabindex="-1" data-fmt="list" data-for="${id}" aria-label="Bullet list" title="Bullet list">•</button>
      <button type="button" tabindex="-1" data-fmt="math" data-for="${id}" aria-label="Maths: put the selection between $ signs" title="Maths: put the selection between $ signs">∑</button>
      ${!images ? '' : `<button type="button" tabindex="-1" data-img-add="${id}" aria-label="Add a picture" title="Add a picture"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5L5 20"/></svg></button>
      <button type="button" tabindex="-1" data-snd-add="${id}" aria-label="Add a sound" title="Add a sound"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg></button>`}</span>`;
  // Said once, under the Back box: maths goes between $ signs.
  const hint = /Back$/.test(id) ? '<small class="note math-hint">Maths: write it between $ signs, like $x^2$.</small>' : '';
  if (RICH.matches) {
    return `<div class="field fmt-field"><span class="fmt-head"><span id="${id}Lbl">${esc(label)}</span>${tools}</span>
      <div class="rich" id="${id}" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="${id}Lbl"
        data-rich="1" ${cloze ? 'data-cloze-box="1"' : ''} data-placeholder="${esc(placeholder)}" style="--rows:${rows}">${formatHTML(value, { math: 'raw' })}</div>
      ${cloze ? '' : `<div class="fmt-preview" id="${id}Prev" aria-label="Preview" ${hasMath(value) ? '' : 'hidden'}>${formatHTML(value)}</div>`}${pics}${hint}</div>`;
  }
  return `<div class="field fmt-field"><span class="fmt-head"><label for="${id}">${esc(label)}</label>${tools}</span>
      <textarea id="${id}" rows="${rows}" placeholder="${esc(placeholder)}" ${cloze ? 'data-cloze-box="1"' : ''}>${esc(value)}</textarea>
      ${cloze ? '' : `<div class="fmt-preview" id="${id}Prev" aria-label="Preview" ${hasFormatting(value) || hasMath(value) ? '' : 'hidden'}>${formatHTML(value)}</div>`}${pics}${hint}</div>`;
}

const pictureHTML = (id, image) => (image
  ? `${imgHTML(image, 'img-thumb')}<button type="button" class="btn ghost small" data-img-remove="${id}">Remove picture</button>` : '');

// The side's picture (a media id), or null.
export const readCardImage = id => document.getElementById(id + 'Img')?.dataset.mediaId || null;
export function setCardImage(id, image) {
  const row = document.getElementById(id + 'Img');
  row.dataset.mediaId = image || '';
  row.innerHTML = pictureHTML(id, image);
}

// ---------- sounds on a side ----------
// The ids of the side's sounds, in order.
export const readCardSounds = id => (document.getElementById(id + 'Snd')?.dataset.soundIds || '').split(',').filter(Boolean);
// Show these sounds under the box. Each is "▶ Sound 1 · 24 KB · Remove" (the size fills in a moment later).
export function setCardSounds(id, ids) {
  const row = document.getElementById(id + 'Snd');
  if (!row) return;
  ids = (ids || []).slice(0, MAX_SOUNDS);
  row.dataset.soundIds = ids.join(',');
  row.innerHTML = ids.map((sid, i) => `<div class="snd-item">
      <button type="button" class="snd-btn" data-snd="${esc(sid)}" aria-label="Play sound ${i + 1}">▶\uFE0E</button>
      <span class="snd-name">Sound ${i + 1} · <span data-size-of="${esc(sid)}"></span></span>
      <button type="button" class="btn ghost small" data-snd-remove="${id}" data-sid="${esc(sid)}" aria-label="Remove sound ${i + 1}">Remove</button></div>`).join('')
    + (ids.length >= MAX_SOUNDS ? `<small class="note">Up to ${MAX_SOUNDS} sounds on each side</small>` : '');
}
// The size of each sound in a row, once its record is read.
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
  if (n.nodeType !== 1) return;
  [...n.querySelectorAll('[data-size-of]'), ...(n.matches('[data-size-of]') ? [n] : [])].forEach(async span => {
    const m = await db.getMedia(span.dataset.sizeOf).catch(() => null);
    span.textContent = m ? sizeText(m.size || m.data?.byteLength || 0) : 'not on this device yet';
  });
}))).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('click', e => {
  const add = e.target.closest?.('[data-snd-add]');
  if (add) {
    if (readCardSounds(add.dataset.sndAdd).length >= MAX_SOUNDS) { toast(`Up to ${MAX_SOUNDS} sounds on each side`); return; }
    document.getElementById(add.dataset.sndAdd + 'SndFile')?.click();
  }
  const rm = e.target.closest?.('[data-snd-remove]');
  if (rm) setCardSounds(rm.dataset.sndRemove, readCardSounds(rm.dataset.sndRemove).filter(x => x !== rm.dataset.sid));
});
document.addEventListener('change', async e => {
  const id = e.target.dataset?.sndFile;
  if (!id || !e.target.files?.length) return;
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const have = readCardSounds(id);
    if (have.length >= MAX_SOUNDS) { toast(`Up to ${MAX_SOUNDS} sounds on each side`); break; }
    try {
      const saved = await saveSound(file);
      setCardSounds(id, [...readCardSounds(id), saved.id]);
      // Saved anyway: another device may play it.
      if (!canPlayType(saved.type)) toast(`This browser can't play .${(file.name.split('.').pop() || 'this').toLowerCase()} files. Other devices may.`);
    } catch (err) {
      console.error(err);
      toast(err.message || "Couldn't add that sound");
    }
  }
});

// The box's text, with formatting as marks.
export function readCardText(id) {
  const el = document.getElementById(id);
  return el.dataset.rich ? htmlToMarks(el.innerHTML) : el.value;
}
export function setCardText(id, text) {
  const el = document.getElementById(id);
  if (el.dataset.rich) { el.innerHTML = formatHTML(text, { math: 'raw' }); showMathPreview(el); }
  else { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
  if (el.dataset.clozeBox) updateClozePreview(id);
}

function applyFormat(id, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.dataset.rich) {
    el.focus();
    if (kind === 'math') {
      // The selected words between $ signs (or, if they already are, without them); with nothing selected, an empty pair
      // with the cursor inside.
      const sel = getSelection(), picked = sel.toString();
      document.execCommand('insertText', false, wrapMath(picked, 0, picked.length).value);
      if (!picked) getSelection().modify?.('move', 'backward', 'character');
      return;
    }
    document.execCommand(kind === 'list' ? 'insertUnorderedList' : kind);
    return;
  }
  const r = kind === 'list'
    ? toggleBullets(el.value, el.selectionStart, el.selectionEnd)
    : kind === 'math' ? wrapMath(el.value, el.selectionStart, el.selectionEnd)
    : toggleWrap(el.value, el.selectionStart, el.selectionEnd, kind === 'bold' ? '**' : '*');
  el.value = r.value;
  el.focus();
  el.setSelectionRange(r.start, r.end);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Pictures: the toolbar button opens the photo picker; the chosen photo is shrunk and saved straight away.
document.addEventListener('click', e => {
  const add = e.target.closest?.('[data-img-add]');
  if (add) document.getElementById(add.dataset.imgAdd + 'File')?.click();
  const rm = e.target.closest?.('[data-img-remove]');
  if (rm) setCardImage(rm.dataset.imgRemove, null);
});
document.addEventListener('change', async e => {
  const id = e.target.dataset?.imgFile;
  if (!id || !e.target.files[0]) return;
  const file = e.target.files[0];
  e.target.value = '';
  const row = document.getElementById(id + 'Img');
  row.innerHTML = '<span class="muted small">Adding picture…</span>';
  try {
    setCardImage(id, await addImage(file));
  } catch (err) {
    console.error(err);
    setCardImage(id, row.dataset.mediaId || null);
    toast(err.message || "Couldn't add that picture");
  }
});

// Pressing a button mustn't take the focus (and the selection) away from the box.
document.addEventListener('mousedown', e => { if (e.target.closest?.('[data-fmt]')) e.preventDefault(); });
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-fmt]');
  if (b) applyFormat(b.dataset.for, b.dataset.fmt);
});
// The live preview under a plain box.
document.addEventListener('input', e => {
  if (e.target.dataset?.clozeBox) updateClozePreview(e.target.id);
  const prev = e.target.id && document.getElementById(e.target.id + 'Prev');
  if (!prev || !prev.classList.contains('fmt-preview')) return;
  if (e.target.dataset.rich) { showMathPreview(e.target); return; }
  prev.innerHTML = formatHTML(e.target.value);
  prev.hidden = !hasFormatting(e.target.value) && !hasMath(e.target.value);
});
// Under the Word-style box the formatting shows as you type, so the preview is only for maths.
function showMathPreview(box) {
  const prev = document.getElementById(box.id + 'Prev');
  if (!prev || !prev.classList.contains('fmt-preview')) return;
  const text = htmlToMarks(box.innerHTML);
  const has = hasMath(text);
  prev.hidden = !has;
  if (has && prev.dataset.src !== text) { prev.dataset.src = text; prev.innerHTML = formatHTML(text); }
}
// The formatting toolbar is one Tab stop (WCAG 2.1.1 / the ARIA toolbar pattern): ← → Home End move between its buttons, and the one
// focused last is the one Tab returns to. (The markup starts with only the first button in the Tab order.)
document.addEventListener('keydown', e => {
  const bar = e.target.closest?.('[role="toolbar"]');
  if (!bar || !e.target.matches('button') || e.ctrlKey || e.metaKey || e.altKey) return;
  const items = [...bar.querySelectorAll('button:not([disabled])')];
  const to = toolbarTarget(e.key, items.indexOf(e.target), items.length);
  if (to === null) return;
  e.preventDefault();
  items[to].focus();
});
document.addEventListener('focusin', e => {
  const bar = e.target.closest?.('[role="toolbar"]');
  if (bar && e.target.matches('button')) bar.querySelectorAll('button').forEach(b => { b.tabIndex = b === e.target ? 0 : -1; });
});
// Ctrl/⌘+B and Ctrl/⌘+I in either kind of box.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'b' && k !== 'i') return;
  const t = e.target;
  if (!t?.id || !(t.dataset?.rich || document.getElementById(t.id + 'Prev'))) return;
  e.preventDefault();
  applyFormat(t.id, k === 'b' ? 'bold' : 'italic');
});
// Pasting into the Word-style box brings in plain text only (no fonts or colors from other sites).
document.addEventListener('paste', e => {
  if (!e.target.closest?.('[data-rich]')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

// ---------- Basic card: Front, Back (or steps, or elements) and a memory hook ----------
// "Answer: Text | Steps | Elements". Steps and Elements swap the Back box for one box per step or element (+ Add, move up / down, delete)
// and an optional intro (Steps also has a Final answer). Saving writes them into the back as "Step 1: ..." or "Element 1: ..." lines
// (steps.js joinSteps / joinElements), so the card needs nothing new in the data. Editing a card whose back has those lines opens in
// the matching mode. The memory hook is the card's noteExtra.
//   basicFields(p, { front, back, frontImage, backImage, hook, frontPh, backPh })   the HTML for the form whose ids start with p
//   readBack(p)       the back to save (from the rows when Steps or Elements is chosen)
//   stepsOn(p)        is Steps or Elements chosen?      stepsProblem(p)   why they can't be saved ('' when they can)
//   clearBasic(p)     empty the form after a card was added
const MODES = [['text', 'Text'], ['steps', 'Steps'], ['elements', 'Elements']];
const NOUN = { steps: 'Step', elements: 'Element' };
const noun = p => NOUN[document.getElementById(p + 'Steps')?.dataset.mode] || 'Step';
const stepRowHTML = (i, text = '', n = 3, word = 'Step') => `<li class="step-row" data-step-row>
      <span class="step-n" aria-hidden="true">${i + 1}</span>
      <textarea class="step-in" rows="2" data-step-in aria-label="${word} ${i + 1}" placeholder="${i ? 'Next ' + word.toLowerCase() : 'The first ' + word.toLowerCase()}">${esc(text)}</textarea>
      <span class="step-tools" role="group" aria-label="${word} ${i + 1} actions">
        <button type="button" class="step-btn" data-step="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${word.toLowerCase()} ${i + 1} up" title="Move up">↑</button>
        <button type="button" class="step-btn" data-step="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${word.toLowerCase()} ${i + 1} down" title="Move down">↓</button>
        <button type="button" class="step-btn" data-step="del" ${n <= 2 ? 'disabled' : ''} aria-label="Delete ${word.toLowerCase()} ${i + 1}" title="Delete ${word.toLowerCase()}">×</button>
      </span></li>`;

export function basicFields(p, { front = '', back = '', frontImage = null, backImage = null, hook = '', frontPh = '', backPh = '' } = {}) {
  const st = parseSteps(back, { mask: maskMath }), el = st ? null : parseElements(back, { mask: maskMath });
  const mode = st ? 'steps' : el ? 'elements' : 'text';
  const parsed = st || el, rows = st ? st.steps : el ? el.items : ['', ''], word = NOUN[mode] || 'Step';
  return `${cardTextField(p + 'Front', 'Front', front, { rows: 2, image: frontImage, placeholder: frontPh })}
      <div class="chips answer-mode" role="radiogroup" aria-label="Answer">
        <span class="answer-mode-l">Answer:</span>
        ${MODES.map(([k, l]) => `<label class="chip"><input type="radio" name="${p}Mode" id="${p}Mode${l}" value="${k}" data-mode-for="${p}" ${k === mode ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <div id="${p}BackWrap" ${parsed ? 'hidden' : ''}>${cardTextField(p + 'Back', 'Back', back, { rows: 3, image: backImage, placeholder: backPh })}</div>
      <div class="steps-ed" id="${p}Steps" data-mode="${mode === 'text' ? 'steps' : mode}" data-cur="${mode}" ${parsed ? '' : 'hidden'}>
        <label class="field"><span id="${p}IntroL">${mode === 'elements' ? 'Rule or intro (optional)' : 'Intro (optional)'}</span><textarea id="${p}Intro" rows="2" placeholder="${mode === 'elements' ? 'Shown above the elements.' : 'Shown before the first step.'}">${esc(parsed?.intro || '')}</textarea></label>
        <ol class="step-list" id="${p}StepList" aria-label="${word}s">${rows.map((t, i) => stepRowHTML(i, t, rows.length, word)).join('')}</ol>
        <button type="button" class="btn ghost small" data-step-add="${p}" id="${p}StepAdd">+ Add ${word.toLowerCase()}</button>
        <label class="field" id="${p}FinalWrap" ${mode === 'elements' ? 'hidden' : ''}><span>Final answer (optional)</span><textarea id="${p}Final" rows="2" placeholder="Shown after the last step. Play asks for it.">${esc(st?.final || '')}</textarea></label>
      </div>
      ${cardTextField(p + 'Hook', 'Memory hook (optional)', hook, { rows: 2, images: false, placeholder: 'A trick to remember it. Shown under the answer.' })}`;
}
// 'text', 'steps' or 'elements'
export const answerMode = p => document.querySelector(`input[name="${p}Mode"]:checked`)?.value || 'text';
export const stepsOn = p => answerMode(p) !== 'text';
const stepRows = p => [...document.querySelectorAll(`#${p}StepList [data-step-row]`)];
const stepValues = p => stepRows(p).map(r => r.querySelector('textarea').value.trim()).filter(Boolean);
const stepParts = p => ({ intro: document.getElementById(p + 'Intro').value, steps: stepValues(p), final: document.getElementById(p + 'Final').value });
const elementParts = p => ({ intro: document.getElementById(p + 'Intro').value, items: stepValues(p) });
export function stepsProblem(p) {
  const mode = answerMode(p);
  if (mode === 'text') return '';
  if (mode === 'elements') {
    if (stepValues(p).length < 2) return 'Add at least two elements, or choose Text.';
    if (elementsRoundTrip(elementParts(p), { mask: maskMath })) return '';
    // Name the real cause: an "Element N:" line inside an element, or a "Step N:" line that would turn the card into a steps card.
    return stepValues(p).some(t => /^\s*element\s*\d+\s*[:.)]/im.test(t)) || /^\s*element\s*\d+\s*[:.)]/im.test(document.getElementById(p + 'Intro').value)
      ? "A line inside an element can't start with 'Element N:'." : "A line inside an element can't start with 'Step N:'.";
  }
  if (stepValues(p).length < 2) return 'Add at least two steps, or choose Text.';
  // What is saved must read back as the same steps (a line inside a step that starts "Step 3:" or "Answer:" would not).
  return stepsRoundTrip(stepParts(p), { mask: maskMath }) ? '' : "A line inside a step can't start with 'Step N:' or 'Answer:'.";
}
export function readBack(p) {
  const mode = answerMode(p);
  if (mode === 'text') return readCardText(p + 'Back');
  return mode === 'elements' ? joinElements(elementParts(p)) : joinSteps(stepParts(p));
}
// Number the rows again (after adding, moving or deleting) and keep the names the buttons speak.
function renumberSteps(p) {
  const rows = stepRows(p), word = noun(p), low = word.toLowerCase();
  rows.forEach((r, i) => {
    r.querySelector('.step-n').textContent = i + 1;
    r.querySelector('textarea').setAttribute('aria-label', `${word} ${i + 1}`);
    r.querySelector('textarea').placeholder = i ? `Next ${low}` : `The first ${low}`;
    r.querySelector('.step-tools').setAttribute('aria-label', `${word} ${i + 1} actions`);
    const names = { up: `Move ${low} N up`, down: `Move ${low} N down`, del: `Delete ${low} N` };
    r.querySelectorAll('[data-step]').forEach(b => { b.setAttribute('aria-label', names[b.dataset.step].replace('N', i + 1)); });
    r.querySelector('[data-step=up]').disabled = i === 0;
    r.querySelector('[data-step=down]').disabled = i === rows.length - 1;
    r.querySelector('[data-step=del]').disabled = rows.length <= 2;
  });
}
function fillSteps(p, steps, final = '', intro = '') {
  document.getElementById(p + 'StepList').innerHTML = steps.map((t, i) => stepRowHTML(i, t, steps.length, noun(p))).join('');
  document.getElementById(p + 'Final').value = final;
  document.getElementById(p + 'Intro').value = intro;
  renumberSteps(p);
}
export function clearBasic(p) {
  setCardText(p + 'Front', ''); setCardText(p + 'Back', ''); setCardText(p + 'Hook', '');
  setCardImage(p + 'Front', null); setCardImage(p + 'Back', null);
  fillSteps(p, ['', '']);
}
// Choosing Text / Steps / Elements. What was typed comes along: the rows are written into Back when going to Text, Back's lines
// become rows when going to Steps or Elements, and Steps <-> Elements keeps the rows (the Final answer stays in its box, hidden).
document.addEventListener('change', e => {
  const p = e.target.dataset?.modeFor;
  if (!p) return;
  const to = e.target.value, panel = document.getElementById(p + 'Steps'), wrap = document.getElementById(p + 'BackWrap');
  const from = panel.dataset.cur || 'text';
  if (to === from) return;
  panel.dataset.cur = to;
  const parseTo = back => (to === 'elements' ? parseElements(back, { mask: maskMath }) : parseSteps(back, { mask: maskMath }));
  if (to === 'text') {
    const joined = from === 'elements' ? joinElements(elementParts(p)) : joinSteps(stepParts(p));
    if (joined) setCardText(p + 'Back', joined);
  } else {
    const back = from === 'text' ? readCardText(p + 'Back').trim() : '';
    panel.dataset.mode = to;
    if (from === 'text') {
      const parsed = parseTo(back);
      if (parsed) fillSteps(p, parsed.steps || parsed.items, parsed.final || '', parsed.intro);
      else if (back) fillSteps(p, [back, ''], '', '');            // what was in Back becomes the first row
      else if (stepValues(p).length === 0) fillSteps(p, ['', ''], '', '');
      else fillSteps(p, stepRows(p).map(r => r.querySelector('textarea').value), document.getElementById(p + 'Final').value, document.getElementById(p + 'Intro').value);
    } else {
      // Steps <-> Elements: the rows stay, the labels change.
      fillSteps(p, stepRows(p).map(r => r.querySelector('textarea').value), document.getElementById(p + 'Final').value, document.getElementById(p + 'Intro').value);
    }
  }
  const el = to === 'elements';
  if (to !== 'text') {
    document.getElementById(p + 'FinalWrap').hidden = el;
    document.getElementById(p + 'IntroL').textContent = el ? 'Rule or intro (optional)' : 'Intro (optional)';
    document.getElementById(p + 'Intro').placeholder = el ? 'Shown above the elements.' : 'Shown before the first step.';
    document.getElementById(p + 'StepList').setAttribute('aria-label', el ? 'Elements' : 'Steps');
    document.getElementById(p + 'StepAdd').textContent = el ? '+ Add element' : '+ Add step';
  }
  panel.hidden = to === 'text'; wrap.hidden = to !== 'text';
  renumberSteps(p);
  (to !== 'text' ? stepRows(p)[0]?.querySelector('textarea') : document.getElementById(p + 'Back'))?.focus({ preventScroll: true });
});
document.addEventListener('click', e => {
  const add = e.target.closest?.('[data-step-add]');
  if (add) {
    const p = add.dataset.stepAdd, list = document.getElementById(p + 'StepList');
    list.insertAdjacentHTML('beforeend', stepRowHTML(stepRows(p).length, '', stepRows(p).length + 1, noun(p)));
    renumberSteps(p);
    list.lastElementChild.querySelector('textarea').focus();
    return;
  }
  const b = e.target.closest?.('[data-step]');
  if (!b || b.disabled) return;
  const row = b.closest('[data-step-row]'), list = row.parentElement, p = list.id.replace(/StepList$/, '');
  if (b.dataset.step === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
  else if (b.dataset.step === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
  else if (b.dataset.step === 'del') {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove(); renumberSteps(p);
    next?.querySelector('textarea').focus();
    return;
  }
  renumberSteps(p);
  // After a move the pressed button may be disabled (first / last row): keep the focus on a button that still works.
  const keep = b.disabled ? row.querySelector(`[data-step=${b.dataset.step === 'up' ? 'down' : 'up'}]`) : b;
  keep.focus();
});

// ---------- Basic | Cloze | Image occlusion ----------
// A cloze note is one text with hidden parts: "The {{c1::mitochondria}} makes {{c2::ATP}}". Each blank number is
// one card (see cloze.js). In the add form a switch picks Basic or Cloze; the editor of a card that already is
// a cloze card opens in Cloze (the same note, so its text has all the blanks).
//   noteKinds(p, kind)    the Basic | Cloze | Image occlusion switch, for the form whose ids start with p ('ac' → #acKind...)
//   clozeFields(p, ...)   the Cloze half of the form: the buttons, the text box, the live preview and Extra
//   readKind(p)           'basic', 'cloze' or 'occlusion'
export function noteKinds(p, kind = 'basic') {
  return `<div class="chips kind-switch" role="radiogroup" aria-label="Card type">
      ${[['basic', 'Basic'], ['cloze', 'Cloze'], ['occlusion', 'Image occlusion']].map(([k, l]) => `<label class="chip"><input type="radio" name="${p}Kind" value="${k}" data-kind-for="${p}" ${k === kind ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    </div>`;
}
export const readKind = p => document.querySelector(`input[name="${p}Kind"]:checked`)?.value || 'basic';

// Why the add form (ids starting with p) can't save yet, in a few plain words; '' when it can.
export function whyNotAdd(p) {
  const kind = readKind(p);
  if (kind === 'occlusion') {
    const note = readOcclusion(p);
    if (!note?.image) return 'Choose a picture first.';
    return groupsOf(note.masks).length ? '' : 'Draw at least one box over the part to hide.';
  }
  if (kind === 'cloze') {
    const text = readCardText(p + 'Text').trim();
    if (!text) return 'Type your text, then select a word to hide.';
    if (!clozeNumbers(text).length) return 'Select a word and press New blank to hide it.';
    return planNoteSave([], text).error || '';
  }
  const front = readCardText(p + 'Front').trim() || readCardImage(p + 'Front') || readCardSounds(p + 'Front')[0];
  const stepsWhy = stepsProblem(p);
  if (stepsOn(p)) return !front ? 'Add a front to save the card.' : stepsWhy;
  const back = readCardText(p + 'Back').trim() || readCardImage(p + 'Back') || readCardSounds(p + 'Back')[0];
  if (front && back) return '';
  return !front && !back ? 'Add a front and a back to save the card.' : !front ? 'Add a front to save the card.' : 'Add a back to save the card.';
}
// Keep the form's Add button and the reason line (#{p}Why) in step with the form: aria-disabled, with the reason, until it can save.
// Typing, picking a type, a picture added or removed, boxes drawn: all of them change the form, so it watches the form itself.
export function watchAdd(p) {
  const form = document.getElementById(p + 'Form'), why = document.getElementById(p + 'Why');
  const add = document.querySelector(`button[type=submit][form="${p}Form"]`);
  if (!form || !why || !add) return () => {};
  const update = () => {
    const reason = whyNotAdd(p);
    // aria-disabled, not disabled: the button stays focusable, so a keyboard or screen-reader user can reach it and hear
    // the reason (aria-describedby). The submit handler checks the form again, so pressing it does nothing harmful.
    add.setAttribute('aria-disabled', reason ? 'true' : 'false');
    add.setAttribute('aria-describedby', why.id);
    if (why.textContent !== reason) why.textContent = reason;
    why.hidden = !reason;
  };
  const watcher = new MutationObserver(update);
  watcher.observe(form, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-media-id', 'data-sound-ids', 'hidden'] });
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
  return update;
}

export function clozeFields(p, text = '', extra = '') {
  const id = p + 'Text';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl', alt = mac ? 'Option' : 'Alt';
  // The Ctrl/⌘ keys are Anki's, but browsers keep Ctrl/⌘+Shift+C for their developer tools, so Alt+Shift+C (new) and Alt+Shift+S (same) also work.
  return `<div class="cloze-tools" role="group" aria-label="Blanks">
      <button type="button" class="btn ghost small" data-cloze="new" data-for="${id}" aria-keyshortcuts="${mac ? 'Meta+Shift+C' : 'Control+Shift+C'} Alt+Shift+C" title="Hide the selected words (${mod}+Shift+C or ${alt}+Shift+C)"><span aria-hidden="true">[…]</span> New blank</button>
      <button type="button" class="btn ghost small" data-cloze="same" data-for="${id}" aria-keyshortcuts="${mac ? 'Meta+Alt+Shift+C' : 'Control+Alt+Shift+C'} Alt+Shift+S" title="Hide the selected words in the same card (${mod}+${alt}+Shift+C or ${alt}+Shift+S)"><span aria-hidden="true">[…]=</span> Same blank as the last one</button>
    </div>
    ${cardTextField(id, 'Text', text, { rows: 4, placeholder: 'e.g. The mitochondria makes ATP for the cell', images: false, cloze: true })}
    <div class="cloze-prev" id="${id}Prev">${clozePreviewHTML(text)}</div>
    ${cardTextField(p + 'Extra', 'Extra (optional)', extra, { rows: 2, images: false, placeholder: 'Shown under the answer' })}
    <p class="note cloze-help">Select a word and press New blank to hide it: each blank becomes its own card. “Same blank as the last one” hides another word on that same card. To show a hint instead of […], type two colons and the hint inside the blank, after the answer. Maths goes between $ signs, like $x^2$.</p>`;
}
const clozePreviewHTML = text => `<p class="cloze-makes" aria-live="polite">${esc(makesText(text))}</p>
  ${text.trim() ? `<div class="cloze-render">${renderCloze(text, 0, 'all')}</div>` : ''}`;
function updateClozePreview(id) {
  const prev = document.getElementById(id + 'Prev');
  if (!prev) return;
  const text = readCardText(id);
  // The "Makes N cards" line keeps its element, so a screen reader only hears it when the words change.
  const makes = prev.querySelector('.cloze-makes'), shown = makesText(text);
  if (makes.textContent !== shown) makes.textContent = shown;
  let shownText = prev.querySelector('.cloze-render');
  if (!text.trim()) { shownText?.remove(); return; }
  if (!shownText) { shownText = document.createElement('div'); shownText.className = 'cloze-render'; prev.append(shownText); }
  shownText.innerHTML = renderCloze(text, 0, 'all');
}

// Put a blank around the selected words: "new" is the next number, "same" the highest one in use.
function addBlank(id, which) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = (which === 'same' ? lastNumber : nextNumber)(readCardText(id));
  if (el.dataset.rich) {
    el.focus();
    const sel = getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    // Nothing selected: hide the word the cursor is in or touching, like the plain box does.
    if (range.collapsed && range.startContainer.nodeType === 3) {
      const [a, b] = wordAt(range.startContainer.data, range.startOffset);
      range.setStart(range.startContainer, a); range.setEnd(range.startContainer, b);
    }
    // Wrap with two text pieces (not by replacing the selection), so bold inside the blank stays.
    const end = range.cloneRange(); end.collapse(false); end.insertNode(document.createTextNode('}}'));
    const start = range.cloneRange(); start.collapse(true); start.insertNode(document.createTextNode(`{{c${n}::`));
    el.normalize();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  let { selectionStart: a, selectionEnd: b } = el;
  if (a === b) [a, b] = wordAt(el.value, a);
  const r = wrapBlank(el.value, a, b, n);
  el.value = r.value;
  el.focus();
  el.setSelectionRange(r.start, r.end);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
document.addEventListener('mousedown', e => { if (e.target.closest?.('[data-cloze]')) e.preventDefault(); });
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-cloze]');
  if (b) addBlank(b.dataset.for, b.dataset.cloze);
});
// Ctrl/⌘+Shift+C: new blank. Ctrl/⌘+Alt+Shift+C: same blank (the same keys as Anki). Browsers may keep those for
// their developer tools, so Alt+Shift+C (new) and Alt+Shift+S (same) do the same.
document.addEventListener('keydown', e => {
  if (!e.shiftKey) return;
  const mod = e.ctrlKey || e.metaKey;
  const which = mod && e.code === 'KeyC' ? (e.altKey ? 'same' : 'new')
    : !mod && e.altKey ? ({ KeyC: 'new', KeyS: 'same' })[e.code] : null;
  const t = e.target;
  if (!which || !t?.dataset?.clozeBox) return;
  e.preventDefault();
  addBlank(t.id, which);
});
// Basic | Cloze | Image occlusion: show one part of the form.
document.addEventListener('change', e => {
  const p = e.target.dataset?.kindFor;
  if (!p) return;
  const kind = e.target.value;
  document.getElementById(p + 'Basic').hidden = kind !== 'basic';
  document.getElementById(p + 'Cloze').hidden = kind !== 'cloze';
  const occ = document.getElementById(p + 'Occ');
  if (occ) occ.hidden = kind !== 'occlusion';
  try { localStorage.setItem('study-sprint-add-kind', kind); } catch { /* fine */ }
  (document.getElementById(kind === 'occlusion' ? (occForms.get(p)?.image ? p + 'OccEdit' : p + 'OccChoose') : p + (kind === 'cloze' ? 'Text' : 'Front')))?.focus();
});
export const lastKind = () => { try { const k = localStorage.getItem('study-sprint-add-kind'); return k === 'cloze' || k === 'occlusion' ? k : 'basic'; } catch { return 'basic'; } };

// ---------- Image occlusion ----------
// A picture with boxes over the parts to learn (see occlusion.js). Each numbered group of boxes is one card. This form
// shows the picture with its boxes, an "Edit boxes" button (the drawing editor, occlusion-editor.js), the header, a
// label for each group (typing the labels works without drawing, and is the way to label with a keyboard or a screen
// reader) and the Extra text. A new note starts with "Choose a picture": a file, a dropped file, or a pasted screenshot.
//   occlusionFields(p, card, extra, { hidden, maxN })   the form for the ids that start with p; card = the card being edited
//                              (null for a new note); maxN = the highest part number any card of the note has (a floor)
//   readOcclusion(p)           { masks, header, w, h, image, maxN }: the note as it stands, ready for planOcclusionSave
//   setOcclusion(p, note)      replace the picture and boxes (note: { masks, image, w, h, header?, maxN? }) and redraw
//   resetOcclusion(p)          back to an empty form (after a note was added)
const occForms = new Map();       // p → { masks, image, w, h, maxN, n }: the form's state (n = the card being edited)
const CAMERA = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5L5 20"/></svg>';

export function occlusionFields(p, card = null, extra = '', { hidden = false, maxN = 0 } = {}) {
  const o = card?.occlusion;
  const st = { masks: o ? o.masks.map(m => ({ ...m })) : [], image: card?.backImage || null, w: o?.w || 0, h: o?.h || 0, maxN: Math.max(0, maxN, ...(o?.masks || []).map(m => m.n)), n: o?.n ?? null };
  occForms.set(p, st);
  const parts = occParts(p, st, o?.header || '');
  const desk = RICH.matches;
  return `<div class="occ-form" id="${p}Occ" data-occ-form="${p}" ${hidden ? 'hidden' : ''}>
      <div class="occ-pick" id="${p}OccPick" data-occ-pick="${p}" ${st.image ? 'hidden' : ''}>
        <button type="button" class="occ-pick-btn" id="${p}OccChoose" data-occ-choose="${p}">${CAMERA}<b>Choose a picture</b><span>${desk ? 'or drop one here, or paste a screenshot (Ctrl/⌘+V)' : 'A photo or screenshot of a diagram'}</span></button>
        <input type="file" id="${p}OccFile" accept="image/*" hidden data-occ-file="${p}">
      </div>
      <div class="occ-body" id="${p}OccBody" ${st.image ? '' : 'hidden'}>
        <div class="occ-form-prev" id="${p}OccPrev">${parts.preview}</div>
        <div class="occ-form-row"><p class="cloze-makes" id="${p}OccMakes" aria-live="polite">${esc(parts.makes)}</p>
          <button type="button" class="btn ghost" id="${p}OccEdit" data-occ-edit="${p}">Edit boxes</button></div>
        <label class="field"><span>Header (optional)</span><input id="${p}OccHead" data-occ-head="${p}" maxlength="${MAX_HEADER}" autocomplete="off" placeholder="e.g. Heart anatomy" value="${esc(o?.header || '')}"></label>
        <fieldset class="occ-labels" id="${p}OccLabels" data-sig="${groupsOf(st.masks).join()}"><legend>Labels (optional)</legend>${parts.labels}</fieldset>
        ${cardTextField(p + 'OccExtra', 'Extra (optional)', extra || card?.noteExtra || '', { rows: 2, images: false, placeholder: 'Shown under the answer' })}
      </div>
    </div>`;
}
// The three parts of the form that come from its state, as HTML: the preview, the "Makes N cards" line and the label boxes.
function occParts(p, st, header) {
  const groups = groupsOf(st.masks);
  return {
    preview: st.image
      ? occlusionHTML({ backImage: st.image, occlusion: { n: st.n, w: st.w, h: st.h, header, masks: st.masks } }, 'all', { zoom: false })
      : '<p class="note">No picture or boxes yet.</p>',
    makes: groups.length ? `Makes ${groups.length} card${groups.length === 1 ? '' : 's'}` : 'No boxes yet: draw at least one box over the part to hide.',
    labels: groups.map((n, i) =>
      `<label class="field occ-lbl"><span>Part ${i + 1}${n === st.n ? ' (this card)' : ''}</span><input id="${p}OccLbl${n}" data-occ-label="${n}" maxlength="${MAX_LABEL}" autocomplete="off" aria-label="Label for part ${i + 1}" placeholder="e.g. Left ventricle" value="${esc(occLabel(st.masks, n))}"></label>`).join('')
  };
}
// Draw the parts of the form that come from its state again (after setOcclusion or a header change).
export function drawOcclusion(p) {
  const st = occForms.get(p), prev = document.getElementById(p + 'OccPrev');
  if (!st || !prev) return;
  const parts = occParts(p, st, document.getElementById(p + 'OccHead')?.value ?? '');
  prev.innerHTML = parts.preview;
  document.getElementById(p + 'OccPick').hidden = !!st.image;
  document.getElementById(p + 'OccBody').hidden = !st.image;
  const makes = document.getElementById(p + 'OccMakes');
  if (makes.textContent !== parts.makes) makes.textContent = parts.makes;
  // The label boxes keep what was typed in them unless the groups changed.
  const labels = document.getElementById(p + 'OccLabels'), sig = groupsOf(st.masks).join();
  if (labels.dataset.sig !== sig) { labels.dataset.sig = sig; labels.innerHTML = '<legend>Labels (optional)</legend>' + parts.labels; }
}
export function readOcclusion(p) {
  const st = occForms.get(p);
  if (!st) return null;
  const masks = st.masks.map(m => ({ ...m }));
  // A label typed for a group goes on all of its boxes (an untouched label box changes nothing).
  for (const n of groupsOf(masks)) {
    const input = document.getElementById(`${p}OccLbl${n}`);
    if (!input) continue;
    const typed = input.value.trim().slice(0, MAX_LABEL);
    if (typed === occLabel(masks, n)) continue;
    for (const m of masks) if (m.n === n) { if (typed) m.label = typed; else delete m.label; }
  }
  return { masks, header: (document.getElementById(p + 'OccHead')?.value ?? '').trim().slice(0, MAX_HEADER), w: st.w, h: st.h, image: st.image, maxN: st.maxN };
}
export function setOcclusion(p, note) {
  const st = occForms.get(p);
  if (!st) return;
  Object.assign(st, { masks: note.masks.map(m => ({ ...m })), image: note.image, w: note.w, h: note.h, maxN: Math.max(st.maxN, note.maxN ?? 0, ...note.masks.map(m => m.n)) });
  const head = document.getElementById(p + 'OccHead');
  if (head && note.header !== undefined) head.value = note.header;
  const labels = document.getElementById(p + 'OccLabels');
  if (labels) delete labels.dataset.sig;           // new boxes: draw the label boxes again
  drawOcclusion(p);
}
export function resetOcclusion(p) {
  const st = occForms.get(p);
  if (!st) return;
  Object.assign(st, { masks: [], image: null, w: 0, h: 0, maxN: 0, n: null });
  const head = document.getElementById(p + 'OccHead');
  if (head) head.value = '';
  if (document.getElementById(p + 'OccExtra')) setCardText(p + 'OccExtra', '');
  const labels = document.getElementById(p + 'OccLabels');
  if (labels) delete labels.dataset.sig;
  drawOcclusion(p);
}
// The header changes the picture's description in the preview.
document.addEventListener('input', e => { const p = e.target.dataset?.occHead; if (p) drawOcclusion(p); });

// Open the box editor on the form's picture. The typed labels go in with the boxes and come back with them.
const editing = new Set();
async function editBoxes(p) {
  const st = occForms.get(p), note = readOcclusion(p);
  if (!st?.image || editing.has(p)) return;
  editing.add(p);
  try {
    const { openOcclusionEditor } = await import('./occlusion-editor.js');
    const res = await openOcclusionEditor({ image: st.image, w: st.w, h: st.h, masks: note.masks, focusN: st.n, maxN: st.maxN });
    const occ = document.getElementById(p + 'Occ');
    if (res && occ?.isConnected) setOcclusion(p, { masks: res.masks, image: st.image, w: st.w, h: st.h, maxN: res.maxN });
    // The button that opened the editor may be disabled or hidden by now: keep the focus inside the form.
    const form = occ?.closest('form');
    if (form && !form.contains(document.activeElement)) {
      const edit = document.getElementById(p + 'OccEdit');
      (st.image && edit && !edit.closest('[hidden]') ? edit : document.getElementById(p + 'OccChoose'))?.focus({ preventScroll: true });
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't open the box editor");
  } finally { editing.delete(p); }
}
// A picture was chosen, dropped or pasted: shrink and keep it (2048px, so small text stays readable), then draw boxes.
async function pickPicture(p, file) {
  const st = occForms.get(p), btn = document.getElementById(p + 'OccChoose');
  if (!st || !btn || btn.disabled) return;
  if (!file?.type?.startsWith('image/')) { toast('Please choose a picture (a photo or a screenshot).'); return; }
  const label = btn.querySelector('b');
  btn.disabled = true; btn.setAttribute('aria-busy', 'true'); label.textContent = 'Preparing picture…';
  try {
    const info = await addImageInfo(file, { maxSide: OCCLUSION_SIDE });
    if (!document.getElementById(p + 'Occ')?.isConnected) return;          // the form was closed meanwhile
    setOcclusion(p, { masks: [], image: info.id, w: info.width, h: info.height });
    await editBoxes(p);
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't add that picture");
  } finally {
    btn.disabled = false; btn.removeAttribute('aria-busy'); label.textContent = 'Choose a picture';
  }
}
document.addEventListener('click', e => {
  const choose = e.target.closest?.('[data-occ-choose]');
  if (choose) document.getElementById(choose.dataset.occChoose + 'OccFile')?.click();
  const edit = e.target.closest?.('[data-occ-edit]');
  if (edit) editBoxes(edit.dataset.occEdit);
});
document.addEventListener('change', e => {
  const p = e.target.dataset?.occFile;
  if (!p) return;
  const file = e.target.files[0];
  e.target.value = '';
  if (file) pickPicture(p, file);
});
// Drag a picture onto the "Choose a picture" box (computers).
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', e => {
  const zone = e.target.closest?.('[data-occ-pick]');
  if (!zone || !hasFiles(e)) return;
  e.preventDefault();
  zone.classList.add('drag');
});
document.addEventListener('dragleave', e => e.target.closest?.('[data-occ-pick]')?.classList.remove('drag'));
document.addEventListener('drop', e => {
  const zone = e.target.closest?.('[data-occ-pick]');
  if (!zone || !hasFiles(e)) return;
  e.preventDefault();
  zone.classList.remove('drag');
  pickPicture(zone.dataset.occPick, e.dataTransfer.files[0]);
});
// Paste a screenshot (Ctrl/⌘+V) while the picture form is showing and has no picture yet.
document.addEventListener('paste', e => {
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (!file) return;
  const p = [...occForms].find(([key, st]) => !st.image && document.getElementById(key + 'Occ')?.offsetParent)?.[0];
  if (!p) return;
  e.preventDefault();
  pickPicture(p, file);
});
