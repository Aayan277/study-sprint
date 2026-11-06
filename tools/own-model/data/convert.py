# Convert raw review logs (one parquet file per user, kept OUTSIDE the repo) into the small JSON files the Own model tools read.
# One of the two files that may name the dataset (the other is sources/anki10k.mjs). Run it with the isolated interpreter:
#
#   ~/fsrs-venv/bin/python -I tools/own-model/data/convert.py [--schema] [--users 1,2,3] [--limit N] [--data DIR]
#
# Reads    <data>/raw/<u>.parquet and, when present, <data>/meta/cards-<u>.parquet (note and deck per card)
#          and <data>/meta/decks-<u>.parquet (preset per deck).
# Writes   <data>/own/users/<u>.json with the columns
#          card_id, day_offset, rating, state, elapsed_seconds, duration_ms, note_id, deck_id, preset_id (a column is null where unknown)
# Rules    every value is checked; a bad row is dropped and counted; a bad file is skipped and counted. Users already converted are
#          skipped, so the script can be stopped and started again, and a download still running does no harm (only finished files are read).
#          It never writes inside the repo. <data> defaults to the FSRS_DATA environment variable, then ~/fsrs-data.
# Needs    pyarrow (python3 -m venv ~/fsrs-venv && ~/fsrs-venv/bin/pip install pyarrow). Nothing here touches the network.
import argparse, json, os, re, sys, time
import pyarrow.parquet as pq

DAY_MAX = 40000
ELAPSED_MAX = 10 ** 10
DURATION_MAX = 36_000_000          # ten hours in ms; Anki itself caps one answer at 50 minutes
REQUIRED = ['card_id', 'day_offset', 'rating', 'state']
OUT_COLS = ['card_id', 'day_offset', 'rating', 'state', 'elapsed_seconds', 'duration_ms', 'note_id', 'deck_id', 'preset_id']


def repo_root():
    return os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))


def inside_repo(path):
    repo, p = repo_root(), os.path.realpath(path)
    return p == repo or p.startswith(repo + os.sep)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def schema_of(path):
    s = pq.read_schema(path)
    return [(n, str(t)) for n, t in zip(s.names, s.types)]


def read_table(path, columns, max_rows):
    f = pq.ParquetFile(path)
    if f.metadata.num_rows > max_rows:
        raise ValueError(f'too many rows ({f.metadata.num_rows})')
    have = set(f.schema_arrow.names)
    missing = [c for c in REQUIRED if c in columns and c not in have]
    if missing:
        raise ValueError('missing columns ' + ','.join(missing))
    return f.read(columns=[c for c in columns if c in have]).to_pydict()


def meta_maps(meta_dir, u, max_rows):
    """card_id -> (note_id, deck_id) and deck_id -> preset_id, or empty maps when the files are absent or unusable."""
    cards, presets = {}, {}
    p = os.path.join(meta_dir, f'cards-{u}.parquet')
    if os.path.exists(p):
        try:
            t = read_table(p, ['card_id', 'note_id', 'deck_id'], max_rows)
            for c, n, d in zip(t.get('card_id', []), t.get('note_id', []), t.get('deck_id', [])):
                if is_int(c) and c >= 0:
                    cards[c] = (n if is_int(n) and n >= 0 else None, d if is_int(d) and d >= 0 else None)
        except Exception:
            cards = {}
    p = os.path.join(meta_dir, f'decks-{u}.parquet')
    if os.path.exists(p):
        try:
            t = read_table(p, ['deck_id', 'preset_id'], max_rows)
            for d, pr in zip(t.get('deck_id', []), t.get('preset_id', [])):
                if is_int(d) and d >= 0 and is_int(pr) and pr >= 0:
                    presets[d] = pr
        except Exception:
            presets = {}
    return cards, presets


