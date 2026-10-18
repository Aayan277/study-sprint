// The small pieces of text and links shared by the app and the privacy/terms pages: who to contact, and the legal links.
// The address lives in one place, SITE in js/sync-config.js. While it is empty, people are sent to the project page.
import { SITE } from './sync-config.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const emailOk = e => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e || '');

// "Contact: name@example.com" as a link, or "Contact: see the project page" while no address is set.
export function contactHTML() {
  const e = (SITE.contactEmail || '').trim();
  return emailOk(e)
    ? `<a href="mailto:${esc(e)}">${esc(e)}</a>`
    : `<a href="${esc(SITE.projectUrl)}" target="_blank" rel="noopener">see the project page</a>`;
}

// Links to the two pages. No target: they open in the same tab (inside the installed app too) and are saved for offline use.
export const legalLinksHTML = () => `<a href="terms.html">Terms</a> and <a href="privacy.html">Privacy</a>`;
