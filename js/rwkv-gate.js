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
