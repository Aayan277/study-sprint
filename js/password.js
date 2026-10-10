// Password rules for new passwords (Create account, Change password, Forgot password).
// Pure functions, tested by tests/sync.test.js.
// Keep these the same as the Supabase project's settings (Authentication → Sign In / Providers → Email:
// minimum length 8, "Letters and digits"), which is where they're really enforced.
// Signing in never checks them, so accounts made with an older, shorter password still work.

export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: pw => pw.length >= 8 },
  { id: 'letter', label: 'A letter', test: pw => /\p{L}/u.test(pw) },
  { id: 'number', label: 'A number', test: pw => /\d/.test(pw) }
];

// Each rule with whether this password meets it.
export const checkPassword = pw => PASSWORD_RULES.map(r => ({ id: r.id, label: r.label, ok: r.test(String(pw ?? '')) }));
export const passwordOk = pw => checkPassword(pw).every(r => r.ok);

// What's missing, in words: "at least 8 characters and a number". Empty when it's fine.
export function passwordMissing(pw) {
  const missing = checkPassword(pw).filter(r => !r.ok).map(r => r.label.charAt(0).toLowerCase() + r.label.slice(1));
  return missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : (missing[0] || '');
}
