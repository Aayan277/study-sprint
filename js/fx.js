// Motion: the small animations in Study Sprint, all in one place.
//   C1  rating feedback in Review (a ring on the button, the interval floating up, an outline of the old card leaving)
//   C2  the daily goal ring on Today (fills from where it was, counts along, turns green when the goal is done)
//   C3  the Review finish screen (count-up, streak flame, milestone pills, a small confetti burst)
//   C4  Play (combo flame, score count-up, the grade stamp and its numbers)
//   C5  screen changes between tabs (View Transitions)
// The look of each one is in styles.css (section 16). This file only starts them and cleans up after them.
//
// Rules this file keeps:
//   - Nothing that rates a card or answers a question ever waits for an animation. Everything here starts and returns.
//   - Reduced motion wins: with "reduce motion" on, nothing moves and numbers are just shown.
//   - Whatever is added to the page is removed again when its animation ends (and a timer removes it if the end never comes).
//   - Count-ups never change the real text: the animated number is drawn by CSS from data-n, and the real (final)
//     text stays in the page, so screen readers and live regions only ever see the final value.
//   - A failure in here must never break studying, so every entry point catches its own errors.

const RM = matchMedia('(prefers-reduced-motion: reduce)');
// The Clinical style is plain and calm: it has no pulses, pops, count-ups, confetti or sliding screens, so every effect
// here treats it like "reduce motion" (the final values simply show). Nothing else in this file needs to know.
export const reduced = () => RM.matches || document.documentElement.dataset.ui === 'clinical';

// The two switches in Settings → Appearance (this device only). app.js calls configure() whenever they change.
export const flags = { rating: true, smooth: true };
export function configure(settings = {}) {
  flags.rating = settings.ratingFeedback !== false;
  flags.smooth = settings.smoothMotion !== false;
  // styles.css uses this to keep the old sheet animation when Smooth transitions is off
  document.documentElement.dataset.smooth = flags.smooth ? 'on' : 'off';
}

// Small things remembered on this device (the last goal ring, the milestones seen, the day confetti last played).
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('study-sprint-fx-' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('study-sprint-fx-' + key, JSON.stringify(value)); } catch { /* fine without */ } }
};
const dayKey = () => new Date().toDateString();
const safe = (name, fn) => (...args) => { try { return fn(...args); } catch (err) { console.warn('motion:', name, err); } };

