"""Makes the golden test data for the RWKV lab (our own script).

It builds a small SYNTHETIC review history (never real data), turns it into the model's 92 inputs with our own rules,
and runs the model's published Python reference as a black box to get the expected outputs.

Two files come out:
  --out      tests/fixtures/rwkv/golden.json   committed: only our synthetic inputs and our own computed inputs-features
  --private  ~/rwkv-lab-private/golden-expected.json   NOT committed: the model's outputs and the weights fingerprint

Run it with isolated mode so nothing from the current folder is imported by accident:
  python -I tools/rwkv-lab/make_golden.py --ref <package>/reference --weights <weights.int8.bin> \
      --out tests/fixtures/rwkv/golden.json --private ~/rwkv-lab-private/golden-expected.json
The reference is only imported from the path given; nothing of it is copied here.
"""
import argparse, base64, hashlib, json, math, os, random, sys
import numpy as np
import pandas as pd

PERIODS = [3, 7, 30, 100, 365, 3650, 36500]
CODE_DIMS = {'c': 12, 'n': 12, 'd': 8, 'p': 8}
DAY_MS = 86400000
HOUR_MS = 3600000
BASE = 1767571200000          # 2026-01-05 00:00:00 UTC
CURVE_TIMES = [60, 3600, 86400, 7 * 86400, 30 * 86400, 365 * 86400]
SEED = 20260314
TRAIN, REPLAY = ('review', 'anki'), ('play', 'test')


# ---------- our hash for entity codes (same as js/rwkv-features.js) ----------
def fnv1a(text):
    h = 0x811c9dc5
    for ch in text:                      # (keys are plain ASCII, so a character is one code unit, as in JS)
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xffffffff
    return h


def mulberry32(seed):
    state = [seed & 0xffffffff]

    def imul(a, b):
        return (a * b) & 0xffffffff

    def rand():
        state[0] = (state[0] + 0x6d2b79f5) & 0xffffffff
        t = state[0]
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xffffffff
        t &= 0xffffffff
        return ((t ^ (t >> 14)) & 0xffffffff) / 4294967296
    return rand


def entity_code(tag, key):
    rand = mulberry32(fnv1a(tag + '|' + key))
    return [math.floor(rand() * 4) - 1.5 for _ in range(CODE_DIMS[tag])]


