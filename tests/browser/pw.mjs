// Finds Playwright (the tool that drives a real browser): installed in this project
// (npm install --no-save playwright), or the copy that comes with Claude Code's cloud computers.
let pw;
try { pw = await import('playwright'); } catch {
  pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
}
export const realChromium = pw.chromium;

// A brand-new install opens on the first-run start (js/onboarding.js) instead of the sample deck.
// Almost every test wants the old behaviour (the sample deck is there on first load), so `chromium` here
// gives every new browser window the "skip onboarding" flag in localStorage (the app also accepts
// ?skipOnboarding in the address). e2e-onboarding.mjs uses `realChromium` to see the real first run.
const SKIP = () => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } };
export const chromium = {
  launch: async (...args) => {
    const browser = await realChromium.launch(...args);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...a) => { const ctx = await newContext(...a); await ctx.addInitScript(SKIP); return ctx; };
    return browser;
  }
};
