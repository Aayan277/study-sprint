# Builds test .apkg files with the real Anki library: one new-format (anki21b) and one legacy (anki2).
import sys, os
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out = sys.argv[1]; work = sys.argv[2]
path = os.path.join(work, 'c.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
psych = col.decks.id('Psychology')
unit = col.decks.id('Psychology::Unit 2')
basic = col.models.by_name('Basic')
def add(model, deck, fields, tags=()):
    n = col.new_note(model)
    for i, f in enumerate(fields): n.fields[i] = f
    n.tags = list(tags)
    col.add_note(n, deck)
add(basic, psych, ['Classical conditioning', 'Learning by <b>association</b>&nbsp;(Pavlov)'], ['learning', 'exam1'])
add(basic, psych, ['Operant conditioning', 'Learning from consequences<br>e.g. rewards &amp; punishments'], ['learning'])
add(basic, unit, ['Hippocampus', 'Forms new memories <img src="brain.png">'])
add(col.models.by_name('Basic (and reversed card)'), unit, ['Amygdala', 'Emotion, especially fear'])
cloze = col.models.by_name('Cloze')
add(cloze, unit, ['The {{c1::frontal lobe}} handles planning and {{c2::Broca::speech area}} is for speech.', 'Extra info'])
add(basic, unit, ['[sound:beep.mp3]Neuron', 'A nerve cell'])
# give one card some progress so we can check it's ignored safely
c = col.get_note(col.find_notes('Hippocampus')[0]).cards()[0]
for v in (True, False):
    name = os.path.join(out, 'anki-legacy.apkg' if v else 'anki-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=True, legacy=v), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