const make = (cls, props = {}, style = {}) => {
  const n = Object.assign(document.createElement('div'), { className: cls }, props);
  Object.assign(n.style, style);
  return n;
};
// Remove short-lived elements when their animation ends, or after `ms` whatever happens.
function tidy(nodes, ms) {
  const drop = () => nodes.forEach(n => n.remove());
  nodes.forEach(n => n.addEventListener('animationend', () => n.remove(), { once: true }));
  setTimeout(drop, ms);
}
// Run a one-shot CSS animation class again, and take the class off when it ends.
function pulse(el, cls) {
  if (!el || reduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth;                                   // restart the animation if it is still running
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

// ---------- C1. Review: rating feedback ----------
// Called by Review's answer() right after it has started saving, with the card on screen and the pressed button.
// It draws a coloured ring off the button, floats the new interval up, and leaves an outline of the old card (no text)
// that drifts away in a direction that belongs to the rating, while the next card rises in as usual. The outline is a plain
// box the size of the card (not a copy of it), so it has no text and no ids and no selector can mistake it for a card.
// The next card is never tinted: the colour only lives on the card that is leaving.
export const rated = safe('rated', (rating, card, btn) => {
  if (!flags.rating || reduced() || !card || !btn) return;
  const b = btn.getBoundingClientRect(), f = card.getBoundingClientRect();
  const ring = make('fx-ring', {}, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
  const ivl = make('fx-ivl', { textContent: btn.querySelector('span')?.textContent || '' }, { left: b.left + b.width / 2 + 'px', top: b.top - 4 + 'px' });
  const ghost = make('fx-ghost');                   // just the card's shape: no copy of the card, no text
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { left: f.left + 'px', top: f.top + 'px', width: f.width + 'px', height: f.height + 'px' });
  for (const n of [ring, ivl, ghost]) n.dataset.r = rating;       // styles.css reads the rating colour from this
  document.body.append(ghost, ring, ivl);
  tidy([ghost, ring, ivl], 1200);
});

// ---------- numbers that count up ----------
const easeOut = t => 1 - Math.pow(2, -10 * t);                  // easeOutExpo
const runs = new WeakMap();                                      // element → { token, v }: the count running on it and the number it shows now

// Split "1,234", "97%", "2.3s", "4/5" or "1:05" into something we can count.
function parseNumber(text) {
  const clock = /^(\d+):(\d{2})$/.exec(text);
  if (clock) return { to: +clock[1] * 60 + +clock[2], fmt: v => `${Math.floor(v / 60)}:${String(Math.round(v) % 60).padStart(2, '0')}` };
  const m = /^([^\d-]*)(-?\d[\d,]*)(\.\d+)?(.*)$/s.exec(text);
  if (!m) return null;
  const decimals = m[3] ? m[3].length - 1 : 0, grouped = m[2].includes(',');
  const to = parseFloat(m[2].replace(/,/g, '') + (m[3] || ''));
  const fmt = v => {
    const n = decimals ? v.toFixed(decimals) : grouped ? Math.round(v).toLocaleString() : String(Math.round(v));
    return m[1] + n + m[4];
  };
  return { to, fmt, clock: false };
}

// Count the number in `el` from `from` up to the number it already shows. The text in the page is never touched:
// it is the final value from the first moment (so screen readers and tests read the right thing), and while the
// count runs, styles.css hides it and draws the ticking number from data-n instead. Never longer than 700ms.
export function countUp(el, ms = 650, delay = 0, from = 0) {
  if (!el || reduced()) return;
  const p = parseNumber(el.textContent.trim());
  if (!p || !Number.isFinite(p.to)) return;
  if (el.closest('[aria-live]')) return;                         // a live region would read out every step
  const start = runs.has(el) ? runs.get(el).v : from;            // a count already running carries on from where it is
  if (start === p.to) return;
  const dur = Math.min(ms, 700);
  const t0 = performance.now() + delay;                          // one clock for everything (not rAF's own timestamp)
  const run = { v: start };
  runs.set(el, run);
  el.classList.add('fx-count');
  el.dataset.n = p.fmt(start);
  const step = () => {
    if (runs.get(el) !== run) return;                            // a newer count took over
    const t = Math.min(1, Math.max(0, (performance.now() - t0) / dur));
    run.v = start + (p.to - start) * easeOut(t);
    if (el.isConnected) el.dataset.n = p.fmt(run.v);
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
    else { el.classList.remove('fx-count'); delete el.dataset.n; runs.delete(el); }
  };
  requestAnimationFrame(step);
}

// ---------- C2. Today: the goal ring ----------
// Fills from the value last shown today to the value now (not from empty on every visit), counts the number along,
// and when the goal is reached turns green with a halo and a check that pops.
export const goalRing = safe('goalRing', (view, answered, goal) => {
  const ring = view.querySelector('.today-hero .ring');
  if (!ring) return;
  const fg = ring.querySelector('.ring-fg');
  const frac = goal ? Math.min(1, answered / goal) : 0;
  const saved = store.get('ring', null);
  const prev = saved && saved.day === dayKey() ? saved : null;
  store.set('ring', { day: dayKey(), frac, n: answered });
  const from = prev ? prev.frac : 0;
  const full = frac >= 0.999;
  const justDone = full && from < 0.999;
  if (reduced()) { ring.classList.toggle('is-full', full); return; }   // final values at once, green but still
  if (fg && Math.abs(frac - from) > 0.005) {
    const [len, circ] = fg.getAttribute('stroke-dasharray').split(' ').map(Number);
    fg.style.strokeDasharray = `${(from * circ).toFixed(2)} ${circ}`;       // start where it was last time
    fg.getBoundingClientRect();                                             // commit that start value
    fg.classList.add('fx-fill');
    requestAnimationFrame(() => { fg.style.strokeDasharray = `${len} ${circ}`; });
    const done = () => { fg.classList.remove('fx-fill'); fg.style.strokeDasharray = ''; };
    fg.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 1200);
    const num = ring.querySelector('.ring-in b');
    if (num && prev) countUp(num, 700, 0, prev.n);
    else if (num) countUp(num, 700, 0, 0);
  }
  if (justDone) {
    ring.classList.add('fx-win');                                           // the halo and the check pop
    setTimeout(() => ring.classList.add('is-full'), 700);                   // green as the fill arrives
    setTimeout(() => ring.classList.remove('fx-win'), 2200);
  } else ring.classList.toggle('is-full', full);
});

// ---------- C3. Review: the finish screen ----------
const MILESTONES = { 7: 'One week', 30: 'One month', 100: '100 days' };

// A tiny confetti, no library: ~40 slivers in the theme's colours, one burst from (x, y), gone in about 1.5 seconds.
export const confetti = safe('confetti', (x, y) => {
  if (reduced()) return;
  const cs = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--accent-text', '--good', '--easy', '--hard'].map(v => cs.getPropertyValue(v).trim() || '#888');
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const bits = Array.from({ length: 42 }, (_, i) => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9, v = 5 + Math.random() * 7;
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      w: 2.5 + Math.random() * 2.5, h: 7 + Math.random() * 6, c: colors[i % colors.length] };
  });
  const life = 1500, t0 = performance.now();
  let last = t0;
  const frame = () => {
    const now = performance.now(), t = (now - t0) / life, k = Math.min(3, (now - last) / 16.7);   // k: steps of 1/60s, so a slow frame doesn't slow the burst
    last = now;
    if (t >= 1 || !canvas.isConnected) { canvas.remove(); return; }
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of bits) {
      p.vy += 0.28 * k; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx * k; p.y += p.vy * k; p.r += p.vr * k;
      g.save();
      g.globalAlpha = Math.max(0, 1 - t * t);
      g.translate(p.x, p.y); g.rotate(p.r); g.scale(1, Math.cos(p.r * 2.2));      // the scale fakes a flutter
      g.fillStyle = p.c; g.beginPath();
      if (g.roundRect) g.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 1.5); else g.rect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.fill(); g.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setTimeout(() => canvas.remove(), 2600);                                          // if the tab was hidden and frames stopped
});

