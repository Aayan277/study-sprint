// Turning Anki notes into Study Sprint cards. Pure functions (no page, no files), tested by tests/anki.test.js.
// anki-read.js opens the .apkg file and hands its notes to notesToImport() below.
//
// How Anki stores things, in short:
//   note       one fact, with several fields (e.g. Front and Back), plus tags
//   note type  says which fields a note has. "Cloze" notes hide parts of one text: {{c1::answer::hint}}
//   deck       where the note's cards live. Subdecks are written "Parent::Child"
// Fields are HTML. Bold, italics and lists are kept (as format.js marks); other formatting, images and sounds
// are left out.

import { htmlToMarks } from './format.js';
import { clozeNumbers, clozeCard } from './cloze.js';
import { parseAnkiOcclusion, occFrontBack, groupsOf } from './occlusion.js';
import { parseDetails, cleanFields } from './note-fields.js';

// HTML → plain text, keeping line breaks (formatting dropped). Fields themselves keep their bold,
// italics and lists as marks: see htmlToMarks in format.js.
export const htmlToText = html => htmlToMarks(html, { marks: false });

// Anki's editor writes formulas as [$]x[/$] and [$$]x[/$$]; here they are \(x\) and \[x\], which (unlike $ ... $) take
// spaces and line breaks inside, as Anki's do. (\( ... \) and \[ ... \] themselves are read as they are.)
export const ankiMath = text => String(text ?? '').replace(/\[\$\$\]([\s\S]+?)\[\/\$\$\]/g, (m, t) => `\\[${t}\\]`).replace(/\[\$\]([\s\S]+?)\[\/\$\]/g, (m, t) => `\\(${t}\\)`);

export const hasImage = html => /<img\b/i.test(String(html ?? ''));

// The sound file names in a field, in order: 'dog [sound:dog.mp3]' → ['dog.mp3']. Names may be URL-encoded ("my%20sound.mp3").
// Call it on the field's HTML before htmlToMarks, which removes the [sound:...] tags.
//   raw: true gives the names as written (before URL-decoding), for a file whose name really has a % in it
export function soundNames(html, { raw = false } = {}) {
  return [...String(html ?? '').matchAll(/\[sound:([^\]]+)\]/g)]
    .map(m => htmlToMarks(m[1], { marks: false }))
    .map(n => (raw ? n : (() => { try { return decodeURIComponent(n); } catch { return n; } })()))
    .map(n => n.trim())
    .filter(Boolean);
}
export const MAX_SOUND_BYTES = 1024 * 1024;        // the cap for one sound (the same number as media.js; this file stays free of page code)
export const MAX_SOUNDS = 4;                        // per side of a card
const SOUND_EXT = /\.(mp3|m4a|mp4|aac|ogg|oga|opus|webm|wav|flac)$/i;

