# Anki decks with sounds (old and new formats), made with the real Anki library. Used by e2e-sounds.mjs and anki.test.js.
#   python make_apkg_sound.py <out folder> <work folder>
# Notes (deck "Sounds"):
#   dog      Basic, a sound on the front              "dog.wav"
#   cat      Basic, two sounds on the back            "cat one.wav" (a name with a space) and "cat two.mp3"
#   Paris    Cloze, a sound in the Text field          "paris.wav"
#   ghost    Basic, the sound is not in the package    "missing.wav"        (counts as: not in the file)
#   big      Basic, a sound over 1 MB                  "big.wav" (1.2 MB)   (counts as: bigger than 1 MB)
#   old      Basic, a format the app can't keep        "old.wma"            (counts as: a format the app can't keep)
#   hound    Basic, the same file as the dog          "dog.wav"            (stored once)
#   Brain    Basic, no sound
import sys, os, wave, struct, math
from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
out, work = sys.argv[1], sys.argv[2]

def wav(seconds, hz=440, rate=8000, silent=False):
    path = os.path.join(work, 'tmp.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        n = int(seconds * rate)
        w.writeframes(b''.join(struct.pack('<h', 0 if silent else int(8000 * math.sin(2 * math.pi * hz * i / rate))) for i in range(n)))
    return open(path, 'rb').read()

# A few silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz: 417 bytes each): a real, tiny mp3.
mp3 = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 8

path = os.path.join(work, 's.anki2')
if os.path.exists(path): os.remove(path)
col = Collection(path)
col.media.write_data('dog.wav', wav(0.25, 440))
col.media.write_data('cat one.wav', wav(0.25, 520))
col.media.write_data('cat two.mp3', mp3)
col.media.write_data('paris.wav', wav(0.25, 660))
col.media.write_data('big.wav', wav(75, silent=True))          # 75 s of silence at 8 kHz, 16 bit = 1.2 MB
col.media.write_data('old.wma', b'ASF-not-a-real-file' * 20)
deck = col.decks.id('Sounds')
basic, cloze = col.models.by_name('Basic'), col.models.by_name('Cloze')
def add(f, b):
    n = col.new_note(basic); n.fields[0] = f; n.fields[1] = b; col.add_note(n, deck)
add('dog [sound:dog.wav]', 'inu')
add('cat', 'neko [sound:cat one.wav][sound:cat two.mp3]')
n = col.new_note(cloze); n.fields[0] = '{{c1::Paris}} is the capital of France [sound:paris.wav]'; n.fields[1] = 'Europe'; col.add_note(n, deck)
add('ghost [sound:missing.wav]', 'Boo')
add('big [sound:big.wav]', 'large')
add('old [sound:old.wma]', 'ancient')
add('hound [sound:dog.wav]', 'dog, again')
add('Brain', 'No sound here')
for legacy in (True, False):
    name = os.path.join(out, 'anki-sound-legacy.apkg' if legacy else 'anki-sound-new.apkg')
    col.export_anki_package(out_path=name, options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=True, legacy=legacy), limit=ExportLimit())
    print(name, os.path.getsize(name))
col.close()
