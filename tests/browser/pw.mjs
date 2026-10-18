// Finds Playwright (the tool that drives a real browser): installed in this project
// (npm install --no-save playwright), or the copy that comes with Claude Code's cloud computers.
let pw;
try { pw = await import('playwright'); } catch {
  pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
}
// Under run.mjs the app is served on a free port (APP_PORT), not 8123: every browser maps localhost:8123 to it,
// so tests keep their http://localhost:8123 addresses and parallel runs never clash. Run alone, it is 8123 as before.
const PORT_MAP = process.env.APP_PORT ? [`--host-resolver-rules=MAP localhost:8123 127.0.0.1:${process.env.APP_PORT}`] : [];
const withPortMap = (opts = {}) => ({ ...opts, args: [...(opts.args || []), ...PORT_MAP] });
// Requests made from Node (page.request / context.request) don't go through the browser's address map, so they are
// pointed at the run's port here.
const toPort = url => (process.env.APP_PORT && typeof url === 'string') ? url.replace(/^http:\/\/localhost:8123\b/, `http://127.0.0.1:${process.env.APP_PORT}`) : url;
function mapRequests(ctx) {
  const r = ctx.request;
  for (const m of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']) { const f = r[m].bind(r); r[m] = (url, ...a) => f(toPort(url), ...a); }
  return ctx;
}
async function launchMapped(opts, ...rest) {
  const browser = await pw.chromium.launch(withPortMap(opts), ...rest);
  const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
  browser.newContext = async (...a) => mapRequests(await newContext(...a));
  browser.newPage = async (...a) => { const page = await newPage(...a); mapRequests(page.context()); return page; };
  return browser;
}
// CPU_THROTTLE=4 slows every page's main thread 4x (CDP Emulation.setCPUThrottlingRate) to reproduce a loaded machine.
// Workers are not slowed by it, which is also how a real busy main thread looks.
const THROTTLE = Number(process.env.CPU_THROTTLE) || 1;
function cpuThrottle(ctx) {
  if (THROTTLE <= 1) return;
  ctx.on('page', async page => {
    try { await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); } catch { /* page already closed */ }
  });
}
export const realChromium = { launch: launchMapped };

// A brand-new install opens on the first-run start (js/onboarding.js) instead of the sample deck.
// Almost every test wants the old behaviour (the sample deck is there on first load), so `chromium` here
// gives every new browser window the "skip onboarding" flag in localStorage (the app also accepts
// ?skipOnboarding in the address). e2e-onboarding.mjs uses `realChromium` to see the real first run.
const SKIP = () => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } };
// Signing in on a device that has cards of its own now asks first ("Add these N cards to your account" / "Start fresh" / "Cancel").
// Most tests build a device with cards and then sign in on purpose to merge them, so `chromium` taps "Add these cards" when the
// question appears. e2e-devices.mjs tests the question itself with `realChromium`, which does not.
const ADD_WHEN_ASKED = () => {
  const tap = () => document.getElementById('devAdd')?.click();
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(tap).observe(document.documentElement, { childList: true, subtree: true }));
};
export const chromium = {
  launch: async (...args) => {
    const browser = await realChromium.launch(...args);
    const newContext = browser.newContext.bind(browser);
    // Reduced motion is on by default in the tests (the motion code skips its effects, so screens, sheets and counts settle at
    // once and the checks are deterministic). e2e-motion.mjs asks for 'no-preference' to test the effects themselves.
    browser.newContext = async (opts = {}, ...rest) => {
      const ctx = await newContext({ reducedMotion: 'reduce', ...opts }, ...rest);
      await ctx.addInitScript(SKIP);
      await ctx.addInitScript(ADD_WHEN_ASKED);
      cpuThrottle(ctx);
      return ctx;
    };
    return browser;
  }
};

// A deck page keeps Edit deck, Add subdeck and Export in its ⋯ menu (#deckMore). Opens it (safe to call when it is already open).
export async function deckMenu(page) {
  await page.waitForSelector('#deckMore');
  if (!(await page.isVisible('#deckMenu'))) await page.click('#deckMore');
  await page.waitForSelector('#deckMenu:not([hidden])');
}

// After a sheet closes, nav takes its history entry off with history.go(-1), which lands a moment later. A raw reload() or
// goto(hash) in that moment is aborted (net::ERR_ABORTED) or lands on the wrong entry, so tests wait for the entry to go first.
export const sheetSettled = (page, timeout = 8000) => page.waitForFunction(() => history.state?.k !== 'ov', null, { timeout });