// The picture file names in a field, in order: <img src="brain.png"> → ['brain.png'].
export function imageNames(html) {
  return [...String(html ?? '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map(m => htmlToMarks(m[1] ?? m[2] ?? m[3], { marks: false }))
    .map(n => { try { return decodeURIComponent(n); } catch { return n; } })
    .filter(Boolean);
}

// The list of pictures in a newer Anki file (after unzipping and decompressing its "media" file). It's a
// small "protobuf" record: a list of entries, each with the picture's name (field 1) and, sometimes, the
// zip file it's stored in (field 255); otherwise entry number i is in zip file "i".
// Returns [{ name, zipName, size? }] (size = bytes when unpacked, when the list says).
export function mediaList(bytes) {
  const read = readProto;
  const out = [];
  read(bytes, (field, value) => {
    if (field !== 1 || !(value instanceof Uint8Array)) return;
    const entry = { name: '', zipName: undefined };
    read(value, (f, v) => {
      if (f === 1) entry.name = new TextDecoder().decode(v);
      if (f === 2 && typeof v === 'number') entry.size = v;
      if (f === 255 && typeof v === 'number') entry.zipName = String(v);
    });
    out.push(entry);
  });
  return out;
}

// Walks one "protobuf" record, calling fields(field number, value) for each part: a number, or the bytes of a text or a nested record.
function readProto(buf, fields) {
  let i = 0;
  const varint = () => { let n = 0, shift = 0, b; do { b = buf[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return n; };
  while (i < buf.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) fields(field, varint());
    else if (wire === 2) { const len = varint(); fields(field, buf.subarray(i, i + len)); i += len; }
    else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;
  }
}

// A card type's config in newer Anki files holds its templates: the front (field 1), like "{{Front}}", and the back (field 2).
export function templateFormats(config) {
  const out = { qfmt: '', afmt: '' };
  if (!(config instanceof Uint8Array)) return out;
  try {
    readProto(config, (field, value) => {
      if (!(value instanceof Uint8Array)) return;
      if (field === 1) out.qfmt = new TextDecoder().decode(value);
      if (field === 2) out.afmt = new TextDecoder().decode(value);
    });
  } catch { /* an odd record: no templates */ }
  return out;
}

// The fields a card template names: "{{Front}}", "{{cloze:Text}}", "{{#Add Reverse}}{{Back}}{{/Add Reverse}}" give Front, Text,
// Add Reverse and Back, each marked as a plain use or as a condition (a {{#…}} or {{^…}} section).
function templateUses(fmt) {
  const out = [];
  for (const m of String(fmt ?? '').matchAll(/\{\{([^}]*)\}\}/g)) {
    const raw = m[1].trim();
    if (raw.startsWith('/')) continue;
    out.push({ name: raw.replace(/^[#^]\s*/, '').split(':').pop().trim(), cond: /^[#^]/.test(raw), type: /^type:/i.test(raw) });
  }
  return out;
}
// Is this note type "Basic (and reversed card)": exactly two card types, the second asking with the Back field (the second field)
// and not the Front? That includes "Basic (optional reversed card)", whose second card only exists when a note asks for it.
export function reverseModel(model) {
  const t = model?.templates;
  if (!model || model.cloze || !Array.isArray(t) || t.length !== 2) return false;
  const [front, back] = (model.fields || []).map(f => String(f).trim());
  const second = t.find(x => x.ord === 1) || t[1];
  if (!front || !back || !second) return false;
  // (A {{type:Front}} box under the question doesn't make the card ask with the front: only the fields shown count, when there are any.)
  const uses = templateUses(second.qfmt), plain = uses.filter(u => !u.type);
  const names = (plain.length ? plain : uses).map(u => u.name);
  return names.includes(back) && !names.includes(front);
}
// The card types ("ord" numbers) that ask for the answer to be typed: their question side has a {{type:Field}} box, which also
// covers {{type:cloze:Text}} and {{type:nc:Field}}. A box only on the answer side doesn't count: Anki shows nothing to type.
export function typedOrds(model) {
  const out = new Set();
  (model?.templates || []).forEach((t, i) => { if (/\{\{\s*type:[^}]+\}\}/i.test(String(t?.qfmt ?? ''))) out.add(Number.isInteger(t.ord) ? t.ord : i); });
  return out;
}
// A field the card types only use as a condition ("Add Reverse" in the optional-reverse type): a switch, not content.
const conditionOnly = (model, name) => {
  const uses = (model.templates || []).flatMap(t => [...templateUses(t.qfmt), ...templateUses(t.afmt)]).filter(u => u.name === String(name).trim());
  return uses.length > 0 && uses.every(u => u.cond);
};

// Cloze helpers live in cloze.js; they're re-exported here for the importer and its tests.
export { clozeNumbers, clozeCard };

// Turn Anki notes into rows for the import preview.
//   notes   [{ mid, fields: [html, ...], tags: [...], deck: 'Parent::Child' }]
//   models  Map note type id → { name, fields: [field names], cloze: true/false }
// Returns the same shape as the other importers ({ columns, rows, format }), plus:
//   tags    tags for each row
//   decks   the Anki deck each row came from
//   images  how many notes had pictures
//   pictures  each row's picture names { front, back } (the first picture on each side; extraImages counts
//             notes with more than that, which are left out)
//   ankiIds   the Anki card each row came from, so its review history can come along
//   reviews   Map Anki card id → its review history, for the rows' cards that have one
//   occluded  for each row, true if it came from an image-occlusion note (see below)
//   occlusions  for each row, null, or { noteKey, n, header, shapes, pixels, image } for an image-occlusion card (see below)
//   clozes    for each row, null, or { noteKey, n, text } for a cloze note's card: the note's text, the blank this
//             row hides, and a key shared by the rows of one note (so the import makes them siblings: see cloze.js)
//   noteExtras  for each row, the note's Back Extra text ('' when none); for a cloze note it is shown under the answer
//   guids     each row's Anki note guid, saved on the card (ankiGuid)
//   sounds    for each row, null or { note, front: [names], back: [names], lost: [{ name, reason }] }: the sound files named on the
//             front (first field) and back (the other fields; for a cloze note, the Text field is the front), the ones that can
//             be kept, and the ones that can't with why: 'missing' (not in the package), 'tooBig' (over 1 MB), 'format' (not a
//             type the app keeps) or 'extra' (more than 4 on a side). See soundReport() for the counts the import shows.
//   reversed  for each row, null, or { ankiId } for a note of a "Basic (and reversed card)" type whose reverse card exists in Anki: the
//             row makes two cards, and the reverse card's history is replayed from its own Anki card (see reverseModel)
//   fieldNames  for each row of an ordinary note, the note type's field names for the columns (null for a field that is only a
//             switch, like "Add Reverse"), so buildCards can keep the columns that are not the front or back as noteFields
//   detailFields  for each ordinary note's row, the <details><summary> sections found in its back fields: [{ name, text }]
//   extraSplits  for each cloze note's row, null or { extra, fields }: the main extra text (the field named Back Extra or Extra, else
//             the second field) and the other non-empty fields, which buildCards keeps as the card's noteFields (item A)
//   fieldInfo  for each row, { note, pics, cut, more }: fields left out for holding only pictures, fields cut to the length limit, and
//             whether the note has more card types in Anki than come in (see fieldReport)
//   progress  { cards, reviews }: how many rows have history, and how many reviews in all
// Rows are [front, back, any other fields]. Cloze notes give one row per cloze number: just [front, back], with
// their other fields (like Back Extra) kept as the note's extra (noteExtras).

// The labels in an Image Occlusion note's Comments field: lines "1. Aorta" (split by <br> or a line break), all of them
// numbered. Returns labels by position (index k - 1), or null when the field is anything else.
export function ioLabels(html) {
  const lines = String(html ?? '').split(/<br\s*\/?>|<\/?div\b[^>]*>|\r?\n/i).map(l => htmlToText(l).trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const m = /^(\d+)\.\s(.*)$/s.exec(line);
    if (!m || +m[1] < 1 || +m[1] > 1000) return null;
    out[+m[1] - 1] = m[2].trim();
  }
  return out.length ? out : null;
}

// Image-occlusion notes (a cloze note whose first field holds "image-occlusion:") hide parts of a picture. Each one
// comes in as a note of image-occlusion cards (see occlusion.js): one card for each numbered group of boxes, with the
// picture and all the boxes. The result's `occlusions` array has, for each such row,
// { noteKey, n, header, shapes, pixels, image }: the Anki boxes, still in Anki's numbers (the import screen turns them
// into fractions of the picture once it has decoded the picture: see import-screen.js).
// A note with no readable boxes or no picture comes in as one plain picture card instead (`occluded`): the heading
// (or "Diagram") on the front, the picture on the back. So are the notes of the old "Image Occlusion Enhanced"
// add-on, which draws its masks in SVG files: one picture card for each group of its notes.
// The note type must be a cloze type or called "...Occlusion...", so an ordinary note that happens to quote the text isn't taken for one.
export const isOcclusionNote = (note, model = {}) =>
  String(note.fields?.[0] ?? '').includes('image-occlusion:') && (!!model.cloze || /occlusion/i.test(model.name || ''));
const fieldIndex = (model, name, fallback) => {
  const i = (model.fields || []).findIndex(f => String(f).trim().toLowerCase() === name);
  return i >= 0 ? i : fallback;
};
// The "Image Occlusion Enhanced" add-on (it makes one note for each mask, with an ID like "20170224194620-3").
export const isEnhancedNote = (model = {}) => {
  const names = (model.fields || []).map(f => String(f).trim().toLowerCase());
  return /image occlusion enhanced/i.test(model.name || '') || (names.includes('question mask') && names.includes('original mask'));
};
// media: the package's files { info(name) → { size, type } | null } (anki-read.js); without it every sound with a known ending is taken as present.
export function notesToImport(notes, models, reviews = new Map(), media = null) {
  const rows = [], tags = [], decks = [], ankiIds = [], pictures = [], occluded = [], clozes = [], noteExtras = [], guids = [], occlusions = [], sounds = [];
  const typeAt = new Set();      // row indexes of cards that ask for the answer to be typed
  const revAt = new Map(), namesAt = new Map(), detailsAt = new Map(), splitAt = new Map(), infoAt = new Map();      // by row index (filled for the rows that have them)
  const soundFiles = new Map();          // name → { size, type } of every sound that can be kept
  const verdicts = new Map();
  const judge = name => {
    if (!verdicts.has(name)) {
      const info = media ? media.info(name) : { size: 0, type: SOUND_EXT.test(name) ? 'audio/*' : '' };
      verdicts.set(name, !info ? 'missing' : !String(info.type).startsWith('audio/') ? 'format' : info.size > MAX_SOUND_BYTES ? 'tooBig' : 'ok');
      if (verdicts.get(name) === 'ok') soundFiles.set(name, { size: info.size, type: info.type });
    }
    return verdicts.get(name);
  };
  // The sounds of a note's fields: front from the given fields, back from the rest. null when it names none.
  // The name as written when the package has a file called that (a real "100%.mp3"), else the URL-decoded name ("my%20cat.wav").
  const namesIn = f => {
    const decoded = soundNames(f), written = soundNames(f, { raw: true });
    return written.map((w, i) => (media && media.info(w) ? w : decoded[i]));
  };
  const soundsOf = (note, frontFields) => {
    const names = { front: [], back: [] };
    note.fields.forEach((f, i) => { for (const n of namesIn(f)) { const side = frontFields.includes(i) ? names.front : names.back; if (!side.includes(n)) side.push(n); } });
    if (!names.front.length && !names.back.length) return null;
    const out = { note: String(note.id ?? ''), front: [], back: [], lost: [] };
    for (const side of ['front', 'back']) {
      for (const n of names[side]) {
        const v = judge(n);
        if (v !== 'ok') out.lost.push({ name: n, reason: v });
        else if (out[side].length >= MAX_SOUNDS) out.lost.push({ name: n, reason: 'extra' });
        else out[side].push(n);
      }
    }
    return out;
  };
  let images = 0, extraImages = 0;
  const usedTypes = new Set();
  const enhancedSeen = new Set();
  for (const [index, note] of notes.entries()) {
    const model = models.get(String(note.mid)) || { name: '', fields: [], cloze: false };
    // <details><summary>Name</summary>…</details> sections in the back fields are note fields of their own (Study Sprint's own export writes them).
    const parts = note.fields.map((f, i) => (i === 0 ? { rest: f, fields: [] } : parseDetails(f)));
    const text = parts.map(p => ankiMath(htmlToMarks(p.rest)));       // bold, italics and lists kept as marks
    const details = parts.flatMap((p, i) => p.fields.map(d => ({ name: htmlToText(d.name).trim(), text: ankiMath(htmlToMarks(d.html)).trim(), at: i })));
    if (isEnhancedNote(model)) {
      // One picture card for each group of the add-on's notes (the ID without its last "-number").
      const idText = htmlToText(note.fields[fieldIndex(model, 'id', 0)] || '').trim();
      const group = `${note.deck || ''}|${idText ? idText.replace(/-\d+$/, '') : 'note' + index}`;
      if (enhancedSeen.has(group)) continue;
      enhancedSeen.add(group);
      if (note.fields.some(hasImage)) images++;
      const image = imageNames(note.fields[fieldIndex(model, 'image', 2)])[0] || note.fields.flatMap(imageNames)[0] || null;
      const header = htmlToText(note.fields[fieldIndex(model, 'header', 1)] || '').trim();
      const extra = text[fieldIndex(model, 'remarks', 5)]?.trim();
      rows.push([header || 'Diagram', extra || '']); tags.push((note.tags || []).map(t => t.toLowerCase())); decks.push(note.deck || '');
      pictures.push({ front: null, back: image }); ankiIds.push(null); occluded.push(true); occlusions.push(null);
      clozes.push(null); noteExtras.push(''); guids.push(note.guid || null); sounds.push(null);
      usedTypes.add('occlusion');
      continue;
    }
    if (note.fields.some(hasImage)) images++;
    // One picture per side: the first in the front field, and the first in the other fields for the back.
    const frontPics = imageNames(note.fields[0]), backPics = note.fields.slice(1).flatMap(imageNames);
    const pics = { front: frontPics[0] || null, back: backPics[0] || null };
    if (frontPics.length > 1 || backPics.length > 1) extraImages++;
    const noteTags = (note.tags || []).map(t => t.toLowerCase());
    if (isOcclusionNote(note, model)) {
      // Fields of the Image Occlusion note type: Occlusion, Image, Header, Back Extra, Comments.
      const image = imageNames(note.fields[fieldIndex(model, 'image', 1)])[0] || null;
      const header = htmlToText(note.fields[fieldIndex(model, 'header', 2)] || '').trim();
      const extra = text[fieldIndex(model, 'back extra', 3)]?.trim() || '';
      const parsed = parseAnkiOcclusion(note.fields[0]), pixels = parsed.pixels;
      const groups = groupsOf(parsed.shapes);
      const labels = ioLabels(note.fields[fieldIndex(model, 'comments', 4)]);
      // Comments "1. Aorta" name the k-th group (Study Sprint's own export writes them).
      const shapes = labels ? parsed.shapes.map(s => (labels[groups.indexOf(s.n)] ? { ...s, label: labels[groups.indexOf(s.n)] } : s)) : parsed.shapes;
      usedTypes.add('occlusion');
      if (shapes.length && image) {
        const noteKey = String(note.id ?? index);
        for (const n of groups) {
          const { front, back } = occFrontBack({ header, masks: shapes }, n);
          rows.push([front, back]); tags.push(noteTags); decks.push(note.deck || '');
          pictures.push({ front: null, back: image }); occluded.push(false); clozes.push(null);
          occlusions.push({ noteKey, n, header, shapes, pixels, image });
          noteExtras.push(extra); guids.push(note.guid || null); sounds.push(null);
          ankiIds.push(note.cards?.[n - 1] ?? null);      // box number n is Anki card number n - 1
        }
      } else {
        // Nothing to hide (or no picture): a plain picture card, as before.
        rows.push([header || 'Diagram', extra]); tags.push(noteTags); decks.push(note.deck || '');
        pictures.push({ front: null, back: image }); ankiIds.push(null); occluded.push(true); occlusions.push(null);
        clozes.push(null); noteExtras.push(''); guids.push(note.guid || null); sounds.push(null);
      }
      continue;
    }
    const nums = clozeNumbers(note.fields[0] ?? '');
    if (model.cloze || nums.length) {
      // Cloze text is in the first field. Turn it to text first so hidden answers lose their formatting too.
      // The note's main extra is the field named Back Extra or Extra (else the second field); every other non-empty field can be kept
      // as a folded section with its name (item A). With that switched off they are all joined into one extra block, as before.
      const mainAt = fieldIndex(model, 'back extra', fieldIndex(model, 'extra', 1)) || 1;
      const others = [];
      let pics = 0;
      text.forEach((t, i) => {
        if (i === 0) return;
        if (i !== mainAt) {
          if (t.trim()) others.push({ name: model.fields?.[i] ?? `Field ${i + 1}`, text: t.trim() });
          else if (hasImage(note.fields[i])) pics++;
        }
        for (const d of details.filter(x => x.at === i)) if (d.text) others.push({ name: d.name || `Field ${i + 1}`, text: d.text });
      });
      const extra = [...text.slice(1).map(t => t.trim()), ...details.map(d => (d.text ? `${d.name}\n${d.text}` : ''))].filter(Boolean).join('\n');
      const kept = cleanFields(others);
      const noteKey = String(note.id ?? index);
      const noteSounds = soundsOf(note, [0]);          // the Text field's sounds are on the front, the rest on the back (every card of the note shares them)
      for (const n of nums) {
        const { front, back } = clozeCard(text[0], n);
        rows.push([front, back]); tags.push(noteTags); decks.push(note.deck || ''); pictures.push(pics); occluded.push(false);
        clozes.push({ noteKey, n, text: text[0] }); occlusions.push(null); noteExtras.push(extra); guids.push(note.guid || null); sounds.push(noteSounds);
        if (typedOrds(model).size > 0) typeAt.add(rows.length - 1);
        ankiIds.push(note.cards?.[n - 1] ?? null);      // blank number n is Anki card number n - 1
        if (kept.fields.length) splitAt.set(rows.length - 1, { extra: (text[mainAt] ?? '').trim(), fields: kept.fields });
        infoAt.set(rows.length - 1, { note: noteKey, pics, cut: kept.cut, more: false });
      }
      usedTypes.add('cloze');
    } else {
      rows.push(text); tags.push(noteTags); decks.push(note.deck || ''); pictures.push(pics); occluded.push(false);
      clozes.push(null); occlusions.push(null); noteExtras.push(''); guids.push(note.guid || null); sounds.push(soundsOf(note, [0]));
      ankiIds.push(note.cards?.[0] ?? null);            // the front → back card
      usedTypes.add(String(note.mid));
      const at = rows.length - 1;
      // A field called Back Extra (after the first two: what this app's reversed-card export writes) is the note's extra, shown open.
      const extraAt = fieldIndex(model, 'back extra', -1);
      if (extraAt >= 2 && !isOcclusionNote(note, model)) { noteExtras[at] = text[extraAt].trim(); }
      // "Basic (and reversed card)" brings both cards: the reverse card exists in Anki when the note has a second card.
      const ords = typedOrds(model);
      if (ords.has(0)) typeAt.add(at);
      const reverse = reverseModel(model) && note.cards?.[1] ? { ankiId: note.cards[1], ...(ords.has(1) ? { typeIn: true } : {}) } : null;
      if (reverse) revAt.set(at, reverse);
      if (model.fields?.length) namesAt.set(at, model.fields.map((n, i) => (conditionOnly(model, n) || (i === extraAt && extraAt >= 2) ? null : n)));
      if (details.length) detailsAt.set(at, details.filter(d => d.text).map(d => ({ name: d.name, text: d.text })));
      const named = namesAt.get(at) || [];
      const spare = [];
      let lost = 0;
      text.forEach((t, i) => {
        if (i < 2 || named[i] === null) return;
        if (t.trim()) spare.push({ name: named[i] ?? `Field ${i + 1}`, text: t.trim() });
        else if (hasImage(note.fields[i])) lost++;
      });
      infoAt.set(at, { note: String(note.id ?? index), pics: lost, cut: 0,        // (the length limits for a basic note depend on the columns picked: basicFieldsCut in import.js)
        more: !reverse && (model.templates?.length || 0) >= 2 && Object.keys(note.cards || {}).length >= 2 });
    }
  }
  const width = Math.max(2, ...rows.map(r => r.length));
  const padded = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  // One ordinary note type: use its field names. Otherwise number them.
  const only = usedTypes.size === 1 && !usedTypes.has('cloze') ? models.get([...usedTypes][0]) : null;
  const columns = Array.from({ length: width }, (_, i) =>
    (only && only.fields[i]) || (i === 0 ? 'Front (field 1)' : i === 1 ? 'Back (field 2)' : `Field ${i + 1}`));
  const all = rows.map((_, i) => i);
  const reversed = all.map(i => revAt.get(i) || null);
  const typeIns = all.map(i => typeAt.has(i));
  const withReverse = [...ankiIds, ...reversed.map(r => r?.ankiId ?? null)];          // a reverse card's history comes along too
  const used = new Map(withReverse.filter(id => id && reviews.get(id)?.length).map(id => [id, reviews.get(id)]));
  return { columns, rows: padded, tags, decks, images, extraImages, pictures, occluded, clozes, occlusions, noteExtras, guids, sounds, soundFiles, ankiIds, reviews: used, progress: progressOf(withReverse, used),
    reversed, typeIns, fieldNames: all.map(i => namesAt.get(i) || null), detailFields: all.map(i => detailsAt.get(i) || null), extraSplits: all.map(i => splitAt.get(i) || null), fieldInfo: all.map(i => infoAt.get(i) || null),
    format: { id: 'anki', label: 'from the Anki deck' }, headerSkipped: false };
}

// What the import says about sounds (item B), counted over the rows now in the result (so it follows the deck picker):
//   notes   how many notes have sounds that can come along     files  the distinct sounds that can be kept     bytes  their total size
//   missing / tooBig / format / extra   how many distinct sound files can't be kept, by reason (a file named on 50 cards counts once)
//   dropped the number of sounds left out in all (the sum of those four)
export function soundReport(result) {
  const notes = new Set(), files = new Map(), lost = { missing: new Map(), tooBig: new Map(), format: new Map(), extra: new Map() };
  for (const s of result.sounds || []) {
    if (!s) continue;
    if (s.front.length || s.back.length) notes.add(s.note);
    for (const n of [...s.front, ...s.back]) files.set(n, result.soundFiles?.get(n)?.size || 0);
    for (const { name, reason } of s.lost) lost[reason]?.set(name, true);
  }
  const count = k => lost[k].size;
  return { notes: notes.size, files: [...files.keys()], bytes: [...files.values()].reduce((a, b) => a + b, 0),
    missing: count('missing'), tooBig: count('tooBig'), format: count('format'), extra: count('extra'),
    dropped: count('missing') + count('tooBig') + count('format') + count('extra') };
}

// What the import says about note fields (item A) and card types, counted over the rows now in the result:
//   pictures  fields left out because they held only pictures      cut  fields shortened or dropped for the length limits
//   more      notes with more card types in Anki than come in (like a listening card): only the first card of each comes
export function fieldReport(result) {
  const seen = new Set();
  const out = { pictures: 0, cut: 0, more: 0 };
  for (const x of result.fieldInfo || []) {
    if (!x || seen.has(x.note)) continue;
    seen.add(x.note);
    out.pictures += x.pics; out.cut += x.cut; if (x.more) out.more++;
  }
  return out;
}

// How many rows have review history, and how many reviews that is.
function progressOf(ankiIds, reviews) {
  let cards = 0, count = 0;
  for (const id of ankiIds) {
    const n = (id && reviews.get(id)?.filter(countsAsReview).length) || 0;
    if (n) { cards++; count += n; }
  }
  return { cards, reviews: count };
}
const isAnswer = e => e.ease >= 1 && e.ease <= 4;

// What Anki's own FSRS code makes of the history rows (rslib: revlog/mod.rs and scheduler/fsrs/params.rs):
//   cram     an answer in a filtered deck that doesn't touch the schedule (type 3, factor 0): ignored
//   reset    "Forget" (type 4, factor 0): the card is new again, so the history before it no longer counts.
//            A manual change that leaves the card with no gap at all (ivl 0) is a reset too: that is how earlier
//            versions of this app read it, and some exports carry a factor on those rows.
// Everything else with a button (1-4) is a real review. Changes made by hand ("Set due date") are skipped.
export const isCram = e => e.type === 3 && e.factor === 0;
export const isReset = e => e.ease === 0 && e.type === 4 && (e.factor === 0 || e.ivl === 0);
export const countsAsReview = e => isAnswer(e) && !isCram(e);

// FSRS-6's default weights w8, w9, w10 (the same ts-fsrs 5.4.2 uses): how fast a Good answer grows the stability.
const W8 = 1.8722, W9 = 0.1666, W10 = 0.796;
const DAY = 86400000;

// A card state to start from when Anki's history is cut off (the first row we have isn't the card's first
// learning step, so earlier reviews are missing). Like Anki's own FSRS import, it turns Anki's interval and ease
// into FSRS memory: stability ~ the interval (a card is due at 90% recall), and the difficulty that makes a Good
// answer multiply the interval by the card's ease. The state is as of that row's review.
// maxInterval is the deck's longest gap (days): the card comes back no later than that, whatever Anki's gap was.
export function seedFromAnki(cardId, e, maxInterval = 36500) {
  const ivl = Math.max(0.1, e.ivl);
  const ease = e.factor >= 1300 && e.factor <= 9999 ? e.factor / 1000 : 2.5;      // unknown or odd: Anki's default
  const growth = Math.exp(W8) * ivl ** -W9 * (Math.exp(W10 * 0.1) - 1);            // how much a Good answer grows S per point of (11 - D)
  const difficulty = Math.min(10, Math.max(1, 11 - (ease - 1) / growth));
  const gap = Math.min(ivl, maxInterval);
  return { cardId, due: e.timestamp + gap * DAY, stability: ivl, difficulty, elapsedDays: 0, scheduledDays: Math.round(gap), learningSteps: 0,
    reps: 1, lapses: 0, state: 2, lastReview: e.timestamp };
}

// Rebuild a card's progress by replaying its Anki reviews, oldest first, through Study Sprint's FSRS.
//   entries  one card's Anki review history [{ timestamp, ease, ivl, ms, type, factor }]
//   rate     (state, rating, timestamp, isLast) → new state: Study Sprint's scheduler (srs.js rate).
//            isLast is true for the card's final review, which sets the due date.
//   cardId   for the seeded state of a cut-off history       maxInterval  the deck's longest gap, for that seed
// Returns { state, logs }: the card's final schedule (null if it ends up new) and review log rows
// (source 'anki') for its history and the stats. Anki's buttons 1–4 are the same as ours.
// Like Anki:
//   - cram reviews (filtered decks) are left out;
//   - "Forget" resets the card: only what comes after it sets the schedule (earlier reviews stay in the log);
//   - old Anki versions didn't log resets, so a new learning step after reviews starts the card again;
//   - a history that starts after the card's first learning step is cut off: it starts from Anki's interval
//     and ease at that row (seedFromAnki) instead of from a new card.
export function replayHistory(entries, rate, cardId = '', maxInterval) {
  // Split the reviews into runs, each starting from a new card. The last run is the card's schedule.
  const runs = [{ rows: [], canSeed: true }];
  for (const e of entries) {
    if (isReset(e)) { runs.push({ rows: [], canSeed: false }); continue; }
    if (!countsAsReview(e)) continue;
    const run = runs.at(-1);
    if (e.type === 0 && run.rows.length && run.rows.at(-1).type !== 0) runs.push({ rows: [e], canSeed: false });
    else run.rows.push(e);
  }
  const logs = [];
  let state = null;
  runs.forEach((run, r) => {
    state = null;
    const { rows } = run;
    let from = 0;
    if (run.canSeed && rows.length && rows[0].type !== 0 && rows[0].ivl > 0) {      // cut off: start from the first row's interval and ease
      state = seedFromAnki(cardId, rows[0], maxInterval);
      logs.push(logOf(rows[0], 2));
      from = 1;
    }
    for (let i = from; i < rows.length; i++) {
      const before = state ? state.state : 0;
      state = rate(state, rows[i].ease, rows[i].timestamp, r === runs.length - 1 && i === rows.length - 1);
      logs.push(logOf(rows[i], before));
    }
  });
  return { state, logs };
}
const logOf = (e, before) => ({ timestamp: e.timestamp, source: 'anki', mode: 'flip', correct: e.ease > 1,
  ms: Math.max(0, Math.min(e.ms || 0, 60000)), rating: e.ease, state: before });

// Only the rows from one Anki deck (and its subdecks). deck = '' means all of them.
export function onlyDeck(result, deck) {
  if (!deck) return result;
  const keep = result.decks.map(d => d === deck || d.startsWith(deck + '::'));
  const pick = list => list.filter((_, i) => keep[i]);
  const ankiIds = pick(result.ankiIds || []);
  const reversed = pick(result.reversed || []);
  return { ...result, reversed, typeIns: pick(result.typeIns || []), fieldNames: pick(result.fieldNames || []), detailFields: pick(result.detailFields || []), extraSplits: pick(result.extraSplits || []), fieldInfo: pick(result.fieldInfo || []), rows: pick(result.rows), tags: pick(result.tags), decks: pick(result.decks), pictures: pick(result.pictures || []), occluded: pick(result.occluded || []), clozes: pick(result.clozes || []), occlusions: pick(result.occlusions || []), noteExtras: pick(result.noteExtras || []), guids: pick(result.guids || []), sounds: pick(result.sounds || []), ankiIds,
    progress: progressOf([...ankiIds, ...reversed.map(r => r?.ankiId ?? null)], result.reviews || new Map()) };
}

// The Anki decks in a result, with how many rows each has (subdecks counted in their parents too), A → Z.
export function deckList(result) {
  const counts = new Map();
  for (const d of result.decks) {
    const parts = d.split('::');
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('::');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts].filter(([name]) => name).map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Keeping Anki's subdecks: each row's deck relative to what all the rows share, as a list of names.
// ['Psych', 'Psych::Unit 1', 'Psych::Unit 1::Lecture 3'] → [[], ['Unit 1'], ['Unit 1', 'Lecture 3']]
// (the shared part, "Psych", is the deck you import into). Decks from different top-level Anki decks
// keep their whole names: ['Bio', 'Chem::Acids'] → [['Bio'], ['Chem', 'Acids']].
export function subdeckPaths(names) {
  const split = names.map(n => String(n || '').split('::').map(s => s.trim()).filter(Boolean));
  let shared = split[0]?.length || 0;
  for (const p of split) {
    let i = 0;
    while (i < shared && i < p.length && p[i] === split[0][i]) i++;
    shared = i;
  }
  return split.map(p => p.slice(shared));
}
