# Anki decks with notes that work in both directions, made with the real Anki library (with review history, as if exported
# with "Include scheduling information"). Used by e2e-reverse.mjs and anki.test.js.
#   python make_apkg_reversed.py <out folder> <work folder>
# Notes (deck "Both ways"):
#   Mitosis    "Basic (and reversed card)"; the forward card has 3 reviews, the reverse card has 2 of its own (the last one an Again)
#   Meiosis    "Basic (and reversed card)", never reviewed
#   Nucleus    "Basic (optional reversed card)" with Add Reverse filled in: both cards   (the reverse card has one review)
#   Ribosome   "Basic (optional reversed card)" with Add Reverse empty: Anki makes only the first card
#   Plain      "Basic": one card
#   Neuron     a type with three card types (front, listening, reverse): only the first card comes in      (2 notes: Neuron, Synapse)
import sys, os, time
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
path = os.path.join(work, 'r.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
deck = col.decks.id('Both ways')
rev = col.models.by_name('Basic (and reversed card)')
opt = col.models.by_name('Basic (optional reversed card)')
basic = col.models.by_name('Basic')

# a note type with three cards: Card 1 asks the Word, Card 2 plays the Audio, Card 3 asks the Meaning
three = col.models.copy(rev)
three['name'] = 'Vocab with listening'
col.models.rename_field(three, three['flds'][0], 'Word')
col.models.rename_field(three, three['flds'][1], 'Meaning')
col.models.add_field(three, col.models.new_field('Audio'))
three['tmpls'][0]['qfmt'] = '{{Word}}'; three['tmpls'][0]['afmt'] = '{{FrontSide}}<hr id=answer>{{Meaning}}'
three['tmpls'][1]['name'] = 'Card 3'; three['tmpls'][1]['qfmt'] = '{{Meaning}}'; three['tmpls'][1]['afmt'] = '{{FrontSide}}<hr id=answer>{{Word}}'
listen = col.models.new_template('Listening'); listen['qfmt'] = '{{Audio}}'; listen['afmt'] = '{{FrontSide}}<hr id=answer>{{Word}}'
col.models.add_template(three, listen)
col.models.save(three)

def add(model, fields):
    n = col.new_note(model)
    for i, f in enumerate(fields): n.fields[i] = f
    col.add_note(n, deck); return n
def card(n, ord_): return [c for c in n.cards() if c.ord == ord_][0]
DAY = 86400000
now = int(time.time() * 1000)
def review(c, days_ago, ease, ivl=0, typ=1, ms=5000):
    col.db.execute('insert into revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) values (?,?,?,?,?,?,?,?,?)',
                   now - days_ago * DAY + c.id % 1000, c.id, -1, ease, ivl, 0, 2500, ms, typ)

mitosis = add(rev, ['Mitosis', 'Cell division'])
meiosis = add(rev, ['Meiosis', 'Gametes'])
nucleus = add(opt, ['Nucleus', 'Holds DNA', 'y'])
ribosome = add(opt, ['Ribosome', 'Makes proteins', ''])
plain = add(basic, ['Plain', 'One way'])
neuron = add(three, ['Neuron', 'Nerve cell', '[sound:n.mp3]'])
synapse = add(three, ['Synapse', 'Gap between neurons', ''])
assert len(mitosis.cards()) == 2 and len(nucleus.cards()) == 2 and len(ribosome.cards()) == 1 and len(neuron.cards()) == 3, 'card counts'
for d, e, t in [(40, 3, 0), (39, 3, 0), (30, 3, 1)]: review(card(mitosis, 0), d, e, typ=t)
for d, e, t in [(20, 3, 0), (3, 1, 1)]: review(card(mitosis, 1), d, e, typ=t)
review(card(nucleus, 1), 10, 3, typ=0)

for legacy in (True, False):
    name = os.path.join(out, 'anki-reversed-legacy.apkg' if legacy else 'anki-reversed-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False, with_media=False, legacy=legacy), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
