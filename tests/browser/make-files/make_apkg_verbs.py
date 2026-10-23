# Anki decks whose note type has its own card layout (a verb-conjugation type that shows many fields on the front and back), made
# with only Python's standard library (the old, schema-11 file layout). Everything in them is made up.
# Used by e2e-anki-template.mjs.   python make_apkg_verbs.py <out folder>
#   anki-verbs-legacy.apkg        deck "Verb forms": two notes of the type "JP Verb Conjugation" (nine fields, one card layout)
#   anki-verbs-mixed-legacy.apkg  the same two notes plus a Basic note with a spare "Source" field, in deck "Verb forms::Extras"
#   anki-multicard-legacy.apkg    a note type with TWO card layouts ("Recognition": word → meaning, "Production": meaning → word), in deck "Multi cards",
#                                 with review history (used by e2e-anki-multicard.mjs). Notes:
#       inu      both cards, history on both (3 + 3 reviews)           the Production card's front is the Meaning
#       neko     Meaning is empty, so its Production card draws an empty front: the card is in the file but is left out
#                (history on both: 2 + 1 reviews, the second is not imported)
#       tori     only the Recognition card (the Production card was deleted in Anki), no history
#       Basic    an ordinary Basic note, one card, with a sound (inu.wav, stored in the file)
#       sakana   both cards, no history
import sys, os, json, sqlite3, zipfile, tempfile, wave, struct, math

out = sys.argv[1]
FIELDS = ['Verb', 'Meaning', 'Form', 'Pattern', 'Gloss', 'Answer', 'AnswerKana', 'Rule', 'Group']
QFMT = ('<div class=verb>{{Verb}}</div><div class=meaning>{{Meaning}}</div>\n'
        '<div class=ask><span class=form>{{Form}}</span></div><div class=hint>{{Pattern}} · {{Gloss}}</div>')
AFMT = ('{{FrontSide}}<hr id=answer><div class=ans>{{Answer}}</div><div class=kana>{{AnswerKana}}</div>\n'
        '<div class=rule>{{Rule}}</div><div class=grp>{{Group}}</div>')
VERBS = [
    ['<ruby>見<rt>み</rt></ruby>る', 'to see', 'Plain negative', '~ない', "doesn't ~", '見ない', 'みない',
     'る-verb (ichidan): drop る, add the ending', 'る-verb (ichidan)'],
    ['<ruby>食<rt>た</rt></ruby>べる', 'to eat', 'Polite', '~ます', 'does ~ (polite)', '食べます', 'たべます',
     'る-verb (ichidan): drop る, add ます', 'る-verb (ichidan)'],
]

def model(mid, name, fields, qfmt, afmt, tmpls=None):
    return {'id': mid, 'name': name, 'type': 0, 'mod': 1, 'usn': -1, 'sortf': 0, 'did': 1, 'css': '', 'latexPre': '', 'latexPost': '', 'req': [[0, 'all', [0]]],
            'flds': [{'name': f, 'ord': i, 'sticky': False, 'rtl': False, 'font': 'Arial', 'size': 20, 'media': []} for i, f in enumerate(fields)],
            'tmpls': tmpls or [{'name': 'Card 1', 'ord': 0, 'qfmt': qfmt, 'afmt': afmt, 'did': None, 'bqfmt': '', 'bafmt': ''}], 'tags': [], 'vers': []}

def make(path, with_basic):
    work = tempfile.mkdtemp()
    db = sqlite3.connect(os.path.join(work, 'collection.anki2'))
    db.executescript('''
      create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
      create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
      create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
      create table revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
      create table graves (usn integer, oid integer, type integer);''')
    models = {'1001': model(1001, 'JP Verb Conjugation', FIELDS, QFMT, AFMT)}
    decks = {'1': {'id': 1, 'name': 'Default'}, '2': {'id': 2, 'name': 'Verb forms'}}
    if with_basic:
        models['1002'] = model(1002, 'Basic with source', ['Front', 'Back', 'Source'], '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}')
        decks['3'] = {'id': 3, 'name': 'Verb forms::Extras'}
    db.execute('insert into col values (1, 0, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)', ('{}', json.dumps(models), json.dumps(decks), '{}', '{}'))
    rows = [(1001, 2, VERBS[0]), (1001, 2, VERBS[1])] + ([(1002, 3, ['Hippocampus', 'Memory', 'Textbook p. 12'])] if with_basic else [])
    for i, (mid, did, flds) in enumerate(rows, start=1):
        db.execute('insert into notes values (?, ?, ?, 0, -1, ?, ?, ?, 0, 0, ?)', (i, 'guid%d' % i, mid, ' verbs ' if mid == 1001 else '', '\x1f'.join(flds), flds[0], ''))
        db.execute('insert into cards values (?, ?, ?, 0, 0, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)', (i * 10, i, did, i, ''))
    db.commit(); db.close()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        z.write(os.path.join(work, 'collection.anki2'), 'collection.anki2')
        z.writestr('media', '{}')
    print(path, os.path.getsize(path))

