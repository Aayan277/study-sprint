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
