# Design round 4: three layouts for Clinical A

The owner picked A (ui3/a-refined.css) and asked for versions with different layouts, "less AI modern techy".
A1, A2 and A3 keep A's colours, type and tokens exactly and change only the page structure. They run on the live app
(origin/main, v4.9); the real `js/` and `css/` are untouched.

```
node design-previews/ui4/shoot.mjs [a|a1|a2|a3]   # 80 PNGs in shots/ (Today, done, Review answer, Decks, Stats x phone/desk x light/dark)
                                                  # also reports horizontal overflow and any visible text below AA
python3 design-previews/ui4/build-preview.py      # preview.html, images inlined
```

Switch: `<html data-ui="clinical" data-var="a" data-lay="1|2|3">`. Each `aN-*.css` imports `layout-common.css`, which
imports `../ui3/a-refined.css` (and so `clinical-base.css`).

## Shared by A1, A2 and A3 (`layout-common.css`, ~100 lines, CSS)

What reads as "modern app" in A, taken out:
- corners 4px everywhere (2px on small marks); no pills, no circles
- no logo mark (the name only), no icons in the nav, in Start or Options, on the streak or on exam rows
- exam countdowns are coloured text, not outlined badges; deck colours are 8px squares
- decks say **Study** / **Done** and **73% mastered** in words instead of play/check circles and a mastery ring
- the phone tab bar is words only, with a 2px line over the current one

**One markup change (DOM):** the goal ring becomes a sentence and a thin bar: "6 of 94 done today" (or
"Daily goal met"), in `js/today.js` where the hero calls `ring()`. Mocked in by `MOCKS.layout` in shoot.mjs.
Plus A's own shared changes from round 3 (Style row, accent names, "All done for today", "Extra study").

## A1. Classic

A plain left-hand menu, as text only: the sections, then the decks as a simple index, then streak and settings. A 3px line beside the current page.
On desktop, Today has two columns: the goal panel and a ruled table of decks (name | course | counts | Study) on the left, and the exams in a right-hand column.
Decks is one ruled list, with a row per deck. Review and Stats are A's, with square corners.

- **DOM vs CSS:** CSS only (~80 lines), plus the shared goal line.
- **Effort:** about 1.5 days on top of A. Nothing is lost from A: the sidebar keeps every feature.

## A2. Document

Like a university portal or a BMJ/NEJM page.
- A header bar has the name, the sections as text tabs with the current one underlined, and Add cards, the streak and settings on the right. A thin accent line runs along the top.
- Each page is one 760 px column of text: a heavy rule under the page title, and section headings with hairline rules. There are no boxes.
- Today reads as a summary: "88 to go / 68 due · 20 new", the bar, the streak, then a normal-width Start button. Exams and decks follow as headed sections of ruled rows.
- Review is a printed, left-aligned question and answer between rules.
- On phones, the sections are a text tab strip under the name, and the bottom bar is gone.

- **DOM vs CSS:** CSS only (~125 lines), plus the shared goal line. The header bar is the existing sidebar moved with CSS, but on desktop **the sidebar's deck list and sync status are hidden**. They need a home (for example a Decks menu, and a sync dot by Settings), which is JS work, as with B in round 3.
- **Effort:** about 2 days on top of A, plus about half a day if the deck list and sync status get a new home.

## A3. Two-pane

Like Outlook or a reference manager.
- Desktop has a 300 px list pane: the name and Add cards, the sections as a row of text tabs, then every deck as a 44 px row with its exam countdown and due count, then the streak and settings.
- The right pane has a header bar (title, date and actions over a rule) and uses the full width.
- Today is the goal as one strip with Start, then the exams as a table (deck | plan | Exam prep). "Your decks" is not repeated, because the pane lists them.
- Decks is a full-width table. Stats keeps A's panels.
- Review goes full width with the panes put away: the question is on the left and the answer on the right of a rule, with the ratings below.
- Phones are list first: a slim goal strip with Start, then the decks, then the exams (CSS `order`).

- **DOM vs CSS:** CSS only (~125 lines), plus the shared goal line. To feel truly two-pane, clicking a deck in the pane should open it on the right with the row selected. The `aria-current` style is in place, but the deck page itself has not been restyled for the pane (not shot this round). The side-by-side review needs testing with long answers, cloze, images and occlusion; it should fall back to stacked when the answer is long.
- **Effort:** about 2 to 2.5 days on top of A.

## Checks

- Rendered-text contrast: every visible text node on all 80 shots, measured against the solid background behind it. No failures.
- Colour tokens are A's unchanged, so the token check is `ui3/contrast.mjs` (0 failing pairs).
- No horizontal scroll on any shot (375 x 812 at 2x, 1440 x 900).
- A is reshot here with the same seed and date, so the four columns in preview.html compare like with like.
