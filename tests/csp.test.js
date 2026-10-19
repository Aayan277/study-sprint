// The Content-Security-Policy in index.html (and the captcha frame's own) names the page's inline scripts by SHA-256 fingerprint.
// Edit one of those scripts and the browser stops running it, so this recomputes the fingerprints and fails when they drift.
// (That nothing the app does is blocked by the policy is tests/browser/e2e-csp.mjs, and the whole browser suite.) Run with: node tests/csp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SUPABASE_URL } from '../js/sync-config.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const cspOf = html => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
const parse = csp => Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([name, ...src]) => [name, src]));
const inlineScripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const hash = body => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`;

const html = read('index.html'), policy = parse(cspOf(html) || '');

test('index.html has a Content-Security-Policy, in the head before any script or link', () => {
  assert.ok(cspOf(html), 'no CSP meta tag');
  const at = html.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(at > 0 && at < html.indexOf('<script') && at < html.indexOf('<link'));
});

test('the script-src fingerprints are exactly those of the inline scripts in index.html', () => {
  const listed = policy['script-src'].filter(s => s.startsWith("'sha256-")).sort();
  const actual = inlineScripts(html).map(hash).sort();
  assert.equal(actual.length, 3, 'expected the theme script, the import map and the Clinical loader');
  assert.deepEqual(listed, actual, 'an inline script in index.html changed: put these in the CSP script-src instead: ' + actual.join(' '));
});

test('scripts: no unsafe-inline, no unsafe-eval; WebAssembly and blob scripts are allowed', () => {
  const s = policy['script-src'];
  assert.ok(!s.includes("'unsafe-inline'") && !s.includes("'unsafe-eval'") && !s.includes('*') && !s.includes('https:'));
  assert.ok(s.includes("'wasm-unsafe-eval'") && s.includes('blob:') && s.includes("'self'"));
  assert.equal(policy['default-src'].join(), "'self'");
  assert.equal(policy['child-src'].join(' '), "'self' blob:", 'older Safari uses child-src for workers');
  assert.equal(policy['object-src'].join(), "'none'");
  assert.equal(policy['base-uri'].join(), "'self'");
  assert.equal(policy['form-action'].join(), "'self'");
});

test('the sync server in js/sync-config.js is allowed to connect, and Google Fonts is gone', () => {
  assert.ok(policy['connect-src'].includes(new URL(SUPABASE_URL).origin), 'the Supabase address is not in connect-src');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(cspOf(html)));
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'index.html still loads Google Fonts');
});

test('every other site the code talks to is allowed by the policy', () => {
  const allowed = new Set(Object.values(policy).flat());
  const sources = fs.readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => read('js/' + f)).join('\n');
  const hosts = new Set();
  // Only addresses the page loads or fetches (not the AI sites it opens as links, which a policy does not govern).
  for (const m of sources.matchAll(/https:\/\/(cdn\.jsdelivr\.net|cdn\.sheetjs\.com|docs\.google\.com)\//g)) hosts.add('https://' + m[1]);
  for (const h of hosts) assert.ok(allowed.has(h), h + ' is used by the app but is not in the CSP');
});

test('the captcha frame has its own policy, with the provider hosts and its inline script fingerprinted', () => {
  const frame = read('js/captcha-frame.html'), p = parse(cspOf(frame) || '');
  assert.ok(cspOf(frame), 'no CSP in captcha-frame.html');
  assert.ok(p['script-src'].includes('https://challenges.cloudflare.com') && p['frame-src'].includes('https://challenges.cloudflare.com'));
  assert.ok(p['connect-src'].includes('https://challenges.cloudflare.com'));
  assert.ok(!p['script-src'].includes("'unsafe-inline'") && !p['script-src'].includes("'unsafe-eval'"));
  assert.equal(p['default-src'].join(), "'none'");
  assert.deepEqual(p['script-src'].filter(s => s.startsWith("'sha256-")), inlineScripts(frame).map(hash));
});

test('no inline event handlers or javascript: links in the page or in HTML the code writes (the policy would block them)', () => {
  const sources = fs.readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js') || f.endsWith('.html')).map(f => f + '\n' + read('js/' + f)).join('\n');
  assert.ok(!/<[a-z][^>]*\son(click|load|error|change|input|submit|focus|blur|key\w+|mouse\w+)\s*=/i.test(html + sources));
  assert.ok(!/href\s*=\s*["']javascript:/i.test(html + sources));
});
