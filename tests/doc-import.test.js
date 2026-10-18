// Tests for js/doc-import.js (PDF and slides text, parts for the AI prompt). Run with: node tests/doc-import.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  xmlText, slideOrder, resolvePath, slideLines, notesText, notesTarget, pptxPages, pdfPageText, tidy,
  pageBlock, pagesToText, splitParts, docPrompt, hasText, charCount, PART_CHARS, NO_TEXT_MESSAGE, tooManyMessage,
  readPptx, readPdf, isDocFile, isPdfFile, isPptxFile, PPTX_TYPE
} from '../js/doc-import.js';
import { parseBlocks, parseText } from '../js/import.js';

// A reader for zip files with stored (not compressed) entries, which is what the test fixture is. (The app uses fflate.)
function unzipStored(buf) {
  const files = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files[name] = new Uint8Array(buf.subarray(start, start + size));
    at += 46 + nameLen + extra + comment;
  }
  return files;
}
const fixture = unzipStored(fs.readFileSync(new URL('./browser/files/doc-slides.pptx', import.meta.url)));

test('xmlText: entities and numbered characters', () => {
  assert.equal(xmlText('red &amp; blue &lt;b&gt; &quot;x&quot; &#233; &#x41;'), 'red & blue <b> "x" é A');
  assert.equal(xmlText('&#99999999;'), '');
});

test('paths in the zip are resolved from where the file lives', () => {
  assert.equal(resolvePath('ppt/', 'slides/slide1.xml'), 'ppt/slides/slide1.xml');
  assert.equal(resolvePath('ppt/slides/', '../notesSlides/notesSlide1.xml'), 'ppt/notesSlides/notesSlide1.xml');
  assert.equal(resolvePath('ppt/', '/ppt/slides/slide9.xml'), 'ppt/slides/slide9.xml');
});

test('slides come in the order the presentation lists them, not their file numbers', () => {
  const pres = '<p:sldIdLst><p:sldId id="1" r:id="rId9"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst>';
  const rels = '<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId9" Target="slides/slide7.xml" Type="x/slide"/></Relationships>';
  assert.deepEqual(slideOrder(pres, rels), ['ppt/slides/slide7.xml', 'ppt/slides/slide1.xml']);
  assert.deepEqual(slideOrder('<nothing/>', rels), []);
});

test('slide text: a:t runs joined per paragraph, line breaks kept, numbers/footers skipped, entities decoded', () => {
  const xml = `<p:sld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hel</a:t></a:r><a:r><a:t xml:space="preserve">lo &amp; bye</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>one</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p><a:p><a:r><a:t/></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Footer</a:t></a:r></a:p></p:txBody></p:sp>
    <p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>
  </p:spTree></p:sld>`;
  assert.deepEqual(slideLines(xml), ['Hello & bye', 'one\ntwo', 'cell']);
});

test('speaker notes: only the notes box', () => {
  const xml = '<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>pic</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>say this</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp></p:notes>';
  assert.equal(notesText(xml), 'say this');
  const rels = '<Relationships><Relationship Id="rId1" Type="http://x/relationships/slideLayout" Target="../slideLayouts/l1.xml"/><Relationship Id="rId2" Type="http://x/relationships/notesSlide" Target="../notesSlides/notesSlide4.xml"/></Relationships>';
  assert.equal(notesTarget('ppt/slides/slide2.xml', rels), 'ppt/notesSlides/notesSlide4.xml');
  assert.equal(notesTarget('ppt/slides/slide2.xml', null), null);
});

test('a whole .pptx: show order, titles in the labels, notes attached', () => {
  const pages = pptxPages(fixture);
  assert.deepEqual(pages.map(p => p.label), ['Slide 1: Cell cycle', 'Slide 2: Photosynthesis', 'Slide 3: Genetics']);
  assert.equal(pages[1].text, 'Plants turn light into sugar\nChlorophyll absorbs red & blue light');
  assert.equal(pages[1].notes, 'Remember the Calvin cycle is the dark reaction');
  assert.equal(pages[0].notes, '');
  assert.ok(hasText(pages));
});

test('without a usable slide list the slideN files are read in number order', () => {
  const only = { 'ppt/slides/slide10.xml': new TextEncoder().encode('<p:sp><a:p><a:r><a:t>ten</a:t></a:r></a:p></p:sp>'), 'ppt/slides/slide2.xml': new TextEncoder().encode('<p:sp><a:p><a:r><a:t>two</a:t></a:r></a:p></p:sp>') };
  assert.deepEqual(pptxPages(only).map(p => p.text), ['two', 'ten']);
});