make(os.path.join(out, 'anki-verbs-legacy.apkg'), False)
make(os.path.join(out, 'anki-verbs-mixed-legacy.apkg'), True)


# ---------- a note type with two card layouts ----------
DAY = 86400000
T0 = 1760000000000          # (a day in 2025; the history is before it)
def tmpl(name, ord, qfmt, afmt):
    return {'name': name, 'ord': ord, 'qfmt': qfmt, 'afmt': afmt, 'did': None, 'bqfmt': '', 'bafmt': ''}

def tiny_wav():
    path = os.path.join(tempfile.mkdtemp(), 'inu.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b''.join(struct.pack('<h', int(6000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(2000)))
    return open(path, 'rb').read()

def make_multicard(path):
    work = tempfile.mkdtemp()
    db = sqlite3.connect(os.path.join(work, 'collection.anki2'))
    db.executescript('''
      create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
      create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
      create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
      create table revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
      create table graves (usn integer, oid integer, type integer);''')
    fields = ['Word', 'Reading', 'Meaning', 'Example', 'Audio']
    vocab = model(2001, 'Vocab two layouts', fields, '', '', [
        tmpl('Recognition', 0, '<div class=w>{{Word}}</div><div class=r>{{Reading}}</div>', '{{FrontSide}}<hr id=answer><div class=m>{{Meaning}}</div><div class=e>{{Example}}</div>'),
        tmpl('Production', 1, '<div class=m>{{Meaning}}</div>', '{{FrontSide}}<hr id=answer><div class=w>{{Word}}</div><div class=r>{{Reading}}</div>{{Audio}}')])
    models = {'2001': vocab, '2002': model(2002, 'Basic', ['Front', 'Back'], '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}')}
    decks = {'1': {'id': 1, 'name': 'Default'}, '2': {'id': 2, 'name': 'Multi cards'}}
    db.execute('insert into col values (1, 0, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)', ('{}', json.dumps(models), json.dumps(decks), '{}', '{}'))
    # (note id, note type, fields, [(card id, ord)])
    notes = [
        (1, 2001, ['inu', 'いぬ', 'dog', 'Inu ga suki.', '[sound:inu.wav]'], [(10, 0), (11, 1)]),
        (2, 2001, ['neko', 'ねこ', '', 'Neko ga suki.', ''], [(20, 0), (21, 1)]),
        (3, 2001, ['tori', 'とり', 'bird', 'Tori ga suki.', ''], [(30, 0)]),
        (4, 2002, ['Hippocampus', 'Memory [sound:inu.wav]'], [(40, 0)]),
        (5, 2001, ['sakana', 'さかな', 'fish', 'Sakana ga suki.', ''], [(50, 0), (51, 1)]),
    ]
    for nid, mid, flds, cards in notes:
        db.execute('insert into notes values (?, ?, ?, 0, -1, ?, ?, ?, 0, 0, ?)', (nid, 'mguid%d' % nid, mid, ' vocab ', '\x1f'.join(flds), flds[0], ''))
        for cid, ord in cards:
            db.execute('insert into cards values (?, ?, 2, ?, 0, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)', (cid, nid, ord, cid, ''))
    # review history: (card id, [(days before T0, ease, interval, type)]): type 0 learning, 1 review, 2 relearning
    history = {
        10: [(30, 3, -600, 0), (28, 3, 3, 1), (20, 3, 8, 1)],
        11: [(30, 3, -600, 0), (27, 1, -600, 2), (25, 3, 4, 1)],
        20: [(12, 3, -600, 0), (10, 3, 2, 1)],
        21: [(12, 3, -600, 0)],
    }
    n = 0
    for cid, rows in history.items():
        for days, ease, ivl, kind in rows:
            n += 1
            db.execute('insert into revlog values (?, ?, -1, ?, ?, 0, 2500, 4000, ?)', (T0 - days * DAY + n, cid, ease, ivl, kind))
    db.commit(); db.close()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        z.write(os.path.join(work, 'collection.anki2'), 'collection.anki2')
        z.writestr('media', json.dumps({'0': 'inu.wav'}))
        z.writestr('0', tiny_wav())
    print(path, os.path.getsize(path))

make_multicard(os.path.join(out, 'anki-multicard-legacy.apkg'))
