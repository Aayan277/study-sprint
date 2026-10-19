// Turning pasted text, files and spreadsheets into flashcards.
// Pure functions only (no page, no database), so they can be tested with: node tests/import.test.js
//
// Every parser returns the same shape:
//   { columns: ['Front', 'Back'],          names for each column (from a header row when there is one)
//     rows:    [['term', 'definition'], ...]
//     format:  { id: 'separator', label: "separated by ' - '" }   what was detected, for the "Found 42 cards ..." line
//     headerSkipped: false }

import { maskMath, MASK_CHAR } from './math.js';
import { foldText } from './match.js';
import { cleanFields } from './note-fields.js';
import { clozeCard, clozeNumbers, hasClozeLines } from './cloze.js';

// Separators, tried in groups. Within the middle group, the one that gives the shortest fronts wins,
// because fronts are usually short terms (so "Term: def - more" splits at ': ', not ' - ').
const STRONG = ['\t', ' | '];                        // almost never appear by accident: take them if they fit
const NORMAL = [' - ', ' – ', ' — ', ': ', ' = '];
const WEAK = [','];                                  // prose is full of commas, so only use commas as a last resort
const MASK_RUN = new RegExp(MASK_CHAR, 'g');
const MIN_SCORE = 0.7;                               // at least 70% of lines must split cleanly

const SEP_LABEL = { '\t': 'tabs', ',': 'commas' };
const sepLabel = sep => SEP_LABEL[sep] || `'${sep.trim()}'`;

// Words that mean "this first row is a header, not a card".
const FRONT_WORDS = new Set(['term', 'terms', 'front', 'question', 'questions', 'q', 'word', 'words', 'concept', 'concepts', 'prompt', 'keyword', 'vocab', 'vocabulary', 'side 1', 'card front']);
const BACK_WORDS = new Set(['definition', 'definitions', 'back', 'answer', 'answers', 'a', 'meaning', 'meanings', 'explanation', 'description', 'translation', 'side 2', 'card back']);

// ---------- rule 1 and 2: clean up the text ----------

// Same line endings everywhere, no invisible characters, no outer whitespace.
export function normalize(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')       // byte-order mark some programs add to the start of files
    .replace(/\r\n?/g, '\n')      // Windows (\r\n) and old Mac (\r) line endings
    .replace(/ /g, ' ')      // non-breaking spaces from web pages and Word
    .trim();
}

// Remove "1." "1)" "-" "*" "•" from the start of a line. Needs a space after it,
// so "**bold**" and "-5 degrees" are left alone.
// A bullet followed by a tab or a "|" is a front that is just that mark ("-<tab>dash"), so it stays,
// unless `bullets` says the whole paste is a bullet list ("•<tab>Term - def", from Word).
export function stripMarker(line, bullets = false) {
  return line.replace(bullets ? /^\s*(?:\d{1,3}[.)]\s+|[-*•–][ \t]+)/ : /^\s*(?:\d{1,3}[.)]\s+|[-*•–] +(?![|\t]))/, '').trim();
}

// At least 70% of the lines start with the same bullet and a tab: that bullet is list formatting, not a front.
function isBulletList(lines) {
  const used = lines.filter(l => l.trim());
  if (!used.length) return false;
  return ['-', '*', '•', '–'].some(m => used.filter(l => l.trim().startsWith(m + '\t')).length / used.length >= MIN_SCORE);
}
const cleanLines = text => {
  const raw = text.split('\n'), bullets = isBulletList(raw);
  return raw.map(l => stripMarker(l, bullets)).filter(Boolean);
};

// A spreadsheet export keeps line breaks inside "quoted cells". Cut the text into lines the way a spreadsheet would,
// so a cell with blank lines, bullets and spaces comes through whole (cleanLines would drop and strip them).
// Returns null when no cell spans lines, or when the quotes don't look like a spreadsheet's (a quote that never closes,
// or text right after a closing quote): then the text is plain lines, as before.
function quoteAwareLines(text) {
  if (!text.includes('"')) return null;
  const out = [], after = /[ ]*(?:[,\t\n]|$)/y;
  let cur = '', quoted = false, atStart = true, multi = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      cur += ch;
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') {
        quoted = false;
        after.lastIndex = i + 1;
        if (!after.test(text)) return null;
      } else if (ch === '\n') multi = true;
      continue;
    }
    if (ch === '\n') { out.push(cur); cur = ''; atStart = true; continue; }
    cur += ch;
    if (ch === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (ch === ',' || ch === '\t') atStart = true;
    else if (!/\s/.test(ch)) atStart = false;
  }
  if (quoted || !multi) return null;
  out.push(cur);
  return out;
}