test('PDF page text: lines end where pdf.js says, spaces kept, split words joined', () => {
  assert.equal(pdfPageText([{ str: 'Mitosis', hasEOL: false }, { str: ' - ', hasEOL: false }, { str: 'division', hasEOL: true }, { str: 'meta-', hasEOL: true }, { str: 'bolism', hasEOL: true }, { str: '', hasEOL: true }, { type: 'beginMarkedContent' }]),
    'Mitosis - division\nmetabolism');
  assert.equal(tidy('  a   b \r\n\r\n c  '), 'a b\nc');
  assert.equal(tidy('Re-\nUse'), 'Re-\nUse');            // only lower case on both sides is a split word
});

const pages = n => Array.from({ length: n }, (_, i) => ({ label: `Page ${i + 1}`, text: 'x'.repeat(1000) + ` end${i + 1}`, notes: '' }));

test('blocks: label first, then the text, notes as one line, blank lines between pages, empty pages skipped', () => {
  const ps = [{ label: 'Slide 1: A', text: 'one\ntwo', notes: 'say\nthis' }, { label: 'Slide 2', text: '', notes: '' }, { label: 'Slide 3', text: 'three', notes: '' }];
  assert.equal(pageBlock(ps[0]), 'Slide 1: A\none\ntwo\nNotes: say this');
  assert.equal(pageBlock(ps[0], false), 'Slide 1: A\none\ntwo');
  assert.equal(pagesToText(ps), 'Slide 1: A\none\ntwo\nNotes: say this\n\nSlide 3\nthree');
  assert.equal(charCount(ps, false), 'Slide 1: A\none\ntwo'.length + 'Slide 3\nthree'.length);
});

test('the text as it is: each page becomes a card, even when its lines look like "term - definition"', () => {
  const text = pagesToText([{ label: 'Page 1', text: 'Mitosis - cell division\nMeiosis - four gametes\nSynapse - a gap', notes: '' }, { label: 'Page 2', text: 'Neuron - a cell\nAxon - a wire\nDendrite - an input', notes: '' }]);
  assert.equal(parseText(text).format.id, 'separator');         // the normal reader would split every line
  const r = parseBlocks(text);
  assert.equal(r.format.id, 'blocks');
  assert.deepEqual(r.rows.map(x => x[0]), ['Page 1', 'Page 2']);
  assert.ok(r.rows[0][1].startsWith('Mitosis - cell division\nMeiosis'));
  assert.equal(parseBlocks('a - b\nc - d').format.id, 'separator');            // not in blocks: the usual reader
});

test('parts: split on page boundaries near the limit, every page once and in order', () => {
  const parts = splitParts(pages(30));
  assert.ok(parts.length > 2 && parts.length < 5, 'parts: ' + parts.length);
  for (const p of parts) assert.ok(p.text.length <= PART_CHARS, 'a part is within the limit');
  const joined = parts.map(p => p.text).join('\n\n');
  assert.equal(joined, pagesToText(pages(30)));                                  // nothing lost, nothing repeated
  assert.match(parts[0].label, /^Pages 1–\d+$/);
  assert.match(parts.at(-1).label, /^Pages \d+–30$/);
  assert.equal(parts.at(-1).text.endsWith('end30'), true);
});

test('parts: a short document is one part, labelled by its page; empty pages leave no part', () => {
  assert.deepEqual(splitParts(pages(1)).map(p => p.label), ['Page 1']);
  assert.equal(splitParts([{ label: 'Page 1', text: '', notes: '' }]).length, 0);
  assert.equal(splitParts(pages(2), 100000).length, 1);
});

test('parts: one huge page is cut at line ends and keeps its label', () => {
  const line = 'A sentence about cells that is long enough. ';
  const big = [{ label: 'Page 4', text: Array.from({ length: 700 }, () => line.trim()).join('\n'), notes: '' }];
  const parts = splitParts(big, 5000);
  assert.ok(parts.length > 3);
  for (const p of parts) { assert.ok(p.text.length <= 5000); assert.match(p.text, /^Page 4( \(cont\.\))?\n/); }
  assert.equal(parts[0].label, 'Page 4');
  // all the sentences are still there
  assert.equal(parts.map(p => p.text).join('\n').split('A sentence about cells').length - 1, 700);
});

