# Navigation: feel like an app, not a website

Owner report (installed app, phone): "swiping swipes back to the previous page like a website would."

## What was wrong

The router is hash based (`#/today`, `#/deck/<id>` ...). Every tab tap, every link and every `location.hash = ...` pushed
a history entry, so an iOS edge swipe or Android back stepped back through every tab visited (Today, Decks, Stats, Today ...).
Sheets and dialogs pushed nothing, so back left the page under an open sheet. A Review session pushed `#/review`; a Play
round pushed nothing (it stays on `#/play`), so back threw you out of a running round with no warning.

## What a back gesture does now

| Screen | Entry made | Back / edge swipe |
| --- | --- | --- |
| Today, Decks, Play, Stats, Settings (tabs) | **replaces** the current entry | Leaves the app (Android exits, iOS has no gesture). Never steps through tabs. |
| Deck page, subdeck, Browse, Import, "Starter decks" | pushes one entry | Returns to the screen it was opened from |
| Tab tapped from a drill-down | replaces; the drill-down entries are dropped | Leaves the app |
| Sheet (card panel, deck editor, any `openSheet`) | pushes one entry while open | Closes the sheet, stays on the page |
| Zoom viewer (image occlusion) | pushes one entry while open | Closes the viewer |
| Box editor (image occlusion) | holds one entry | Same as Esc: asks "Discard your changes?" if there are any |
| Review session | pushes `#/review` (a drill-down) and **holds** an entry while running | Sheet "End this session?" (Keep going / End session). A second back with the sheet open closes it and stays. |
| Review summary ("Session ended / done") | hold released | Returns to where Review was started (deck page or Today). One press, no dead press |
| Play round | holds one entry (the address stays `#/play`) | Sheet "Quit this round?" (Keep playing / Quit round) |
| Play setup and results | none | Leaves the app (Play is a tab) |
| First-run welcome | unchanged (it already used replace) | Unchanged |

Android hardware back on Today exits: Today is the first and only entry, nothing is pushed behind it. We deliberately did
**not** add the Material "back from another tab goes to Today first" rule: it needs an entry under every non-home tab,
which is exactly the swipe-back-between-tabs the owner reported. If you want it later, it is one extra entry in `toTab`.

Reload keeps your place: the history state survives it, so Back after a reload still goes to the parent. Deep links
(`/#/deck/x`, `/#/stats`) open directly; a deep-linked drill-down has nothing under it, so its on-screen Back button goes to
the parent (Decks) and the system Back leaves, which is what a link into a page normally does.

`overscroll-behavior-x: none` on `html, body` stops Chromium's sideways overscroll from triggering browser navigation.
`overscroll-behavior-y: none` is added only when installed (`display-mode: standalone | fullscreen | minimal-ui`), so
pull-to-refresh is gone in the app but still works in a normal browser tab. No visual change in Original or Clinical.

## How it works (`js/nav.js`)

Every entry the app makes carries `history.state = { ss: depth, k: 'page' | 'ov', id, from }`.
`depth` is the number of entries above the app's first one. That is what makes "go to a tab" cheap and exact: `history.go(-depth)`
to the bottom, then `history.replaceState` there.

- `go(hash)`: a tab destination replaces (`toTab`), anything else is one new entry. All former `location.hash = x` sites use it.
  When nothing is in flight it changes the address synchronously, like the old code (some callers compare `location.hash` right after).
- `up(hash)`: for a Back button with a known parent; if the entry below is that parent it really goes back, so no loop of entries.
- `back(fallback)`: Import's back button.
- `replace(hash)`: redirects (the old `location.replace`).
- `openOverlay(dismiss)` / `closeOverlay(id)`: sheets and dialogs. Opening pushes an entry; Back calls `dismiss`; closing by code
  takes the entry off again with `history.back()`.
- `holdBack(key, onBack)` / `releaseBack(key)`: running sessions. Back re-pushes the held entry and calls `onBack` (the confirm), so the session
  never loses its place. Released when the round finishes, quits, or the router leaves the screen.
- Links: a click on any `<a href="#/tab">` is turned into `toTab` (the tab bar, the sidebar, the logo, "Back to Today"...).
  A hash change that did not come through `go()` or a link (the address bar, another app opening a link) is kept as the
  browser made it: one more entry, tagged one level deeper. Nothing in the app does that any more, and keeping it simple means a
  reload straight after it behaves. A tab tap afterwards still goes down to the root.
- Entries whose owner is gone (a sheet closed while something else navigated, a finished session) are "stale": landing on one
  during Back keeps going, so there is never a Back press that appears to do nothing.
- All history changes run one after another (a small queue): `history.back()` is asynchronous, and a push issued before it
  lands would end up in the wrong place (closing one sheet and opening another in the same tick is the common case).
- If a `hashchange` arrives while nav is moving through history on its own, it is held back and `reconcile()` shows the address afterwards.
- Because `replaceState` fires no `hashchange`, nav announces tab switches itself by dispatching one, so the screens that listen
  (audio, glossary, toasts, Review's scratchpad) keep working.

## Known limits

- A session confirm is a modal sheet. A Play round's clock (Lightning, Survival) keeps running while it is open.
- A sheet left open while a link inside it navigates leaves one dead entry under the new page; Back then passes over it
  (stale-entry rule), costing no extra press.
- Opening Settings from a drill-down and closing it with the gear goes to that page as a new entry, not back to it.

## Tests

`tests/nav.test.js` (pure helpers) and `tests/browser/e2e-nav.mjs` (Back via `page.goBack()` for tabs, drill-down, sheets,
Review, Play, Settings gear, reload and deep links, in Original and Clinical).
