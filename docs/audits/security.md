# Security review: Study Sprint (read-only)

Base: `main` at fd36b8c. Date: 2026-10-24. Scope: XSS sinks fed by imported or shared decks, Supabase RLS in `*.sql`,
committed secrets, service-worker cache poisoning, untrusted media. Static review only: no app code changed, the live
Supabase project and other external services were not contacted, and nothing was run in a browser. Secret values are
never printed here.

**In plain words:** the app is careful in most places. Card text from imports is escaped before it is shown, the page
has a strict Content-Security-Policy, and the database rules only let each account see its own rows. The one serious
problem is in the service worker: a file "shared" to the app can later be opened as a web page on the app's own address,
with no CSP to stop it. That is a way to run someone else's script with your login.

| # | Severity | Title | CWE |
|---|----------|-------|-----|
| 1 | HIGH | Shared file served back as a same-origin page (stored XSS through the share-target cache) | CWE-79, CWE-434, CWE-352 |
| 2 | MEDIUM | App lives on a shared `*.github.io` origin | CWE-653 |
| 3 | MEDIUM | Service worker caches any CDN response, including opaque ones, without a pin check | CWE-345, CWE-494 |
| 4 | LOW | SVG pictures from `.apkg` files kept as `image/svg+xml` | CWE-79 (latent) |
| 5 | LOW | No clickjacking protection possible via `<meta>` CSP | CWE-1021 |
| 6 | INFO | Secrets scan: no live secret committed | - |
| 7 | INFO | XSS sinks fed by imports: no exploitable sink found | - |
| 8 | INFO | Supabase RLS: scoped to `auth.uid()`, no `USING (true)` | - |

---

## 1. HIGH: shared file served back as a same-origin page

**Where:**
- `sw.js:130-136` `shareIsOurs()` accepts a POST with **no** `Origin` or with `Origin: null` (the comment admits this is not CSRF protection).
- `sw.js:147` stores the shared file at `share-target/file` with `content-type: file.type`, a type the sender chooses.
- `sw.js:168` every same-origin GET goes to `savedFirst()` (`sw.js:182-183`), which calls `caches.match(req, { ignoreSearch: true })`.
  `caches.match` searches **every** cache, including `study-sprint-share`. So a GET of `<app>/share-target/file` is answered with
  the stored file, as whatever type the attacker gave it.
- `index.html:16` the CSP is a `<meta>` tag in `index.html` only. A document served from the cache at `share-target/file` has no CSP.
- `js/import-screen.js:509-515` the stored share is cleared only when cards are saved or the next share arrives. A share older than
  10 minutes is cleared only when the import screen next opens, so the stored file can sit there for a long time.

**Exploit path (needs a browser check, confidence medium-high):**
1. Victim, who has the app installed and is signed in, visits the attacker's page.
2. That page holds a sandboxed iframe (`sandbox="allow-scripts allow-forms allow-top-navigation"` or `allow-popups`), so its requests carry
   `Origin: null`. A script makes `new File(['<script>/* read localStorage, send the Supabase session token off-site */</script>'], 'x.html', { type: 'text/html' })`,
   puts it on a file input with `DataTransfer`, and submits a `multipart/form-data` form to `https://<app>/share-target` as a top-level navigation.
3. The service worker accepts it (`Origin: null`), stores it as `text/html`, and redirects to `#/import/share`.
4. The attacker then navigates the victim (or a popup) to `https://<app>/share-target/file`. `savedFirst` finds it in the share cache and
   returns it as an HTML page on the app's origin with no CSP. The script runs with full access to `localStorage`, IndexedDB and the
   Supabase session, so it can read or wipe every synced card (account takeover). Same thing for `share-target/text` as JSON (lower impact).

**Fix (one commit):**
- In `savedFirst`, look only in this version's cache: `(await caches.open(CACHE)).match(req, { ignoreSearch: true })`, and never answer
  `share-target/*` from the fetch handler (return `fetch(req)` or a 404 for those paths).
- Store the shared file as `application/octet-stream` and keep the real type in a custom header (`x-type`) that `takeShared()` reads.
- Refuse `Origin: null` in `shareIsOurs()` unless `Sec-Fetch-Site` is `none`. If the Android share really sends `null`, keep it, but
  then the two changes above are what stop the XSS, so they are required.

---

## 2. MEDIUM: shared `*.github.io` origin

**Where:** no `CNAME` file in the repo; the app is served from GitHub Pages as a project page (`<user>.github.io/<repo>/`).

**Why it matters:** every other project page of the same GitHub account is the **same origin**. Any script in any sibling repo (or a
compromised one) can read this app's `localStorage` (Supabase session), IndexedDB (all cards) and Cache Storage, and can write to the
caches the service worker answers from (`caches.open('study-sprint-v130').put(...)` from a sibling page poisons the app shell until the
next version bump: cache poisoning, CWE-345).

**Exploit path:** a sibling repo page (yours, a forked template, or one where a dependency is compromised) runs
`localStorage` reads for the `sb-*-auth-token` key and sends it off-site, or puts a modified `js/app.js` into the app cache.

**Fix:** serve the app from its own origin: a custom domain or subdomain (a `CNAME` file plus DNS), or a dedicated
`<org>.github.io` account that hosts only this app.

---

## 3. MEDIUM: CDN responses cached with no pin check

**Where:** `sw.js:169-174`. For any GET to `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com` or `cdn.sheetjs.com`, the cached copy is
used if present, else fetched and saved (`save()` at `sw.js:161-165` keeps **opaque** responses too). `PINNED` is only checked when copying
between versions (`stillUsed`, `sw.js:93-96`), not at fetch time. jsDelivr matches ignore the query string.

