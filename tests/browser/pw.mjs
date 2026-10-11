// Finds Playwright (the tool that drives a real browser): installed in this project
// (npm install --no-save playwright), or the copy that comes with Claude Code's cloud computers.
let pw;
try { pw = await import('playwright'); } catch {
  pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
}
export const { chromium } = pw;
