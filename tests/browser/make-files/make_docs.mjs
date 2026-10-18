// Makes the tiny PDF and PowerPoint files the import tests read (tests/browser/files/doc-*.pdf, doc-slides.pptx).
// Written by hand, no libraries, so they are small and free to use. Run: node tests/browser/make-files/make_docs.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../files');

// ---- PDF: pages = [content stream strings]; resources say what each page can use ----
function pdf(pageStreams, { image = false } = {}) {
  const objs = [];                                          // objs[i] is object i+1
  const add = body => { objs.push(body); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PLACEHOLDER');                                       // pages, filled below
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const img = image ? add({ dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>', data: '\x40\x80\xc0\xff' }) : 0;
  const kids = [];
  for (const s of pageStreams) {
    const content = add({ dict: `<< /Length ${s.length} >>`, data: s });
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${img} 0 R >>` : ''} >> >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${typeof o === 'string' ? o : `${o.dict}\nstream\n${o.data}\nendstream`}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const text = lines => 'BT /F1 11 Tf 14 TL 20 170 Td ' + lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ') + ' ET';

fs.writeFileSync(path.join(OUT, 'doc-text.pdf'), pdf([
  text(['Mitosis - cell division into two identical cells', 'Meiosis - division into four gametes']),
  text(['Synapse - the gap between two neurons', 'Mirror neuron - fires when watching an action'])
]));
// A page with only a picture: no text layer, like a scan.
fs.writeFileSync(path.join(OUT, 'doc-scanned.pdf'), pdf(['q 200 0 0 100 20 50 cm /Im1 Do Q'], { image: true }));

// ---- PPTX: a zip. Entries are stored (not compressed), which every reader accepts. ----
function crc32(buf) { return zlib.crc32 ? zlib.crc32(buf) : (() => { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; })(); }
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8'), n = Buffer.from(name), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    parts.push(head, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const box = (id, ph, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="b${id}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map(p => `<a:p>${p}</a:p>`).join('')}</p:txBody></p:sp>`;
const run = t => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;
const slide = shapes => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
fs.writeFileSync(path.join(OUT, 'doc-slides.pptx'), zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  // The show order is slide2, slide1, slide3 (the file numbers are not the order).
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/><Relationship Id="rId4" Type="${REL}/slide" Target="slides/slide3.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': slide(box(2, 'title', [run('Photosynthesis')]) + box(3, 'body', [run('Plants turn light into sugar'), run('') + run('Chlorophyll absorbs red &amp; blue light')]) + box(4, 'sldNum', ['<a:fld id="{1}" type="slidenum"><a:t>2</a:t></a:fld>'])),
  'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  'ppt/notesSlides/notesSlide1.xml': slide(box(2, 'sldImg', ['']) + box(3, 'body', [run('Remember the Calvin cycle is the dark reaction')])),
  'ppt/slides/slide2.xml': slide(box(2, 'title', [run('Cell cycle')]) + box(3, 'body', [run('Interphase comes before mitosis')])),
  'ppt/slides/slide3.xml': slide(box(2, 'title', [run('Genetics')]) + box(3, 'body', [run('An allele is a version of a gene')]))
}));
// A longer one (30 slides of about 900 characters): more than one prompt part.
const longFiles = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${Array.from({ length: 30 }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: 30 }, (_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`
};
for (let i = 1; i <= 30; i++) longFiles[`ppt/slides/slide${i}.xml`] = slide(box(2, 'title', [run('Topic ' + i)]) + box(3, 'body', [run(`Fact ${i} about topic ${i}: ` + 'the quick brown fox jumps over the lazy dog. '.repeat(20))]));
fs.writeFileSync(path.join(OUT, 'doc-long.pptx'), zip(longFiles));
console.log('wrote', fs.readdirSync(OUT).filter(f => /^doc-/.test(f)).join(', '));
