// Maths on cards: $x^2$ for a formula in a line, $$...$$ for one on its own, drawn by KaTeX.
// The functions up to "KaTeX" are pure (no page), tested by tests/math.test.js. KaTeX itself is only fetched
// from the CDN the first time a card with maths is shown (never at start-up), and the service worker keeps it.
//
// The rules are Pandoc's, so a price is not a formula:
//   $x^2$        inline maths. The opening $ has a non-space after it, the closing $ a non-space before it and no
//                digit after it, all on one line (at most 1000 characters). So "$5 and $10" is just text.
//   $$ ... $$    display maths: on its own line, may run over several lines
//   \( ... \)    inline and  \[ ... \]  display (what Anki writes)
//   \$           a dollar sign

export const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/';

const INLINE_MAX = 1000;
const DISPLAY_MAX = 20000;
// Private characters stand in for the maths while format.js does its work (cloze.js uses U+E000 to U+E00F).
const PRIVATE = /[-]/;
export const PLACEHOLDER_FIRST = 0xE100, PLACEHOLDER_LAST = 0xEFFF;
export const STRAY_PLACEHOLDER = /[-]/g;
const MASK_CHAR = '';

// Where the maths is: [{ start, end, tex, display }], in order. The text between is not maths.
function scan(text) {
  const out = [];
  if (!text.includes('$') && !text.includes('\\')) return out;
  const n = text.length;
  const add = (start, end, tex, display) => {
    if (!tex.trim() || PRIVATE.test(tex)) return false;
    out.push({ start, end, tex, display });
    return true;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const d = text[i + 1];
      if (d === '(' || d === '[') {
        const close = d === '(' ? '\\)' : '\\]';
        const at = text.indexOf(close, i + 2);
        if (at > 0 && at - i <= DISPLAY_MAX && add(i, at + 2, text.slice(i + 2, at), d === '[')) { i = at + 2; continue; }
      }
      i += 2;                                   // \$ and \\ and any other backslash pair: not an opener
      continue;
    }
    if (c !== '$') { i++; continue; }
    if (text[i + 1] === '$') {
      // $$ ... $$
      let j = i + 2, found = -1;
      while (j < n && j - i <= DISPLAY_MAX) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '$') { found = j; break; }
        j++;
      }
      if (found > 0 && add(i, found + 2, text.slice(i + 2, found), true)) { i = found + 2; continue; }
      i += 2;
      continue;
    }
    // $ ... $ on one line
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) {
      let j = i + 1, found = -1;
      while (j < n && j - i <= INLINE_MAX) {
        const d = text[j];
        if (d === '\n') break;
        if (d === '\\') { j += 2; continue; }
        if (d === '$') {
          // The first unescaped $ decides: it closes the maths if it hugs a word and no digit follows, else this wasn't maths.
          if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? '')) found = j;
          break;
        }
        j++;
      }
      if (found > 0 && add(i, found + 1, text.slice(i + 1, found), false)) { i = found + 1; continue; }
    }
    i++;
  }
  return out;
}

// "\$" → "$" in text that isn't maths (and "\\" stays as it is).
const unescapeDollar = s => (s.includes('\\') ? s.replace(/(\\\\)|\\\$/g, (m, bs) => bs || '$') : s);

// Text → [{ type: 'text', value } | { type: 'math', tex, display, raw }]. Fast path: no $ and no \ is one text piece.
export function splitMath(text) {
  const s = String(text ?? '');
  const found = scan(s);
  if (!found.length) return [{ type: 'text', value: unescapeDollar(s) }];
  const out = [];
  let at = 0;
  for (const m of found) {
    if (m.start > at) out.push({ type: 'text', value: unescapeDollar(s.slice(at, m.start)) });
    out.push({ type: 'math', tex: m.tex.trim(), display: m.display, raw: s.slice(m.start, m.end) });
    at = m.end;
  }
  if (at < s.length) out.push({ type: 'text', value: unescapeDollar(s.slice(at)) });
  return out;
}

export const hasMath = text => scan(String(text ?? '')).length > 0;

// Text with each maths piece replaced by fn(piece). The rest has its "\$" turned into "$".
export const replaceMath = (text, fn) => splitMath(text).map(s => (s.type === 'math' ? fn(s) : s.value)).join('');

