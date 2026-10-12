# Test .apkg files for the Anki history replay (cram reviews, truncated history, old-style resets) and for
# image-occlusion notes. Made with the real Anki library:  python make_apkg_replay.py <out folder> <work folder>
import sys, os, time, zlib, struct
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]
path = os.path.join(work, 'r.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
deck = col.decks.id('Replay')
basic = col.models.by_name('Basic')
def add(model, fields):
    n = col.new_note(model)
    for i, f in enumerate(fields): n.fields[i] = f
    col.add_note(n, deck); return n
DAY = 86400000
now = int(time.time() * 1000)
def rev(card, days_ago, ease, ivl=0, typ=1, factor=2500, ms=5000):
    col.db.execute('insert into revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) values (?,?,?,?,?,?,?,?,?)',
                   now - int(days_ago * DAY) + card.id % 1000, card.id, -1, ease, ivl, 0, factor, ms, typ)

# 1. Learned, reviewed, then missed in a filtered deck (cram): the miss must not count.
cram = add(basic, ['Cram card', 'Reviewed, then crammed']).cards()[0]
rev(cram, 20, 3, ivl=-600, typ=0); rev(cram, 19, 3, ivl=4, typ=1); rev(cram, 10, 3, ivl=10, typ=1)
rev(cram, 2, 1, ivl=0, typ=3, factor=0)

# 2. History cut off: the first row we have is a review with a 30-day gap and ease 250%.
cut = add(basic, ['Cut-off card', 'Only the later reviews exist']).cards()[0]
rev(cut, 20, 3, ivl=30, typ=1, factor=2500); rev(cut, 1, 3, ivl=75, typ=1, factor=2500)

# 3. Forgotten in an old Anki that did not log it: a second group of learning rows follows the reviews.
again = add(basic, ['Restarted card', 'Learned again from scratch']).cards()[0]
rev(again, 60, 3, ivl=-600, typ=0); rev(again, 59, 3, ivl=3, typ=1); rev(again, 50, 3, ivl=8, typ=1)
rev(again, 6, 3, ivl=-600, typ=0); rev(again, 5, 3, ivl=2, typ=1)

# 4. An image-occlusion note.
def png():
    raw = b''.join(b'\x00' + bytes([200, 60, 60]) * 8 for _ in range(8))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 8, 8, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
img = os.path.join(work, 'heart.png')
open(img, 'wb').write(png())
name = col.media.add_file(img)
io = col.models.by_name('Image Occlusion')
add(io, ['{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=1}}{{c2::image-occlusion:rect:left=.5:top=.5:width=.2:height=.2:oi=1}}',
         f'<img src="{name}">', 'Heart anatomy', 'The left side pumps to the body', ''])

for legacy in (True, False):
    file = os.path.join(out, 'anki-replay-legacy.apkg' if legacy else 'anki-replay-new.apkg')
    col.export_anki_package(out_path=file, options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False, with_media=True, legacy=legacy), limit=ExportLimit())
    print(file)
col.close()
