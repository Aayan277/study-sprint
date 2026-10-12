# Test .apkg files WITH review history (as if exported with "Include scheduling information").
import sys, os, time
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
path = os.path.join(work, 's.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
deck = col.decks.id('Biology')
basic = col.models.by_name('Basic'); cloze = col.models.by_name('Cloze')
def add(model, fields):
    n = col.new_note(model)
    for i, f in enumerate(fields): n.fields[i] = f
    col.add_note(n, deck); return n
a = add(basic, ['Mitochondria', 'Powerhouse of the cell'])
b = add(basic, ['Ribosome', 'Makes proteins'])
c = add(basic, ['Nucleus', 'Holds DNA'])            # never reviewed
z = add(cloze, ['{{c1::DNA}} is copied into {{c2::RNA}}', ''])
DAY = 86400000
now = int(time.time() * 1000)
def rev(card, days_ago, ease, ivl=0, typ=1, ms=5000):
    col.db.execute('insert into revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) values (?,?,?,?,?,?,?,?,?)',
                   now - days_ago * DAY + card.id % 1000, card.id, -1, ease, ivl, 0, 2500, ms, typ)
ca = a.cards()[0]
for d, e in [(40, 3), (39, 3), (35, 3), (25, 3), (10, 3)]: rev(ca, d, e, typ=0 if d >= 39 else 1)
cb = b.cards()[0]
for d, e in [(30, 3), (29, 3), (20, 1), (19, 3)]: rev(cb, d, e)
rev(cb, 5, 0, ivl=0, typ=4)                      # Forget: back to new
z2 = [x for x in z.cards() if x.ord == 1][0]
rev(z2, 3, 3, typ=0)
for v in (True, False):
    name = os.path.join(out, 'anki-sched-legacy.apkg' if v else 'anki-sched-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False, with_media=False, legacy=v), limit=ExportLimit())
    print(name)
col.close()