// The same text, the same length, with the maths characters replaced by a private character: so a search for a
// separator (import.js) never finds one inside a formula.
export function maskMath(text) {
  const s = String(text ?? '');
  const found = scan(s);
  if (!found.length) return s;
  let out = '', at = 0;
  for (const m of found) { out += s.slice(at, m.start) + MASK_CHAR.repeat(m.end - m.start); at = m.end; }
  return out + s.slice(at);
}

// Swap each maths piece for one private character (the text is otherwise untouched), so formatting marks are never
// read inside a formula. items[i] is the piece behind the character PLACEHOLDER_FIRST + i. unholdMath puts them back.
export function holdMath(text) {
  const s = String(text ?? '');
  const found = scan(s).slice(0, PLACEHOLDER_LAST - PLACEHOLDER_FIRST + 1);
  if (!found.length) return { text: s, items: [] };
  let out = '', at = 0;
  const items = found.map((m, k) => {
    out += s.slice(at, m.start) + String.fromCharCode(PLACEHOLDER_FIRST + k);
    at = m.end;
    return { tex: m.tex.trim(), display: m.display, raw: s.slice(m.start, m.end) };
  });
  return { text: out + s.slice(at), items };
}
export const unholdMath = (text, items, fn) => (items.length
  ? text.replace(STRAY_PLACEHOLDER, ch => { const it = items[ch.charCodeAt(0) - PLACEHOLDER_FIRST]; return it ? fn(it) : ''; })
  : text);
export { unescapeDollar };

