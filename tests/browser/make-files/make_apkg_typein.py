# Anki decks with "type in the answer" cards, made with the real Anki library. Used by e2e-typecards.mjs.
#   python make_apkg_typein.py <out folder> <work folder>
# Notes (deck "Typing"):
#   Capital of France   "Basic (type in the answer)": {{type:Back}} under the question          -> a typing card
#   Cloze copy          a Cloze type whose question has {{type:cloze:Text}}, with two blanks    -> both cards are typing cards
#   Reversed copy       "Basic (and reversed card)" whose card 2 asks "{{Back}} {{type:Front}}"  -> forward flips, reverse types
#   Plain               "Basic": one card, not typed
import sys, os
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
path = os.path.join(work, 'typein.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
deck = col.decks.id('Typing')
typed = col.models.by_name('Basic (type in the answer)')
basic = col.models.by_name('Basic')
rev = col.models.copy(col.models.by_name('Basic (and reversed card)'))
rev['name'] = 'Reversed with a typed card 2'
rev['tmpls'][1]['qfmt'] = '{{Back}}\n\n{{type:Front}}'
rev['tmpls'][1]['afmt'] = '{{Back}}\n\n<hr id=answer>\n\n{{type:Front}}'
col.models.save(rev)
cloze = col.models.copy(col.models.by_name('Cloze'))
cloze['name'] = 'Cloze (type in the answer)'
cloze['tmpls'][0]['qfmt'] = '{{cloze:Text}}\n{{type:cloze:Text}}'
cloze['tmpls'][0]['afmt'] = '{{cloze:Text}}\n{{type:cloze:Text}}<br>\n{{Back Extra}}'
col.models.save(cloze)
assert '{{type:Back}}' in typed['tmpls'][0]['qfmt'], 'the stock typing type has a type box'

def add(model, fields):
    n = col.new_note(model)
    for i, f in enumerate(fields): n.fields[i] = f
    col.add_note(n, deck); return n
france = add(typed, ['Capital of France', 'Paris'])
heart = add(cloze, ['The {{c1::heart}} pumps {{c2::blood}}', ''])
mitosis = add(rev, ['Mitosis', 'Cell division'])
plain = add(basic, ['Plain', 'One way'])
assert len(france.cards()) == 1 and len(heart.cards()) == 2 and len(mitosis.cards()) == 2 and len(plain.cards()) == 1, 'card counts'

for legacy in (True, False):
    name = os.path.join(out, 'anki-typein-legacy.apkg' if legacy else 'anki-typein-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=False, legacy=legacy), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
