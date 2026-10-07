// What counts as "today". Like Anki, a new day starts at 4am, not midnight,
// so a late-night study session still counts toward the day you started it.

export const ROLLOVER_HOUR = 4;

// When the current study day began (a timestamp in milliseconds).
export function dayStart(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  return d.getTime();
}

// When the current study day ends. Anything due before this is "due today".
export function dayEnd(now = Date.now(), daysAhead = 0) {
  const d = new Date(dayStart(now));
  d.setDate(d.getDate() + 1 + daysAhead); // setDate handles months and daylight-saving changes
  return d.getTime();
}