# ---------- the synthetic collection ----------
def make_collection():
    rng = random.Random(SEED)
    decks = [{'id': 'deckA'}, {'id': 'deckB'}, {'id': 'deckC', 'options': {'desiredRetention': 0.85}}]
    cards = []
    for i in range(30):
        c = {'id': 'k%02d' % (i + 1), 'deckId': decks[i % 3]['id']}
        if i < 12:
            c['noteId'] = 'note%d' % (i // 2 + 1)         # six pairs share a note
        elif i % 4 == 0:
            c['noteId'] = ''                              # empty note id: a note of its own
        elif i % 4 == 1:
            c['noteId'] = 'solo%d' % i
        cards.append(c)
    events = []                                            # (timestamp, cardId, source, applied)
    for c in cards:
        day = rng.randrange(0, 40)
        gap = 1
        for n in range(rng.randrange(4, 13)):
            minute = rng.randrange(0, 24 * 60)
            if rng.random() < 0.12:
                minute = rng.choice([3 * 60 + 50, 4 * 60 + 5, 23 * 60 + 55, 0 * 60 + 5])   # near the 4am and midnight edges
            t = BASE + day * DAY_MS + minute * 60000
            events.append([t, c['id'], 'review', None, n])
            if rng.random() < 0.25:                        # a same-day relearn
                events.append([t + rng.randrange(5, 30) * 60000, c['id'], 'review', None, n + 0.5])
            gap = max(1, int(gap * rng.choice([1, 1.5, 2, 2.5])))
            day += gap
            if day > 150:
                break
    # three imported rows, two applied Play answers, one Play answer that does not count, a row of a card that was deleted
    events.append([BASE + 70 * DAY_MS + 9 * HOUR_MS, 'k03', 'anki', None, 90])
    events.append([BASE + 71 * DAY_MS + 9 * HOUR_MS, 'k03', 'anki', None, 91])
    events.append([BASE + 72 * DAY_MS + 9 * HOUR_MS, 'k04', 'anki', None, 92])
    events.append([BASE + 75 * DAY_MS + 12 * HOUR_MS, 'k05', 'play', True, 93])
    events.append([BASE + 76 * DAY_MS + 12 * HOUR_MS, 'k06', 'test', True, 94])
    events.append([BASE + 77 * DAY_MS + 12 * HOUR_MS, 'k07', 'play', False, 95])
    events.append([BASE + 60 * DAY_MS + 8 * HOUR_MS, 'gone1', 'review', None, 96])
    events.append([BASE + 90 * DAY_MS + 8 * HOUR_MS, 'gone1', 'review', None, 97])
    events.sort(key=lambda e: (e[0], e[4]))
    seen, logs = set(), []
    for idx, (t, cid, src, applied, _) in enumerate(events):
        key = cid
        first = key not in seen
        seen.add(key)
        rating = rng.choices([1, 2, 3, 4], weights=[1, 1, 6, 2])[0]
        ms = rng.randrange(1500, 20000)
        if src == 'anki':
            ms = 60000
        log = {'id': idx + 1, 'cardId': cid, 'timestamp': t, 'source': src, 'mode': 'flip', 'correct': rating > 1, 'ms': ms, 'rating': rating,
               'state': 0 if first else 2}
        if applied is not None:
            log['applied'] = applied
        logs.append(log)
    logs[10]['ms'] = 700000                                # over the 10-minute cap
    logs[20]['ms'] = 0
    return decks, cards, logs


# ---------- mapping, written in Python from the same rules ----------
def study_day(t):                                          # TZ is UTC for the fixture: before 4am belongs to the day before
    return (t - 4 * HOUR_MS) // DAY_MS


def model_rows(logs, cards, decks):
    card_of = {c['id']: c for c in cards}
    own = {d['id'] for d in decks if d.get('options')}
    rows = []
    for l in logs:
        ok = l['source'] in TRAIN or (l['source'] in REPLAY and l.get('applied') is True)
        if not ok:
            continue
        ck = 'c:' + l['cardId']
        r = {'logId': l['id'], 'cardKey': ck, 't': l['timestamp'], 'day': int(study_day(l['timestamp'])), 'rating': l['rating'],
             'ms': min(600000, max(0, l['ms']))}
        c = card_of.get(l['cardId'])
        if c:
            r['noteKey'] = 'n:' + c['noteId'] if c.get('noteId') else ck
            r['deckKey'] = 'd:' + c['deckId']
            r['presetKey'] = 'p:' + c['deckId'] if c['deckId'] in own else 'p:default'
        else:
            r['noteKey'], r['deckKey'], r['presetKey'] = ck, 'd:?', 'p:default'
        rows.append(r)
    rows.sort(key=lambda r: (r['t'], r['logId']))
    return rows


def build_features(rows, query_flags=None):
    """92 inputs for every row, as if each were an update row (or a query row where query_flags[i])."""
    n = len(rows)
    df = pd.DataFrame(rows)
    df['th'] = np.arange(1, n + 1)
    g = df.groupby('cardKey')
    first = (g.cumcount() == 0).astype(int)
    es = np.where(first == 1, -1, np.floor(g['t'].diff().fillna(0).to_numpy() / 1000 + 0.5))
    ed = np.where(first == 1, -1, g['day'].diff().fillna(0).to_numpy())
    esum = pd.Series(es).groupby(df['cardKey'].to_numpy()).cumsum().to_numpy()
    dsum = pd.Series(ed).groupby(df['cardKey'].to_numpy()).cumsum().to_numpy()
    L = lambda x: np.where(x == -1, 0, np.log(1 + 1e-5 + np.maximum(x, -0.99999)))
    f = np.zeros((n, 92), np.float64)
    f[:, 0] = (L(ed) - 1.51) / 1.62
    f[:, 1] = (L(dsum) - 2.14) / 2.25
    f[:, 2] = (L(es) - 9.96) / 5.21
    f[:, 3] = np.sin(np.mod(es, 86400) * 2 * np.pi / 86400); f[:, 4] = np.cos(np.mod(es, 86400) * 2 * np.pi / 86400)
    f[:, 5] = (L(esum) - 10.86) / 5.80
    f[:, 6] = np.sin(np.mod(esum, 86400) * 2 * np.pi / 86400); f[:, 7] = np.cos(np.mod(esum, 86400) * 2 * np.pi / 86400)
    f[:, 8] = (np.log(10 + df['ms'].to_numpy(float)) - 8.9) / 1.07
    rt = df['rating'].to_numpy()
    for i in range(4):
        f[:, 9 + i] = (rt == i + 1)
    day = (df['day'] - df['day'].iloc[0]).to_numpy()
    f[:, 16] = np.log(np.log(np.e + np.diff(day, prepend=day[0])))
    f[:, 17] = ((day % 7) - 3) / 3
    cum_new = first.cumsum()
    dnew = cum_new.groupby(df['cardKey']).diff().fillna(0).to_numpy()
    f[:, 18] = (np.log(3 + dnew) - 2.945) / 2.011
    drev = np.maximum(0, -1 + df.groupby('cardKey')['th'].diff().fillna(0).to_numpy())
    f[:, 19] = (np.log(3 + drev) - 4.64) / 2.59
    f[:, 20] = (np.log(3 + first.groupby(df['day']).cumsum().to_numpy()) - 2.55) / 1.41
    f[:, 21] = (np.log(3 + df.groupby('day').cumcount().to_numpy()) - 4.59) / 1.30
    if query_flags is not None:
        q = np.asarray(query_flags, bool)
        f[q, 8:13] = 0
        f[q, 23] = 1
    off = 24
    for tag, col in (('c', 'cardKey'), ('n', 'noteKey'), ('d', 'deckKey'), ('p', 'presetKey')):
        d = CODE_DIMS[tag]
        cache = {}
        for i, key in enumerate(df[col]):
            if key not in cache:
                cache[key] = entity_code(tag, key)
            f[i, off:off + d] = cache[key]
        off += d
    dfirst = df.groupby('cardKey')['day'].transform('first').to_numpy() - df['day'].iloc[0]
    for p in PERIODS:
        w = 2 * np.pi / p
        f[:, off] = np.sin(w * np.mod(day, p)); f[:, off + 1] = np.cos(w * np.mod(day, p))
        f[:, off + 2] = np.sin(w * np.mod(dfirst, p)); f[:, off + 3] = np.cos(w * np.mod(dfirst, p))
        off += 4
    assert off == 92
    return f.astype(np.float32), es, ed


def sig7(x):
    return float('%.7g' % x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True, help='the package reference folder (imported at run time, never copied)')
    ap.add_argument('--weights', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--private', required=True)
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.ref))
    from small_model_recurrent import RecurrentModel      # noqa: E402
    from weights_io import read_weights                    # noqa: E402
    spec = json.loads(open(os.path.join(os.path.abspath(a.ref), '..', 'architecture.json')).read())
    wbytes = open(a.weights, 'rb').read()
    sha = hashlib.sha256(wbytes).hexdigest()
    tensors = read_weights(a.weights)

    decks, cards, logs = make_collection()
    rows = model_rows(logs, cards, decks)
    n = len(rows)
    # query rows: one before every update row of a card that has been seen before
    seen, qflag = set(), []
    for r in rows:
        qflag.append(r['cardKey'] in seen)
        seen.add(r['cardKey'])
    upd, es, ed = build_features(rows)
    qry, _, _ = build_features(rows, [True] * n)
    # features of 60 update rows and 20 query rows go into the committed file
    feat_rows = 60
    q_idx = [i for i in range(n) if qflag[i]][:20]

    # what-if rows: 5 cards, a moment after the last event
    last_t = rows[-1]['t']
    what_cards = [c['id'] for c in cards if c['id'] in ('k01', 'k08', 'k15', 'k22', 'k29')]
    what_t = last_t + 26 * HOUR_MS + 17 * 60000
    what_ms = 7500
    card_of = {c['id']: c for c in cards}
    what_inputs = [{'cardId': cid, 't': what_t, 'ms': what_ms} for cid in what_cards]

    def keys_of(r):
        return {'card_id': r['cardKey'], 'deck_id': r['deckKey'], 'note_id': r['noteKey'], 'preset_id': r['presetKey'], 'user_id': 'u'}

    def idmap(r):                                          # the reference wants numbers as ids
        return {k: abs(hash_id(v)) for k, v in keys_of(r).items()}

    def hash_id(text):
        return int(hashlib.sha256(text.encode()).hexdigest()[:12], 16)

    expected = {'weightsSha256': sha, 'curveTimes': CURVE_TIMES, 'stateBits': {}, 'teacher': {}}
    ID_NAMES = ['card_id', 'deck_id', 'note_id', 'preset_id', 'user_id']       # the order of the five streams in the model's store

    def pack(entity):
        # one entity's saved state as base64 of little-endian f32: for each layer, shift, then S, then the channel shift when it has one
        if entity is None:
            return None
        parts = []
        for _, ly in sorted(entity.items()):
            parts += [ly['shift'].ravel(), ly['S'].ravel()] + ([ly['cshift'].ravel()] if 'cshift' in ly else [])
        return base64.b64encode(np.concatenate(parts).astype('<f4').tobytes()).decode()
    for bits in (8, 0):
        model = RecurrentModel(tensors, spec, state_bits=bits)
        store = model.new_store()
        last_heads, ups, qrs = {}, {}, {}

        def cvec(h):
            return [sig7(float(v)) for v in list(h['w_logits']) + list(h['s_raw']) + list(h['d_raw'])]
        for i, r in enumerate(rows):
            ids = idmap(r)
            if qflag[i]:
                q = qry[i].copy()
                h = model.step(q, ids, True, store)
                pimm, prat = model.instant(h)
                qrs[str(r['logId'])] = {'pImm': sig7(pimm), 'pRating': [sig7(float(v)) for v in prat]}
            if bits == 8 and (i < 5 or i % 5 == 0):
                # teacher forcing: the exact saved state the reference carried into this step (for the JS test to start from)
                expected['teacher'][str(r['logId'])] = [pack(store[k].get(ids[name])) for k, name in enumerate(ID_NAMES)]
            h = model.step(upd[i], ids, False, store)
            rec = {'heads': cvec(h), 'pAt': [sig7(model.p_curve(h, t)) for t in CURVE_TIMES]}
            if qflag[i] and r['cardKey'] in last_heads:
                rec['pActual'] = sig7(model.p_curve(last_heads[r['cardKey']], es[i]))
            ups[str(r['logId'])] = rec
            last_heads[r['cardKey']] = h
        whatif = {}
        for w in what_inputs:
            c = card_of[w['cardId']]
            per = {}
            for rating in (1, 2, 3, 4):
                hyp = dict(rows[0]); hyp.update({'cardKey': 'c:' + w['cardId'], 'noteKey': 'n:' + c['noteId'] if c.get('noteId') else 'c:' + w['cardId'],
                                                 'deckKey': 'd:' + c['deckId'], 'presetKey': 'p:' + c['deckId'] if c['deckId'] == 'deckC' else 'p:default',
                                                 't': w['t'], 'day': int(study_day(w['t'])), 'rating': rating, 'ms': w['ms'], 'logId': 10 ** 6})
                ft, _, _ = build_features(rows + [hyp])
                h = model.step(ft[-1], idmap(hyp), True, store)
                per[str(rating)] = cvec(h)
            whatif[w['cardId']] = per
        expected['stateBits'][str(bits)] = {'updates': ups, 'queries': qrs, 'whatIf': whatif}

    golden = {
        'note': 'Synthetic inputs and our own computed features only. Generated by tools/rwkv-lab/make_golden.py, with TZ=UTC.',
        'seed': SEED, 'tz': 'UTC', 'decks': decks, 'cards': cards, 'logs': logs,
        'features': {'updateRows': [[sig7(float(v)) for v in upd[i]] for i in range(feat_rows)],
                     'queryRows': [{'index': i, 'f': [sig7(float(v)) for v in qry[i]]} for i in q_idx]},
        'whatIf': what_inputs, 'modelRows': n
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w') as fh:
        json.dump(golden, fh, separators=(',', ':'))
    os.makedirs(os.path.dirname(os.path.abspath(a.private)), exist_ok=True)
    with open(a.private, 'w') as fh:
        json.dump(expected, fh, separators=(',', ':'))
    print('model rows', n, 'query rows', sum(qflag), 'golden.json bytes', os.path.getsize(a.out), 'private bytes', os.path.getsize(a.private))


if __name__ == '__main__':
    main()
