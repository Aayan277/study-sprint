// Turning pasted text, files and spreadsheets into flashcards.
// Pure functions only (no page, no database), so they can be tested with: node tests/import.test.js
//
// Every parser returns the same shape:
//   { columns: ['Front', 'Back'],          names for each column (from a header row when there is one)
//     rows:    [['term', 'definition'], ...]
//     format:  { id: 'separator', label: "separated by ' - '" }   what was detected, for the "Found 42 cards ..." line
//     headerSkipped: false }

// Separators, tried in groups. Within the middle group, the one that gives the shortest fronts wins,
// because fronts are usually short terms (so "Term: def - more" splits at ': ', not ' - ').
const STRONG = ['\t', ' | '];                        // almost never appear by accident: take them if they fit
const NORMAL = [' - ', ' – ', ' — ', ': ', ' = '];
const WEAK = [','];                                  // prose is full of commas, so only use commas as a last resort
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
export function stripMarker(line) {
  return line.replace(/^\s*(?:\d{1,3}[.)]|[-*•–])\s+/, '').trim();
}

const cleanLines = text => text.split('\n').map(stripMarker).filter(Boolean);

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
function finish(rows, format, names = null) {
  let headerSkipped = false;
  if (!names && rows.length && isHeaderRow(rows[0])) { names = rows[0]; rows = rows.slice(1); headerSkipped = true; }
  const width = Math.max(2, ...rows.map(r => r.length));
  rows = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const columns = Array.from({ length: width }, (_, i) =>
    (names && names[i]) || (width === 2 ? ['Front', 'Back'][i] : `Column ${i + 1}`));
  return { columns, rows, format, headerSkipped: headerSkipped || !!names };
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
  const at = line.indexOf(sep);
  if (at <= 0) return null;
  const front = line.slice(0, at).trim(), back = line.slice(at + sep.length).trim();
  return front && back ? [front, back] : null;
}

// Tabs and commas go through the quote-aware parser. If every row has the same number of columns
// it's a real spreadsheet export, so the columns are kept. Otherwise everything after the first
// field is the back (so a definition can contain commas).
function delimitedRows(lines, sep) {
  const rows = parseDelimited(lines.join('\n'), sep);
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

// ---------- the main entry point ----------

// Work out the format of pasted text and turn it into rows.
export function parseText(text) {
  text = normalize(text);
  const empty = { columns: ['Front', 'Back'], rows: [], format: { id: 'empty', label: '' }, headerSkipped: false };
  if (!text) return empty;
  const rawLines = text.split('\n').filter(l => l.trim());
  const lines = cleanLines(text);

  // Rule 6: a markdown or Notion table.
  if (rawLines.filter(isTableLine).length / rawLines.length >= MIN_SCORE) return parseMarkdownTable(rawLines);

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
export function buildCards(result, frontCol = 0, backCol = 1) {
  return result.rows.map(r => ({ front: r[frontCol] ?? '', back: r[backCol] ?? '' }));
}

// A card only counts if both sides have something on them.
export const isComplete = c => !!(c.front.trim() && c.back.trim());

// Two fronts that differ only in capitals, spaces or punctuation count as the same.
export function dupKey(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// For each card: 'deck' if the deck already has that front, 'import' if it appeared earlier in
// this same import, or null if it's new.
export function findDuplicates(cards, existingFronts = []) {
  const inDeck = new Set(existingFronts.map(dupKey));
  const seen = new Set();
  return cards.map(c => {
    const k = dupKey(c.front);
    if (!k) return null;
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
