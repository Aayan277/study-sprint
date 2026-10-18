// Used by privacy.html and terms.html: fills in the contact line. The address is set in one place (js/sync-config.js).
// If this file can't load, the line already on the page stays as written.
import { contactHTML } from './legal.js';
const box = document.getElementById('contact');
if (box) box.innerHTML = 'Contact: ' + contactHTML();
