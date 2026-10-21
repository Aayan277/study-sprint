// Sign-in, sign-up and reset messages (js/supa.js): the duplicate-email answer, which box an error is about, and the wording.
// Run with: node --test tests/auth-errors.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as supa from '../js/supa.js';

const realFetch = globalThis.fetch;
const answer = (status, body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
test.afterEach(() => { globalThis.fetch = realFetch; });

test('signing up with an email that already has an account says so (Supabase answers 200 with no identities)', async () => {
  answer(200, { id: 'x', email: 'a@b.co', identities: [] });
  await assert.rejects(supa.signUp('a@b.co', 'secret123'), e => e.code === 'user_already_exists' && e.status === 422 && /already an account/.test(e.message));
  answer(200, { user: { id: 'x', identities: [] } });
  await assert.rejects(supa.signUp('a@b.co', 'secret123'), e => e.code === 'user_already_exists');
});

test('a normal sign-up is pending, or a session', async () => {
  answer(200, { id: 'x', email: 'a@b.co', identities: [{ id: 'x', provider: 'email' }] });
  assert.deepEqual(await supa.signUp('a@b.co', 'secret123'), { pending: true });
  answer(200, { id: 'x', email: 'a@b.co' });                       // (older answers without identities)
  assert.deepEqual(await supa.signUp('a@b.co', 'secret123'), { pending: true });
  answer(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } });
  const r = await supa.signUp('a@b.co', 'secret123');
  assert.equal(r.session.access_token, 'tok');
  assert.equal(r.session.user.email, 'a@b.co');
});

test('which box an error is about', () => {
  for (const c of ['email_address_invalid', 'user_already_exists', 'email_exists', 'email_not_confirmed', 'user_not_found', 'email_address_not_authorized']) assert.equal(supa.authErrorField(c), 'email', c);
  for (const c of ['invalid_credentials', 'invalid_grant', 'weak_password', 'same_password']) assert.equal(supa.authErrorField(c), 'password', c);
  for (const c of ['network', 'timeout', 'over_email_send_rate_limit', 'over_request_rate_limit', 'captcha_failed', 'signup_disabled', '', undefined, null]) assert.equal(supa.authErrorField(c), null, String(c));
});

test('sign-in wording for a lost connection', () => {
  const net = new supa.SupaError('sync words', { code: 'network' });
  assert.equal(supa.authMessage(net, { online: false }), 'You’re offline. Connect to the internet to sign in. You can keep studying while offline.');
  assert.equal(supa.authMessage(net, { online: true }), 'Couldn’t reach the sync server. Check your connection and try again. You can keep studying meanwhile.');
  assert.equal(supa.authMessage(net), supa.authMessage(net, { online: true }));
  assert.equal(supa.authMessage(new supa.SupaError('x', { code: 'timeout' })), 'The sync server took too long to answer. Try again in a moment.');
  assert.equal(supa.authMessage(new Error('plain')), 'plain');
  assert.ok(!/safe on this device/.test(supa.authMessage(net)));
});

test('the new texts reach the person', async () => {
  answer(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  await assert.rejects(supa.signIn('a@b.co', 'x'), e => e.message === 'Wrong email or password. Check both, or tap Forgot password? below.');
  answer(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
  await assert.rejects(supa.signIn('a@b.co', 'x'), e => e.message.startsWith('Confirm your email first') && /spam folder/.test(e.message));
  answer(422, { error_code: 'user_already_exists', msg: 'User already registered' });
  await assert.rejects(supa.signUp('a@b.co', 'secret123'), e => /Tap Sign in instead, or Forgot password\?/.test(e.message));
  answer(400, { error_code: 'captcha_failed', msg: 'captcha verification process failed' });
  await assert.rejects(supa.signIn('a@b.co', 'x'), e => e.message === 'The “are you a person?” check didn’t go through. Try again.');
  answer(422, { error_code: 'email_address_not_authorized', msg: 'Email address not authorized' });
  await assert.rejects(supa.signUp('a@b.co', 'secret123'), e => /can’t send emails to that address yet/.test(e.message));
  answer(403, { error_code: 'user_banned', msg: 'User banned' });
  await assert.rejects(supa.signIn('a@b.co', 'x'), e => /has been blocked/.test(e.message));
  answer(422, { error_code: 'email_provider_disabled', msg: 'x' });
  await assert.rejects(supa.signUp('a@b.co', 'secret123'), e => /can’t be made right now/.test(e.message));
  answer(429, { error_code: 'over_request_rate_limit', msg: 'rate' });
  await assert.rejects(supa.signIn('a@b.co', 'x'), e => e.code === 'over_request_rate_limit' && /Too many tries/.test(e.message));
});

test('Send the link again: the address, the body and where the link opens', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  await supa.resendSignup('a@b.co', { redirectTo: 'https://x.example/app/' });
  assert.match(calls[0].url, /\/auth\/v1\/resend\?redirect_to=https%3A%2F%2Fx\.example%2Fapp%2F$/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { type: 'signup', email: 'a@b.co' });
  await supa.resendSignup('a@b.co', { captcha: 'tok' });
  assert.deepEqual(calls[1].body, { type: 'signup', email: 'a@b.co', gotrue_meta_security: { captcha_token: 'tok' } });
  answer(429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
  await assert.rejects(supa.resendSignup('a@b.co'), e => /Too many emails/.test(e.message));
});

test('a failed fetch or a module that could not load reads as a lost connection; other TypeErrors do not', () => {
  const net = supa.authMessage({ code: 'network' }, { online: true });
  const off = supa.authMessage({ code: 'network' }, { online: false });
  assert.equal(supa.authMessage(new TypeError('Failed to fetch dynamically imported module: https://x.example/js/captcha.js')), net);
  assert.equal(supa.authMessage(new TypeError('Failed to fetch')), net);
  assert.equal(supa.authMessage(new TypeError('Load failed'), { online: false }), off);
  assert.notEqual(supa.authMessage(new TypeError("Cannot read properties of undefined (reading 'x')")), net);
  assert.equal(supa.authMessage(new TypeError('x is not a function')), 'x is not a function');
});
