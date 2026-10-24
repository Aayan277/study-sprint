# Two versions of one small Anki deck, for testing a re-import (e2e-anki-update.mjs), made with only Python's standard library (the old,
# schema-11 file layout). The notes keep their guids from one version to the next, the way a deck re-exported from Anki does. All made up.
#   python make_apkg_update.py <out folder>
#   anki-update-v1.apkg  deck "Update test": Alpha (Basic, a picture on its back), Beta (Basic), Gamma ("Basic (and reversed card)": two cards),
#                        a cloze note with blanks c1 and c2
#   anki-update-v2.apkg  the same notes, changed: Alpha's text, Gamma's front, the cloze text (and a third blank, c3), the same picture;
#                        Beta is untouched; a new note, Epsilon
import sys, os, json, sqlite3, zipfile, tempfile, zlib, struct

out = sys.argv[1]

def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

def model(mid, name, fields, tmpls, kind=0):
    return {'id': mid, 'name': name, 'type': kind, 'mod': 1, 'usn': -1, 'sortf': 0, 'did': 1, 'css': '', 'latexPre': '', 'latexPost': '', 'req': [[i, 'all', [0]] for i in range(len(tmpls))],
            'flds': [{'name': f, 'ord': i, 'sticky': False, 'rtl': False, 'font': 'Arial', 'size': 20, 'media': []} for i, f in enumerate(fields)],
            'tmpls': [{'name': n, 'ord': i, 'qfmt': q, 'afmt': a, 'did': None, 'bqfmt': '', 'bafmt': ''} for i, (n, q, a) in enumerate(tmpls)], 'tags': [], 'vers': []}

ANS = '{{FrontSide}}<hr id=answer>'
MODELS = {
    '1001': model(1001, 'Basic', ['Front', 'Back'], [('Card 1', '{{Front}}', ANS + '{{Back}}')]),
    '1002': model(1002, 'Basic (and reversed card)', ['Front', 'Back'], [('Card 1', '{{Front}}', ANS + '{{Back}}'), ('Card 2', '{{Back}}', ANS + '{{Front}}')]),
    '1003': model(1003, 'Cloze', ['Text', 'Back Extra'], [('Cloze', '{{cloze:Text}}', '{{cloze:Text}}<br>{{Back Extra}}')], kind=1),
}
# (guid, model, fields, how many cards)
V1 = [
    ('gAlpha', 1001, ['Alpha', 'first letter <img src="pic.png">'], 1),
    ('gBeta', 1001, ['Beta', 'second letter'], 1),
    ('gGamma', 1002, ['Gamma', 'third letter'], 2),
    ('gHeart', 1003, ['The {{c1::heart}} pumps {{c2::blood}}.', 'Muscle'], 2),
]
V2 = [
    ('gAlpha', 1001, ['Alpha (revised)', 'first letter, updated <img src="pic.png">'], 1),
    ('gBeta', 1001, ['Beta', 'second letter'], 1),
    ('gGamma', 1002, ['Gamma!', 'third letter'], 2),
    ('gHeart', 1003, ['The {{c1::lung}} takes in {{c2::oxygen}} and {{c3::releases CO2}}.', 'Organ'], 3),
    ('gEpsilon', 1001, ['Epsilon', 'fifth letter'], 1),
]

def make(path, notes):
    work = tempfile.mkdtemp()
    db = sqlite3.connect(os.path.join(work, 'collection.anki2'))
    db.executescript('''
      create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
      create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
      create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
      create table revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
      create table graves (usn integer, oid integer, type integer);''')
    decks = {'1': {'id': 1, 'name': 'Default'}, '2': {'id': 2, 'name': 'Update test'}}
    db.execute('insert into col values (1, 0, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)', ('{}', json.dumps(MODELS), json.dumps(decks), '{}', '{}'))
    nid = 0
    for guid, mid, flds, ncards in notes:
        nid += 1
        db.execute('insert into notes values (?, ?, ?, 0, -1, ?, ?, ?, 0, 0, ?)', (nid, guid, mid, ' update ', '\x1f'.join(flds), flds[0], ''))
        for ord_ in range(ncards):
            cid = nid * 10 + ord_
            db.execute('insert into cards values (?, ?, 2, ?, 0, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)', (cid, nid, ord_, cid, ''))
    db.commit(); db.close()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        z.write(os.path.join(work, 'collection.anki2'), 'collection.anki2')
        z.writestr('media', json.dumps({'0': 'pic.png'}))
        z.writestr('0', png(120, 90, (200, 60, 60)))
    print(path, os.path.getsize(path))

make(os.path.join(out, 'anki-update-v1.apkg'), V1)
make(os.path.join(out, 'anki-update-v2.apkg'), V2)