// Called when Review's finish screen has been drawn.
//   complete: the whole queue was finished (not "End" pressed early); reviewed: cards rated this session
// Numbers count up; the streak flame ignites; a 7 / 30 / 100 day streak gets a pill the first time it is reached;
// and confetti plays when the whole queue is done with 5 or more cards, at most once a day (a new milestone bypasses
// that daily limit, once).
export const finished = safe('finished', (view, { complete, reviewed }) => {
  const stats = view.querySelector('.stats4');
  const moving = !reduced();
  if (moving && stats) {
    stats.classList.add('fx-in');
    stats.querySelectorAll('.v').forEach((v, i) => countUp(v, 650, 80 + i * 50));
  }
  const streak = view.querySelector('.finish-next .streak.kept');
  let milestone = false;
  if (streak) {
    if (moving) streak.classList.add('fx-ignite');
    const days = +streak.querySelector('b')?.textContent || 0;
    const seen = store.get('miles', []);
    if (MILESTONES[days] && !seen.includes(days)) {
      milestone = true;
      store.set('miles', [...seen, days]);
      streak.querySelector('span')?.before(make('fx-mile-tag', { textContent: MILESTONES[days] }));
    }
  }
  const burst = complete && reviewed >= 5 && (milestone || store.get('burst', '') !== dayKey());
  if (!burst) return;
  if (!moving) return;
  store.set('burst', dayKey());
  view.querySelector('h1')?.classList.add('fx-glow-h1');
  const r = (stats || view).getBoundingClientRect();
  setTimeout(() => { if (view.isConnected) confetti(r.left + r.width / 2, r.top + 8); }, 180);
});

// ---------- C4. Play ----------
// The combo pill: tier 1 at x3, 2 at x5, 3 at x10 (a tier is just a colour, so it also shows with reduced motion),
// and a small bump each time the combo grows.
export const combo = safe('combo', (wrap, n) => {
  const tier = n >= 10 ? 3 : n >= 5 ? 2 : n >= 3 ? 1 : 0;
  if (tier) wrap.dataset.tier = tier; else delete wrap.dataset.tier;
  const before = +wrap.dataset.n || 0;
  wrap.dataset.n = n;
  if (n > before && n >= 3) pulse(wrap, 'fx-bump');
});
// The score counts up from the old total to the new one, with a bump.
export const score = safe('score', (el, from, to) => {
  if (to <= from) return;
  pulse(el.parentElement, 'fx-bump');
  countUp(el, 320, 0, from);
});
// Right after the grade stamp lands: the header nudges, then the score and the stats count up.
export const result = safe('result', view => {
  pulse(view.querySelector('.res-head'), 'fx-thud');
  countUp(view.querySelector('.res-n'), 700, 260);
  view.querySelectorAll('.stats4 .v').forEach((v, i) => countUp(v, 600, 320 + i * 50));
});

// ---------- C5. Screen changes ----------
// Tabs slide by their order (forward from the right, back from the left) with the header and tab bar staying still.
// Not used for Review and Play rounds, with reduced motion, or with the switch off. A browser without View Transitions
// gets a short fade-up on the new screen instead (route() asks for it with enterClass()).
const ORDER = ['today', 'decks', 'deck', 'browse', 'import', 'play', 'stats', 'settings'];
let wantEnter = false;
export const enterClass = () => { const on = wantEnter; wantEnter = false; return on ? ' fx-enter' : ''; };

export function transition(run, from, to) {
  const root = document.documentElement;
  const skip = !flags.smooth || reduced() || !from || !to || from === to || from === 'review' || to === 'review'
    || from === 'welcome' || to === 'welcome' || document.body.classList.contains('focus');
  if (skip) return run();
  if (!document.startViewTransition) { wantEnter = true; return run(); }
  root.dataset.vtDir = ORDER.indexOf(to) < ORDER.indexOf(from) && ORDER.indexOf(to) >= 0 ? 'back' : 'fwd';
  root.classList.add('vt-on');                                   // gives the header and tab bar their own layer (styles.css)
  // The old screen is captured first, then run() draws the new one inside the callback. The new screen is captured as
  // soon as it has drawn, or after 120ms, whichever is first, so a slow load can never hold the page up.
  const vt = document.startViewTransition(() => Promise.race([Promise.resolve(run()).catch(() => {}), new Promise(r => setTimeout(r, 120))]));
  const cleanup = () => { delete root.dataset.vtDir; root.classList.remove('vt-on'); };
  vt.finished.then(cleanup, cleanup);
  return vt.updateCallbackDone;
}