// ---------- the editor's ∑ button on a plain text box ----------
// Wrap the selection in $...$, or take the $ off again if it is already wrapped. Nothing selected: an empty pair
// with the cursor inside. Returns the new text and the selection, like toggleWrap in format.js.
export function wrapMath(value, start, end) {
  let sel = value.slice(start, end);
  const lead = sel.match(/^\s*/)[0].length, trail = sel.slice(lead).match(/\s*$/)[0].length;
  start += lead; end -= trail; sel = value.slice(start, end);
  if (sel && value[start - 1] === '$' && value[end] === '$' && value[start - 2] !== '$' && value[end + 1] !== '$') {
    return { value: value.slice(0, start - 1) + sel + value.slice(end + 1), start: start - 1, end: end - 1 };
  }
  if (sel.length > 2 && sel.startsWith('$') && sel.endsWith('$') && !sel.startsWith('$$')) {
    const inner = sel.slice(1, -1);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  if (!sel) return { value: value.slice(0, start) + '$$' + value.slice(end), start: start + 1, end: start + 1 };
  return { value: value.slice(0, start) + '$' + sel + '$' + value.slice(end), start: start + 1, end: end + 1 };
}

// ---------- maths as plain words ----------
const GREEK = {
  alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', epsilon: 'epsilon', varepsilon: 'epsilon', zeta: 'zeta', eta: 'eta',
  theta: 'theta', vartheta: 'theta', iota: 'iota', kappa: 'kappa', lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', pi: 'pi',
  rho: 'rho', sigma: 'sigma', tau: 'tau', upsilon: 'upsilon', phi: 'phi', varphi: 'phi', chi: 'chi', psi: 'psi', omega: 'omega',
  Gamma: 'Gamma', Delta: 'Delta', Theta: 'Theta', Lambda: 'Lambda', Xi: 'Xi', Pi: 'Pi', Sigma: 'Sigma', Phi: 'Phi', Psi: 'Psi', Omega: 'Omega'
};
// Commands whose argument is the words themselves.
const TEXTLIKE = new Set(['text', 'textbf', 'textit', 'textrm', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathbb', 'mathcal', 'operatorname', 'boldsymbol', 'bm', 'emph', 'mbox', 'hbox', 'displaystyle', 'textstyle']);
const FRACS = new Set(['frac', 'dfrac', 'tfrac', 'cfrac']);
const PLAIN_SYMBOL = { infty: 'infinity', leq: '<=', le: '<=', geq: '>=', ge: '>=', neq: '!=', ne: '!=', approx: '~=', pm: '+-', to: '->', rightarrow: '->', leftarrow: '<-', cdot: ' ', times: ' ', div: '/', ldots: '...', dots: '...', cdots: '...', circ: 'degrees', degree: 'degrees' };
const SPOKEN_SYMBOL = {
  infty: 'infinity', leq: 'less than or equal to', le: 'less than or equal to', geq: 'greater than or equal to', ge: 'greater than or equal to',
  neq: 'not equal to', ne: 'not equal to', approx: 'approximately', pm: 'plus or minus', to: 'to', rightarrow: 'goes to', leftarrow: 'comes from',
  cdot: 'times', times: 'times', div: 'divided by', int: 'integral', iint: 'double integral', oint: 'integral', sum: 'sum', prod: 'product',
  lim: 'limit', sin: 'sine', cos: 'cosine', tan: 'tangent', log: 'log', ln: 'natural log', exp: 'exp', partial: 'partial', nabla: 'nabla',
  ldots: 'and so on', dots: 'and so on', cdots: 'and so on', in: 'in', forall: 'for all', exists: 'there exists', circ: 'degrees', degree: 'degrees'
};

// One argument at s[i]: a {group} (balanced) or a single character / command. Returns [content, next index].
function arg(s, i) {
  while (s[i] === ' ') i++;
  if (i >= s.length) return ['', i];
  if (s[i] === '{') {
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
    }
    return [s.slice(i + 1, j), Math.min(j + 1, s.length)];
  }
  if (s[i] === '\\') { const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); return [m[0], i + m[0].length]; }
  return [s[i], i + 1];
}

// The walk shared by both outputs. mode 'plain' makes typed-answer text, 'speech' makes words to say.
function walk(tex, mode) {
  const speech = mode === 'speech';
  const sub = t => walk(t, mode);
  let out = '';
  const s = String(tex);
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
      if (!m) {                                   // \\ \, \; \{ \% ...
        const d = s[i + 1] ?? '';
        i += 2;
        if (d === '\\' || d === ',' || d === ';' || d === ':' || d === ' ') out += ' ';
        else if (d === '!') continue;
        else out += d;
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (FRACS.has(name)) {
        const [a, i1] = arg(s, i), [b, i2] = arg(s, i1);
        i = i2;
        const A = sub(a), B = sub(b);
        if (speech) out += ` ${A} over ${B} `;
        else { const wrap = t => (/^[\w.]+$/.test(t) ? t : `(${t})`); out += `${wrap(A)}/${wrap(B)}`; }
      } else if (name === 'sqrt') {
        let index = '';
        if (s[i] === '[') { const e = s.indexOf(']', i); if (e > 0) { index = s.slice(i + 1, e); i = e + 1; } }
        const [a, i1] = arg(s, i);
        i = i1;
        const A = sub(a);
        if (speech) out += ` ${index ? `${sub(index)}th root` : 'square root'} of ${A} `;
        else out += index ? `root${sub(index)}(${A})` : `sqrt(${A})`;
      } else if (TEXTLIKE.has(name)) {
        if (name === 'displaystyle' || name === 'textstyle') continue;
        const [a, i1] = arg(s, i);
        i = i1;
        out += ` ${a.replace(/\\[,;: !]/g, ' ')} `.replace(/[{}]/g, '');
      } else if (GREEK[name]) {
        out += ` ${GREEK[name]} `;
      } else if (speech && SPOKEN_SYMBOL[name]) {
        out += ` ${SPOKEN_SYMBOL[name]} `;
      } else if (!speech && PLAIN_SYMBOL[name] !== undefined) {
        out += PLAIN_SYMBOL[name];
      }
      // any other command (\left, \right, \quad ...) is dropped
      continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (speech) {
      if (c === '^') {
        const [a, i1] = arg(s, i + 1);
        i = i1;
        const A = sub(a).trim();
        out += A === '2' ? ' squared ' : A === '3' ? ' cubed ' : ` to the power ${A} `;
        continue;
      }
      if (c === '_') {
        const [a, i1] = arg(s, i + 1);
        i = i1;
        out += ` sub ${sub(a).trim()} `;
        continue;
      }
      const word = { '=': 'equals', '+': 'plus', '-': 'minus', '−': 'minus', '/': 'over', '<': 'is less than', '>': 'is greater than', '*': 'times', '!': 'factorial', '%': 'percent', '|': 'absolute value' }[c];
      if (word) { out += ` ${word} `; i++; continue; }
      if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',' || c === '&') { out += ' '; i++; continue; }
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// \frac{a}{b} → a/b, \sqrt{x} → sqrt(x), Greek letters → names, \text{..} → its words, unknown commands dropped.
export const texToPlain = tex => walk(tex, 'plain');

// What a speech engine should say: "x squared", "a over b", "square root of x", "integral" ...
export const texToSpeech = tex => walk(tex, 'speech');

// ---------- KaTeX (fetched when a card with maths is first shown) ----------
let loading = null, tries = 0;
export function loadKatex() {
  if (loading) return loading;
  const css = new Promise((ok, fail) => {
    if (document.querySelector('link[data-katex]')) { ok(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = KATEX_BASE + 'katex.min.css'; link.dataset.katex = '1';
    link.onload = () => ok();
    link.onerror = () => { link.remove(); fail(new Error('KaTeX styles did not load')); };
    document.head.append(link);
  });
  // A module that failed once stays failed for its address, so a retry asks for a new one.
  const url = KATEX_BASE + 'katex.mjs' + (tries++ ? `?again=${tries}` : '');
  loading = Promise.all([import(/* @vite-ignore */ url), css]).then(([mod]) => {
    warmFonts();
    return mod.default || mod;
  }).catch(err => { loading = null; throw err; });
  return loading;
}

// Once KaTeX has worked, fetch its main fonts quietly so the service worker has them for offline use.
const CORE_FONTS = ['Main-Regular', 'Math-Italic', 'Main-Italic', 'Main-Bold', 'Size1-Regular', 'Size2-Regular', 'AMS-Regular'];
let warmed = false;
function warmFonts() {
  if (warmed) return;
  warmed = true;
  const go = () => CORE_FONTS.forEach(f => fetch(`${KATEX_BASE}fonts/KaTeX_${f}.woff2`).catch(() => {}));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 5000 }); else setTimeout(go, 2000);
}

// Draw every formula under root that has not been drawn yet. Loads nothing when there are none.
export async function renderMath(root = document.body) {
  const spans = [...(root.matches?.('.tex:not([data-done])') ? [root] : []), ...root.querySelectorAll('.tex:not([data-done])')];
  if (!spans.length) return;
  let katex;
  try { katex = await loadKatex(); } catch {
    for (const el of spans) {
      if (el.dataset.done) continue;
      el.dataset.done = 'raw';
      el.classList.add('tex-raw');
      el.title = "Maths shows after you've been online once";
    }
    return;
  }
  for (const el of spans) {
    if (el.dataset.done || !el.isConnected) continue;
    el.dataset.done = '1';
    try {
      katex.render(el.dataset.tex || '', el, {
        displayMode: el.classList.contains('tex-d'), throwOnError: false, trust: false, strict: 'ignore',
        output: 'htmlAndMathml', maxSize: 10, maxExpand: 1000, errorColor: 'currentColor'
      });
    } catch (err) {
      console.error(err);
      el.classList.add('tex-raw');
    }
  }
  spans.forEach(fit);
  document.fonts?.ready.then(() => spans.forEach(fit)).catch(() => {});      // the maths fonts change the widths
}

// A formula wider than the space it is in scrolls inside its own box (the page never scrolls sideways). It becomes
// reachable by keyboard when it does.
function fit(el) {
  if (!el.isConnected || el.classList.contains('tex-raw')) return;
  if (el.classList.contains('tex-d')) { if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0; return; }
  const inner = el.firstElementChild;
  let box = el.parentElement;
  while (box && getComputedStyle(box).display === 'inline') box = box.parentElement;
  if (inner && box && inner.getBoundingClientRect().width > box.clientWidth + 1) { el.classList.add('tex-scroll'); el.tabIndex = 0; }
}

// Keeps the page's formulas drawn: anything added later is drawn, and formulas that could not load try again
// when the phone comes back online. Called once by app.js.
export function watchMath() {
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; renderMath(document.body).catch(err => console.error(err)); });
  };
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches?.('.tex') || n.querySelector?.('.tex'))) { later(); return; }
    }
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('online', () => {
    document.querySelectorAll('.tex-raw[data-done="raw"]').forEach(el => { el.classList.remove('tex-raw'); el.removeAttribute('title'); delete el.dataset.done; });
    later();
  });
  later();
}