**Exploit path:** any one bad response from a CDN (a CDN or network compromise, or an unversioned URL) is saved and served for the rest of
the release, even after the CDN is fixed. The scripts that run are protected: sql.js, the pdf.js worker and KaTeX are fetched with SRI
(`js/anki-read.js:160-167`, `js/doc-import.js:12,221`, `js/math.js:16-17`), and the import map in `index.html` covers the ES modules.
What is left exposed is anything loaded without integrity: KaTeX fonts, and `cdn.sheetjs.com` content (check that its import is in the import map).

**Fix:** in the fetch handler, cache only URLs that start with an entry of `PINNED`, never save opaque responses, and pass other CDN
requests straight to the network. Remove `cdnjs.cloudflare.com` and `unpkg.com` from `CACHE_FIRST_HOSTS` (the CSP already blocks them).

---

## 4. LOW: SVG from `.apkg` kept as `image/svg+xml`

**Where:** `js/anki-read.js:153` maps `.svg` to `image/svg+xml`; `js/media.js:123` turns stored media into a same-origin `blob:` URL of that type.

**Exploit path:** today the picture is only shown through `<img>` (`js/media.js:105,176`), where SVG scripts do not run, so this is not
exploitable now. It becomes XSS if a later change opens a picture in a new tab, an `<iframe>`, `<object>`, or a download link
(a `blob:` document runs on the app's origin). Separately, the server bucket refuses SVG (`supabase/media.sql:12-13`), so these pictures never sync.

**Fix:** rasterize SVG to PNG on import (draw to a canvas, the way `js/media.js:42` already makes JPEG), or drop SVG files from imports.

---

## 5. LOW: no clickjacking protection

**Where:** `index.html:16`. `frame-ancestors` is ignored in a `<meta>` CSP, and GitHub Pages cannot send `X-Frame-Options`.

**Exploit path:** an attacker frames the app and tricks a signed-in user into clicking "Delete account" or "Remove" through an overlay.

**Fix:** a frame-buster in `js/app.js` (`if (top !== self) top.location = self.location`), or host behind a CDN that can set
`Content-Security-Policy: frame-ancestors 'none'`.

---

## 6. INFO: secrets scan

No live secret was found in tracked files. Locations that look like secrets, all judged safe:
- `js/sync-config.js:5`: Supabase **publishable** key (`sb_publishable_` type). Meant to be public; RLS is the real gate. OK.
- `js/sync-config.js:4`, `index.html:16`: the Supabase project URL. Public by design.
- `tests/browser/fake-supabase.mjs`: a publishable-type key for the local fake server. OK.
- `tests/browser/e2e-pw.mjs:46`: a test password for the local fake server. Not a real credential, as long as it is never used for a real account.
- `js/supa.js:86,93`: password-rule messages, not secrets.
- `js/anki-read.js:160-161`, `js/doc-import.js:12`, `js/math.js:16-17`, `index.html:16`: SRI and CSP hashes. Public by design.
- `service_role` appears only in comments, docs and the test SQL shim (`tests/sql/shim.sql`), never as a key value.

Not checked: git history (a key committed and removed earlier would still be leaked) and GitHub Actions secrets.

## 7. INFO: XSS sinks fed by imports

Every `innerHTML` / `insertAdjacentHTML` / `outerHTML` sink in `js/` was listed. The ones fed by `.apkg`, docs, spreadsheets or shared decks
go through `esc()`, `formatHTML()` or `mathHTML()` (`js/format.js:12,112-140`), which escape all text before adding their own tags
(furigana, bold, lists). KaTeX runs with `trust: false` (`js/math.js:378-379`). The CSP allows no inline scripts (hash-listed only),
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. The captcha frame checks `e.source` (`js/captcha.js:43-44`).
Checked call sites include `js/import-screen.js:795,880,1141`, `js/play.js:376,401`, `js/mock-exam.js:179`, `js/decks.js:261,385`,
`js/card-editor.js:150,216,226`, `js/browse.js:588` (a draft snapshot of the app's own editor), and `js/occlusion-view.js:176`.
`js/export.js:121` is Anki's own Image Occlusion template text and runs inside Anki, not in this app.
No exploitable sink found. Not exhaustive: helper functions such as `RS.rowHtml`, `occlusionHTML` and `tagTreeHTML` were spot-checked, not traced in full.

## 8. INFO: Supabase RLS

- `supabase/setup.sql:39-49`: `public.sync_items` has RLS on, with select, insert, update and delete all scoped to `user_id = auth.uid()`
  (update has both `using` and `with check`). No `USING (true)`.
- `supabase/limits.sql:85-90`: `quotas` is read-own only, and writes are revoked. `global_limits`, `sync_usage` (`:97-107`) have RLS on and all access revoked.
- `supabase/media.sql:12-27`, `supabase/limits.sql:261-273`: the `media` bucket is private (`public = false`), with an allow-list of types, and
  every storage policy is scoped to the `<uid>/` folder.
- `security definer` functions all `set search_path = ''`. No authorization uses `user_metadata`.
- `supabase/ci-roles.sql:39`: the CI role can read `auth.users` and `auth.identities` (emails). That is intended, but keep that role's password
  only in GitHub Actions secrets and rotate it if it ever leaks.

Limits: whether the live database matches these files was not checked (on purpose: no contact with the live project).
`delete_my_account()` (`supabase/limits.sql:441-457`) was not reviewed in depth.
