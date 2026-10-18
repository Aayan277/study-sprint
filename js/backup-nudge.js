// The "Last backup" line in Settings → Your data, and the gentle nudge when a backup is old. Pure logic, no page or database:
// app.js passes in what it knows and shows what comes back.
//
//   - lastBackup is when THIS device last saved a backup file (a local-only setting: the file lives on one device).
//   - The nudge appears only with a meaningful amount of data (50 cards or more) and a backup that is over 30 days old,
//     or none at all. It is one quiet line in Settings; there is no pop-up and nothing to dismiss.
//   - Signed in, the data is also on the server, so the wording is softer.

export const NUDGE_CARDS = 50;                 // fewer cards than this and a backup is not worth a reminder
export const NUDGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// "today", "yesterday", "12 days ago", "3 months ago".
export function agoText(at, now) {
  const days = Math.max(0, Math.floor((now - at) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

// { text, nudge }: the sentence for Settings, and whether it is the "time for a backup" kind (shown in amber).
export function backupNote({ lastBackup, cards, synced, now = Date.now() }) {
  const at = Number.isFinite(lastBackup) ? lastBackup : null;
  const old = at === null || now - at > NUDGE_DAYS * DAY;
  const nudge = old && cards >= NUDGE_CARDS;
  const status = at === null ? 'No backup yet on this device.' : `Last backup: ${agoText(at, now)}.`;
  if (!nudge) return { text: status, nudge: false };
  if (synced) return { text: `${status} Your cards are also in your sync account, but a file of your own is a good second copy.`, nudge };
  return { text: `${status} Your cards only live on this device, so it's a good time to save a backup file.`, nudge };
}
