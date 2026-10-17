// Tags with "::" in them (Anki decks like AnKing: "#ak_step1_v12::#uworld::step::12345") read as folders.
// This file has the pure parts, tested by tests/tag-tree.test.js, and the small piece of page code the two tag
// screens share (Browse > Tools, and the "Study by tag or question ID" sheet): tagTreeHTML() and wireTagTree().
//
//   tagTree(cards)              the folders and tags as a tree of { path, name, count, own, children }
//   cardsUnder(cards, path)     cards with the tag `path`, or any tag below it
//   parseIds(text)              question IDs pasted from a question bank
//   matchIds(cards, ids)        which cards belong to those IDs (an ID is the last piece of a tag)
//
// Tags stay lower case (as they are saved). Folders and IDs are matched ignoring capitals.

// (Not imported from ui.js: that file needs a page, and the tests run without one.)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SEP = '::';
export const MAX_IDS = 5000;
const NATURAL = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// "a::::b" and "a::b" are the same tag for display and matching (empty pieces are dropped).
export const pieces = tag => String(tag ?? '').split(SEP).map(s => s.trim()).filter(Boolean);
export const normTag = tag => pieces(tag).join(SEP).toLowerCase();
export const hasFolders = cards => cards.some(c => (c.tags || []).some(t => String(t).includes(SEP)));

// ---------- the tree ----------
// A node: { path, name, count, own, children }
//   count  cards with this tag or any tag below it (a card counts once, however many of its tags are in here)
//   own    cards with exactly this tag (0 for a folder that is not a tag itself)
// Children are sorted by name, numbers in order.
export function tagTree(cards) {
  const nodes = new Map();
  const roots = [];
  const nodeFor = (path, name, parent) => {
    let n = nodes.get(path);
    if (!n) { n = { path, name, count: 0, own: 0, children: [] }; nodes.set(path, n); (parent ? parent.children : roots).push(n); }
    return n;
  };
  for (const card of cards) {
    const seen = new Set();
    for (const tag of card.tags || []) {
      const parts = pieces(tag).map(s => s.toLowerCase());
      let parent = null, path = '';
      parts.forEach((name, i) => {
        path = i ? path + SEP + name : name;
        const n = nodeFor(path, name, parent);
        if (!seen.has(path)) { seen.add(path); n.count++; }
        if (i === parts.length - 1) n.own++;
        parent = n;
      });
    }
  }
  const sort = list => { list.sort((a, b) => NATURAL.compare(a.name, b.name)); list.forEach(n => sort(n.children)); };
  sort(roots);
  return roots;
}

// Find a node by its path.
export function findNode(tree, path) {
  let list = tree, found = null;
  for (const part of pieces(path)) {
    found = list.find(n => n.name === part.toLowerCase()) || null;
    if (!found) return null;
    list = found.children;
  }
  return found;
}

// The cards with the tag `path`, or any tag below it. Ignores capitals.
export function cardsUnder(cards, path) {
  const p = normTag(path);
  if (!p) return [];
  return cards.filter(c => (c.tags || []).some(t => { const n = normTag(t); return n === p || n.startsWith(p + SEP); }));
}

// ---------- question IDs ----------
// What compares an ID: lower case, and a number without its leading zeros ("00123" = "123").
export const idKey = s => { const t = String(s ?? '').trim().toLowerCase(); return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t; };

// Pasted text → the IDs in it, in the order written, with no repeats (ignoring capitals and leading zeros). Words are split
// on spaces, line breaks, commas and semicolons; brackets, dots and the like around a word are trimmed. At most 5,000.
export function parseIds(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}#_]+|[^\p{L}\p{N}_]+$/gu, '');
    if (!token) continue;
    const k = idKey(token);
    if (seen.has(k)) continue;
    seen.add(k); out.push(token);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

// Which cards belong to these IDs? An ID matches a tag whose last piece equals it ("...::step::12345" is 12345).
//   under   only tags below this folder count (the folder chosen in "Look in")
// Returns
//   cards    the cards, in the order of the IDs (then the order of the cards); a card once
//   found    the IDs (as written) that matched          missing   the IDs that did not
//   sources  where the matches are, by the tag's folder: [{ path, ids, cards }] with the most IDs first. Not narrowed by `under`,
//            so the choice stays on screen.
export function matchIds(cards, ids, { under = '' } = {}) {
  const wanted = new Map();                      // key → the ID as written
  for (const id of ids) if (!wanted.has(idKey(id))) wanted.set(idKey(id), id);
  const hits = new Map();                        // key → [{ card, folder }]
  const folders = new Map();                     // folder → { path, ids: Set, cards: Set }
  for (const card of cards) {
    for (const tag of card.tags || []) {
      const parts = pieces(tag);
      if (!parts.length) continue;
      const k = idKey(parts[parts.length - 1]);
      if (!wanted.has(k)) continue;
      const folder = parts.slice(0, -1).join(SEP).toLowerCase();
      if (!hits.has(k)) hits.set(k, []);
      hits.get(k).push({ card, folder });
      let s = folders.get(folder);
      if (!s) folders.set(folder, s = { path: folder, ids: new Set(), cards: new Set() });
      s.ids.add(k); s.cards.add(card.id);
    }
  }
  const u = normTag(under);
  const inUnder = folder => !u || folder === u || folder.startsWith(u + SEP);
  const out = [], seenCards = new Set(), found = [], missing = [];
  for (const [k, id] of wanted) {
    const list = (hits.get(k) || []).filter(h => inUnder(h.folder));
    if (!list.length) { missing.push(id); continue; }
    found.push(id);
    for (const { card } of list) if (!seenCards.has(card.id)) { seenCards.add(card.id); out.push(card); }
  }
  const sources = [...folders.values()].map(s => ({ path: s.path, ids: [...s.ids].map(k => wanted.get(k)), cards: s.cards.size }))
    .sort((a, b) => b.ids.length - a.ids.length || b.cards - a.cards || NATURAL.compare(a.path, b.path));
  return { cards: out, found, missing, sources };
}

