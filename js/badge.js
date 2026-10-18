// The due count on the app icon (navigator.setAppBadge). Works for the installed app on iPhone/iPad (iOS 16.4+, after
// the person allows notifications) and on desktop Chrome and Edge; elsewhere there is nothing to do and the
// setting is hidden. Off by default, a switch in Settings → Study → Reminders (this device only: `appBadge`).
//
// The number is Today's Start count for all decks. It is worked out with the same loadAll() Today uses, which reads
// every card, so it is never run per answer: changes are collected for 2 seconds, nothing runs during a Review or Play
// round (the round's end asks for one), and it runs at once when the app is put away (so the icon is right when you leave), but only if something changed. The last number is kept
// against a key of the data version, the study day and a 10-minute slot, so a quick return to the app reads nothing. The number is Today's
// Start count (the decks chosen on Today, otherwise all).
// The number cannot change while the app is closed (a web page cannot run then), so it is as of the last time you used the app.

import * as db from './db.js';
import { loadAll, countFor } from './study-data.js';
import { dayStart } from './days.js';
import { isIOS, isInstalled } from './install.js';
import { supported, applyBadge, makeRefresher } from './badge-logic.js';

export { supported, applyBadge, makeRefresher };

let refresher = null;
export const refreshBadge = () => refresher?.request();
export const refreshBadgeNow = () => refresher?.now({ fresh: true });

// Start-up: hook into the things that change the count.
export function initBadge() {
  if (refresher || !supported()) return;
  refresher = makeRefresher({
    // Today's Start count: the decks chosen on Today, otherwise all decks.
    compute: async () => {
      const data = await loadAll();
      const all = data.decks.map(d => d.id), chosen = data.settings.reviewDecks.filter(id => all.includes(id));
      return countFor(data, chosen.length ? chosen : all).total;
    },
    key: () => `${db.dataVersion()}|${dayStart()}|${Math.floor(Date.now() / 600000)}`,
    apply: n => applyBadge(navigator, n),
    enabled: async () => (await db.getSettings()).appBadge === true,
    held: () => document.body.classList.contains('focus')
  });
  db.onLocalChange(() => refresher.request());
  document.addEventListener('visibilitychange', () => { if (document.hidden) refresher.now(); else refresher.request(); });      // (nothing is read when the data hasn't changed, or mid-round)
  addEventListener('sync', e => { if (e.detail?.applied) refresher.request(); });
  refresher.request();
}

// iPhone only: the badge needs permission to send notifications (we send none). 'granted', 'denied', 'default' or 'n/a' when no question is needed.
export const needsPermission = () => isIOS() && typeof Notification !== 'undefined';
export async function askPermission() {
  if (!needsPermission()) return 'n/a';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

// What Settings shows: 'switch' (installed app on a browser that has the badge), 'install' (a hint: it works in the installed app) or ''.
export function badgeRow(nav = globalThis.navigator) {
  if (isInstalled()) return supported(nav) ? 'switch' : '';
  return supported(nav) || isIOS() ? 'install' : '';
}
