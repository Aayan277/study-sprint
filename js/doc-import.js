// Reading PDFs and PowerPoint files for the Import screen. Both come out as "pages": [{ label, text, notes }], one per PDF page or slide.
// The pure parts (slide XML → text, chunking, prompt building) are tested in tests/doc-import.test.js; the readers load a
// library from the CDN only when someone picks a file, like Excel and Anki files do (import-screen.js).
//   PDF   pdf.js reads the text layer of each page. A scanned PDF has none: we say so, there is no OCR.
//   PPTX  a zip file: fflate (also used for Anki files) opens it and the text runs (a:t) are read from each slide.

export const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
// The legacy build also runs on older phones (it brings its own fixes for newer browser features).
export const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs';
export const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs';
export const CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/';
export const PDFJS_WORKER_INTEGRITY = 'sha384-vbNBYP03jHFPlgtK4qSXtazEmGfmpTWlSsfq9OiU20MroW/Q9TbaEXiM7PpeWg+6';

export const MAX_PAGES = 300;
export const MAX_BYTES = 50 * 1024 * 1024;
export const PART_CHARS = 12000;                 // about how much of the material goes into one AI prompt
const MAX_SLIDE_BYTES = 20 * 1024 * 1024;        // one slide (or notes) file unpacking to more than this, or all of them to more than the next one,
const MAX_UNPACKED = 100 * 1024 * 1024;          // makes the .pptx refused (a "zip bomb": a small file that unpacks huge)

export const NO_TEXT_MESSAGE = "This PDF has no text in it (it's probably scanned). Try a PDF with selectable text.";
export const tooBigMessage = (what = 'file') => `That ${what} is over 50 MB. Try a smaller one, or a few pages of it.`;
export const tooManyMessage = (n, what) => `That ${what} has ${n.toLocaleString('en')} ${what === 'PDF' ? 'pages' : 'slides'}. The limit is ${MAX_PAGES}. Split it into smaller files.`;

// ---------- PowerPoint (.pptx) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlText = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(code); } catch { return ''; }
});

// Attributes of one XML tag as an object: <a b="1" c='2'/> → { b: '1', c: '2' }
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], m[2] ?? m[3]]));

// The slide files in the order the presentation shows them: presentation.xml lists the slides by relationship id, and its
// .rels file says which file each id is. ["ppt/slides/slide1.xml", …]
export function slideOrder(presXml, relsXml) {
  const targets = new Map();
  for (const m of openTags(String(relsXml), 'Relationship')) {
    const a = attrs(m);
    if (a.Id && a.Target) targets.set(a.Id, a.Target);
  }
  const out = [];
  for (const m of openTags(String(presXml), 'p:sldId')) {
    const t = targets.get(attrs(m)['r:id']);
    if (t) out.push(resolvePath('ppt/', t));
  }
  return out;
}

// "slides/slide1.xml" from ppt/ → "ppt/slides/slide1.xml"; "../notesSlides/n.xml" from ppt/slides/ → "ppt/notesSlides/n.xml"; "/ppt/x.xml" → "ppt/x.xml"
export function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').filter(Boolean);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

// Linear-time stand-ins for regexes that went quadratic on a hostile file (50 KB of unclosed tags took 300 ms to 700 ms).
const isWord = c => c !== undefined && /\w/.test(c);
// Same as .replace(/[ \t]+\n/g, '\n')
const trimLineEnds = s => {
  let out = '', from = 0, nl;
  while ((nl = s.indexOf('\n', from)) >= 0) {
    let e = nl;
    while (e > from && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
    out += s.slice(from, e) + '\n';
    from = nl + 1;
  }
  return out + s.slice(from);
};
// Same matches as /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g: [{ br: true }] for a line break, [{ text }] for the inside of a <a:t>
function textRuns(s) {
  const out = [];
  let gt = -1, close = -1, noGt = false, noClose = false, i = 0;
  while (!noGt && (i = s.indexOf('<a:', i)) >= 0) {
    const isT = s.startsWith('<a:t', i) && !isWord(s[i + 4]), isBr = s.startsWith('<a:br', i) && !isWord(s[i + 5]);
    if (!isT && !isBr) { i++; continue; }
    if (gt < i) { gt = s.indexOf('>', i); if (gt < 0) { noGt = true; break; } }
    if (isT && !noClose) {
      if (close <= gt) { close = s.indexOf('</a:t>', gt + 1); if (close < 0) noClose = true; }
      if (!noClose) { out.push({ text: s.slice(gt + 1, close) }); i = close + 6; continue; }
    }
    if (isBr) { out.push({ br: true }); i = gt + 1; continue; }
    i++;
  }
  return out;
}
// The [start, end) ranges of the <p:sp>...</p:sp> boxes; same as /<p:sp\b[\s\S]*?<\/p:sp>/g
function spRanges(s) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf('<p:sp', i)) >= 0) {
    if (isWord(s[i + 5])) { i++; continue; }
    const close = s.indexOf('</p:sp>', i + 5);
    if (close < 0) break;
    out.push([i, close + 7]);
    i = close + 7;
  }
  return out;
}

