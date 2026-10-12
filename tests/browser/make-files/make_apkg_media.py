# Anki decks with pictures (old and new formats), made with the real Anki library.
import sys, os, zlib, struct
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
path = os.path.join(work, 'm.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
col.media.write_data('heart diagram.png', png(400, 300, (200, 40, 40)))
col.media.write_data('lungs.png', png(300, 300, (40, 120, 200)))
col.media.write_data('extra.png', png(50, 50, (0, 200, 0)))
deck = col.decks.id('Anatomy')
basic = col.models.by_name('Basic')
def add(f, b):
    n = col.new_note(basic); n.fields[0] = f; n.fields[1] = b; col.add_note(n, deck)
add('Heart <img src="heart diagram.png">', 'Pumps blood')
add('<img src="lungs.png">', 'Lungs')
add('Kidney', 'Filters blood <img src="extra.png"><img src="lungs.png">')
add('Brain', 'No picture here')
for legacy in (True, False):
    name = os.path.join(out, 'anki-media-legacy.apkg' if legacy else 'anki-media-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=True, legacy=legacy), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
