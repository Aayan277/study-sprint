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
export const realChromium = { launch: (opts, ...rest) => pw.chromium.launch(withPortMap(opts), ...rest) };

// A brand-new install opens on the first-run start (js/onboarding.js) instead of the sample deck.
// Almost every test wants the old behaviour (the sample deck is there on first load), so `chromium` here
// gives every new browser window the "skip onboarding" flag in localStorage (the app also accepts
// ?skipOnboarding in the address). e2e-onboarding.mjs uses `realChromium` to see the real first run.
const SKIP = () => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } };
export const chromium = {
  launch: async (...args) => {
    const browser = await realChromium.launch(...args);
    const newContext = browser.newContext.bind(browser);
    // Reduced motion is on by default in the tests (the motion code skips its effects, so screens, sheets and counts settle at
    // once and the checks are deterministic). e2e-motion.mjs asks for 'no-preference' to test the effects themselves.
    browser.newContext = async (opts = {}, ...rest) => { const ctx = await newContext({ reducedMotion: 'reduce', ...opts }, ...rest); await ctx.addInitScript(SKIP); return ctx; };
    return browser;
  }
};

// A deck page keeps Edit deck, Add subdeck and Export in its ⋯ menu (#deckMore). Opens it (safe to call when it is already open).
export async function deckMenu(page) {
  await page.waitForSelector('#deckMore');
  if (!(await page.isVisible('#deckMenu'))) await page.click('#deckMore');
  await page.waitForSelector('#deckMenu:not([hidden])');
}