def convert_user(raw_path, meta_dir, u, max_rows):
    t = read_table(raw_path, REQUIRED + ['elapsed_seconds', 'duration'], max_rows)
    n = len(t['card_id'])
    for c in REQUIRED:
        if len(t[c]) != n:
            raise ValueError('columns differ in length')
    cards, presets = meta_maps(meta_dir, u, max_rows)
    es_col, du_col = t.get('elapsed_seconds'), t.get('duration')
    out = {k: [] for k in OUT_COLS}
    c = {'rows_in': n, 'rows_out': 0, 'bad_row': 0, 'bad_elapsed': 0, 'bad_duration': 0, 'day_goes_back': 0}
    prev_day = -1
    for i in range(n):
        card, day, rating, state = t['card_id'][i], t['day_offset'][i], t['rating'][i], t['state'][i]
        if not (is_int(card) and card >= 0 and is_int(day) and 0 <= day <= DAY_MAX and is_int(rating) and 0 <= rating <= 4 and is_int(state) and 0 <= state <= 4):
            c['bad_row'] += 1
            continue
        es = es_col[i] if es_col is not None else None
        if es is not None and not (is_int(es) and -1 <= es <= ELAPSED_MAX):
            es = None
            c['bad_elapsed'] += 1
        du = du_col[i] if du_col is not None else None
        if du is not None and not (is_int(du) and 0 <= du <= DURATION_MAX):
            du = None
            c['bad_duration'] += 1
        if day < prev_day:
            c['day_goes_back'] += 1
        prev_day = max(prev_day, day)
        note, deck = cards.get(card, (None, None))
        out['card_id'].append(card); out['day_offset'].append(day); out['rating'].append(rating); out['state'].append(state)
        out['elapsed_seconds'].append(es); out['duration_ms'].append(du)
        out['note_id'].append(note); out['deck_id'].append(deck); out['preset_id'].append(presets.get(deck) if deck is not None else None)
    c['rows_out'] = len(out['card_id'])
    c['has_duration'] = du_col is not None
    c['has_cards_meta'] = bool(cards)
    c['has_preset'] = bool(presets)
    # a column that is null everywhere is written as null, not as a long list of nulls
    for k in ('elapsed_seconds', 'duration_ms', 'note_id', 'deck_id', 'preset_id'):
        if all(v is None for v in out[k]):
            out[k] = None
    return {'schema': 'own-users-v1', 'user': u, **out}, c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.environ.get('FSRS_DATA') or os.path.expanduser('~/fsrs-data'))
    ap.add_argument('--schema', action='store_true', help='print the column names and types of one raw file (and its meta files), then stop')
    ap.add_argument('--users', help='comma-separated user ids')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--max-rows', type=int, default=5_000_000)
    ap.add_argument('--max-bytes', type=int, default=400 * 1024 * 1024)
    a = ap.parse_args()
    data = os.path.realpath(os.path.expanduser(a.data))
    if inside_repo(data):
        sys.exit(f'Refusing: the data folder ({data}) is inside the repo {repo_root()}. Real review data must stay outside it.')
    raw_dir, meta_dir = os.path.join(data, 'raw'), os.path.join(data, 'meta')
    out_dir = os.path.join(data, 'own', 'users')
    if not os.path.isdir(raw_dir):
        sys.exit('No raw folder in the data folder.')
    users = sorted(int(m.group(1)) for f in os.listdir(raw_dir) if (m := re.fullmatch(r'(\d{1,12})\.parquet', f)))
    if a.schema:
        if not users:
            sys.exit('No raw files.')
        u = users[0]
        print('raw:', schema_of(os.path.join(raw_dir, f'{u}.parquet')))
        for kind in ('cards', 'decks'):
            p = os.path.join(meta_dir, f'{kind}-{u}.parquet')
            if os.path.exists(p):
                print(kind + ':', schema_of(p))
        return
    if a.users:
        want = {int(x) for x in a.users.split(',')}
        users = [u for u in users if u in want]
    os.makedirs(out_dir, exist_ok=True)
    todo = [u for u in users if not os.path.exists(os.path.join(out_dir, f'{u}.json'))]
    if a.limit:
        todo = todo[:a.limit]
    print(f'{len(users)} raw users, {len(users) - len(todo) if not a.limit else "?"} already converted, {len(todo)} to do', flush=True)
    tot = {'users': 0, 'refused': 0, 'rows_in': 0, 'rows_out': 0, 'bad_row': 0, 'bad_elapsed': 0, 'bad_duration': 0, 'day_goes_back': 0,
           'with_duration': 0, 'with_cards_meta': 0, 'with_preset': 0}
    log = open(os.path.join(data, 'own', 'convert.jsonl'), 'a')
    t0 = time.time()
    for k, u in enumerate(todo):
        p = os.path.join(raw_dir, f'{u}.parquet')
        try:
            if os.path.getsize(p) > a.max_bytes:
                raise ValueError('file too large')
            obj, c = convert_user(p, meta_dir, u, a.max_rows)
        except Exception as e:
            tot['refused'] += 1
            log.write(json.dumps({'user': u, 'refused': str(e)[:200]}) + '\n'); log.flush()
            print(f'user {u}: refused ({str(e)[:80]})', flush=True)
            continue
        dest = os.path.join(out_dir, f'{u}.json')
        with open(dest + '.part', 'w') as f:
            json.dump(obj, f, separators=(',', ':'), allow_nan=False)
        os.replace(dest + '.part', dest)
        tot['users'] += 1
        for key in ('rows_in', 'rows_out', 'bad_row', 'bad_elapsed', 'bad_duration', 'day_goes_back'):
            tot[key] += c[key]
        tot['with_duration'] += c['has_duration']; tot['with_cards_meta'] += c['has_cards_meta']; tot['with_preset'] += c['has_preset']
        log.write(json.dumps({'user': u, **c}) + '\n'); log.flush()
        if (k + 1) % 50 == 0:
            print(f'{k + 1}/{len(todo)} ({time.time() - t0:.0f}s)', flush=True)
    print('done:', json.dumps(tot))


main()
