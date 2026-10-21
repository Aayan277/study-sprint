// What the rest of the app may ask about syncing without loading the sync code (js/sync.js, which brings the server client,
// the merge and push code, and more). Today and the sidebar read the last result and the signed-in account on every start;
// the sync code itself is only loaded after the first screen is drawn (or when something needs it: Settings → Sync, a media
// download). sync.js writes the status here whenever it changes and re-exports these two reads, so
// `import { lastStatus, account } from './sync.js'` still works.
// Before sync.js has loaded the status reads as "never synced" ({ state: 'idle' }), never as an error.

import * as db from './db.js';

let last = { state: 'idle', at: 0, applied: 0, sent: 0, error: null };

export const lastStatus = () => last;
export const setStatus = status => { last = status; };

// Who's signed in on this device, or null.
export async function account() {
  const { syncAuth, syncState } = await db.getSettings();
  return syncAuth ? { email: syncAuth.user.email, id: syncAuth.user.id, lastSync: syncState?.lastSync || 0 } : null;
}
