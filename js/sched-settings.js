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
export function schedulerOptions(settings = {}) {
  const ls = parseSteps(settings.learningSteps ?? SCHED_DEFAULTS.learningSteps);
  const rs = parseSteps(settings.relearningSteps ?? SCHED_DEFAULTS.relearningSteps);
  const mi = parseMaxInterval(settings.maxInterval ?? SCHED_DEFAULTS.maxInterval);
  return {
    retention: settings.targetRetention ?? 0.9,
    learningSteps: ls.steps || parseSteps(SCHED_DEFAULTS.learningSteps).steps,
    relearningSteps: rs.steps || parseSteps(SCHED_DEFAULTS.relearningSteps).steps,
    maxInterval: mi.days || SCHED_DEFAULTS.maxInterval,
    fuzz: settings.fuzz ?? SCHED_DEFAULTS.fuzz
  };
}

// ---------- showing steps in plain words ----------
const UNIT_WORDS = { m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] };

// '10m' → '10 minutes', '1h' → '1 hour'
export function stepWords(step) {
  const [, n, u] = step.match(/^(\d+)([mhd])$/);
  return `${n} ${UNIT_WORDS[u][+n === 1 ? 0 : 1]}`;
}
// '10m' → '10 min' (for the small chips)
export const stepShort = step => step.replace(/^(\d+)m$/, '$1 min').replace(/^(\d+)h$/, '$1 h').replace(/^(\d+)d$/, '$1 d');

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
