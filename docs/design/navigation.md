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
- `up(hash)`: (like `back` and `go`, it runs through the queue) for a Back button with a known parent; if the entry below is that parent it really goes back, so no loop of entries.
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
  during Back keeps going (`unwind` loops past them after every pop nav makes itself), so there is never a Back press that appears to do nothing.
  A hold released while a sheet is over it (a Review that ends with its card panel open) leaves such an entry; closing the sheet takes both off.
  Review's finish also closes any open panel or sheet.
- Overlay ids start from `Date.now()` per load, so an entry left by an earlier load can never match a live overlay.
- Every `a[href^="#/"]` click goes through `go()`, so a link clicked in the same tick as a sheet closing waits its turn in the queue.
- Waiting for a history move gives up after 1.5 s; a popstate that still arrives later (within 5 s, at the depth we asked for) is recognised as ours and is not treated as a press of Back.
- `whenIdle()` resolves when that queue is empty; the update-reload after a new service worker waits for it (and tries once more a second later if the page is still there), so a reload is never cancelled by a history step in flight.
- All history changes run one after another (a small queue): `history.back()` is asynchronous, and a push issued before it
  lands would end up in the wrong place (closing one sheet and opening another in the same tick is the common case).
- If a `hashchange` arrives while nav is moving through history on its own, it is held back and `reconcile()` shows the address afterwards.
- Because `replaceState` fires no `hashchange`, nav announces tab switches itself by dispatching one, so the screens that listen
  (audio, glossary, toasts, Review's scratchpad) keep working.

## Known limits

- The Play clock pauses while "Quit this round?" is open (Classic, Survival and Lightning): the question timer and the Lightning clock stop, an automatic "Next" waits, and on Keep playing (or any other way the question closes) the time spent asking is added back to the question's start. Review has no clock.
- When Back skips several entries at once (the long-press Back menu, `history.go(-2)`), a held session is let go and the move counts as leaving. Only a single step back onto the address the hold was made on puts the hold's entry back (and asks), which is also the only push nav makes from a popstate (Chrome on Android can mark an entry pushed without a tap as skippable).
- The long-press Back menu, and entries Chrome skips (it can mark an entry pushed without a tap as skippable), move Back by more than one entry. A running Review or Play session is then let go quietly, without asking "End this session?". That is the safe choice: nothing is lost (answers are saved as they are made), and re-pushing the hold from there could put it at the wrong address.
- **Still to do: a check on a real Android phone** (Chrome, installed app and browser tab). Open Review, then Play, and in each press Back three times: the first Back asks, the second closes the question, the third asks again; Keep going stays in the session. Also check the edge-swipe and the hardware button leave the app from a tab. The tests use Chromium's `goBack()`, which does not apply Chrome's skippable-entry rule.
- A sheet left open while a link inside it navigates leaves one dead entry under the new page; Back then passes over it
  (stale-entry rule), costing no extra press.
- Opening Settings from a drill-down and closing it with the gear goes to that page as a new entry, not back to it.

## Tests

`tests/nav.test.js` (pure helpers) and `tests/browser/e2e-nav.mjs` (Back via `page.goBack()` for tabs, drill-down, sheets,
Review, Play, Settings gear, reload and deep links, in Original and Clinical).
