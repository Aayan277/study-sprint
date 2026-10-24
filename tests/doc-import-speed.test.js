// Speed and behaviour checks for the slide-XML scanning in js/doc-import.js. Run with: node tests/doc-import-speed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFast, rep as repBytes, size } from './speed-helper.mjs';
import { slideLines, notesText, slideOrder, notesTarget, xmlText } from '../js/doc-import.js';

const rep = s => repBytes(s).slice(0, size(50000));
const hostile = () => ({
  'unclosed a:p': rep('<a:p>'),
  'unclosed a:t in a:p': '<a:p>' + rep('<a:t x') + '</a:p>',
  'unclosed a:t': '<a:p>' + rep('<a:t>'),
  'unclosed a:r': '<a:p>' + rep('<a:r>'),
  'unclosed a:br': '<a:p>' + rep('<a:br'),
  'unclosed p:sp': rep('<p:sp>'),
  'unclosed p:sp with ph': rep('<p:sp><p:ph '),
  'long blank run': '<a:p><a:t>' + ' \t'.repeat(size(25000)) + 'x\n</a:t></a:p>',
  'unclosed Relationship': rep('<Relationship '),
  'unclosed sldId': rep('<p:sldId '),
  'unfinished entities': rep('&#x'),
});

for (const name of Object.keys(hostile())) {
  test(`fast on hostile text: ${name}`, () => {
    for (const [fn, f] of Object.entries({
      slideLines: xml => slideLines(xml), slideLinesMarks: xml => slideLines(xml, { marks: true }), notesText: xml => notesText(xml),
      slideOrderRels: xml => slideOrder('', xml), slideOrderPres: xml => slideOrder(xml, ''), notesTarget: xml => notesTarget('ppt/slides/s1.xml', xml), xmlText: xml => xmlText(xml)
    })) assertFast(`${name}: ${fn}`, () => f(hostile()[name]));
  });
}

const sp = (inner, ph = '') => `<p:sp>${ph}<p:txBody>${inner}</p:txBody></p:sp>`;
const para = runs => `<a:p>${runs}</a:p>`;
const run = (t, rpr = '') => `<a:r>${rpr}<a:t>${t}</a:t></a:r>`;

test('normal slide text, breaks, entities, trailing blanks', () => {
  const xml = sp(para(run('Hello &amp; ') + run('world') + '<a:br/>' + run('line two   ')) + para('') + para(run('Second')));
  assert.deepEqual(slideLines(xml), ['Hello & world\nline two', 'Second']);
});
test('attributes on tags are handled', () => {
  const xml = sp('<a:p lvl="1"><a:r><a:t xml:space="preserve">kept</a:t></a:r><a:tab/><a:br /><a:r><a:t>x</a:t></a:r></a:p>');
  assert.deepEqual(slideLines(xml), ['kept\nx']);
});
test('trailing spaces before a line break are dropped, inner ones kept', () => {
  assert.deepEqual(slideLines(sp(para(run('a \t') + '<a:br/>' + run('b  c')))), ['a\nb  c']);
});
test('footers and slide numbers are skipped, tables outside shapes are read after', () => {
  const xml = sp(para(run('Body')), '<p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>')
    + sp(para(run('7')), '<p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>')
    + '<p:graphicFrame>' + para(run('Cell')) + '</p:graphicFrame>';
  assert.deepEqual(slideLines(xml), ['Body', 'Cell']);
});
test('bold marks still work', () => {
  const b = '<a:rPr b="1"/>';
  assert.deepEqual(slideLines(sp(para(run('Title', b))), { marks: true }), ['## Title']);
  assert.deepEqual(slideLines(sp(para(run('a ') + run('key', b) + run(' b'))), { marks: true }), ['a **key** b']);
});
test('notes text reads only the body placeholder', () => {
  const xml = sp(para(run('picture')), '<p:nvPr><p:ph type="sldImg"/></p:nvPr>') + sp(para(run('My notes')), '<p:nvPr><p:ph type="body"/></p:nvPr>');
  assert.equal(notesText(xml), 'My notes');
});
test('slide order and notes target from .rels', () => {
  const rels = '<Relationships><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>';
  const pres = '<p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst>';
  assert.deepEqual(slideOrder(pres, rels), ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']);
  assert.equal(notesTarget('ppt/slides/slide1.xml', '<Relationship Type="x/notesSlide" Target="../notesSlides/n1.xml"/>'), 'ppt/notesSlides/n1.xml');
});
