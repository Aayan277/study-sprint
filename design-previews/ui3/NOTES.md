# Design round 3: three Clinical variants

The owner chose Clinical over Paper and asked for more options. Each variant below is one stylesheet that runs on the
live app (origin/main, v4.9). The real `js/` and `css/` files are untouched. None of them use gradients, glows, blur
or a techy look.

```
node design-previews/ui3/shoot.mjs [current|clinical|refined|compact|calm]   # 160 PNGs in shots/, plus overflow and rendered-contrast report
node design-previews/ui3/contrast.mjs                                         # token contrast, 3 variants x 2 modes x 5 accents
python3 design-previews/ui3/build-preview.py                                  # preview.html, images inlined
```

Files: `clinical-base.css` holds the rules every variant shares (ui2 Clinical, cut down to Clinical only and updated
for v4.9). `a-refined.css`, `b-compact.css` and `c-calm.css` each `@import` it. A variant is switched on with
`<html data-ui="clinical" data-var="a|b|c">`.

## Shared by all three (needed whichever one ships)

| Change | Kind | Where |
|---|---|---|
| Store `ui` / `var` with the theme; set `data-ui` + `data-var` before first paint | JS | `js/themes.js` (`cleanTheme`, `applyTheme`), head script in `index.html` |
| Settings > Appearance: a **Style** row (Classic / Clinical); "Theme" is relabelled "Accent colour" | DOM | settings screen (mocked in by `MOCKS.common`) |
| Accent names Indigo, Blue, Teal, Rust, Plum (the five existing skins remapped, so saved themes still work) | JS | `SKINS` in `js/themes.js` |
| Done state: headline reads **"All done for today"** (currently "All done", with a second bold "All done for today" under it, which CSS now hides) | DOM, 1 string | `js/today.js` line 95 |
| Done state: "Custom study" link becomes a calm secondary button, **"Extra study"** (`btn ghost th-extra`) | DOM, 1 line | `js/today.js` line 104 |
| Everything else (tokens, no glow, hairlines, muted rating colours, flat stats) | CSS | `clinical-base.css`, ~325 lines |

Base effort, done once: about 0.5 day (layer, switch, Settings row, plus a pass over first run, Import and Play results).

## A. Clinical refined

The Clinical the owner liked, with the rough edges taken off. It keeps the same layout.

- Today is one summary panel: goal ring, figures, a one-line streak footer, and Start (normal width) on the right on desktop.
- Exams and Today's decks are grouped lists (one bordered box with rows split by hairlines) instead of floating cards. On desktop they are two columns.
- White sidebar with a hairline. The page sits in a 960 px column.
- Review is a hairline sheet with calm rating buttons.

**DOM vs CSS:** CSS only (~95 lines on top of the base).
**Effort:** about 1 to 1.5 days in total, including the shared work.

## B. Clinical compact (dashboard)

Dense and information-first, like an EHR or UpToDate.

- On desktop, a **top bar** replaces the sidebar: logo, the four sections as tabs, Add cards, streak and settings. The page gets the full width.
- Today: goal | **Due / Learning / New** summary | a big **Start** button, with the streak as a footer line. In the done state, the summary and Start step aside for one calm line and the Extra study button.
- Exams are one line each. Today's decks and the Decks screen are **tables** (Deck, Course, Due, New, Exam or Mastered, go).
- Review: the question and answer are left-aligned under small QUESTION / ANSWER labels, with one joined Again | Hard | Good | Easy bar.
- Phones keep the bottom tab bar (for thumbs), only slimmer, with narrower number columns and two-line exam rows.

**DOM vs CSS:** ~285 lines of CSS, plus markup:
- `<dl class="sum3">` Due / Learning / New on Today (`js/today.js`). The learning count comes from the queue (`kind === 'learn'`). It is mocked in by `MOCKS.compact`.
- Column-header rows (`.tbl-head`, `aria-hidden`) above Today's decks and the Decks list (`js/today.js`, `js/decks.js`). Also mocked.
- The top bar itself is CSS only (it repositions the existing sidebar). But it **hides the deck tree, the sidebar's deck list and the sync status**. Those need a new home (for example a Decks dropdown and a sync dot by the settings icon), which is real JS work.
- The table rows rely on `display:contents` over the existing row markup. If it ships, real table-like markup would be sturdier.

**Effort:** about 2.5 to 3.5 days.

Fixes made in this round: the exam badge in Today's table had lost its padding; phone exam rows and number columns were tightened (deck names wrapped less); the done state's empty 0/0/0 strip is hidden; and the `.deck-counts` table rules are now limited to deck rows (they had broken the deck page summary line).

## C. Clinical calm (focus)

White space, one centred column, and a review screen like a textbook page.

- Desktop: the sidebar **starts as its slim icon rail** (the app's own collapsed state). The page is one centred 680 px column, 880 px for Stats.
- Today has no panels: a heading, one line of figures, a small ring, Start, and plain lists split by hairlines.
- Review has no card box or chrome. The question and answer sit on the page in a **serif, used for card text only** (the device's own: Iowan / Charter on Apple, Cambria / Georgia on Windows, so nothing is downloaded). The ratings are quiet text buttons on a hairline.
- The light page is a softer off-white (#FBFBFA). Dark mode is neutral graphite.

**DOM vs CSS:** ~165 lines of CSS. The only JS is a default: the rail starts collapsed for new Clinical C users (`study-sprint-rail` in `js/sidebar.js`, currently `'0'`). It is set by the shoot script's init, not mocked into the DOM.
**Effort:** about 1.5 to 2 days. Long answers, cloze, maths (KaTeX next to a serif) and image cards need checking on the centred, frameless review page.

Fix made in this round: the freeze note in the streak line kept an outline from the pill style. It is now plain text.

## Checks

- **Contrast, tokens** (`contrast.mjs`): 0 failing pairs across A, B, C x light, dark x 5 accents.
- **Contrast, rendered** (in `shoot.mjs`): every visible text node is measured against the solid background behind it on all 96 variant screenshots, and none fall below AA. The chart peak label `.cap` is skipped because it sits above its bar, on the card background. That pair (text-2 on surface-1) is covered by the token check.
- **Overflow:** no horizontal scroll on any of the 160 screenshots (375 x 812 at 2x, 1440 x 900).
- Old Clinical (ui2) is shot without the round-3 mocks, as it shipped in round 2.
