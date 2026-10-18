# An AnKing-style Anki deck, made with the real Anki library: a cloze note type with many fields (Text, Extra, Personal Notes,
# First Aid, Sketchy, Pathoma) and the question-bank tags AnKing uses, such as #AK_Step1_v12::#UWorld::Step::12345.
# Used by e2e-anki-fields.mjs and anki.test.js (and by the tag-study tests in batch 2, which look up cards by question ID).
#   python make_apkg_anking.py <out folder> <work folder>
# Notes (deck "AnKing"):
#   Aorta      cloze, 2 blanks   Extra, First Aid "p. 41" and Sketchy "Video: Heart" filled in        UWorld Step 1 12345 and FirstAid::Cardio
#   Insulin    cloze, 1 blank    Extra, Personal Notes and First Aid "p. 335"                            UWorld Step 1 23456
#   ACE        cloze, 2 blanks   no Extra; First Aid is only a picture (fa.png), Pathoma has text        UWorld Step 1 34567, and UWorld Step 2 12345 (the same number in another bank)
#   Heart      cloze, 1 blank    only Extra                                                              UWorld Step 1 00456 (a number with a leading zero)
import sys, os, base64
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
path = os.path.join(work, 'k.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
deck = col.decks.id('AnKing')
m = col.models.copy(col.models.by_name('Cloze'))
m['name'] = 'AnKingOverhaul'
col.models.rename_field(m, m['flds'][1], 'Extra')
for name in ['Personal Notes', 'First Aid', 'Sketchy', 'Pathoma']: col.models.add_field(m, col.models.new_field(name))
m['tmpls'][0]['afmt'] = '{{cloze:Text}}<br>{{Extra}}<br>{{Personal Notes}}{{First Aid}}{{Sketchy}}{{Pathoma}}'
col.models.save(m)
# a 1x1 PNG
col.media.write_data('fa.png', base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='))
def add(fields, tags):
    n = col.new_note(m)
    for i, f in enumerate(fields): n.fields[i] = f
    n.tags = tags
    col.add_note(n, deck)
add(['{{c1::Aorta}} leaves the {{c2::left ventricle}}', 'Pumps <b>oxygenated</b> blood', '', 'p. 41', 'Video: Heart', ''],
    ['#AK_Step1_v12::#UWorld::Step::12345', '#AK_Step1_v12::#FirstAid::Cardio'])
add(['{{c1::Insulin}} lowers blood glucose', 'Made by beta cells', 'My mnemonic: I = in', 'p. 335', '', ''],
    ['#AK_Step1_v12::#UWorld::Step::23456'])
add(['{{c1::ACE inhibitors}} cause {{c2::cough}}', '', '', '<img src="fa.png">', '', 'Bradykinin builds up'],
    ['#AK_Step1_v12::#UWorld::Step::34567', '#AK_Step1_v12::#UWorld::Step2::12345'])
add(['The {{c1::mitral valve}} is on the left', 'Two leaflets', '', '', '', ''],
    ['#AK_Step1_v12::#UWorld::Step::00456'])
for legacy in (True, False):
    name = os.path.join(out, 'anki-anking-legacy.apkg' if legacy else 'anki-anking.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=True, legacy=legacy), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