// Same matches as /<NAME\b[^>]*>/g, as strings
function openTags(s, name) {
  const out = [];
  let i = 0, gt = -1;
  while ((i = s.indexOf('<' + name, i)) >= 0) {
    if (isWord(s[i + name.length + 1])) { i++; continue; }
    if (gt < i) { gt = s.indexOf('>', i); if (gt < 0) break; }
    out.push(s.slice(i, gt + 1));
    i = gt + 1;
  }
  return out;
}
// Same as xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g), keeping only the inside of each paragraph
function paragraphs(s) {
  const out = [];
  let i = 0, gt = -1;
  while ((i = s.indexOf('<a:p', i)) >= 0) {
    if (isWord(s[i + 4])) { i++; continue; }
    if (gt < i) { gt = s.indexOf('>', i); if (gt < 0) break; }
    const close = s.indexOf('</a:p>', gt + 1);
    if (close < 0) break;
    out.push(s.slice(gt + 1, close));
    i = close + 6;
  }
  return out;
}
const textOfParagraphs = (xml, marks = false) => {
  const lines = [];
  for (const inner of paragraphs(xml)) {
    let line = '';
    for (const t of textRuns(inner)) line += t.br ? '\n' : xmlText(t.text);
    line = trimLineEnds(line).trim();
    if (!line) continue;
    lines.push(marks ? markParagraph(inner, line) : line);
  }
  return lines;
};
// A paragraph with its bold runs marked: "the **bold** words", or "## the whole paragraph" when all of it is bold (that is a heading).
// Used by "Suggest cards", which takes **bold** as a key term and ## as a heading (js/reading-cards.js).
function markParagraph(inner, plain) {
  const parts = [];
  for (const r of inner.matchAll(/<a:(r|fld)\b[^>]*>([\s\S]*?)<\/a:\1>|<a:br\b[^>]*\/?>/g)) {
    if (r[0].startsWith('<a:br')) { parts.push({ text: '\n', bold: false }); continue; }
    const text = [...r[2].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(t => xmlText(t[1])).join('');
    if (text) parts.push({ text, bold: /<a:rPr\b[^>]*\sb="(?:1|true)"/.test(r[2]) });
  }
  const words = parts.filter(x => x.text.trim());
  if (!words.length) return plain;
  if (words.every(x => x.bold)) return '## ' + plain.replace(/\n+/g, ' ');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const x = parts[i];
    if (!x.bold || !x.text.trim()) { out += x.text; continue; }
    let text = x.text;
    while (parts[i + 1] && (parts[i + 1].bold || !parts[i + 1].text.trim()) && parts.slice(i + 1).some(y => y.bold && y.text.trim())) { i++; text += parts[i].text; }
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    out += lead + '**' + text.trim() + '**' + trail;
  }
  return trimLineEnds(out).trim();
}
// The text boxes (<p:sp>) of a slide. Slide numbers, dates and footers are page furniture, not content.
const shapes = xml => spRanges(xml).map(([a, b]) => xml.slice(a, b));
const placeholder = sp => { const m = sp.match(/<p:ph\b[^>]*>/); return m ? attrs(m[0]).type || 'body' : null; };

// The text of one slide, one paragraph per line, in the order it is in the file (which is the reading order PowerPoint saves).
// With marks: true, bold runs are written **like this** and a paragraph that is all bold as "## heading".
export function slideLines(xml, { marks = false } = {}) {
  xml = String(xml);
  const lines = [];
  // Anything outside a <p:sp> (tables in graphic frames) is read too, after the plain text boxes.
  let rest = '', at = 0;
  for (const [a, b] of spRanges(xml)) { rest += xml.slice(at, a); at = b; }
  rest += xml.slice(at);
  for (const sp of shapes(xml)) {
    const ph = placeholder(sp);
    if (ph === 'sldNum' || ph === 'ftr' || ph === 'dt' || ph === 'hdr') continue;
    lines.push(...textOfParagraphs(sp, marks));
  }
  lines.push(...textOfParagraphs(rest, marks));
  return lines;
}
export const slideText = xml => slideLines(xml).join('\n');

