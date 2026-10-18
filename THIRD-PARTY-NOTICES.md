# Third-party notices

Study Sprint uses the free, open-source libraries below. They are not copied into this repository: the app loads them at the pinned versions listed here, from jsDelivr (a code delivery network) and, for SheetJS, from its own download site, cdn.sheetjs.com (see the import map in `index.html` and `sw.js`). Each library keeps its own licence; the licence text is in the library's own package and on the linked page.

This list does not choose a licence for Study Sprint's own code. That decision is still open (see "Licence" in the [README](README.md)).

| Library | Version | What the app uses it for | Licence | Source |
| --- | --- | --- | --- | --- |
| ts-fsrs | 5.4.2 | The FSRS-6 scheduling algorithm | MIT | https://github.com/open-spaced-repetition/ts-fsrs |
| fflate | 0.8.2 | Unzipping and zipping (Anki decks, backups) | MIT | https://github.com/101arrowz/fflate |
| fzstd | 0.1.1 | Reading Zstandard-compressed Anki decks | MIT | https://github.com/101arrowz/fzstd |
| sql.js | 1.12.0 | Reading Anki's SQLite files | MIT | https://github.com/sql-js/sql.js |
| KaTeX | 0.16.47 | Showing maths on cards | MIT | https://github.com/KaTeX/KaTeX |
| pdf.js (`pdfjs-dist`) | 4.10.38 | Reading PDF files for import | Apache-2.0 | https://github.com/mozilla/pdf.js |
| SheetJS Community Edition (`xlsx`) | 0.20.3 | Reading Excel files for import | Apache-2.0 | https://cdn.sheetjs.com/ |

## Used only for development and tests (not shipped to users)

| Tool | Licence |
| --- | --- |
| ts-fsrs 5.4.2 and the 6.0 beta of ts-fsrs (`package.json`), used by tests | MIT |
| Playwright, used by the browser tests | Apache-2.0 |

## Fonts and services

- **Geist** (the app's font, stored with the app): SIL Open Font License 1.1, https://github.com/vercel/geist-font
- **Cloudflare Turnstile**, **Supabase**, **GitHub** (Pages hosts the app; Actions makes the nightly backup) and **Google** (Gmail sends the sign-up emails) are online services, not code that is part of this repository. Their terms apply to the developer's accounts with them. See [privacy.html](privacy.html) for how they are used.

## A note on accuracy

Licences above were taken from each project's published package information. Before the licence of Study Sprint itself is chosen, re-check this list against the exact versions in `index.html`, since licences can differ between versions.
