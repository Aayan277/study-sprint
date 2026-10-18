// The "are you a person?" check (Cloudflare Turnstile or hCaptcha) for sign-up, sign-in and password reset.
//
// It is only used when the owner has set a site key in sync-config.js AND turned on "Enable Captcha protection" in
// Supabase (docs/sync-setup.md). Supabase then wants a fresh token with every sign-up, sign-in and reset; with no
// key set, none of this runs and the app asks for nothing.
//
// The provider's script is never loaded into the app's own page. askCaptcha() opens captcha-frame.html in a
// sandboxed iframe (no access to the app's data or sign-in), only while someone is signing up / in, and gets back
// just the one-time token. That script can't be given an integrity fingerprint (the providers change it without
// a version number), so keeping it in the sandbox is the protection. See the comments in captcha-frame.html.

import { CAPTCHA } from './sync-config.js';

const PROVIDERS = ['turnstile', 'hcaptcha'];
export const captchaOn = () => PROVIDERS.includes(CAPTCHA.provider) && /^[A-Za-z0-9_-]{6,80}$/.test(CAPTCHA.siteKey || '');

const WAIT = 20 * 1000;           // the frame should say "ready" within seconds: after this it is called failed, never a silent hang
const SOLVE = 5 * 60 * 1000;      // once it is ready, the person gets this long to solve it (a visible puzzle can take a while)
export const CAPTCHA_FAILED = 'The bot check didn’t load. Try again, or contact the site owner.';

// Show the check inside `container` and give back its token (a string, good for one request).
// Rejects with an Error whose message is ready to show.
export function askCaptcha(container, { wait = CAPTCHA.waitMs || WAIT } = {}) {
  return new Promise((resolve, reject) => {
    container.replaceChildren();
    container.hidden = false;
    const frame = document.createElement('iframe');
    frame.title = 'Check that you are a person';
    frame.setAttribute('sandbox', 'allow-scripts');          // no allow-same-origin: it can't reach the app
    frame.setAttribute('referrerpolicy', 'origin');          // the provider checks the site's address
    frame.style.cssText = 'border:0;width:100%;height:76px;color-scheme:normal';
    frame.src = `${new URL('captcha-frame.html', import.meta.url).href}?p=${encodeURIComponent(CAPTCHA.provider)}&k=${encodeURIComponent(CAPTCHA.siteKey)}`;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      container.replaceChildren();
      container.hidden = true;
      fn(value);
    };
    const onMessage = e => {
      if (e.source !== frame.contentWindow || e.data?.from !== 'study-sprint-captcha') return;
      if (e.data.type === 'token' && typeof e.data.token === 'string' && e.data.token) finish(resolve, e.data.token);
      else if (e.data.type === 'error') finish(reject, new Error(CAPTCHA_FAILED));
      else if (e.data.type === 'ready' && !done) { clearTimeout(timer); timer = setTimeout(() => finish(reject, new Error(CAPTCHA_FAILED)), Math.max(wait, SOLVE)); }
    };
    let timer = setTimeout(() => finish(reject, new Error(CAPTCHA_FAILED)), wait);
    addEventListener('message', onMessage);
    container.append(frame);
  });
}