// The speaker notes of a notes page: only the notes box, not the slide picture or the page number.
export function notesText(xml) {
  return shapes(String(xml)).filter(sp => placeholder(sp) === 'body').flatMap(textOfParagraphs).join('\n');
}

// The notes file a slide points to, from its .rels file ("../notesSlides/notesSlide1.xml" → "ppt/notesSlides/notesSlide1.xml").
export function notesTarget(slidePath, relsXml) {
  for (const m of openTags(String(relsXml || ''), 'Relationship')) {
    const a = attrs(m);
    if (/\/notesSlide$/.test(a.Type || '') && a.Target) return resolvePath(slidePath.replace(/[^/]*$/, ''), a.Target);
  }
  return null;
}

// Read a .pptx. `files` is { path: Uint8Array } from fflate (only the slide parts are needed; see readPptx).
// → [{ label: 'Slide 3: Title', text, notes }]
export function pptxPages(files) {
  const read = path => (files[path] ? new TextDecoder().decode(files[path]) : null);
  let order = [];
  const pres = read('ppt/presentation.xml'), rels = read('ppt/_rels/presentation.xml.rels');
  if (pres && rels) order = slideOrder(pres, rels).filter(p => files[p]);
  if (!order.length) {                                                                    // no usable list: slide1, slide2…
    order = Object.keys(files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  }
  return order.map((path, i) => {
    const xml = read(path);
    const lines = slideLines(xml), marked = slideLines(xml, { marks: true });
    const noteFile = notesTarget(path, read(path.replace(/([^/]*)$/, '_rels/$1.rels')));
    const notes = noteFile && files[noteFile] ? notesText(read(noteFile)) : '';
    // The first line of a slide is almost always its title: it goes in the label, so the card's front says what the slide is about.
    const title = lines.length > 1 && lines[0].length <= 80 && !/\n/.test(lines[0]) ? lines[0] : '';
    // (`md` is the same text with the bold and heading marks that "Suggest cards" reads; the title is in the label, so it is not in it)
    return { label: `Slide ${i + 1}${title ? ': ' + title : ''}`, text: (title ? lines.slice(1) : lines).join('\n'), md: (title ? marked.slice(1) : marked).join('\n'), notes };
  });
}

// Open a .pptx from its bytes. `unzipSync` is fflate's (passed in so the tests don't need the CDN).
export function readPptx(bytes, unzipSync) {
  let unpacked = 0;
  const files = unzipSync(bytes, {
    filter: f => {
      if (!/^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml)$/.test(f.name)) return false;
      unpacked += f.originalSize;
      if (f.originalSize > MAX_SLIDE_BYTES || unpacked > MAX_UNPACKED) throw new Error('too-big');
      return true;
    }
  });
  return pptxPages(files);
}

// ---------- PDF ----------

// The text of one PDF page from pdf.js's text items: lines end where pdf.js says (hasEOL); spaces are already items.
export function pdfPageText(items) {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str + (it.hasEOL ? '\n' : '');
  }
  return tidy(s);
}

// The lines of one PDF page with the size of their letters: [{ text, size }]. A line ends where pdf.js says (hasEOL); its size is the
// largest letter height on it (item.height, or the scale in item.transform when pdf.js gives no height).
export function pdfPageLines(items) {
  const lines = [];
  let text = '', size = 0;
  const end = () => { const t = text.replace(/[ \t\u00a0]+/g, ' ').trim(); if (t) lines.push({ text: t, size }); text = ''; size = 0; };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    if (it.str.trim()) size = Math.max(size, Number(it.height) || Math.abs(Number(it.transform?.[3])) || 0);
    text += it.str;
    if (it.hasEOL) end();
  }
  end();
  return lines;
}
// A line is a heading when its letters are 1.2 times the page's usual size or more, it is 12 words or fewer and 80 characters or fewer,
// and it does not end in a full stop. (No letter sizes: no headings; the cards are found all the same.)
export function pdfHeadings(lines) {
  const sizes = lines.map(l => l.size).filter(x => x > 0).sort((a, b) => a - b);
  if (!sizes.length) return lines.map(() => false);
  const median = sizes[Math.floor(sizes.length / 2)];
  return lines.map(l => l.size >= median * 1.2 && l.text.split(/\s+/).length <= 12 && l.text.length <= 80 && !/\.$/.test(l.text));
}
// The page's text with its headings marked "## " (what "Suggest cards" reads).
export function pdfPageMarkdown(items) {
  const lines = pdfPageLines(items), heads = pdfHeadings(lines);
  return tidy(lines.map((l, i) => (heads[i] ? '## ' : '') + l.text).join('\n'));
}

