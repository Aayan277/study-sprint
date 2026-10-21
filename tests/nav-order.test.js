// Deterministic model of Chromium's order for history.go(-n) plus a same-tick `location.hash = ...` (measured with probe/raw.mjs):
//   1. the hash commits at once: one new untagged entry; its hashchange task is queued and its popstate fires synchronously;
//   2. the traversal lands later (an IPC round trip), on the entry n below the one the go() was made from; the stray entry is dropped.
// What varies in a real browser is only whether (2) comes before or after the app's next setTimeout(0). Both orders are run here.
import test from 'node:test'; import assert from 'node:assert/strict'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const NAV = process.env.NAV ? path.resolve(process.env.NAV) : fileURLToPath(new URL('../js/nav.js', import.meta.url));
const tasks = []; let tick = 0;
globalThis.setTimeout = (fn, ms = 0) => { const t = { fn, at: tick + ms, id: tasks.length + 1 }; tasks.push(t); return t; };
globalThis.clearTimeout = t => { const i = tasks.indexOf(t); if (i >= 0) tasks.splice(i, 1); };
let listeners = {};
globalThis.addEventListener = (type, fn) => (listeners[type] ||= []).push(fn);
globalThis.dispatchEvent = e => { let stop = false; e.stopImmediatePropagation = () => { stop = true; }; for (const f of listeners[e.type] || []) { f(e); if (stop) break; } return true; };
globalThis.HashChangeEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
globalThis.document = { addEventListener() {} };
let entries, idx, pendingGo = null;
const fire = type => dispatchEvent({ type });
globalThis.history = {
  get length() { return entries.length; }, get state() { return entries[idx].state; },
  go(d) { pendingGo = { target: idx + d, base: entries.length }; },
  pushState(s, _t, url) { entries.splice(idx + 1); entries.push({ hash: url != null ? '#' + String(url).split('#')[1] : entries[idx].hash, state: s }); idx++; },
  replaceState(s, _t, url) { entries[idx] = { hash: url != null ? '#' + String(url).split('#')[1] : entries[idx].hash, state: s }; },
};
globalThis.location = {
  get hash() { return entries[idx].hash; }, get href() { return 'http://x/' + entries[idx].hash; }, pathname: '/', search: '',
  set hash(h) { entries.splice(idx + 1); entries.push({ hash: h, state: null }); idx++; setTimeout(() => fire('hashchange')); fire('popstate'); },
};
const landTraversal = () => { const g = pendingGo; pendingGo = null; entries.splice(g.base); idx = g.target; setTimeout(() => fire('hashchange')); fire('popstate'); };
const runTasks = async () => { for (let n = 0; n < 200 && tasks.length; n++) { tasks.sort((a, b) => a.at - b.at || a.id - b.id); const t = tasks.shift(); tick = t.at; t.fn(); await new Promise(r => setImmediate(r)); } };
const flush = () => new Promise(r => setImmediate(r));

let n = 0;
async function fresh() {         // a new copy of nav.js on a new history: [today]
  listeners = {}; tasks.length = 0; pendingGo = null;
  entries = [{ hash: '#/today', state: null }]; idx = 0;
  const nav = await import('file://' + NAV + '?' + ++n); nav.initNav();
  const shown = []; addEventListener('hashchange', () => shown.push(location.hash));
  return { nav, shown };
}

for (const tab of ['#/decks', '#/welcome']) for (const order of ['traversal first', 'timer first']) {
  test(`toTab(${tab}) + a same-tick stray address (${order}): the stray, made later, wins; the tab's entry is not written over`, async () => {
    const { nav, shown } = await fresh();
    // like app.js route(): an onboarded user's #/welcome is redirected to Today while it renders (inside nav's announce())
    addEventListener('hashchange', () => { if (location.hash === '#/welcome') nav.replace('#/today'); });
    const root = tab === '#/welcome' ? '#/today' : tab;
    nav.openOverlay(() => {}); await flush();                     // a sheet: [today(0), ov(1)]
    assert.equal(entries.length, 2);
    nav.toTab(tab); location.hash = '#/import';
    assert.ok(pendingGo, 'the tab switch issued history.go');
    if (order === 'traversal first') landTraversal();
    else { await flush(); const t = tasks.filter(t => t.at === tick); for (const x of t) { tasks.splice(tasks.indexOf(x), 1); x.fn(); } await flush(); await flush(); landTraversal(); }
    await runTasks(); await flush(); await runTasks();
    assert.equal(location.hash, '#/import');
    assert.equal(entries[0].hash, root, 'the bottom entry is the tab');
    assert.equal(entries.length, 2, 'no orphan entries');
    assert.equal(shown.at(-1), '#/import');
  });
}