// ---------- CSV / TSV ----------

// Split text into rows and fields, understanding quotes like a spreadsheet does:
//   "Paris, France",capital     → ['Paris, France', 'capital']
//   "He said ""hi""",greeting   → ['He said "hi"', 'greeting']
// A quoted field can even contain line breaks.
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.trim() === '') { quoted = true; field = ''; i++; continue; }
    if (text.startsWith(delim, i)) { row.push(field); field = ''; i += delim.length; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // A quote that never closes was probably just a quote mark in the text. Split plainly instead.
  if (quoted) return text.split('\n').map(line => line.split(delim).map(f => f.trim()));
  row.push(field); rows.push(row);
  return rows.map(r => r.map(f => f.trim())).filter(r => r.some(Boolean));
}

// ---------- rule 5: header row ----------

const headerWord = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
export function isHeaderRow(row) {
  return row.length >= 2 && FRONT_WORDS.has(headerWord(row[0])) && BACK_WORDS.has(headerWord(row[1]));
}

// Turn rows into a result, skipping a header row if there is one.
// Export writes a ' in front of cells that start with = + - @ (so Excel doesn't run them as formulas): take it off again.
const FORMULA_GUARD = /^'(?='*[=+\-@\t\r])/;
// Only the export's own header ("Front,Back,Tags...") means the guard marks are ours to remove.
const isExportHeader = names => !!names && /^front$/i.test(String(names[0] ?? '').trim()) && /^back$/i.test(String(names[1] ?? '').trim()) && /^tags$/i.test(String(names[2] ?? '').trim());

// Tags in one cell: "a b c" (what Export writes), or with commas ("cell biology, week 1": then spaces belong to a tag).
const splitTags = cell => {
  const s = String(cell ?? '');
  return [...new Set(s.split(s.includes(',') ? /\s*,\s*/ : /\s+/).map(t => t.trim().toLowerCase()).filter(Boolean))];
};