// Trim each line, drop blank ones and a hyphen at a line end that split a word ("meta-\nbolism" → "metabolism").
export function tidy(text) {
  return String(text).replace(/\r/g, '').replace(/([a-z])-\n([a-z])/g, '$1$2').split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

let pdfjsLoading = null;
// pdf.js and its worker. The worker file comes from another site, and a page may not start such a worker directly, so it is
// fetched (the browser checks its fingerprint) and started from a blob.
export function loadPdfjs() {
  if (pdfjsLoading) return pdfjsLoading;
  pdfjsLoading = (async () => {
    const lib = await import(/* @vite-ignore */ PDFJS_URL);        // (the import map in index.html checks this file's fingerprint)
    const res = await fetch(PDFJS_WORKER_URL, { integrity: PDFJS_WORKER_INTEGRITY });
    if (!res.ok) throw new Error('worker ' + res.status);
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'text/javascript' }));
    return lib;
  })().catch(err => { pdfjsLoading = null; throw err; });
  return pdfjsLoading;
}

const pause = () => new Promise(r => setTimeout(r, 0));

// Read every page's text. onProgress(done, total) is called as pages finish; the screen stays usable in between.
// Throws Error('too-many:N') over the page limit.
export async function readPdf(bytes, onProgress = () => {}, lib, signal) {
  const aborted = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
  if (signal?.aborted) throw aborted();
  lib = lib || await loadPdfjs();
  if (signal?.aborted) throw aborted();
  // cMaps are what lets pdf.js read the text of Japanese and Chinese PDFs (fetched only when a PDF needs them).
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0, disableFontFace: true, cMapUrl: CMAP_URL, cMapPacked: true }).promise;
  try {
    const total = doc.numPages;
    if (total > MAX_PAGES) throw new Error('too-many:' + total);
    const pages = [];
    for (let n = 1; n <= total; n++) {
      if (signal?.aborted) throw aborted();
      const page = await doc.getPage(n);
      try {
        const items = (await page.getTextContent()).items;
        pages.push({ label: `Page ${n}`, text: pdfPageText(items), md: pdfPageMarkdown(items), notes: '' });
      } finally { page.cleanup(); }
      onProgress(n, total);
      if (n % 5 === 0) await pause();
    }
    return pages;
  } finally { doc.destroy(); }
}

// ---------- from pages to text ----------

// One page as a block of text: the label first, then the page's lines (no blank lines, so it stays one block).
export function pageBlock(p, withNotes = true) {
  const body = [p.text, withNotes && p.notes ? 'Notes: ' + p.notes.replace(/\n+/g, ' ') : ''].filter(Boolean).join('\n');
  return body ? p.label + '\n' + body : '';
}

// All the pages, blocks separated by a blank line. The Import screen reads this as "first line of each block is the front".
export const pagesToText = (pages, withNotes = true) => pages.map(p => pageBlock(p, withNotes)).filter(Boolean).join('\n\n');

// The same with the headings and bold terms marked, for "Suggest cards" (a page without marks gives its plain text).
export const pagesToMarkdown = (pages, withNotes = true) => pages.map(p => pageBlock({ ...p, text: p.md ?? p.text }, withNotes)).filter(Boolean).join('\n\n');