// "#ak_step1_v12::#uworld::step" → "#ak_step1_v12 › #uworld › step"
export const crumbs = path => pieces(path).join(' › ');

// ---------- the tree on the page ----------
// Draws one level of the tree: folders (with a toggle) and tags. The insides of a folder are drawn when it is first opened,
// so a deck with thousands of tags opens at once.
//   mode    'manage' (Browse > Tools: Rename, Remove and Show cards on each row) or 'pick' (choose a folder or a tag)
//   depth   how deep this level is (the indent stops at 6)
const INDENT_MAX = 6;
const countText = n => `${n.toLocaleString('en')} ${n === 1 ? 'card' : 'cards'}`;
export function tagTreeHTML(nodes, { mode = 'manage', depth = 0 } = {}) {
  const pad = `--depth:${Math.min(depth, INDENT_MAX)}`;
  const actions = n => mode === 'manage'
    ? `<span class="tf-acts"><button class="btn ghost small" type="button" data-tf-show>Show cards</button>
        <button class="btn ghost small" type="button" data-tf-rename>Rename</button>
        <button class="btn ghost small" type="button" data-tf-remove>Remove</button></span>`
    : `<span class="tf-acts"><button class="btn ghost small" type="button" data-tf-pick>Choose</button></span>`;
  return `<ul class="tag-tree" style="${pad}">${nodes.map(n => n.children.length ? `
    <li class="tag-folder" data-path="${esc(n.path)}">
      <div class="tf-row">
        <button class="tf-toggle" type="button" aria-expanded="false"><span class="tf-caret" aria-hidden="true">▸</span><span class="tag-name">${esc(n.name)}</span><span class="muted small">${countText(n.count)}</span></button>
        ${actions(n)}
      </div>
      <div class="tf-kids" hidden></div>
    </li>` : `
    <li class="tag-leaf" data-path="${esc(n.path)}">
      <div class="tf-row"><span class="tf-leaf"><span class="tag-name">${esc(n.name)}</span><span class="muted small">${countText(n.count)}</span></span>${actions(n)}</div>
    </li>`).join('')}</ul>`;
}

// The row for a folder that is also a tag itself ("a" and "a::b"): first among the folder's children.
const ownRowHTML = (n, mode) => `<ul class="tag-tree"><li class="tag-leaf tf-own" data-path="${esc(n.path)}" data-own>
  <div class="tf-row"><span class="tf-leaf"><span class="tag-name">(this tag)</span><span class="muted small">${countText(n.own)}</span></span>
  ${mode === 'manage' ? '<span class="tf-acts"><button class="btn ghost small" type="button" data-tf-show>Show cards</button><button class="btn ghost small" type="button" data-tf-rename>Rename</button><button class="btn ghost small" type="button" data-tf-remove>Remove</button></span>'
    : '<span class="tf-acts"><button class="btn ghost small" type="button" data-tf-pick>Choose</button></span>'}</div></li></ul>`;

// Open and close folders, and pass the buttons on.
//   root     the element holding the tree          tree   from tagTree()
//   on       { show(path), rename(path, node), remove(path, node), pick(path, node) }  (any may be missing)
export function wireTagTree(root, tree, { mode = 'manage', on = {} } = {}) {
  root.addEventListener('click', e => {
    const li = e.target.closest('li[data-path]');
    if (!li || !root.contains(li)) return;
    const path = li.dataset.path;
    const node = findNode(tree, path);
    if (!node) return;
    const toggle = e.target.closest('.tf-toggle');
    if (toggle && li.classList.contains('tag-folder')) {
      const kids = li.querySelector(':scope > .tf-kids');
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      if (open && !kids.dataset.drawn) {
        const depth = (path.split(SEP).length);
        kids.innerHTML = (node.own ? ownRowHTML(node, mode) : '') + tagTreeHTML(node.children, { mode, depth });
        kids.dataset.drawn = '1';
      }
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.tf-caret').textContent = open ? '▾' : '▸';
      kids.hidden = !open;
      return;
    }
    // A button on a row: the row's own li (the closest), not a folder above it.
    const act = e.target.closest('[data-tf-show],[data-tf-rename],[data-tf-remove],[data-tf-pick]');
    if (!act) return;
    const kind = Object.keys(act.dataset)[0].slice(2).toLowerCase();
    on[kind]?.(path, node, li);
  });
}
