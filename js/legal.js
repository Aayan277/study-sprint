// The small pieces of text and links shared by the app and the privacy/terms pages: who to contact, and the legal links.
// The address lives in one place, SITE in js/sync-config.js. While it is empty, people are sent to the project page.
import { SITE } from './sync-config.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const emailOk = e => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e || '');

// The text after "Contact: ": the address as a link, or (while no valid address is set) a pointer to the project page.
// Takes the site settings as an argument so tests can try other values.
export function contactHTML(site = SITE) {
  const e = String(site.contactEmail || '').trim();
  return emailOk(e)
    ? `<a href="mailto:${esc(e)}">${esc(e)}</a>`
    : `open an issue on the <a href="${esc(site.projectUrl)}" target="_blank" rel="noopener">project page</a> (please don’t post personal details there)`;
}

// Links to the two pages. No target: they open in the same tab (inside the installed app too) and are saved for offline use.
export const legalLinksHTML = () => `<a href="terms.html">Terms</a> and <a href="privacy.html">Privacy</a>`;
