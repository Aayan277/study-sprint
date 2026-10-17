// Advanced scheduling settings (Settings → Study → Advanced): checking what you type and turning
// your settings into options for the FSRS scheduler. Pure functions, tested by tests/sched.test.js.

export const SCHED_DEFAULTS = {
  learningSteps: '1m 10m',     // short gaps for a new card before it "graduates"
  relearningSteps: '10m',      // short gaps after you forget a card
  maxInterval: 36500,          // longest gap in days (36500 ≈ 100 years, i.e. no limit)
  fuzz: true                   // spread due dates out a little so cards added together don't bunch up
};

export const MAX_INTERVAL_PRESETS = [[30, '1 month'], [90, '3 months'], [180, '6 months'], [365, '1 year'], [36500, 'No limit']];
const MAX_STEPS = 10;

// "1m 10m" → { steps: ['1m', '10m'] }, or { error: '...' } if something can't be read.
// Units: m (minutes), h (hours), d (days). Commas or spaces between steps. Empty means no steps.
export function parseSteps(text) {
  const parts = String(text ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length > MAX_STEPS) return { error: `Use ${MAX_STEPS} steps or fewer.` };
  const steps = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*(m|min|h|hr|d|day)s?$/i);
    if (!m || +m[1] <= 0) return { error: `"${p}" isn't a step. Use a number then m, h or d, like 10m, 1h or 1d.` };
    const unit = m[2][0].toLowerCase();
    if ((unit === 'm' && +m[1] > 1440 * 30) || (unit === 'h' && +m[1] > 24 * 30) || (unit === 'd' && +m[1] > 30)) {
      return { error: `"${p}" is too long for a step. Keep steps under 30 days.` };
    }
    steps.push(`${+m[1]}${unit}`);
  }
  return { steps };
}

// Steps written back out the way they're shown in the box.
export const formatSteps = steps => steps.join(' ');

// A whole number of days from 1 to 36500, or an error.
export function parseMaxInterval(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { error: 'Use a whole number of days, 1 or more.' };
  return { days: Math.min(n, 36500) };
}

// Everything the scheduler needs, from the saved settings. Anything unreadable falls back to the default.
// A deck's options: its own scheduling settings (deck.options, same names as Settings) where it has them,
// otherwise the overall ones.
// Your own FSRS parameters (fsrsParams) are the same for every deck, so a deck's options never override them.
export function deckSchedulerOptions(settings, deck) {
  return schedulerOptions(deck?.options ? { ...settings, ...deck.options, fsrsParams: settings?.fsrsParams } : settings);
}

// ---------- your own FSRS parameters ----------
// The synced setting `fsrsParams` (fitted by js/fsrs-fit.js, see docs/design/fsrs-optimizer-plan.md section 6):
//   { w: [21 numbers] | null, at, reviews, cards, logLoss: { before, after }, rmse: { before, after }, version: 'fsrs-6' }
// w is null after "Reset to default" (the value is kept, not deleted, because a stamped value syncs and a missing one does not).
export const FSRS_VERSION = 'fsrs-6';
export const FSRS_W_COUNT = 21;

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const pair = o => (o && typeof o === 'object' && isNum(o.before) && isNum(o.after) ? { before: o.before, after: o.after } : undefined);

// The value if it can be used, as a clean copy with only the known fields; otherwise null (= the standard settings).
// Used wherever the value comes in: when settings are read, from the server, and from a backup. (The scheduler still
// clips every weight to its allowed range, so a wild number can't break it.)
export function cleanFsrsParams(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== FSRS_VERSION) return null;
  if (v.w !== null && !(Array.isArray(v.w) && v.w.length === FSRS_W_COUNT && v.w.every(isNum))) return null;
  const out = { w: v.w === null ? null : [...v.w] };
  if (isNum(v.at)) out.at = v.at;
  for (const k of ['reviews', 'cards']) if (Number.isInteger(v[k]) && v[k] >= 0) out[k] = v[k];
  for (const k of ['logLoss', 'rmse']) { const p = pair(v[k]); if (p) out[k] = p; }
  out.version = FSRS_VERSION;
  return out;
}

// The forgetting-curve decay (w20) the exam and readiness maths should use: your own, or undefined for the default.
// Kept inside the range the scheduler allows (0.1 to 0.8), so the numbers agree with it.
export function personalW20(settings) {
  const w = cleanFsrsParams(settings?.fsrsParams)?.w;
  return w ? Math.min(0.8, Math.max(0.1, w[20])) : undefined;
}

export function schedulerOptions(settings = {}) {
  const ls = parseSteps(settings.learningSteps ?? SCHED_DEFAULTS.learningSteps);
  const rs = parseSteps(settings.relearningSteps ?? SCHED_DEFAULTS.relearningSteps);
  const mi = parseMaxInterval(settings.maxInterval ?? SCHED_DEFAULTS.maxInterval);
  const w = cleanFsrsParams(settings.fsrsParams)?.w;
  return {
    retention: settings.targetRetention ?? 0.9,
    learningSteps: ls.steps || parseSteps(SCHED_DEFAULTS.learningSteps).steps,
    relearningSteps: rs.steps || parseSteps(SCHED_DEFAULTS.relearningSteps).steps,
    maxInterval: mi.days || SCHED_DEFAULTS.maxInterval,
    fuzz: settings.fuzz ?? SCHED_DEFAULTS.fuzz,
    ...(w ? { w } : {})                      // your own FSRS weights (left out when the standard ones are used)
  };
}

// ---------- showing steps in plain words ----------
const UNIT_WORDS = { m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] };

// '10m' → '10 minutes', '1h' → '1 hour'
export function stepWords(step) {
  const [, n, u] = step.match(/^(\d+)([mhd])$/);
  return `${n} ${UNIT_WORDS[u][+n === 1 ? 0 : 1]}`;
}

// How long a step is in minutes, so steps can be kept in order.
const stepMinutes = step => { const [, n, u] = step.match(/^(\d+)([mhd])$/); return +n * { m: 1, h: 60, d: 1440 }[u]; };
export const sortSteps = steps => [...steps].sort((a, b) => stepMinutes(a) - stepMinutes(b));

// What each rating button does with these steps, as [button, what happens] pairs.
// (Checked against ts-fsrs: Again always goes back to step 1, Good moves to the next step, Good on the
// last step finishes the steps, and Easy skips them.)
// kind: 'learning' (new cards) or 'relearning' (cards you forgot).
export function explainSteps(steps, kind) {
  const done = kind === 'learning' ? 'moves on to normal reviews (days apart)' : 'goes back to normal reviews';
  if (!steps.length) return [['Any button', `No steps: the card ${done} straight away.`]];
  const out = [['Again', `back in ${stepWords(steps[0])} (step 1)`]];
  if (steps.length > 1) {
    out.push(['Good', `moves to the next step: ${steps.slice(1).map((s, i) => `${stepWords(s)} (step ${i + 2})`).join(', then ')}`]);
    out.push(['Good on the last step', done]);
  } else {
    out.push(['Good', done]);
  }
  out.push(['Easy', `skips the steps and ${done}`]);
  return out;
}