function finish(rows, format, names = null) {
  let headerSkipped = false;
  if (!names && rows.length && isHeaderRow(rows[0])) { names = rows[0]; rows = rows.slice(1); headerSkipped = true; }
  const own = isExportHeader(names);        // the export's own header: Front, Back, Tags…
  if (own) rows = rows.map(r => r.map(c => (typeof c === 'string' ? c.replace(FORMULA_GUARD, '') : c)));
  // A "Tags" column (what Export writes) holds the cards' tags; it is not a side of the card.
  let tags = null;
  const at = names ? names.findIndex(n => /^tags$/i.test(String(n ?? '').trim())) : -1;
  if (at >= 2) {
    tags = rows.map(r => splitTags(r[at]));
    rows = rows.map(r => r.filter((_, i) => i !== at));
    names = names.filter((_, i) => i !== at);
  }
  // A "Both directions" column (also what Export writes, when any card has a reverse card) says "yes" for cards that work both ways.
  // Like Tags, it is only read in a file with the export's own header.
  let both = null;
  const bothAt = names && own ? names.findIndex((n, i) => i >= 2 && /^both directions$/i.test(String(n ?? '').trim())) : -1;
  if (bothAt >= 2) {
    both = rows.map(r => /^(yes|y|true|1)$/i.test(String(r[bothAt] ?? '').trim()));
    rows = rows.map(r => r.filter((_, i) => i !== bothAt));
    names = names.filter((_, i) => i !== bothAt);
  }
  // A "Cloze note" column (the export writes one row per cloze card, with the note's {{c1::…}} text here) puts the rows of one note back
  // together as a single cloze note, with only the blanks that have a row. Like Both directions, only with the export's own header.
  // "Cloze extra" holds the note's extra line.
  let clozes = null, noteExtras = null;
  const noteAt = names && own ? names.findIndex((n, i) => i >= 2 && /^cloze note$/i.test(String(n ?? '').trim())) : -1;
  if (noteAt >= 2) {
    const extraAt = names.findIndex((n, i) => i >= 2 && /^cloze extra$/i.test(String(n ?? '').trim()));
    const texts = rows.map(r => String(r[noteAt] ?? '').trim()), extras = rows.map(r => String(r[extraAt] ?? '').trim());
    const groups = new Map();        // note text → the notes made from it so far: { key, used: numbers taken }
    clozes = rows.map((r, i) => {
      const text = texts[i];
      if (!text || !hasClozeLines(text)) return null;
      const front = String(r[0] ?? '').trim();
      const n = clozeNumbers(text).find(k => clozeCard(text, k).front.trim() === front);
      if (n === undefined) return null;                      // the front was changed in the spreadsheet: an ordinary card
      const list = groups.get(text) || groups.set(text, []).get(text);
      let g = list.find(x => !x.used.has(n));
      if (!g) { g = { key: 'csv' + i, used: new Set() }; list.push(g); }
      g.used.add(n);
      return { noteKey: g.key, n, text };
    });
    if (clozes.some(Boolean)) noteExtras = extras.map((x, i) => (clozes[i] ? x || null : null)); else clozes = null;
    const drop = new Set([noteAt, extraAt]);
    rows = rows.map(r => r.filter((_, i) => !drop.has(i)));
    names = names.filter((_, i) => !drop.has(i));
  }
  const width = Math.max(2, ...rows.map(r => r.length));
  rows = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const columns = Array.from({ length: width }, (_, i) =>
    (names && names[i]) || (width === 2 ? ['Front', 'Back'][i] : `Column ${i + 1}`));
  return { columns, rows, format, headerSkipped: headerSkipped || !!names, ...(tags ? { tags } : {}), ...(both?.some(Boolean) ? { both } : {}), ...(clozes ? { clozes, noteExtras } : {}) };
}

// ---------- rule 6: markdown / Notion tables ----------

const isTableLine = l => l.trim().startsWith('|');
const isDividerLine = l => /^\|?[\s:|-]+\|?$/.test(l.trim()) && l.includes('-');
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)                       // split on | but not on \| (an escaped pipe inside a cell)
    .map(c => c.replace(/\\\|/g, '|').trim());
}
function parseMarkdownTable(lines) {
  const tableLines = lines.filter(isTableLine);
  const hasHeader = tableLines.length > 1 && isDividerLine(tableLines[1]);
  const rows = tableLines.filter(l => !isDividerLine(l)).map(tableCells);
  if (hasHeader) return finish(rows.slice(1), { id: 'table', label: 'from a table' }, rows[0]);
  return finish(rows, { id: 'table', label: 'from a table' });
}

// ---------- rule 8: bold terms ----------

// "**Term** definition", "**Term**: definition", "**Term:** definition", "**Term** - definition"
const BOLD = /^\*\*(.+?)\*\*\s*(?:[:\-–—=|]\s*)?(.*)$/;
function boldSplit(line) {
  const m = line.match(BOLD);
  if (!m || !m[2].trim()) return null;
  return [m[1].replace(/[:\s]+$/, '').trim(), m[2].trim()];
}

// ---------- rule 3 and 4: separators ----------

// Split one line at the first place the separator appears.
function splitFirst(line, sep) {
  const at = maskMath(line).indexOf(sep);          // a separator inside a formula ($a - b$) doesn't count
  if (at <= 0) return null;
  const front = line.slice(0, at).trim(), back = line.slice(at + sep.length).trim();
  return front && back ? [front, back] : null;
}

// Commas inside a formula ("Point, $f(a,b)$") don't separate fields: parse the text with the formulas masked (same
// length), then put the original characters back at the masked places, in order.
function parseCommaRows(text) {
  const masked = maskMath(text);
  if (masked === text || text.includes(MASK_CHAR)) return parseDelimited(text, ',');
  const pieces = [];
  for (let i = 0; i < text.length; i++) if (masked[i] === MASK_CHAR) pieces.push(text[i]);
  let at = 0;
  return parseDelimited(masked, ',').map(r => r.map(f => (f.includes(MASK_CHAR) ? f.replace(MASK_RUN, () => pieces[at++]) : f)));
}

