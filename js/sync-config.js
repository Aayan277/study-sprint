// Which Supabase project sync uses (see docs/sync-setup.md).
// Both values are meant to be public: Row Level Security in supabase/setup.sql is what keeps each
// account's data private. Never put the service_role or secret key here.
export const SUPABASE_URL = 'https://lakxeftzlpvydzulxrbi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_LEdkCU7O5RdatxRtT44I_Q_1rWHPL9r';

// "Are you a person?" check for sign-up, sign-in and password reset (optional; see docs/sync-setup.md).
// Leave siteKey empty and the app asks for nothing. To use one: set provider to 'turnstile' (Cloudflare) or
// 'hcaptcha', paste its SITE key here, and turn on Captcha protection in Supabase with the matching SECRET key.
// The site key is public by design; the secret key goes only in Supabase, never here.
export const CAPTCHA = { provider: 'turnstile', siteKey: '' };

// Where people can reach the app's developer (used by privacy.html, terms.html and Settings → About).
// contactEmail: the Study Sprint email address, once it exists (see docs/owner-launch-checklist.md step 3). While it is empty,
// the pages say "Contact: see the project page" and link to projectUrl instead.
export const SITE = { contactEmail: '', projectUrl: 'https://github.com/aayan277/study-sprint' };
