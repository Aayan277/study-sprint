# Download a seeded random sample of users from the gated HuggingFace dataset open-spaced-repetition/anki-revlogs-10k
# and convert each user's review log to a small JSON file of columns that Node can read without extra packages.
# The data stays OUTSIDE the repository (licence: research use, no redistribution). Default folder: ~/fsrs-data.
#
#   HF_TOKEN=... python3 -I tests/realdata/fetch.py [--n 300] [--seed 20261018] [--out ~/fsrs-data] [--meta]
#
# --meta also downloads each user's cards table and decks table (note, deck and preset ids) to <out>/meta/cards-<u>.parquet and
# decks-<u>.parquet, the names tools/own-model/data/convert.py reads. It also fills in users that already have their JSON file.
#
# Needs pyarrow (pip install pyarrow, in a virtual environment). The token is read from HF_TOKEN and never printed.
import argparse, json, os, random, sys, urllib.request
import pyarrow.parquet as pq

REPO = 'open-spaced-repetition/anki-revlogs-10k'
COLS = ['card_id', 'day_offset', 'rating', 'state', 'elapsed_days', 'elapsed_seconds']

def get(url, token):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def fetch_meta(u, meta_dir, token):
    # cards: card_id, note_id, deck_id; decks: deck_id, parent_id, preset_id. A table that fails to download is skipped (the next run tries again).
    for kind in ('cards', 'decks'):
        dest = os.path.join(meta_dir, f'{kind}-{u}.parquet')
        if os.path.exists(dest): continue
        try:
            data = get(f'https://huggingface.co/datasets/{REPO}/resolve/main/{kind}/user_id={u}/data.parquet', token)
        except Exception as e:
            print(f'user {u} {kind}: download failed ({type(e).__name__})', flush=True)
            continue
        with open(dest + '.part', 'wb') as f: f.write(data)
        os.replace(dest + '.part', dest)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=300)
    ap.add_argument('--seed', type=int, default=20261018)
    ap.add_argument('--out', default=os.path.expanduser('~/fsrs-data'))
    ap.add_argument('--meta', action='store_true', help='also download the cards and decks tables of each user into <out>/meta')
    a = ap.parse_args()
    # Real review data stays outside the repo (the .mjs scripts refuse the same, tests/realdata/lib.mjs refuseInsideRepo).
    repo = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    out = os.path.realpath(os.path.expanduser(a.out))
    if out == repo or out.startswith(repo + os.sep):
        sys.exit(f'Refusing: --out ({out}) is inside the repo {repo}. Real review data must stay outside it.')
    token = os.environ.get('HF_TOKEN')
    if not token: sys.exit('HF_TOKEN is not set')
    info = json.loads(get(f'https://huggingface.co/api/datasets/{REPO}', token))
    users = sorted(int(s['rfilename'].split('user_id=')[1].split('/')[0]) for s in info['siblings'] if s['rfilename'].startswith('revlogs/user_id='))
    sample = random.Random(a.seed).sample(users, a.n)
    raw, users_dir = os.path.join(a.out, 'raw'), os.path.join(a.out, 'users')
    os.makedirs(raw, exist_ok=True); os.makedirs(users_dir, exist_ok=True)
    with open(os.path.join(a.out, 'sample.json'), 'w') as f: json.dump({'seed': a.seed, 'n': a.n, 'of': len(users), 'users': sample}, f)
    meta_dir = os.path.join(a.out, 'meta')
    if a.meta: os.makedirs(meta_dir, exist_ok=True)
    for k, u in enumerate(sample):
        if a.meta: fetch_meta(u, meta_dir, token)
        dest = os.path.join(users_dir, f'{u}.json')
        if os.path.exists(dest): continue
        pfile = os.path.join(raw, f'{u}.parquet')
        if not os.path.exists(pfile):
            data = get(f'https://huggingface.co/datasets/{REPO}/resolve/main/revlogs/user_id={u}/data.parquet', token)
            with open(pfile + '.part', 'wb') as f: f.write(data)
            os.replace(pfile + '.part', pfile)
        t = pq.read_table(pfile, columns=COLS)
        out = {'user': u, **{c: t.column(c).to_pylist() for c in COLS}}
        with open(dest + '.part', 'w') as f: json.dump(out, f, separators=(',', ':'))
        os.replace(dest + '.part', dest)
        print(f'{k + 1}/{len(sample)} user {u}: {t.num_rows} rows', flush=True)

main()