// Tabs and commas go through the quote-aware parser. If every row has the same number of columns
// it's a real spreadsheet export, so the columns are kept. Otherwise everything after the first
// field is the back (so a definition can contain commas).
function delimitedRows(lines, sep) {
  const rows = sep === ',' ? parseCommaRows(lines.join('\n')) : parseDelimited(lines.join('\n'), sep);
  const same = rows.length > 0 && rows.every(r => r.length === rows[0].length);
  if (same) return rows;
  const joiner = sep === ',' ? ', ' : ' ';
  return rows.map(r => [r[0], r.slice(1).filter(Boolean).join(joiner)]);
}

// Try one separator: the rows it would give, and how well it fits (0 to 1).
function trySeparator(lines, sep) {
  let rows;
  if (sep === '\t' || sep === ',') rows = delimitedRows(lines, sep);
  else rows = lines.map(l => splitFirst(l, sep) || [l, '']);
  const good = rows.filter(r => r[0] && r.slice(1).some(Boolean));
  const avgFront = good.reduce((n, r) => n + r[0].length, 0) / (good.length || 1);
  return { sep, rows, score: rows.length ? good.length / rows.length : 0, avgFront };
}

function bestSeparator(lines) {
  for (const sep of STRONG) {
    const t = trySeparator(lines, sep);
    if (t.score >= MIN_SCORE) return t;
  }
  const normal = NORMAL.map(sep => trySeparator(lines, sep)).filter(t => t.score >= MIN_SCORE);
  if (normal.length) {
    const top = Math.max(...normal.map(t => t.score));
    // Among separators that fit about as well as the best one, pick the one with the shortest fronts.
    return normal.filter(t => t.score >= top - 0.1).sort((a, b) => a.avgFront - b.avgFront)[0];
  }
  for (const sep of WEAK) {
    const t = trySeparator(lines, sep);
    if (t.score >= MIN_SCORE) return t;
  }
  return null;
}

// ---------- rule 7: blocks and alternating lines ----------

function tryBlocks(text) {
  const blocks = text.split(/\n[ \t]*\n+/).map(cleanLines).filter(b => b.length);
  if (blocks.length < 2) return null;
  const multi = blocks.filter(b => b.length >= 2).length;
  if (multi / blocks.length < MIN_SCORE) return null;
  return blocks.map(b => [b[0], b.slice(1).join('\n')]);
}

// ---------- labelled pairs: "Q: ..." then "A: ..." ----------

// Notes written as Q:/A: (or Question:/Answer:, Ans:, Front:/Back:, any case) pairs. A label ends with a colon, so "Q - x" is left to the
// separator rules. A card runs from its Q: line to its A: line and on to the next Q: line, so an answer can take several lines.
// Up to 2 lines before the first Q: ("Quiz 1", "Here are your flashcards:") are skipped.
// The separator rules win (null) when this only looks like labelled pairs: answers that run on into lines like "Side: lateral"
// (a list of "Word: text" lines, two of which happen to be called Front and Back; one pair, or as many such lines as pairs), or fewer than 2 pairs among lines that mostly split on ": ".
const LABEL_Q = /^\s*(?:[-*•–]\s+)?(?:q(?:uestion)?\s*\d{0,3}|front)\s*[:：]\s*(.*)$/i;
const LABEL_A = /^\s*(?:[-*•–]\s+)?(?:a(?:ns(?:wer)?)?\s*\d{0,3}|back)\s*[:：]\s*(.*)$/i;
const WORD_TEXT = /^\s*(?:[-*•–]\s+)?\p{L}[\p{L}\p{N}'’ -]{0,30}[:：]\s+\S/u;
const LEADING_MAX = 2;
function tryLabelled(text) {
  const rows = [], others = [];
  let cur = null, part = 0, leading = 0, lines = 0, runOn = 0;       // part: 0 = in the question, 1 = in the answer
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    const q = LABEL_Q.exec(line), a = LABEL_A.exec(line);
    if (q) {
      if (cur && !cur[1].trim()) return null;     // a question that never got an answer: not this format
      cur = [q[1].trim(), '']; part = 0; rows.push(cur);
    } else if (a && cur && part === 0) { cur[1] = a[1].trim(); part = 1; }
    else if (!cur) { if (++leading > LEADING_MAX) return null; }      // a title line before the first Q: (more than 2: not this format)
    else {
      if (part === 1 && WORD_TEXT.test(line)) runOn++;      // the answer runs on into a "Word: text" line (a list of terms?)
      if (splitFirst(line, ': ')) others.push(line);
      cur[part] = cur[part] ? cur[part] + '\n' + line : line;      // more lines of the same side
    }
  }
  if (!rows.length || rows.some(r => !r[0].trim() || !r[1].trim())) return null;
  if (runOn && (rows.length < 2 || runOn >= rows.length)) return null;      // a few notes inside answers are fine; a list of terms is not
  if (rows.length < 2 && others.length && (rows.length * 2 + others.length) / (lines - leading) >= MIN_SCORE) return null;
  return rows;
}