test('parts: slide labels with titles still give "Slides a–b"', () => {
  const ps = [1, 2, 3].map(n => ({ label: `Slide ${n}: Title ${n}`, text: 'y'.repeat(5000), notes: '' }));
  assert.deepEqual(splitParts(ps).map(p => p.label), ['Slides 1–2', 'Slide 3']);
});

test('the AI prompt: format, the source line, the part, and the material last', () => {
  const one = docPrompt('Some text', 1, 1);
  assert.match(one, /^Turn the study material below into flashcards for an exam\./);
  assert.match(one, /front \| back/);
  assert.match(one, /Source: "the sentence from the material"/);
  assert.doesNotMatch(one, /part 1 of 1/i);
  assert.ok(one.endsWith('Material:\nSome text'));
  const two = docPrompt('More', 2, 3);
  assert.match(two, /This is part 2 of 3 of the same material\. Make cards for this part only\./);
});

test('the answer to the prompt reads as cards, with the source kept on the back', () => {
  const r = parseText('Mitosis | Cell division into two identical cells. Source: "Mitosis makes two identical cells."\nSynapse | Gap between neurons. Source: "A synapse is a gap."');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0][0], 'Mitosis');
  assert.match(r.rows[0][1], /Source: "Mitosis makes two identical cells\."$/);
});

test('messages', () => {
  assert.equal(NO_TEXT_MESSAGE, "This PDF has no text in it (it's probably scanned). Try a PDF with selectable text.");
  assert.match(tooManyMessage(450, 'PDF'), /450 pages\. The limit is 300/);
  assert.match(tooManyMessage(1, 'presentation'), /1 slides?/);
});

test('one page or slide on its own still reads as one card (heading, then the text)', () => {
  const r = parseBlocks(pagesToText([{ label: 'Page 1', text: 'Mitosis - cell division\nMeiosis - four gametes', notes: '' }]));
  assert.equal(r.format.id, 'blocks');
  assert.deepEqual(r.rows, [['Page 1', 'Mitosis - cell division\nMeiosis - four gametes']]);
  assert.equal(parseBlocks(pagesToText([{ label: 'Slide 1: Cells', text: 'one line', notes: '' }])).rows[0][0], 'Slide 1: Cells');
});

test('a .pptx whose parts unpack too big is refused, one slide file or all together', () => {
  const fake = sizes => (bytes, { filter }) => { for (const [name, originalSize] of sizes) filter({ name, originalSize }); return {}; };
  assert.throws(() => readPptx(new Uint8Array(1), fake([['ppt/slides/slide1.xml', 21 * 1024 * 1024]])), /too-big/);
  const many = Array.from({ length: 6 }, (_, i) => [`ppt/slides/slide${i + 1}.xml`, 19 * 1024 * 1024]);       // each fine, 114 MB together
  assert.throws(() => readPptx(new Uint8Array(1), fake(many)), /too-big/);
  assert.deepEqual(readPptx(new Uint8Array(1), fake([['ppt/slides/slide1.xml', 1000], ['ppt/media/huge.png', 900 * 1024 * 1024]])), [], 'pictures are never unpacked or counted');
});

test('reading a PDF stops when told to (another file picked, screen left)', async () => {
  let opened = 0, destroyed = 0;
  const lib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 50, destroy() { destroyed++; }, getPage: async () => { opened++; return { getTextContent: async () => ({ items: [{ str: 'x', hasEOL: true }] }), cleanup() {} }; } }) }) };
  const ctl = new AbortController();
  await assert.rejects(readPdf(new Uint8Array(1), n => { if (n === 3) ctl.abort(); }, lib, ctl.signal), { name: 'AbortError' });
  assert.equal(opened, 3);
  assert.equal(destroyed, 1, 'the document is closed');
  await assert.rejects(readPdf(new Uint8Array(1), () => {}, lib, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(opened, 3);
});

test('a PDF or slides file is recognised by its name or its type', () => {
  assert.ok(isPdfFile({ name: 'a.PDF', type: '' }) && isPdfFile({ name: 'download', type: 'application/pdf' }) && !isPdfFile({ name: 'a.txt', type: 'text/plain' }));
  assert.ok(isPptxFile({ name: 'deck.pptx', type: '' }) && isPptxFile({ name: 'deck', type: PPTX_TYPE }) && !isPptxFile({ name: 'a.ppt', type: '' }));
  assert.ok(isDocFile({ name: 'x', type: 'application/pdf' }) && !isDocFile({ name: 'x.csv', type: 'text/csv' }));
});
