# Round 2 Batch 1 review (bd17300..e6c5cd9)
A2's counts, A1's Keep going and the undo bookkeeping are verified correct. Fix everything below, each with a test.

## Blocking
1. **cloze.js:245 `withClozeLines`** splits the raw text on `\n` and drops blank lines without regard to CSV quotes.
   - A CSV export containing a cloze card re-imports with the CSV tail leaking into the front ("…DNA,,bio"), lost tags, and blank lines inside multi-line cells dropped.
   - Fix: when `parse(src)` is a separator result with `sep` `,` or `\t`, decide cloze per PARSED row (`hasClozeLines(r[0])`), build the notes from `r[0]` (Extra from `r[1]`), keep `result.tags[i]`, and never re-split the text.
   - Test: add a cloze card + a multi-line cell to `tests/csv-roundtrip.test.js`, run through `withClozeLines(…, parseText)`.

## Should fix
2. **import.js:43, Word bullets broken.** The `[-*•–] +(?![|\t])` change makes "•\tMitosis - cell division" give front "•" (a regression).
   - Keep marker-only fronts only on the CSV/quote-aware export path, or keep stripping marker+tab when ≥70% of lines start with the same marker.
   - Update the test at `csv-roundtrip.test.js:35` accordingly.
3. **The `'` guard round trip** (export.js:17, import.js:115,125). A real value starting with `'` loses it, and plain pastes like `'+' operator` lose it too.
   - Export: `if (/^'*[=+\-@\t\r]/.test(s)) s = "'" + s`.
   - Import: strip `/^'(?='*[=+\-@\t\r])/` only when the header is the export's own (`Front,Back,Tags…`).
4. **export.js:17:** also guard a leading `\t` and `\r` (OWASP).
5. **export.js:23:** tags containing a space split on re-import. Export with `join(', ')` (`splitTags` understands commas).
6. **decks.js:359 ⋯ menu:**
   - After choosing an item, focus is lost (it ends on BODY after Esc). Call `close(true)` before `openSheet` so the ⋯ button has focus.
   - Items get `tabindex="-1"` (roving focus); add Home/End.
   - Remove the document pointerdown listener on re-render (listener build-up).
7. **card-editor.js:197 / browse.js:571:** the disabled Add hides its reason from keyboard/SR users. Use `aria-disabled="true"` + `aria-describedby="acWhy"`, keeping the submit-handler checks.
8. **Rescue label prep (decks.js:422):** when cards are held by rescue, label them separately. Add `heldByRescue` to `deckCounts` (zero until 2A wires rescue into Review) so 2A only has to pass `data.rescue`.
9. **Performance (decks.js:274,414,381; study-data.js):**
   - `renderDeck`/`refreshCounts` call both `loadDecks()` and `loadAll()` (each reads all cards and states). Let `loadAll` expose the cards so `loadDecks` can reuse them.
   - Memoise `dueOf` in a Map.
   - Cache `noLimit()` inside `deckCounts`.
   - The tree calls `countFor` per row on every search keystroke: cache it.

## Nits
- **decks.js:345:** the dev `console.warn` never fires (`anyLimit` is always true because `newPerDay` defaults to 20). Check only the review limits.
- **CSS section labels** are out of order (22b, 25, 23): renumber in file order. No rule collisions found.
- **README** still says "Same blank". The button is now "Same blank as the last one".
- **`drawFinishExtras`** must tolerate ids of cards deleted mid-session.
- **Tags column detection:** a third column headed "Tag" in a vocab list is swallowed. Low risk: require the header to be exactly "Tags", or the export header.
- **Keep going:** `aria-label="Keep going: N cards"`.
- **Missing tests:**
  - the CSV round trip with cloze, a `'=` value and a spaced tag
  - the Word `•\t` paste
  - menu focus after Edit
