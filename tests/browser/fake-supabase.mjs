// A stand-in for the Supabase project, for browser tests: auth (password) + the sync_items table,
// with the same rules as supabase/setup.sql (own rows only, newest wins, seq bumps on change) and
// supabase/limits.sql (media space limit, 3 MB files, 64 KB records, my_usage(), delete_my_account()).
// Options: confirmEmail (sign-up needs the emailed link first), captcha (every sign-up, sign-in and reset needs a token).
// Like the project's settings: at least 8 characters, letters and digits.
const strong = pw => pw.length >= 8 && /[a-z]/i.test(pw) && /\d/.test(pw);
export function fakeSupabase({ key = 'sb_publishable_LEdkCU7O5RdatxRtT44I_Q_1rWHPL9r', confirmEmail = false, captcha = false } = {}) {
  const users = new Map();          // email → { id, password }
  const tokens = new Map();         // access token → user id
  const refreshTokens = new Map();  // refresh token → user id
  const rows = new Map();           // `${uid}|${store}|${id}` → row
  let seq = 0, n = 0, down = false;
  const log = [];
  const recoveries = [];
  const confirmations = [];     // sign-up confirmation emails sent: { email, redirectTo }
  const captchaTokens = [];     // tokens that came with sign-ups, sign-ins and resets
  const limits = new Map();     // user id → media limit (quotas table); 180 MB when missing
  const DEFAULT_LIMIT = 180 * 1024 * 1024, MAX_FILE = 3 * 1024 * 1024, MAX_RECORD = 65536;
  const dataLimits = new Map(), dataOffsets = new Map();   // user id → synced-data limit (80 MB default), and bytes counted besides the rows
  const DEFAULT_DATA_LIMIT = 80 * 1024 * 1024;
  let recordMax = MAX_RECORD, serverFull = false, mediaFull = false;     // serverFull / mediaFull: the whole project is over its ceiling for synced data / files
  const rowSize = r => 120 + (r.data ? JSON.stringify(r.data).length : 0);
  const dataUsed = uid => (dataOffsets.get(uid) || 0) + [...rows.values()].filter(r => r.user_id === uid).reduce((n, r) => n + rowSize(r), 0);
  let rateLimited = false, limitsSql = true;      // limitsSql false = limits.sql not run yet (no my_usage, no record size check)
  const deleted = [];           // emails of accounts removed with delete_my_account()
  const mediaUsed = uid => [...files].filter(([k]) => k.startsWith(uid + '/')).reduce((n, [, f]) => n + f.data.length, 0);
  const limitOf = uid => limits.get(uid) ?? DEFAULT_LIMIT;
  // With captcha protection on, a request needs a token (any non-empty one passes here).
  const needsCaptcha = body => { if (!captcha) return false; const t = body?.gotrue_meta_security?.captcha_token; if (t) captchaTokens.push(t); return !t; };
  const files = new Map();      // storage: `${uid}/${id}` → { type, data }
  let bucket = true;            // false = media.sql not run yet
  let audio = true;             // false = the bucket's file types are the old list (media.sql from before sounds): audio uploads are turned away
  const uploads = [];           // every upload that was accepted, in order: { path, type }
  const session = uid => {
    const a = `acc-${uid}-${++n}`, r = `ref-${uid}-${n}`;
    tokens.set(a, uid); refreshTokens.set(r, uid);
    const email = [...users].find(([, u]) => u.id === uid)[0];
    return { access_token: a, refresh_token: r, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email } };
  };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: body === undefined ? '' : JSON.stringify(body) });
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (down) return route.abort('connectionrefused');
    const h = req.headers();
    if (h.apikey !== key) return json(route, 401, { message: 'Invalid API key' });
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    log.push(`${req.method()} ${url.pathname}${url.search}`);
    if (url.pathname === '/auth/v1/signup') {
      if (needsCaptcha(body)) return json(route, 400, { error_code: 'captcha_failed', msg: 'captcha verification process failed' });
      if (rateLimited) return json(route, 429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
      if (confirmEmail && users.get(body.email)?.confirmed === false) {      // asking again re-sends the link
        confirmations.push({ email: body.email, redirectTo: url.searchParams.get('redirect_to') });
        return json(route, 200, { id: users.get(body.email).id, email: body.email, confirmation_sent_at: new Date().toISOString() });
      }
      if (users.has(body.email)) return json(route, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      if (!strong(body.password)) return json(route, 422, { error_code: 'weak_password', msg: 'weak', weak_password: { reasons: ['length', 'characters'] } });
      users.set(body.email, { id: `user-${users.size + 1}`, password: body.password, confirmed: !confirmEmail });
      if (confirmEmail) {
        confirmations.push({ email: body.email, redirectTo: url.searchParams.get('redirect_to') });
        return json(route, 200, { id: users.get(body.email).id, email: body.email, confirmation_sent_at: new Date().toISOString() });
      }
      return json(route, 200, session(users.get(body.email).id));
    }
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        if (needsCaptcha(body)) return json(route, 400, { error_code: 'captcha_failed', msg: 'captcha verification process failed' });
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return json(route, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (u.confirmed === false) return json(route, 400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        return json(route, 200, session(u.id));
      }
      const uid = refreshTokens.get(body.refresh_token);
      if (!uid) return json(route, 400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      refreshTokens.delete(body.refresh_token);
      return json(route, 200, session(uid));
    }
    if (url.pathname === '/auth/v1/logout') return json(route, 204);
    if (url.pathname === '/auth/v1/recover') {
      // Real Supabase answers the same whether or not the account exists (so nobody can probe emails).
      if (needsCaptcha(body)) return json(route, 400, { error_code: 'captcha_failed', msg: 'captcha verification process failed' });
      recoveries.push({ email: body.email, redirectTo: url.searchParams.get('redirect_to') });
      return json(route, 200, {});
    }
    if (url.pathname === '/auth/v1/user') {
      const uid = tokens.get((h.authorization || '').replace('Bearer ', ''));
      if (!uid) return json(route, 401, { error_code: 'bad_jwt', msg: 'invalid JWT' });
      const [email, u] = [...users].find(([, x]) => x.id === uid);
      if (req.method() === 'PUT') {
        if (body.password === u.password) return json(route, 422, { error_code: 'same_password', msg: 'same' });
        if (!strong(body.password)) return json(route, 422, { error_code: 'weak_password', msg: 'weak' });
        u.password = body.password;
      }
      return json(route, 200, { id: uid, email });
    }
    if (url.pathname.startsWith('/storage/v1/')) {
      const uid = tokens.get((h.authorization || '').replace('Bearer ', ''));
      if (!uid) return json(route, 400, { statusCode: '403', error: 'Unauthorized', message: 'invalid JWT' });
      if (!bucket) return json(route, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      const p = decodeURIComponent(url.pathname.replace('/storage/v1/', ''));
      let m;
      if (req.method() === 'POST' && (m = /^object\/media\/([^/]+)\/(.+)$/.exec(p))) {
        if (m[1] !== uid) return json(route, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        if (!audio && String(h['content-type']).startsWith('audio/')) return json(route, 415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${h['content-type']} is not supported` });
        uploads.push({ path: `${m[1]}/${m[2]}`, type: h['content-type'] });
        if (req.postDataBuffer().length > MAX_FILE) return json(route, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        // limits.sql: no new files once the folder is at or above the limit (the file being added isn't counted)
        if (mediaFull || mediaUsed(uid) + req.postDataBuffer().length > limitOf(uid)) return json(route, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        files.set(`${m[1]}/${m[2]}`, { type: h['content-type'], data: req.postDataBuffer() });
        return json(route, 200, { Key: `media/${m[1]}/${m[2]}` });
      }
      if (req.method() === 'GET' && (m = /^object\/authenticated\/media\/([^/]+)\/(.+)$/.exec(p))) {
        const f = m[1] === uid && files.get(`${m[1]}/${m[2]}`);
        if (!f) return json(route, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return route.fulfill({ status: 200, contentType: f.type, headers: { 'access-control-allow-origin': '*' }, body: f.data });
      }
      if (req.method() === 'DELETE' && p === 'object/media') {
        for (const k of body.prefixes) if (k.startsWith(uid + '/')) files.delete(k);
        return json(route, 200, []);
      }
      if (req.method() === 'POST' && p === 'object/list/media') {
        return json(route, 200, [...files.keys()].filter(k => k.startsWith(body.prefix)).map(k => ({ name: k.slice(body.prefix.length) })));
      }
      return json(route, 400, { message: 'unknown storage call ' + p });
    }
    if (url.pathname === '/rest/v1/rpc/my_usage' || url.pathname === '/rest/v1/rpc/delete_my_account') {
      const uid = tokens.get((h.authorization || '').replace('Bearer ', ''));
      if (!uid) return json(route, 401, { code: 'PGRST301', message: 'JWT expired' });
      if (!limitsSql) return json(route, 404, { code: 'PGRST202', message: 'Could not find the function public.' + url.pathname.split('/').pop() + ' in the schema cache' });
      if (url.pathname.endsWith('my_usage')) {
        return json(route, 200, { data_bytes: dataUsed(uid), data_limit: dataLimits.get(uid) ?? DEFAULT_DATA_LIMIT, media_bytes: mediaUsed(uid), media_limit: limitOf(uid) });
      }
      for (const k of [...files.keys()]) if (k.startsWith(uid + '/')) files.delete(k);
      for (const [k, r] of rows) if (r.user_id === uid) rows.delete(k);
      for (const [t, id] of tokens) if (id === uid) tokens.delete(t);
      for (const [t, id] of refreshTokens) if (id === uid) refreshTokens.delete(t);
      for (const [e, u] of users) if (u.id === uid) { users.delete(e); deleted.push(e); }
      return json(route, 204);
    }
    if (url.pathname === '/rest/v1/sync_items') {
      const uid = tokens.get((h.authorization || '').replace('Bearer ', ''));
      if (!uid) return json(route, 401, { code: 'PGRST301', message: 'JWT expired' });
      if (req.method() === 'GET') {
        const after = Number(url.searchParams.get('seq').replace('gt.', ''));
        const limit = Number(url.searchParams.get('limit'));
        const out = [...rows.values()].filter(r => r.user_id === uid && r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit)
          .map(({ store, id, data, deleted, updated_at, seq }) => ({ store, id, data, deleted, updated_at, seq }));
        return json(route, 200, out);
      }
      if (req.method() === 'POST') {
        const keys = body.map(r => `${r.store}|${r.id}`);
        if (new Set(keys).size !== keys.length) return json(route, 500, { code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' });
        // All or nothing, like one transaction: rows are staged, and a refusal throws the whole batch away.
        const staged = new Map();
        let used = dataUsed(uid);
        for (const raw of body) {
          let r = raw;
          if (!['decks', 'cards', 'cardStates', 'reviewLog', 'settings'].includes(r.store)) return json(route, 400, { code: '23514', message: 'check' });
          if (limitsSql && Buffer.byteLength(String(r.id)) > 200) return json(route, 400, { code: '23514', message: 'new row for relation "sync_items" violates check constraint "sync_items_id_size"' });
          if (limitsSql && r.data && JSON.stringify(r.data).length >= recordMax) return json(route, 400, { code: '23514', message: 'new row for relation "sync_items" violates check constraint "sync_items_data_size"' });
          const k = `${uid}|${r.store}|${r.id}`, old = staged.get(k) || rows.get(k);
          r = { ...r, updated_at: Math.min(r.updated_at, Date.now() + 86400000) };     // setup.sql: a clock far ahead can't win forever
          if (old && r.updated_at <= old.updated_at) continue;          // older or identical: ignored
          const next = { user_id: uid, store: r.store, id: r.id, data: r.data, deleted: !!r.deleted, updated_at: r.updated_at, seq: 0 };
          const growth = rowSize(next) - (old ? rowSize(old) : 0);
          if (limitsSql && growth > 0 && !next.deleted && next.data) {     // limits.sql: growth is refused over the limit; deleting never is
            if (used + growth > (dataLimits.get(uid) ?? DEFAULT_DATA_LIMIT)) return json(route, 400, { code: '54000', message: 'sync_data_full' });
            if (serverFull) return json(route, 400, { code: '54000', message: 'sync_server_full' });
          }
          used += growth;
          staged.set(k, next);
        }
        for (const [k, r] of staged) rows.set(k, { ...r, seq: ++seq });
        return json(route, 201);
      }
      if (req.method() === 'DELETE') {
        for (const [k, r] of rows) if (r.user_id === uid) rows.delete(k);
        return json(route, 204);
      }
    }
    return json(route, 404, { message: 'not found ' + url.pathname });
  }
  return {
    handle, rows, users, log, recoveries, files, uploads, confirmations, captchaTokens, deleted, mediaUsed,
    setLimit(email, bytes) { limits.set(users.get(email).id, bytes); },
    setLimitsSql(v) { limitsSql = v; },
    setDataLimit(email, bytes) { dataLimits.set(users.get(email).id, bytes); },
    setDataUsed(email, bytes) { dataOffsets.set(users.get(email).id, bytes); },
    dataUsed: email => dataUsed(users.get(email).id),
    setServerFull(v) { serverFull = v; },
    setMediaFull(v) { mediaFull = v; },
    setRecordMax(n) { recordMax = n; },
    setRateLimited(v) { rateLimited = v; },
    // The person opened the link in the confirmation email: confirmed, and (as the real link does) sent back to the app.
    confirm(email) { users.get(email).confirmed = true; },
    confirmLink(email, base) { users.get(email).confirmed = true; const t = session(users.get(email).id); return `${base}#access_token=${t.access_token}&expires_at=${t.expires_at}&expires_in=3600&refresh_token=${t.refresh_token}&token_type=bearer&type=signup`; },
    setBucket(v) { bucket = v; },
    setAudio(v) { audio = v; },
    // The link in a reset email: a fresh sign-in for that account, after the #.
    recoveryLink(email, base) { const t = session(users.get(email).id); return `${base}#access_token=${t.access_token}&expires_at=${t.expires_at}&expires_in=3600&refresh_token=${t.refresh_token}&token_type=bearer&type=recovery`; },
    setDown(v) { down = v; },
    expireTokens() { tokens.clear(); },
    userRows: email => [...rows.values()].filter(r => r.user_id === users.get(email)?.id)
  };
}
