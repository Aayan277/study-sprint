# Image occlusion (PLAN "After v3.0" round 3) — design

Approved style: **"hide all, guess one"**. Built on the cloze model from round 2 (v3.7): siblings share a `noteId`,
the sibling rule (one per note per day, Exam prep shows all) applies unchanged.

## Data (no new store, no DB_VERSION bump, no Supabase SQL change)
- Siblings share `noteId`. Each card gets
  `occlusion: { image: mediaId, masks: [{ id, n, shape: 'rect'|'ellipse'|'polygon', x, y, w, h, points?, label? }], n }`.
- Coordinates are **fractions (0–1) of the image size**, so they survive resizing. Masks with the same `n` form one
  card (grouping). Optional note `header`.
- Fallback for older app versions: `front` = header or "Diagram: what is under mask 3?", `backImage` = the image,
  `back` = the label. Older apps then show a sensible picture card instead of a spoiled one.
- Sync: masks are small JSON inside the card row; the image goes through the existing media pipeline and Supabase
  Storage bucket.
- Validate in `checkBackup`: masks are an array of objects with finite 0–1 numbers; `n` positive integer.

## Drawing UI (new `js/occlusion-editor.js`, pure helpers in `js/occlusion.js`)
- Full-screen sheet, `touch-action: none`, Pointer Events.
- One finger drags out a rectangle (minimum 3% of the image so taps don't make specks). Two fingers pinch/pan the
  view, so they can't be confused with drawing.
- Tap a mask to select it; drag to move; corner handle to resize. Buttons: Delete, Group (selected masks share an
  `n`), optional Label, Undo.
- v1 draws **rectangles only**; ellipses and polygons are rendered (from Anki imports) but not drawn.
- Entry point: Add card → a third type next to Basic | Cloze (or "Image occlusion" from the picture button).

## Rendering
- A `div` with the image's `aspect-ratio` holding the `<img>` and absolutely placed boxes in `%` (polygons via CSS
  `clip-path: polygon()`). No canvas.
- Front: every mask grey; the active group in the accent colour with "?". Back: only the active group uncovered,
  the others stay covered. Keep the Review flip / inert / aria patterns; give masks an accessible label
  ("Hidden part 2 of 5"), and the back reads the label.
- Play: occlusion cards are playable only when they have a label (typing, or multiple choice from the other labels).

## Anki import (fixes the current picture-card fallback from v3.1)
- Anki 23.10+ image-occlusion notes are cloze notes whose Occlusion field holds
  `{{cN::image-occlusion:rect:left=.23:top=.1:width=.4:height=.5:oi=1}}` (also `ellipse`, `polygon` with
  `points=`, and `text` shapes; `:` is escaped as `\:`). `oi=1` = hide all, guess one.
- Values ≥ 1 mean absolute pixels (older versions): divide by the image size.
- Image from the Image field, header from the Header field; skip `text` shapes.
- The old "Image Occlusion Enhanced" add-on uses SVG mask files (scripts not allowed): import those as plain
  picture cards with a note saying so.
- Export to Anki's occlusion note type is deferred: export as Basic cards with the picture.

## Risks / owner decisions
- The 1280px picture downscale makes small diagram text hard to read: consider 2048px for occlusion images only
  (bigger files and storage). **Ask the owner.**
- Placing masks on very small phones: zoom in the editor.
- Editing masks after reviews started: moving keeps the schedule; deleting a group asks first (same as cloze).

## Tests
- `tests/occlusion.test.js`: parsing Anki strings incl. escapes, pixels → fractions, hit testing, grouping,
  save plan (reuse cloze `planNoteSave` ideas), checkBackup validation.
- Anki fixtures (make one with tests/browser/make-files), sibling rule, and a browser test drawing with simulated
  pointer events at 375px; Review front/back; Play with labels.
