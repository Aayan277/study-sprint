# Image occlusion: implementation plan (2 stages)

**Status: DONE (v3.8).** Stage 1 (commits af8aa3a..054ffce) and Stage 2 (the drawing editor, entry points and `tests/browser/e2e-occlusion-editor.mjs`) are built; this file is kept as the record of the design.

Written by the planning review against `experiment` at db55738, after reading the code. Line numbers are approximate.
It refines `image-occlusion.md`; where the two disagree, **this file wins**. The owner approved section 0, including the
data changes and real Anki occlusion export.

## 0. Corrections to the design doc (approved)

1. **No `occlusion.image`: the picture lives in `card.backImage` only.** `db.cleanMedia` (~676), `syncMedia`'s
   `want` list (sync.js ~242) and Anki export `fileFor` (export.js ~175) only read `frontImage`/`backImage`, and the
   old-app fallback needs `backImage` anyway.
2. **Add `w`/`h` (saved image px) to `occlusion`** so the box has the right `aspect-ratio` before the picture loads
   (and when it hasn't synced yet).
3. **Anki pixel coordinates: decided per note.** Any coordinate > 1 means the whole note is in pixels. Pixels → fractions
   needs the *original* image size, known only after decoding at save time, so it happens in `import-screen.js save()`.
   `processImage` also returns `srcWidth`/`srcHeight`.
4. **No 3% minimum box.** A drag is a box if it moved ≥ 8 CSS px on screen and is ≥ 0.3% of the image on each side;
   anything less is a tap.
5. **The editor is its own `<dialog class="occ-ed">`** opened with `showModal()` (stacks above the one `#sheet`
   dialog, ui.js ~87), removed on close. Not `openSheet`.
6. **Sync healing:** add `healOcclusion` and call it from `sync.healNotes` (~158) next to cloze's.
7. **Play distractors:** `pickDistractors` skips siblings (game.js ~109); for occlusion, sibling labels are the best
   distractors, so allow them for occlusion only.
8. **Export as a real Anki Image Occlusion note** (cloze-type model, Anki's stock IO template). Check the templates
   against Anki's `rslib/src/image_occlusion/notetype.rs` (23.12+) incl. CSS. The owner opens one export in Anki to confirm.
9. Existing tests that assert the old picture-card fallback must be rewritten: `tests/anki.test.js` ~235–262,
   `tests/import.test.js` ~224–228, `tests/browser/e2e-anki-replay.mjs` lines 44–46 and 63.
10. Also handle: Find & replace and the Duplicates filter skip occlusion cards; Review typed answer and read-aloud;
    `isComplete` accepts unlabeled rows; onboarding's guided-review renderer (~223); Play's speed-vs-you counts
    characters (picture questions get a fixed allowance); Review keys are ignored while the zoom viewer or editor is open.
11. `setPointerCapture` throws for synthetic pointers: wrap in try/catch. Browser tests use CDP
    `Input.dispatchTouchEvent` (real multi-touch) and `page.mouse`, not `new PointerEvent`.
12. No Anki library here to make new .apkg fixtures. Reuse `anki-replay-{new,legacy}.apkg` (has an IO note: c1/c2
    rects, `oi=1`, Header "Heart anatomy", Back Extra, an 8×8 PNG). Edge cases in unit tests.
13. Labels stored per mask; a group's label = its masks' distinct labels joined with ", ". The editor labels a group.
14. **Numbers shown to people are display positions, not `n`:** the k-th group sorted by `n` is "part k of G"
    (aria, fallback front, editor badges, read-aloud). `n` is the identity that keeps a schedule; never renumbered,
    never reused within an editing session.

## Data shape (no new store, no DB_VERSION bump, no SQL change)

```
card = { id, deckId, noteId, front, back, backImage: <mediaId>, tags, noteExtra?, noteEditedAt, ...,
  occlusion: {
    n: 3,                     // this card's group (integer ≥ 1)
    w: 2048, h: 1365,         // saved image size in px
    header?: 'Heart anatomy', // plain text, ≤ 300 chars
    masks: [{ id: 'm1', n: 1, shape: 'rect'|'ellipse'|'polygon', x, y, w, h,   // fractions 0–1, 5 decimals
              points?: [[x, y], ...],  // polygon only: image fractions; x/y/w/h = their bounding box
              label?: 'Aorta' }]       // ≤ 200 chars
  } }
```
- Every sibling carries the full `masks` (like `noteText`). `noteExtra` holds Back Extra.
- No `noteText` / `cloze`, so the cloze code paths ignore these cards.
- `front` = `"${header || 'Diagram'}: hidden part ${k} of ${G}"`, `back` = group label or `''`. Older apps show a text
  front and the whole picture + label on flip.
- Limits: ≤ 300 masks per note, polygons 3–200 points.

## Stage 1: helpers, data, media 2048, Anki import/export, rendering

**`js/occlusion.js`** (new, pure, NO imports, safe in the boot graph):
- Card helpers:
  - `isOcclusion(card)`: noteId + plain-object `occlusion` with an array of masks and an integer n.
  - `hasMasks(card)`: `isOcclusion` and the card's n is still among `groupsOf(masks)`. If not, render the card as an
    ordinary card.
  - `groupsOf(masks)` → sorted unique n. `groupIndex(masks, n)` → `{ k, total }`. `occLabel(masks, n)`.
  - `occFrontBack({ header, masks }, n)` → `{ front, back }`.
- Validation:
  - `validOcclusion(o)`: integer n ≥ 1; finite w, h > 0; header absent or a string.
  - Masks: an array of 1–300 objects, each with a string id, an integer n ≥ 1 and a known shape. Finite numbers with
    0 ≤ x, y and 0 < w, h, and x+w, y+h ≤ 1 + 1e-6.
  - `label` absent or a string; `points` absent or 3–200 finite pairs in 0–1.
  - `cleanMask(m)`: `Number()`, clamp, drop zero-size or NaN.
- Anki:
  - `parseAnkiOcclusion(fieldHtml)` → `{ shapes: [{ n, shape, x, y, w, h, points? }], pixels }`:
    - Strip tags and decode entities (`&amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN;`).
    - Match `/\{\{c(\d+)::image-occlusion:(rect|ellipse|polygon|text)((?:\\.|[^}])*)\}\}/g`. Split properties on
      unescaped `:` and unescape `\:`.
    - rect: left/top/width/height. Ellipse: left/top + rx/ry (w = 2rx), or width/height. Polygon: `points="x,y x,y"`,
      bbox computed.
    - Skip `text`. Ignore `oi`, `angle` and unknown keys. Drop non-finite values.
  - `toFractions(shapes, pixels, srcW, srcH)` → masks with ids `m1…`, clamped and cleaned.
  - `ankiOcclusionText(masks)` → `{{cN::image-occlusion:rect:left=.1234:top=…:width=…:height=…:oi=1}}` per mask:
    4 decimals, leading zero dropped like Anki. Ellipse writes rx/ry; polygon writes points.
- Saving: `planOcclusionSave(oldSiblings, note, score = () => 0)`, with
  `note = { masks, header, w, h, image, extra? }`. Mirrors `planNoteSave` and returns
  `{ update, add, remove, duplicates, error }`:
  - error: no masks ("Draw at least one box over the part to hide.") or invalid.
  - Siblings are keyed by `occlusion.n`. A duplicate n means the higher score stays; a card without occlusion counts
    as a duplicate.
  - update (n still present): same id, new `occlusion: { ...note fields, n }`, recomputed front/back,
    `backImage: note.image`.
  - add: each new n. remove: siblings whose n is gone (deleted or merged).
- `occRemovalText(plan)`: "Box 3 was removed: its card and review history go too." Uses display numbers from the old
  masks, with plural/duplicate wording like `removalText`.
- `healOcclusion(cards)`, mirroring `cloze.healNotes`:
  - Group by noteId (occlusion cards only). Signature = `JSON.stringify({ header, masks, w, h })` + `backImage` +
    `noteExtra || ''`; if all are equal, skip.
  - Winner: latest `noteEditedAt`, else latest `updatedAt`, ties to the larger id.
  - Siblings whose n is in the winner's groups get the winner's occlusion with their own n, recomputed front/back,
    `backImage`, `noteExtra` and the winner's `noteEditedAt` (never "now"). A sibling whose n is gone is left alone.
- Rendering: `occlusionHTML(card, side, { zoom = true } = {})`, side `'front'|'back'|'all'` ('all' = editor/panel
  preview with numbered outlines):
  ```
  <figure class="occ occ-${side}" style="aspect-ratio:W / H;--ar:${(W/H).toFixed(4)}" role="group" aria-label="${esc(header||'Diagram')}: ${G} hidden parts">
    <img class="occ-img" data-media="${esc(backImage)}" alt="${esc(header||'Diagram')}">
    <div class="occ-mask[ occ-ask| occ-reveal]" style="left:…%;top:…%;width:…%;height:…%[;border-radius:50%][;clip-path:polygon(…)]" …aria></div>…
    ${zoom ? '<button type="button" class="occ-zoom" aria-label="Zoom picture" aria-keyshortcuts="Z">…</button>' : ''}
  </figure>
  ```
  - `pct = (clamp01(Number(v)) * 100).toFixed(3) + '%'`. Non-finite masks are dropped, so only formatted numbers
    reach `style`. Polygon points become % of their bbox.
  - Front: the active group gets `occ-ask`, `role="img"` and `aria-label="Hidden part k of G: name this part"`; the
    others get `aria-hidden="true"`.
  - Back: the active group gets `occ-reveal`, `aria-label="Answer: ${label}"` (or "Uncovered part k of G") and a
    `<span class="occ-tag">label</span>`; the others stay covered.
  - Missing w/h: no aspect-ratio, in-flow img. Use the existing `data-media` image watcher from media.js (check how
    `imgHTML` works and reuse it).
- `occSpeech(card, flipped)`. Front: "Heart anatomy. What is hidden part 2 of 5?" Back: the label, or "Part 2 of 5".
- Geometry, used by zoom (stage 1) and the editor (stage 2):
  - `fitView(vw, vh, iw, ih)`; `zoomAt(view, s, cx, cy)` keeps the point under the cursor fixed, scale 1–8;
    `clampView(view, vw, vh, cw, ch)` keeps ≥ 40% of the image visible; `toImage(view, px, py, cw, ch)`; `rectFrom(a, b)`.
  - `hitTest(masks, x, y)`: topmost (last) wins; ellipses by equation, polygons by ray-cast.
  - `handleAt(mask, x, y, tolX, tolY)` → `'nw'|'ne'|'sw'|'se'|null`. `moveMask` (clamped).
    `resizeMask(m, corner, x, y, minW, minH)`: dragging past the opposite corner swaps sides.
  - `nextN(masks, floor) = max(floor, ...n) + 1`; `groupMasks(masks, ids)` joins into the lowest n;
    `splitMask(masks, id, floor)`; `deleteMasks(masks, ids)`.
  - History `{ past, present, future }`, cap 100: `pushH`, `undoH`, `redoH`.

**`js/media.js`**: `processImage(file, { maxSide = MAX_SIDE } = {})`, also returning `srcWidth`/`srcHeight`.
`export const OCCLUSION_SIDE = 2048`. `addImage(file, opts)` passes opts through. Add `addImageInfo(file, opts)` →
`{ id, width, height }`.

**`js/occlusion-view.js`** (new, DOM, lazy-loaded): zoom viewer plus a reusable pan/zoom controller.
- `panZoom(stage, canvas, { oneFinger: 'pan'|'none', onChange })` → `{ view, set, fit, zoomBy, destroy }`:
  - Pointer Events in a Map: 2 pointers pinch around the midpoint and pan; 1 pointer pans if `oneFinger: 'pan'`.
  - Wheel zooms at the cursor (preventDefault), including ctrlKey (trackpad pinch). Double-tap/dblclick toggles
    1×/2.5×. Keys `+`/`-`/`0`.
  - `transform: translate(tx,ty) scale(s)` with origin 0 0. Set `--s` on the canvas so handles stay a constant size.
  - setPointerCapture in try/catch.
- `openZoom(figureHTML, title)`: appends a `<dialog class="occ-view">` (Close, + / − / Fit, `touch-action:none`,
  `overscroll-behavior:contain`), then `showModal()` and `panZoom` with `oneFinger: 'pan'`. Escape closes; the dialog
  is removed and focus returns to the zoom button.
- A delegated capture-phase click on `.occ-zoom` (stopPropagation so Review doesn't flip) →
  `openZoom(closest('.occ').outerHTML)`.

**Other files:**
- `js/db.js` `checkBackup` (~433): every card has `occlusion === undefined`, or `validOcclusion(c.occlusion)` and a
  string noteId. Otherwise: 'This backup file is damaged (a card has invalid image-occlusion fields).'
  `saveNote` is already generic.
- `index.html`: `<link rel="modulepreload" href="js/occlusion.js">` (db.js is a boot module; preload.test.js).
- `sw.js`: add both new files to CORE, bump CACHE, run `node tests/update-sw-hash.mjs`.
- `js/sync.js healNotes` (~158): import cloze and occlusion together; `fixed = [...heal(all), ...healOcclusion(all)]`.
- `js/browse-logic.js` (inline checks): `replaceInCards` skips `c.occlusion`; the Duplicates key (~91) is `''` for
  occlusion cards.
- `js/import.js`: `buildCards` passes `result.occlusions?.[i]` as `occlusion`; `isComplete` accepts `c.occlusion`;
  `findDuplicates` skips `occlusion || occluded`.
- `js/anki.js notesToImport` (~104): a new per-row array `occlusions` (null otherwise), returned and kept in step by
  `onlyDeck` (~236).
  - Occlusion note: parse fields[0]. Image from field 1, header = htmlToText(field 2), extra = marks of field 3.
  - With ≥ 1 shape and an image, one row per n:
    - `[front, back]` from `occFrontBack` (back `''`); `pictures { front: null, back: image }`; `occluded: false`.
    - `occlusions: { noteKey, n, header, shapes, pixels, image }`; `noteExtras: extra`;
      `ankiIds: note.cards?.[n-1] ?? null` (history now comes along).
  - Otherwise the old single `occluded` picture row.
  - "Image Occlusion Enhanced" add-on notes (model `/image occlusion enhanced/i`, or fields 'Question Mask' +
    'Original Mask'): one plain picture card per add-on note group (ID minus its last `-N`), `occluded: true`.
- `js/import-screen.js`:
  - `renderList` (~363): occlusion rows readonly, with the badge "Image occlusion: box k". Swap skips them; hide Swap
    when every row is cloze or occlusion.
  - `refreshFlags` (~412): "N image-occlusion notes make these cards: one card per box. Every box is hidden and you
    name the highlighted one; Review shows one a day." The `occluded`-only warning becomes "…came in as plain picture
    cards (this kind of occlusion note can't be read)". Drop "later update".
  - `save()` (~433): keep occlusion rows. noteIds per noteKey, noteId, noteExtra.
  - Pictures for occlusion rows use a second cache keyed `name|2048`:
    `processImage(blob, { maxSide: OCCLUSION_SIDE })` → saveImage → `card.backImage`, then
    `card.occlusion = { n, w, h, header?, masks: toFractions(shapes, pixels, srcW, srcH) }` and front/back from
    `occFrontBack`.
  - If decoding fails or the masks come out empty: a plain picture card (`front: header || 'Diagram'`, back: extra),
    with no noteId/occlusion.
- `js/export.js ankiContents`:
  - The IO model: `IO_ID = 1_600_000_000_003`, `{ ...model, id: IO_ID, name: 'Study Sprint Image Occlusion', type: 1,
    originalStockKind: 6 }`, fields `['Occlusion','Image','Header','Back Extra','Comments']`, with templates matching
    Anki's stock IO notetype.
  - One note per noteId (`isOcclusion && hasMasks`). Fields: Occlusion `ankiOcclusionText`, Image
    `<img src="file">`, Header, Back Extra, Comments = labels "1. Aorta<br>2. …". `sfld` = header || 'Image occlusion'.
  - Cards `ord: n - 1`. Add the model only when it's used.
  - `decks.js openExport` (~392): when the deck has occlusion cards, note "Image-occlusion cards need Anki 23.10+
    (AnkiDroid 2.17+). In a spreadsheet they're text only." CSV is unchanged (fallback front/back).
- `js/review.js`:
  - `renderSession` (~163): `occ = hasMasks(card)`. The front is head + `occlusionHTML(card, 'front')`; the answer is
    `occlusionHTML(card, 'back')`. No `.flash-recap` when occ.
  - The back shows the label (or "No label", muted), and noteExtra as for cloze.
  - A `.occ-peek` toggle on the back: "Show whole picture", `aria-pressed`, key M.
  - typeThis (~157): only when there is a label and `canType(label)`. `#longNote` (~202) for an occ with no label:
    "No label on this box: say it in your head, then flip."
  - readAloud (~120) uses `occSpeech`. The flip click (~214) ignores `.occ-zoom, .occ-peek`.
  - keydown (~513): return early when `dialog.occ-view[open], dialog.occ-ed[open]`. Z opens zoom; M toggles peek.
  - Lazy-import occlusion-view.js the first time an occlusion card shows.
- `js/onboarding.js` (~223, ~241): the same occlusion branch in the guided review.
- `js/game.js`:
  - `isFrontOnly = c => isCloze(c) || isOcclusion(c)`.
  - `questionFor`: a label is required (none → null). 'front' → `{ prompt: header || 'Name the highlighted part',
    answer: label, occ: true }`; typing the same when `canType`; 'back' → null.
  - `defaultQuestionType` filters out front-only cards. `pickDistractors` skips siblings only for non-occlusion
    cards: +4 for the same noteId, +3 when both are occlusion.
- `js/play.js`:
  - ~113: use `pool.some(isFrontOnly)`. ~307: the prompt is `occlusionHTML(card, 'front', { zoom: false })` +
    prompt text.
  - ~410: speed allowance `chars += q.occ ? 60 : 0`.
  - Missed list (~615): a small `.occ-mini` back figure.
- `js/browse.js`:
  - Row badge `k/G` (title "Image occlusion, part k of G").
  - `cardFieldsHTML` (~304) → `occlusionFields('ce', card)`. `wireCardForm` (~316) → `saveOcclusionNote`, a copy of
    `saveClozeNote`'s guarded re-plan-on-confirm flow using `planOcclusionSave`/`occRemovalText`.
  - Delete-confirm wording (~220). Card info: "Type: Image occlusion, part k of G".
- `js/card-editor.js` (stage 1 part): `occlusionFields(p, card|null)`:
  - Preview `occlusionHTML(…, 'all')` with this card's group highlighted, and "Makes N cards".
  - Header input `${p}OccHead`, and a Labels list (one input `${p}OccLbl${n}` per group, `aria-label="Label for part
    k"`, the keyboard/screen-reader labelling route). Extra via `cardTextField`.
  - State in a module Map `occForms` (p → `{ masks, image, w, h, maxN }`); `readOcclusion(p)`, `setOcclusion(p, note)`.
- `css/styles.css`, new section "Image occlusion":
  - `.occ`: relative, `max-width: min(100%, calc(52dvh * var(--ar)))` (62dvh ≥ 1024px), radius, white bg, outline.
  - `.occ-img`: absolute fill.
  - `.occ-mask`: grey #8b919c with an inset ring. `.occ-ask`: accent fill, white "?" `::after` (clamp size), white
    inner and dark outer ring. `.occ-reveal`: transparent with an accent ring.
  - `.occ-tag` pill. `.peek .occ-mask:not(.occ-reveal) { opacity: 0 }`. 44px `.occ-zoom`/`.occ-peek`.
  - forced-colors support, no animation under reduced motion, the `.occ-view` full-screen dialog, `.occ-mini`.

**Edge cases:**
- n gone → plain card. Picture missing → alt text, masks still in the aspect box.
- Unlabeled boxes are left out of Play and typed Review.
- Escaping: label/header/media id escaped; style values are numbers only.
- Siblings: queue `limitSiblings` and Play `weightedQueue` already key on noteId. Exam prep shows all. Deck/tag moves
  apply to the whole note. `refreshNoteInSession` works by noteId.
- Anki without `oi=1` is still hide-all. `angle` is ignored.

**Tests:**
- `tests/occlusion.test.js`:
  - Parsing: rect, ellipse, polygon bbox, text skipped, `\:`, tags/entities, several shapes per cN, missing oi,
    unknown keys, bad numbers, pixel detection.
  - `toFractions`; `occFrontBack`/`groupIndex`; `planOcclusionSave` (new/move/label/delete/merge/duplicate/errors/
    backImage, w, h); `occRemovalText`; `healOcclusion`.
  - `occlusionHTML` (classes, aria, escaping, injected styles dropped, polygon clip-path).
  - Geometry (hitTest, handleAt, rectFrom, move/resize/corner flip, nextN/group/split/delete, undo/redo, zoomAt anchor,
    clampView, toImage round trip).
  - `validOcclusion` table; `ankiOcclusionText` round-trips within 1e-4.
- `anki.test.js` IO tests rewritten: rows per group, ankiIds, header/extra, the fallbacks, IOE add-on, onlyDeck.
- `import.test.js`: buildCards, isComplete, findDuplicates.
- `export.test.js`: IO model only when used, one note per noteId, the Occlusion string, Image, ords, Comments, CSV
  fallback.
- `backup.test.js`: accept a valid card; reject bad n, out-of-range x, style injection, missing noteId.
- `game.test.js`: label/no label, 'back' null, sibling distractors, defaultQuestionType. `browse.test.js`: replace and
  dupes skip. `queue.test.js`: one-a-day for occlusion siblings.
- `tests/browser/e2e-occlusion.mjs` (375×812 touch, plus 1440 desktop):
  - A 3000×2000 canvas PNG → 2048×1365 with `srcWidth` 3000. Seed a 3-group note via `db.saveNote(planOcclusionSave(…))`.
  - Review: 1 of 3 siblings due; front aria; the zoom button doesn't flip and opens/closes the dialog; the flip
    reveals; peek; typed only when labelled; mask rects match % within 1px.
  - Browse: badge; editing a label saves to every sibling with ids and states kept.
  - Play: MC includes sibling labels.
  - Anki import with both replay .apkg files → 2 occlusion cards with masks ≈ (.1,.1,.2,.2)/(.5,.5,.2,.2), w/h 8.
  - Export → re-import round trip; backup round trip; two-device sync with fake-supabase incl. heal.
  - `scrollWidth <= 375`.
- Update `e2e-anki-replay.mjs` (44–46, 63).

**Acceptance:** `npm test` and `node tests/browser/run.mjs` all green. No page errors at 375 or 1440.

## Stage 2: drawing editor, entry points, e2e with real pointer input

**`js/occlusion-editor.js`** (new, lazy): `openOcclusionEditor({ image, w, h, masks = [], focusN = null, maxN = 0 })`
→ `Promise<{ masks, maxN } | null>`.
- `<dialog class="occ-ed" aria-labelledby="occEdTitle">`, opened with showModal, removed on close.
  - Top bar: × Cancel · "Hide parts" + `<span aria-live="polite">5 boxes · 4 cards</span>` · Done (primary).
  - `.occ-ed-stage`: touch-action none, overflow hidden, overscroll contain.
  - `.occ-ed-canvas`: transformed by panZoom; holds the img and the mask divs. Masks have a semi-opaque accent fill,
    a number badge (k), and when selected a thick outline and 4 corner handles (14px drawn, 44px hit area via
    `::before`, `calc(14px / var(--s))`).
  - Bottom toolbar of 48px icon buttons: Undo, Redo, Delete, Group/Join/Split, Label, Add box, Fit. Each has
    aria-label and title, and disabled states kept in step.
  - Label row (hidden until Label is pressed): an input "Label for part k (optional), e.g. Left ventricle".
  - First-use hint "Drag over a part to hide it. Pinch with two fingers to zoom." (dismissal remembered in
    localStorage `study-sprint-occ-hint`).
- Input:
  - `panZoom(stage, canvas, { oneFinger: 'none' })` owns the 2nd pointer, wheel, keys and double-tap. Desktop pans
    with Space+drag or middle-drag.
  - Single pointer (via `toImage`):
    - On a handle → resize.
    - On a mask → select; moving more than 4px → move.
    - On empty → a provisional rect. It becomes a box only if the drag moved ≥ 8px and is ≥ 0.3% each side;
      otherwise it's a tap that deselects.
    - A second pointer arrives → cancel the gesture (restore, no history) and pinch.
  - Each finished gesture is one pushH. New masks get `n = nextN(masks, maxN)`; maxN only grows.
  - Shift-click multi-select on desktop. Group with 1 selected enters join mode ("Join N") → `groupMasks`; on a
    grouped mask the button reads "Split".
  - Keys:
    - Delete/Backspace deletes. Ctrl/⌘+Z undoes; Ctrl/⌘+Shift+Z or Ctrl+Y redoes.
    - Arrows nudge 0.5% (Shift 5%); Alt+arrows resize.
    - G groups, L labels. Esc deselects, otherwise cancels.
    - Tab cycles masks (`tabindex=0`, `role="button"`, aria "Part k of G, label …, selected").
  - "Add box" puts a 20% box in the middle of the view. Resize/orientation change re-fits; `visualViewport` resize
    re-fits when the keyboard opens.
- Cancel with changes (including Escape's `cancel` event) → in-dialog "Discard your changes?" (Keep editing /
  Discard). Never `confirm()`.
- setPointerCapture in try/catch. pointercancel aborts. Prevent `gesturestart`.

**Other files:**
- `js/card-editor.js`:
  - `noteKinds` (~139) gets a third chip `['occlusion', 'Image occlusion']`. The change handler (~223) shows the
    Basic/Cloze/Occ pane, and `lastKind` (~232) accepts it.
  - `occlusionFields` with no image: a big "Choose a picture" button plus a hidden
    `<input type=file accept="image/*" id="${p}OccFile">`. Desktop also gets drag-and-drop and screenshot paste
    (Ctrl/⌘+V).
  - Picking runs `addImageInfo(file, { maxSide: OCCLUSION_SIDE })` ("Preparing picture…") and opens the editor.
  - With an image: the preview + "Edit boxes" + "Makes N cards" + the Labels list + Header + Extra. Editor Done →
    `setOcclusion`.
  - No "change picture" in v1 ("To use a different picture, make a new card").
- `js/browse.js`:
  - `openAddCard` (~505): an `#acOcc` pane; submit when the kind is occlusion: `planOcclusionSave([], readOcclusion('ac'))`
    → errors to acErr → `db.saveNote(plan, { deckId, noteId: db.newId(), tags, noteExtra })` → reset, toast
    "Added N cards", refresh.
  - The edit panel's "Edit boxes" opens with `focusN` = the card's n and `maxN` = the max n across siblings; Save goes
    through `saveOcclusionNote`.
- `sw.js`: add the editor to CORE, bump CACHE, update the hash.
- CSS: `.occ-ed` full-screen on phones (100dvw × 100dvh, safe areas); ≥ 1024px `min(1200px, 96vw) × 92dvh`. Toolbar,
  handles, join mode, label row; the kind switch wraps at 375.
- Docs: PLAN.md "After v3.0" item 3 → ✅ with the decisions; README features line.

**Edge cases:**
- Drawing while zoomed maps correctly and clamps at the edges. A tap-sized drag makes nothing; a 1st finger drawing
  that gets a 2nd finger leaves no box. Overlapping masks: the topmost wins.
- No boxes → "Draw at least one box".
- Editing after reviews: move/resize/relabel keeps the schedule. Delete or join asks first (`occRemovalText`) and
  re-plans at confirm. New boxes → new cards. Guard against a double submit.
- Review → E → Edit boxes → Save refreshes the session. Tall/wide images fit both axes; a 12MP photo only keeps the
  2048 copy.

**Tests:** `tests/browser/e2e-occlusion-editor.mjs`.
- Phone 375×812 `isMobile`/`hasTouch`, real touch via CDP:
  ```js
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  async function swipe(a, b, steps = 8) { await touch('touchStart', [a]); for (let i = 1; i <= steps; i++) await touch('touchMove', [[a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]]); await touch('touchEnd', []); }
  ```
  1. Add card → Image occlusion → `setInputFiles('#acOccFile', png3000x2000)` → the editor opens; media is 2048 wide.
  2. Swipe 3 boxes → masks match the expected fractions (±0.01). A 3px swipe makes nothing.
  3. Select → move → resize from `se`. Pinch → `--s` > 1.5 with the mask count unchanged; draw while zoomed is
     correct.
  4. Undo/redo. Group two → 3 groups; label "Aorta".
  5. Done → "Makes 3 cards" → Add → 3 siblings with backImage, w 2048 and the label.
  6. Edit boxes → delete a group → Save → the confirm names it; Cancel keeps it; confirm removes it and the others
     keep their ids/states.
  7. Cancel with changes → discard confirm. `scrollWidth <= 375` throughout; toolbar buttons ≥ 44px.
- Desktop 1440×900 with `page.mouse`: draw; the wheel zooms at the cursor (anchor within 2px); Shift-click + G;
  arrows; Delete; Ctrl+Z; Add box; Tab reaches the masks.
- Screenshots `occ-editor-375.png` / `occ-editor-desk.png`. Then Review the card at 375 and Play with 4 labelled boxes.

**Acceptance:**
- Both suites green.
- At 375px, choose → draw → label → save takes ≤ ~6 taps for a 3-box note, with no sideways scroll and no page
  zoom/scroll while drawing.
- Desktop mouse, wheel and keys all work.
- Editing a reviewed note keeps schedules except for confirmed deletions. CACHE bumped, hash updated.