// ---------- the main entry point ----------

// Work out the format of pasted text and turn it into rows.
export function parseText(text) {
  text = normalize(text);
  const empty = { columns: ['Front', 'Back'], rows: [], format: { id: 'empty', label: '' }, headerSkipped: false };
  if (!text) return empty;
  // "Q: ..." / "A: ..." pairs come first: their colons are labels, not the separator between a term and its definition.
  const labelled = tryLabelled(text);
  if (labelled) return finish(labelled, { id: 'labelled', label: 'as Q: / A: pairs' });
  // Lines the way a spreadsheet reads them (a quoted cell can hold line breaks); plain lines otherwise.
  const records = quoteAwareLines(text);
  const rawLines = (records || text.split('\n')).filter(l => l.trim());
  const lines = records ? records.map(r => (r.includes('\n') ? r : stripMarker(r))).filter(r => r.trim()) : cleanLines(text);

  // Rule 6: a markdown or Notion table.
  if (rawLines.filter(isTableLine).length / rawLines.length >= MIN_SCORE) return parseMarkdownTable(rawLines);

  // A spreadsheet export (a header row of Front, Back... or cells spanning lines): its commas or tabs are the columns,
  // even when the cells have ": " or " - " in them.
  for (const sep of ['\t', ',']) {
    const t = trySeparator(lines, sep);
    if (t.score >= MIN_SCORE && (records || isHeaderRow(t.rows[0] || []))) {
      return finish(t.rows, { id: 'separator', sep, label: `separated by ${sepLabel(sep)}` });
    }
  }

  // Rule 8: bold terms.
  const bold = lines.map(boldSplit);
  if (bold.filter(Boolean).length / lines.length >= MIN_SCORE) {
    return finish(lines.map((l, i) => bold[i] || [l.replace(/\*\*/g, ''), '']), { id: 'bold', label: 'with bold terms' });
  }

  // Rules 3, 4 and 9 (Quizlet exports are tab-separated).
  const best = bestSeparator(lines);
  if (best) return finish(best.rows, { id: 'separator', sep: best.sep, label: `separated by ${sepLabel(best.sep)}` });

  // Rule 7: blocks separated by blank lines, then alternating lines.
  const blocks = tryBlocks(text);
  if (blocks) return finish(blocks, { id: 'blocks', label: 'in blocks separated by blank lines' });
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const rows = [];
    for (let i = 0; i < lines.length; i += 2) rows.push([lines[i], lines[i + 1]]);
    return finish(rows, { id: 'alternating', label: 'on alternating lines (term, then definition)' });
  }

  // Nothing fit. Show each line as a front so it can be fixed by hand in the preview.
  return finish(lines.map(l => [l, '']), { id: 'none', label: "but couldn't spot a pattern. Add the backs below, or try one card per line like: term - definition" });
}

// Text that is already in blocks (the text of a PDF or slides: a heading line, then its text, a blank line between pages):
// read it as blocks without trying the separators first, since a lecture's lines are full of " - " and ": ".
export function parseBlocks(text) {
  const clean = normalize(text);
  let blocks = tryBlocks(clean);
  // One page or slide on its own is one block: its heading is the front, the rest the back.
  if (!blocks) { const one = cleanLines(clean); if (!/\n[ \t]*\n/.test(clean) && one.length >= 2 && /^(Page|Slide) \d+/.test(one[0])) blocks = [[one[0], one.slice(1).join('\n')]]; }
  return blocks ? finish(blocks, { id: 'blocks', label: 'in blocks separated by blank lines' }) : parseText(text);
}

