// Reading PDFs and PowerPoint files for the Import screen. Both come out as "pages": [{ label, text, notes }], one per PDF page or slide.
// The pure parts (slide XML → text, chunking, prompt building) are tested in tests/doc-import.test.js; the readers load a
// library from the CDN only when someone picks a file, like Excel and Anki files do (import-screen.js).
//   PDF   pdf.js reads the text layer of each page. A scanned PDF has none: we say so, there is no OCR.
//   PPTX  a zip file: fflate (also used for Anki files) opens it and the text runs (a:t) are read from each slide.

export const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
// The legacy build also runs on older phones (it brings its own fixes for newer browser features).
export const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs';
export const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs';
export const PDFJS_WORKER_INTEGRITY = 'sha384-vbNBYP03jHFPlgtK4qSXtazEmGfmpTWlSsfq9OiU20MroW/Q9TbaEXiM7PpeWg+6';

export const MAX_PAGES = 300;
export const MAX_BYTES = 50 * 1024 * 1024;
export const PART_CHARS = 12000;                 // about how much of the material goes into one AI prompt
const MAX_UNPACKED = 300 * 1024 * 1024;          // a .pptx that unpacks to more than this is refused (a "zip bomb")

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
  for (const m of String(relsXml).matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) targets.set(a.Id, a.Target);
  }
  const out = [];
  for (const m of String(presXml).matchAll(/<p:sldId\b[^>]*>/g)) {
    const t = targets.get(attrs(m[0])['r:id']);
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

const textOfParagraphs = xml => {
  const lines = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = '';
    for (const t of p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g)) line += t[0].startsWith('<a:br') ? '\n' : xmlText(t[1]);
    line = line.replace(/[ \t]+\n/g, '\n').trim();
    if (line) lines.push(line);
  }
  return lines;
};
// The text boxes (<p:sp>) of a slide. Slide numbers, dates and footers are page furniture, not content.
const shapes = xml => [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map(m => m[0]);
const placeholder = sp => { const m = sp.match(/<p:ph\b[^>]*>/); return m ? attrs(m[0]).type || 'body' : null; };

// The text of one slide, one paragraph per line, in the order it is in the file (which is the reading order PowerPoint saves).
export function slideLines(xml) {
  xml = String(xml);
  const lines = [];
  // Anything outside a <p:sp> (tables in graphic frames) is read too, after the plain text boxes.
  const rest = xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, '');
  for (const sp of shapes(xml)) {
    const ph = placeholder(sp);
    if (ph === 'sldNum' || ph === 'ftr' || ph === 'dt' || ph === 'hdr') continue;
    lines.push(...textOfParagraphs(sp));
  }
  lines.push(...textOfParagraphs(rest));
  return lines;
}
export const slideText = xml => slideLines(xml).join('\n');

// The speaker notes of a notes page: only the notes box, not the slide picture or the page number.
export function notesText(xml) {
  return shapes(String(xml)).filter(sp => placeholder(sp) === 'body').flatMap(textOfParagraphs).join('\n');
}

// The notes file a slide points to, from its .rels file ("../notesSlides/notesSlide1.xml" → "ppt/notesSlides/notesSlide1.xml").
export function notesTarget(slidePath, relsXml) {
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
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
    const lines = slideLines(read(path));
    const noteFile = notesTarget(path, read(path.replace(/([^/]*)$/, '_rels/$1.rels')));
    const notes = noteFile && files[noteFile] ? notesText(read(noteFile)) : '';
    // The first line of a slide is almost always its title: it goes in the label, so the card's front says what the slide is about.
    const title = lines.length > 1 && lines[0].length <= 80 && !/\n/.test(lines[0]) ? lines[0] : '';
    return { label: `Slide ${i + 1}${title ? ': ' + title : ''}`, text: (title ? lines.slice(1) : lines).join('\n'), notes };
  });
}

// Open a .pptx from its bytes. `unzipSync` is fflate's (passed in so the tests don't need the CDN).
export function readPptx(bytes, unzipSync) {
  let unpacked = 0;
  const files = unzipSync(bytes, {
    filter: f => {
      if (!/^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml)$/.test(f.name)) return false;
      unpacked += f.originalSize;
      if (unpacked > MAX_UNPACKED) throw new Error('too-big');
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
export async function readPdf(bytes, onProgress = () => {}, lib) {
  lib = lib || await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0, disableFontFace: true }).promise;
  try {
    const total = doc.numPages;
    if (total > MAX_PAGES) throw new Error('too-many:' + total);
    const pages = [];
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      try { pages.push({ label: `Page ${n}`, text: pdfPageText((await page.getTextContent()).items), notes: '' }); } finally { page.cleanup(); }
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
// "Page 3" and "Page 9" → "Pages 3–9"; "Slide 2: Title" and "Slide 5: Other" → "Slides 2–5".
function rangeLabel(first, last) {
  const num = l => l.match(/^(Page|Slide) (\d+)/);
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

// Read a PDF or PowerPoint File. → { pages } or throws Error with .code: 'too-big', 'too-many', 'no-text' (message ready to show),
// or any other error from the libraries (the screen says it couldn't read the file).
export async function readDocument(file, onProgress = () => {}) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const what = isPdf ? 'PDF' : 'presentation';
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (file.size > MAX_BYTES) throw fail('too-big', tooBigMessage(what));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pages;
  try {
    if (isPdf) {
      onProgress(0, 0);
      pages = await readPdf(bytes, onProgress);
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
