// A small Supabase client: just what sync needs, using fetch (no library to download).
//   Sign in:  Supabase Auth (/auth/v1) with email + password. A session is
//             { access_token, refresh_token, expires_at (seconds), user: { id, email } }.
//   Data:     the sync_items table through Supabase's REST API (/rest/v1).
// Errors are thrown as SupaError with a plain-words message.

import { SUPABASE_URL, SUPABASE_KEY } from './sync-config.js';

export class SupaError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new SupaError(navigator.onLine === false
      ? "You're offline. Sync will catch up when you're back online."
      : "Couldn't reach the sync server. If you haven't used the app for a week, your Supabase project may be paused: open it on supabase.com and click Restore.",
    { code: 'network' });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const code = json?.error_code || json?.code || json?.error || '';
    throw new SupaError(explain(res.status, code, json?.msg || json?.message || json?.error_description || text), { status: res.status, code });
  }
  return json;
}

// Supabase's error codes, in plain words.
function explain(status, code, raw) {
  const known = {
    invalid_credentials: 'Wrong email or password.',
    invalid_grant: 'Wrong email or password.',
    user_already_exists: 'There’s already an account with that email. Sign in instead.',
    email_exists: 'There’s already an account with that email. Sign in instead.',
    signup_disabled: 'New accounts are turned off for this project. Sign in with your existing account.',
    weak_password: 'That password is too short. Use at least 6 characters.',
    email_address_invalid: 'That email address doesn’t look right.',
    validation_failed: 'Check the email and password.',
    email_not_confirmed: 'This account is waiting for email confirmation. In Supabase, turn off “Confirm email” (see docs/sync-setup.md), then try again.',
    over_request_rate_limit: 'Too many tries. Wait a minute and try again.',
    refresh_token_not_found: 'You’ve been signed out. Sign in again to keep syncing.',
    refresh_token_already_used: 'You’ve been signed out. Sign in again to keep syncing.',
    session_not_found: 'You’ve been signed out. Sign in again to keep syncing.',
    PGRST205: 'The sync table is missing. Run supabase/setup.sql in your Supabase project (see docs/sync-setup.md).',
    '42P01': 'The sync table is missing. Run supabase/setup.sql in your Supabase project (see docs/sync-setup.md).'
  };
  if (known[code]) return known[code];
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return 'You’ve been signed out. Sign in again to keep syncing.';
  if (status === 429) return known.over_request_rate_limit;
  if (status >= 500) return 'The sync server had a problem. It will try again later.';
  return raw || `Sync error (${status}).`;
}
// Errors that mean the saved sign-in no longer works (the person has to sign in again).
export const isSignedOutError = err => err instanceof SupaError &&
  (err.status === 401 || /^(refresh_token_not_found|refresh_token_already_used|session_not_found|PGRST301|PGRST303)$/.test(err.code));

// ---------- sign in ----------
const session = json => {
  if (!json?.access_token) return null;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    user: { id: json.user?.id, email: json.user?.email }
  };
};

export async function signUp(email, password) {
  const json = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
  const s = session(json);
  // No session back means Supabase wants the email confirmed first.
  if (!s) throw new SupaError('Account made, but Supabase is waiting for email confirmation. In Supabase, turn off “Confirm email” (Authentication → Sign In / Providers → Email), then sign in here.', { code: 'email_not_confirmed' });
  return s;
}
export async function signIn(email, password) {
  return session(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
}
export async function refresh(refreshToken) {
  const s = session(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } }));
  if (!s) throw new SupaError('You’ve been signed out. Sign in again to keep syncing.', { status: 401, code: 'session_not_found' });
  return s;
}
export async function signOut(accessToken) {
  try { await call('/auth/v1/logout', { method: 'POST', token: accessToken }); } catch { /* signed out here either way */ }
}

// ---------- data ----------
// Rows changed after a server change number (seq), oldest first.
export function getChanges(token, afterSeq, limit = 1000) {
  return call(`/rest/v1/sync_items?select=store,id,data,deleted,updated_at,seq&seq=gt.${afterSeq}&order=seq.asc&limit=${limit}`, { token });
}
// Add or update rows. The server keeps whichever version is newest (see supabase/setup.sql).
export function putRows(token, rows) {
  return call('/rest/v1/sync_items?on_conflict=user_id,store,id', {
    method: 'POST', token, body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });
}
// Delete every row of this account (Settings → Sync → delete my data on the server).
export function deleteAllRows(token, userId) {
  return call(`/rest/v1/sync_items?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', token });
}