// Rows that came straight from a spreadsheet (.xlsx). Cells can be numbers or dates, so make them text.
export function parseRows(rows) {
  const clean = rows
    .map(r => (r || []).map(c => (c == null ? '' : String(c).trim())))
    .filter(r => r.some(Boolean));
  // Drop columns that are empty in every row.
  const width = Math.max(0, ...clean.map(r => r.length));
  const used = Array.from({ length: width }, (_, i) => clean.some(r => r[i]));
  const trimmed = clean.map(r => r.filter((_, i) => used[i]));
  return finish(trimmed, { id: 'spreadsheet', label: 'from the spreadsheet' });
}

// ---------- after parsing ----------

// Pick which columns are the front and back.
//   keepFields  true keeps an Anki note's other fields as folded sections with their names (noteFields, item A); false joins a cloze
//               note's other fields into its one extra block, and leaves a basic note's other columns out
export function buildCards(result, frontCol = 0, backCol = 1, { keepFields = true } = {}) {
  // tags, ankiId, ankiGuid, ankiDeck, cloze and pictures: only Anki imports have them, one per row (ankiId links a row to its Anki
  // review history; ankiDeck is the Anki deck it came from, for keeping subdecks).
  return result.rows.map((r, i) => ({
    // A cloze note's card always has its front and back in the first two columns, whichever columns were picked.
    front: (result.clozes?.[i] ? r[0] : r[frontCol]) ?? '', back: (result.clozes?.[i] ? r[1] : r[backCol]) ?? '',
    ...(result.tags ? { tags: result.tags[i] } : {}),
    ...(result.ankiIds?.[i] ? { ankiId: result.ankiIds[i] } : {}),
    ...(result.decks?.[i] ? { ankiDeck: result.decks[i] } : {}),
    ...(result.pictures?.[i] && (result.pictures[i].front || result.pictures[i].back) ? { pictures: result.pictures[i] } : {}),
    ...(result.sounds?.[i] && (result.sounds[i].front.length || result.sounds[i].back.length) ? { sounds: { front: result.sounds[i].front, back: result.sounds[i].back } } : {}),     // sound file names on each side (Anki imports; see anki.js)
    ...(result.occluded?.[i] ? { occluded: true } : {}),       // image-occlusion notes (see anki.js)
    ...(result.clozes?.[i] ? { cloze: result.clozes[i] } : {}),         // a cloze note's card: { noteKey, n, text }
    ...(result.occlusions?.[i] ? { occlusion: result.occlusions[i] } : {}),     // an image-occlusion note's card: { noteKey, n, header, shapes, pixels, image }
    ...extrasOf(result, i, frontCol, backCol, keepFields),
    ...(result.guids?.[i] ? { ankiGuid: result.guids[i] } : {}),
    ...(result.typeIns?.[i] ? { typeIn: true } : {}),          // the Anki card asks for the answer to be typed (anki.js typedOrds); other cards follow their deck
    // A basic note that has a reverse card too (Anki "Basic (and reversed card)", or "yes" in the CSV's Both directions column).
    ...(!result.clozes?.[i] && !result.occlusions?.[i] && (result.reversed?.[i] || result.both?.[i]) ? { reversed: result.reversed?.[i] || {} } : {})
  }));
}

