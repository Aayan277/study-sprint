// Marks this build as the personal RWKV lab build. It never syncs (js/sync.js) and is never merged into main.
export const LAB_BUILD = true;

// Is the network layer shut? Always, in the lab build. The one exception is the node unit tests of the sync code, which stub `fetch`
// and say so with a global that only exists in node (a page has `document`, and nothing in the app sets the global).
export const labNetworkBlocked = () => LAB_BUILD && !(typeof document === 'undefined' && globalThis.__SS_TEST_NETWORK === true);