// Pasted text as "pages" for the AI parts view: one per paragraph (blocks separated by blank lines) → [{ label: 'Paragraph 3', text, notes: '' }]
export const textPages = text => String(text ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(t => t.trim()).filter(Boolean).map((t, i) => ({ label: `Paragraph ${i + 1}`, text: t, notes: '' }));

export const charCount = (pages, withNotes = true) => pages.reduce((n, p) => n + pageBlock(p, withNotes).length, 0);
export const hasText = pages => pages.some(p => p.text.trim() || p.notes.trim());

// Cut a long block at a line end (or a sentence end, or a space) near `max`.
function cutBlock(block, max) {
  const out = [];
  while (block.length > max) {
    let at = block.lastIndexOf('\n', max);
    if (at < max * 0.5) at = block.lastIndexOf('. ', max) + 1;
    if (at < max * 0.5) at = block.lastIndexOf(' ', max);
    if (at < max * 0.5) at = max;
    out.push(block.slice(0, at).trim());
    block = block.slice(at).trim();
  }
  if (block) out.push(block);
  return out;
}

// Split the material into prompt-sized parts on page boundaries: [{ text, label: 'Pages 1–8' }]. One page longer than `max` is cut at a
// line or sentence end and each piece keeps the page's label.
export function splitParts(pages, max = PART_CHARS, withNotes = true) {
  const parts = [];
  let cur = null;
  const flush = () => { if (cur) { parts.push({ text: cur.blocks.join('\n\n'), label: rangeLabel(cur.first, cur.last) }); cur = null; } };
  for (const p of pages) {
    const block = pageBlock(p, withNotes);
    if (!block) continue;
    const pieces = block.length > max ? cutBlock(block, max).map((s, i) => (i ? p.label + ' (cont.)\n' + s : s)) : [block];
    for (const piece of pieces) {
      if (cur && cur.size + piece.length + 2 > max) flush();
      if (!cur) cur = { blocks: [], size: 0, first: p.label, last: p.label };
      cur.blocks.push(piece); cur.size += piece.length + 2; cur.last = p.label;
    }
  }
  flush();
  return parts;
}
// "Page 3" and "Page 9" → "Pages 3–9"; "Slide 2: Title" and "Slide 5: Other" → "Slides 2–5"; "Paragraph 3" … "Paragraph 9" → "Paragraphs 3–9".
export function rangeLabel(first, last) {
  const num = l => l.match(/^(Page|Slide|Paragraph) (\d+)/);
  const a = num(first), b = num(last);
  if (!a || !b) return first === last ? first : `${first} to ${last}`;
  return a[2] === b[2] ? `${a[1]} ${a[2]}` : `${a[1]}s ${a[2]}–${b[2]}`;
}

// ---------- the AI prompt ----------

// Like the "Make cards with Claude" prompt, with two more things: the sentence each card came from, kept at the end of the back
// ("Source: …"; the paste reader has only a front and a back, so this is the simple way to keep it), and, when there are
// several parts, which one this is.
export function docPrompt(material, part = 1, parts = 1) {
  return `Turn the study material below into flashcards for an exam.
${parts > 1 ? `This is part ${part} of ${parts} of the same material. Make cards for this part only.\n` : ''}Output ONLY lines in this exact format, one card per line, no header, no numbering:
front | back
Keep the front short: a term, concept, or specific question. Do not use the | character inside a card.
Keep the back under 25 words, then end it with the sentence from the material the card came from, like this:
front | back text. Source: "the sentence from the material"
Cover the definitions, distinctions, examples and facts a professor would most likely test. Skip trivia.

Material:
${material}`;
}

export const AI_SITES = [
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' }
];

// ---------- one file ----------

// A PDF or PowerPoint file, by its name or by the type the phone or browser says it is (a share often has no usable name).
export const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const isPdfFile = f => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
export const isPptxFile = f => /\.pptx$/i.test(f.name || '') || f.type === PPTX_TYPE;
export const isDocFile = f => isPdfFile(f) || isPptxFile(f);


// Read a PDF or PowerPoint File. → { pages } or throws Error with .code: 'too-big', 'too-many', 'no-text' (message ready to show),
// or any other error from the libraries (the screen says it couldn't read the file).
export async function readDocument(file, onProgress = () => {}, signal) {
  const isPdf = isPdfFile(file);
  const what = isPdf ? 'PDF' : 'presentation';
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (file.size > MAX_BYTES) throw fail('too-big', tooBigMessage(what));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pages;
  try {
    if (isPdf) {
      onProgress(0, 0);
      pages = await readPdf(bytes, onProgress, undefined, signal);
    } else {
      const { unzipSync } = await import(/* @vite-ignore */ FFLATE_URL);
      pages = readPptx(bytes, unzipSync);
      if (pages.length > MAX_PAGES) throw new Error('too-many:' + pages.length);
    }
  } catch (err) {
    const many = /^too-many:(\d+)$/.exec(err.message);
    if (many) throw fail('too-many', tooManyMessage(+many[1], what));
    if (err.message === 'too-big') throw fail('too-big', tooBigMessage(what));
    throw err;
  }
  if (!hasText(pages)) throw fail('no-text', isPdf ? NO_TEXT_MESSAGE : "This presentation has no text in it. Slides that are only pictures can't be read.");
  return { pages };
}