// A row's note extra and note fields. A cloze note's extras are the main extra (the Back Extra field) and the other fields; a basic
// note's other fields are the columns that are not the front or back, plus its <details> sections.
function extrasOf(result, i, frontCol, backCol, keep) {
  const split = result.extraSplits?.[i];
  if (result.clozes?.[i]) {
    if (keep && split) return { ...(split.extra ? { noteExtra: split.extra } : {}), noteFields: split.fields };
    return result.noteExtras?.[i] ? { noteExtra: result.noteExtras[i] } : {};
  }
  const out = result.noteExtras?.[i] ? { noteExtra: result.noteExtras[i] } : {};
  if (!keep) return out;
  const names = result.fieldNames?.[i];
  const fields = keptFields(result, i, frontCol, backCol);
  return fields.length ? { ...out, noteFields: fields } : out;
}
// The fields a basic note keeps, cleaned to the limits (note-fields.js), so what is saved always passes a backup check.
function rawFields(result, i, frontCol, backCol) {
  const names = result.fieldNames?.[i];
  const fields = [];
  if (names) result.rows[i].forEach((text, c) => {
    if (c === frontCol || c === backCol || names[c] === null || names[c] === undefined || !String(text).trim()) return;
    fields.push({ name: names[c], text: String(text).trim() });
  });
  fields.push(...(result.detailFields?.[i] || []));
  return fields;
}
const keptFields = (result, i, frontCol, backCol) => cleanFields(rawFields(result, i, frontCol, backCol)).fields;
// How many of a basic note's fields were shortened or dropped for the length limits with these columns (what fieldReport can't
// know, because the columns are chosen in the preview). Cloze notes are counted in anki.js.
export const basicFieldsCut = (result, frontCol = 0, backCol = 1) =>
  result.rows.reduce((n, _, i) => (result.clozes?.[i] || result.occlusions?.[i] ? n : n + cleanFields(rawFields(result, i, frontCol, backCol)).cut), 0);

// How many of the rows have fields to keep (the "Keep the other fields" switch shows when there are any).
export const hasKeptFields = (result, frontCol = 0, backCol = 1) =>
  buildCards(result, frontCol, backCol, { keepFields: true }).some(c => c.noteFields?.length);

// A card only counts if both sides have something on them.
// (A side can also be just a picture or a sound: Anki imports bring those along. An image-occlusion card's back is its
// label, which can be empty.)
export const isComplete = c => !!c.occlusion || !!((c.front.trim() || c.pictures?.front || c.sounds?.front?.length) && (c.back.trim() || c.pictures?.back || c.sounds?.back?.length));

// Two fronts that differ only in capitals, spaces or punctuation count as the same.
// Folded like a typed answer (match.js foldText): Latin accents off, but か ≠ が and कि ≠ की; a text of only
// symbols ("+", "🧠") keeps them.
export function dupKey(s) {
  return foldText(s);
}

// For each card: 'deck' if the deck already has that front, 'import' if it appeared earlier in
// this same import, or null if it's new. Image-occlusion cards are left out: without a heading they all
// have the front "Diagram", and what tells them apart is the picture (and the box).
export function findDuplicates(cards, existingFronts = []) {
  const inDeck = new Set(existingFronts.map(dupKey));
  const seen = new Set();
  return cards.map(c => {
    const k = dupKey(c.front);
    if (!k || c.occluded || c.occlusion) return null;
    if (inDeck.has(k)) return 'deck';
    if (seen.has(k)) return 'import';
    seen.add(k);
    return null;
  });
}

// ---------- Google Sheets ----------

// Turn a Google Sheets link into a link that downloads that tab as CSV.
// Works for "Publish to web" links and for normal links shared as "Anyone with the link".
export function sheetsCsvUrl(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch (e) { return null; }
  if (url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/spreadsheets/')) return null;
  const gid = url.searchParams.get('gid') || (url.hash.match(/gid=(\d+)/) || [])[1];

  // Published to the web: /spreadsheets/d/e/LONG-ID/pub...
  const pub = url.pathname.match(/^\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) {
    const out = new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub`);
    out.searchParams.set('output', 'csv');
    if (gid) out.searchParams.set('gid', gid);
    return out.href;
  }
  // Normal link: /spreadsheets/d/ID/edit...
  const id = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
  if (!id) return null;
  const out = new URL(`https://docs.google.com/spreadsheets/d/${id[1]}/gviz/tq`);
  out.searchParams.set('tqx', 'out:csv');
  if (gid) out.searchParams.set('gid', gid);
  return out.href;
}

// ---------- the "Make cards with Claude" prompt ----------

export const CLAUDE_PROMPT = `Turn the study material below into flashcards for an exam.
Output ONLY lines in this exact format, one card per line, no header, no numbering:
front | back
Keep the front short: a term, concept, or specific question.
Keep the back under 25 words.
Cover the definitions, distinctions, examples and facts a professor would most likely test. Skip trivia.

Material:
`;

export const claudePrompt = material => CLAUDE_PROMPT + normalize(material);
