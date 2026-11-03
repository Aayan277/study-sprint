// RWKV lab: is the lab switched on? Used by Review and Practice before they load anything else. Reads nothing unless the lab
// database already exists (it is never created here), so for anyone who has not opened the lab this does next to nothing.
import { labExists, openLab, get } from './rwkv-labdb.js';

export async function labActive() {
  try {
    if (!(await labExists())) return false;
    await openLab();
    const [settings, weights] = await Promise.all([get('meta', 'settings'), get('weights', 'current')]);
    return !!(settings && settings.shadow === true && weights);
  } catch { return false; }
}

// The lab's code for Review and Practice, or null when the lab is off. Asked once and remembered (so a Play round does not look the lab
// up for every answer, and callers hear the same answer in the order they asked); the lab forgets it (resetGate) when shadow mode or the
// weights change, and Review forgets it at the start of every session.
let cached = null;
export const resetGate = () => { cached = null; };
export const labModule = () => (cached ||= labActive().then(on => (on ? import('./rwkv-lab.js') : null)).catch(() => null));
