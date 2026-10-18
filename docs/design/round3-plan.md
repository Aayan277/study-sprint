# Study Sprint: round 3 plan

Status: plan for approval. Base: `origin/main` at v4.9 (589f545). Inputs: `PLAN.md`, `README.md`, `student-research.md`, `fsrs-optimizer-plan.md`, and the code on `origin/main`, with `origin/wip/v410-ring` and `origin/wip/fsrs-opt-1` checked for overlap.

Items in this round: **1** study by tag or question ID, **3** audio on cards, **4** elements cards, **5** cards that work in both directions, **10** postpone, **12** your own glossary, and improvements **A** (Anki field names), **B** (sounds not imported), **C** (Play "I was right"), **D** (tag folders) and **E** (readiness is an estimate). Items 6 and 7 come later. Item 2 (the FSRS optimizer) is built separately.

---

## 0. Summary

| Item | What | Batch | Effort |
|---|---|---|---|
| 3 + B | Sounds on cards, kept from Anki, with a play button and auto-play. The import reports sounds it couldn't keep | 1a | L (4–5 days) |
| 5 | Cards that work in both directions (a linked reverse card), including Anki "Basic (and reversed card)" | 1b | M–L (3 days) |
| A | Anki fields keep their names, shown as folded sections | 1b | M (1.5–2 days) |
| 1 | Study by tag or question ID | 2 | M (2 days) |
| D | `::` tags shown as folders in Browse → Tools | 2 | S (1 day) |
| 10 | Postpone | 2 | S–M (1.5 days) |
| C | Play: "I was right" and "Accept this answer from now on" | 2 | S–M (1.5 days) |
| E | Readiness note | 2 | XS (0.25 day) |
| 4 | Elements cards | 3 | S–M (2 days) |
| 12 | Your own glossary | 3 | M (3 days) |

Total: about 22–24 working days of coding. Batches 1a, 2 and 3 can run at the same time. 1b follows 1a, because both change the Anki import and export code.

---

## 1. Ground rules for every batch

- **Data format changes need the owner's OK** (PLAN.md, "How I want you to work"). Every new field is listed in decision D1 (section 6).
- **No new IndexedDB store and no `DB_VERSION` bump.** Sounds go in the existing `media` store. The glossary uses the `settings` store. A version bump would block any tab still open on an older version ("Close other Study Sprint tabs and reload").
- **No Supabase table change.** `sync_items.store` has a check constraint listing five stores. A new store name would make every push fail until the owner ran a migration. Only `supabase/media.sql` changes: its list of allowed file types gets the sound types. The app has to keep working until the owner runs it (section 2).
- **Ready for the "Clinical" restyle (`html[data-ui]`):** new UI uses only existing tokens (`var(--...)`) and component classes (`.sheet`, `.cs-opt`, `.tchip`, `.btn`, `.switch`, `.adv-row`, `.chips`). No hard-coded colours. Every new class is listed in the batch's PR description so the restyle can cover it. Each batch puts its CSS after a different existing section (named in section 5), so the hunks don't collide.
- **Service worker:** every new `js/*.js` file goes in `CORE` in `sw.js`. Bump `CACHE` and run `node tests/update-sw-hash.mjs`. `sw.js` will conflict between batches every time; whoever merges second re-bumps and re-hashes.
- **Browser tests share port 8123.** Parallel worktrees queue behind each other (run.mjs waits). Coders should run `npm run test:browser <name>` for their own files and leave the full run to the end.
- **Version numbers are given in merge order:** v4.10 (in progress), then v4.11, v4.12 and so on.

---

## 2. Storage limits for sounds

### How pictures work today (from the code)
- **On the device:** `media` store `{ id, type, data: ArrayBuffer, size, created, uploaded }`. Cards point at a picture with `frontImage` / `backImage`. Photos are re-saved as JPEG (1280px; 2048px for occlusion).
- **Sync** (`js/sync.js` `syncMedia`, `js/supa.js`): pictures are files in **Supabase Storage**, not `sync_items`. The bucket `media` is private, with one folder per user (`<uid>/<mediaId>`). Row-level policies come from `supabase/media.sql`, which sets `file_size_limit` to 5 MB and `allowed_mime_types` to jpeg, png, webp and gif. After the records sync:
  - pictures with `uploaded: false` are uploaded **one at a time**;
  - every picture a card uses that this device lacks is downloaded, eagerly and one at a time;
  - `cleanMedia()` deletes pictures that no `frontImage`/`backImage` uses (after a one-hour grace period), here and on the server.
  
  A storage error is shown as a note ("Pictures can't sync yet: run supabase/media.sql…") and doesn't stop the rest of sync. Note that **one failed upload stops the whole picture loop**.
- **Backups:** `exportAll` writes every media row as base64. `checkBackup` rejects any type outside `ALLOWED_IMAGE_TYPES`, and so would reject a backup containing sounds.

### Browser limits (approximate; they change between releases)
- **Chrome / Edge / Android:** one site can use up to about 60% of free disk. The browser deletes it only under storage pressure, unless `navigator.storage.persist()` was granted (it usually is for installed apps).
- **Safari 17+ (iOS/macOS):** about 60% of disk for browser sites, less for some embedded cases. Safari can delete storage of sites **not opened in the browser for 7 days**; home-screen apps are exempt. Before 17, the limit was about 1 GB, after which Safari asked.
- **Firefox:** up to about 10% of disk (or a group limit) while storage is best-effort; more once persisted.
- In every browser, `navigator.storage.estimate()` gives `{ usage, quota }`. Use it before an import and in Settings.

### Sizes and the server
- Anki word sounds are usually 10–40 KB and sentence sounds 30–150 KB. A 6,000-note vocabulary deck with word and sentence audio is typically **150–400 MB**.
- Supabase free projects have about **1 GB of Storage** and a monthly bandwidth allowance (the owner should check current pricing). Two big language decks could fill it. Every new device downloads every sound once.

### Decisions (the size cap is owner decision D2)
1. **Cap: 1 MB per sound.** Bigger files are skipped and reported (B). The bucket's 5 MB limit stays as a backstop.
2. **Before an Anki import with sounds:** add up the zip entries' sizes (fflate's `filter` callback sees each entry's size, so nothing is unpacked). Show "Bring sounds (about 96 MB)". If `usage + incoming > 0.8 × quota`, the switch starts off with the note "Not enough free space on this device for the sounds (about 96 MB needed, 40 MB free)."
3. **After the first import or add of a sound,** call `navigator.storage.persist()` once (it shows no prompt in Chrome and Safari).
4. **Settings → Your data** gets a line: "On this device: pictures 34 MB · sounds 120 MB · about 2.1 GB free." (from `estimate()` plus the summed `size` of media rows).
5. **Sync:** sounds use the same bucket and paths as pictures. Each file's error is caught so one failure never stops the others. A file-type rejection (the owner hasn't re-run `media.sql`) leaves the sound `uploaded: false`, sets `blocked: 'type'` (cleared on each app version or Sync now), and shows "Sounds can't sync yet: run the new supabase/media.sql in your Supabase project (see docs/sync-setup.md). Pictures and everything else are syncing." Downloads run **4 at a time** with "Downloading sounds: 12 of 340…".
6. **Backups:** Export backup gets the switch "Include sounds (120 MB)". It is on when sounds total 150 MB or less; above that it is off, with the note "Very large backups can fail on phones." A backup that contains sounds is `version: 2`, so older apps say "made by a newer version" instead of "damaged". Without sounds it stays `version: 1`.
7. **Old tabs:** an old tab's `cleanMedia` would delete sounds, because it only counts `frontImage`/`backImage`. When the new service worker takes over, app.js reloads every tab (the `controllerchange` handler), and the one-hour grace period covers that window. That is accepted, and the new `cleanMedia` counts sound references from day one.

---

## 3. The items

### Item 3: sounds on cards (Batch 1a)

**Data model**
- Card fields `frontSounds` and `backSounds`: arrays of 1–4 media ids. The field is absent when a side has no sounds. Cloze siblings share the ids, as they do for pictures.
- Media row: as for pictures, plus `name` (the original file name, used for export). Allowed types (`ALLOWED_MEDIA_TYPES` in db.js) are the images plus `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/webm`, `audio/wav` and `audio/flac`. `audio/x-wav` is stored as `audio/wav`. Sound bytes are stored as they are, never converted.
- `db.js`:
  - `cleanMedia` counts `frontSounds`/`backSounds`;
  - `checkBackup` accepts the new types and checks that the sound fields are arrays of at most 4 valid ids;
  - `exportAll({ sounds })` can leave sounds out;
  - `BACKUP_VERSION` is 2 when sounds are included.
- `sync.js` `syncMedia`: each upload has its own try/catch, the "want" list includes sound ids, and downloads run 4 at a time. `supa.js` reports a file-type rejection as `code: 'media_type'`.
- `supabase/media.sql`: the sound types are added to `allowed_mime_types` (the file is already safe to re-run). `docs/sync-setup.md` gets a line on re-running it.
- **Anki import:**
  - `anki.js` gets `soundNames(html)` (`/\[sound:([^\]]+)\]/g`, URL-decoded), called **before** `htmlToMarks` removes the tags. The front's sounds come from field 0, the back's from the other fields. For a cloze note, sounds in Text are on the front and the rest on the back. Occlusion notes get none.
  - The result gains `sounds[i] = { front: [...], back: [...] }`.
  - `anki-read.js` gets `audioType(name)`, and `media.get` returns the right type for sound files.
  - `import-screen.js` saves sounds without changing them (no `processImage`), stores each file once, and enforces the 1 MB cap.
- **Anki export:** `[sound:<id>.<ext>]` goes at the end of the side's field, after the text and picture, and the file goes in the package. Extensions: mp3, m4a, aac, ogg, webm, wav, flac. Importing that file again gives the sounds back. CSV leaves sounds out, and the Export sheet already says "Pictures and sounds aren't in CSV files" (that wording is the change).

**UI and wording**
- **Review:** a row of play buttons under each side's text: `<button class="snd-btn" aria-label="Play sound 1 of 2">▶</button>`. With more than one sound, a side plays them in order.
  - **R and the speaker button** play the side's sounds when it has any, otherwise they read it aloud (title: "Play the sound or read aloud (R)").
  - **Auto-play** is a deck option in Edit deck under "Read aloud", inherited by subdecks like `ttsAuto`: switch **"Play sounds automatically"**, with the description "In Review: the front's sounds when a card appears, the back's when you flip." The field is `soundAuto`: absent means on, `false` means off.
  - When a side has sounds, automatic read-aloud is skipped for that side.
  - Playback stops on the next card, on Undo, when leaving Review, and when you start read-aloud.
  - If the browser blocks auto-play (`play()` rejects), the first ▶ pulses once and the hint "Tap ▶ to play" appears.
- **Play:** a ▶ button next to the prompt when the asked side has sounds. Sounds never auto-play in Play, because rounds are timed.
- **Card editor:** a music-note button next to the picture button, with the label and title "Add a sound". It opens a file picker (`accept="audio/*"`). Each sound shows as "▶ Sound 1 · 24 KB · Remove". There are at most 4 per side ("Up to 4 sounds on each side").
  - Too big: "That sound is 3.4 MB. Sounds can be up to 1 MB: shorten it or save it at a lower quality."
  - Can't play here (`canPlayType` is empty): it is saved anyway, with the note "This browser can't play .ogg files. Other devices may."
- **Card list:** a ♪ mark on rows with sounds (`aria-label="Has sound"`). The card panel shows its play buttons.
- **Import preview:** the summary line "312 notes have sounds, which come along too." and a switch row (same style as `progRow`) **"Bring sounds"**, with "About 96 MB. Kept on this device, synced like pictures and kept in backups."

**Edge cases**
- A sound named on a card but missing from the package (reported by B).
- The same file on many cards (stored once).
- Formats Safari can't play (older iOS and Ogg): show a disabled ▶ with the title "This sound can't play in this browser".
- iOS needs a user tap before it allows playing: use one shared `HTMLAudioElement`, unlocked by the tap that starts the session.
- Older app versions keep the sound fields on cards they edit (cards are saved whole) but never play them.
- A synced sound that hasn't been downloaded yet: ▶ downloads it first (like `mediaURL` for pictures). If it isn't available, the title is "Sound not available on this device yet".
- A sound on a side that has no text.
- Cloze siblings share the ids, and `cleanMedia` keeps them while any card uses them.
- A backup restored on a device with little free space: `importAll` fails as one transaction and keeps everything as it was, with the message "Not enough space on this device to restore this backup."

**Tests**
- Unit:
  - `anki.test.js`: `soundNames`, and the front/back split for basic, cloze and occlusion notes;
  - `export.test.js`: `[sound:]` in fields and the media list;
  - `backup.test.js`: audio types accepted, version 2, invalid sound fields rejected;
  - a new `media-clean.test.js` (a pure helper `usedMediaIds(cards)` taken out of `cleanMedia`);
  - `sync.test.js`: one failed upload doesn't stop the others; a type rejection gives the note.
- Fixtures: `tests/browser/make-files/make_apkg_media.py` adds a short WAV made with Python's `wave` module and a small MP3 frame, giving `anki-sound-legacy.apkg` and `anki-sound-new.apkg`, plus one 1.2 MB sound for the cap.
- e2e, new `e2e-sounds.mjs`:
  - import, then the summary text and the B line;
  - Review shows ▶; auto-play is called (spy on `HTMLMediaElement.prototype.play`) and is off when the deck switch is off;
  - R plays the sound instead of speaking;
  - editor add, remove and the size limit;
  - export `.apkg`, then re-import, and the sound is still there;
  - backup with and without sounds;
  - `fake-supabase.mjs` accepts audio uploads and can be set to reject the type, so the note shows.

**Effort:** L, 4–5 days.

### Item B: "N sounds not imported" (Batch 1a, with item 3)

- No data change. `notesToImport` counts sounds per reason: `missing` (not in the package), `tooBig` (over 1 MB), `format` (not an allowed type) and `off` (the "Bring sounds" switch is off).
- **Wording** (an import summary line, `warn` style, like the picture lines): "14 sounds weren't imported: 9 are bigger than 1 MB, 3 aren't in the file, 2 are a format the app can't keep." With the switch off: "Sounds are left out (Bring sounds is off)." Only the reasons that apply are listed, as "N sound(s)".
- **Edge cases:** the same missing file named on 50 cards counts once (distinct names). The counts change when the deck picker changes (`onlyDeck` passes the per-row reasons through).
- **Tests:** an `anki.test.js` counting case, and the summary line asserted in `e2e-sounds.mjs`.
- **Effort:** S, 0.5 day, inside item 3.

### Item A: Anki fields keep their names (Batch 1b)

**Data model**
- New card field `noteFields: [{ name, text }]`: at most 24 entries, `name` up to 60 characters, `text` up to 20,000 characters, in card text format (marks). Every card of a note stores it, like `noteExtra`.
- `noteExtra` stays as it is: the note's main extra field, shown open as today. For a cloze note that is the field named "Back Extra" or "Extra" (`fieldIndex`), else field 1. The other non-empty fields become `noteFields`, in note-type order, with the note type's field names.
- **Basic notes:** fields other than the chosen front and back columns become `noteFields`. `buildCards` does this because the columns are chosen in the preview. The result carries `fieldNames` (the model's names per row).
- `checkBackup`: `noteFields` must be an array of `{ name: string, text: string }` within the limits.
- **Anki export:** each field is added to Back Extra (cloze) or to the end of Back (basic) as `<details><summary>Name</summary>html</details>`. Anki shows it as a folded section.
- **Anki import:** `<details><summary>` blocks in Back Extra are read back into `noteFields`, so a file exported here comes back the same. CSV keeps Front/Back only, and that is documented.

**UI and wording**
- **Import preview:** a switch row **"Keep the other fields"**, with "Anki fields like First Aid or Sketchy stay under the answer, folded, with their names." It shows only when a note has 3 or more non-empty fields, and is on by default. The summary line says "Other fields come along as folded sections." The current "joined into one block" behaviour stays for the switch-off case.
- **Review back:** after `.flash-extra`, one `<details class="note-field"><summary>First Aid</summary>…</details>` per field. Whether a field is open is remembered on this device per field name (`foldOpen`/`saveFold` keys `field:<lowercase name>`), so "Missed Questions" can stay open everywhere. Like `.flash-extra`, they are hidden until a step card's last step is shown.
- **Full card editor** (card panel → Edit): a fold **"Other fields (N)"**, with one textarea per field labelled with the field's name and a "Remove field" button. Cloze notes save the fields on every sibling through `db.saveNote`'s `common`.

**Edge cases**
- A field with only pictures is dropped and counted: "Pictures in other fields are left out (N)."
- Duplicate field names are both kept.
- A field holding `{{c1::…}}` is shown as plain text, not as blanks.
- Huge AnKing fields: the limit is applied with "…" and the summary says so.
- Empty fields are dropped.
- An edit that removes every field removes `noteFields`.
- Search doesn't look in `noteFields`, which keeps Browse fast (decided below).

**Tests**
- Unit: `anki.test.js` (AnKing-style model with Text, Extra, Personal Notes, First Aid, Sketchy → `noteExtra` plus 3 `noteFields`; basic with 4 columns); `export.test.js` (`<details>` written, read back the same); `backup.test.js`.
- Fixture: `anki-anking.apkg` with AnKing-style fields **and** tags such as `#AK_Step1_v12::#UWorld::Step::12345`. Batch 2 uses it too, so it is created in the shared fixtures commit (section 5).
- e2e: `e2e-anki-fields.mjs` (sections shown folded, open state kept after a reload, edit and save).

**Effort:** M, 1.5–2 days.

### Item 5: cards that work in both directions (Batch 1b)

**Data model**
- A pair is two cards with the same new `noteId`. The second card has `reverse: true`.
- The reverse card keeps a full ordinary front and back, like cloze cards do, so search, CSV, older versions and backups still work. Its `front`/`back`, `frontImage`/`backImage` and `frontSounds`/`backSounds` are the forward card's swapped.
- `deckId`, `tags`, `noteExtra` and `noteFields` are shared. `suspended`, `buriedUntil`, `flag` and the schedule are per card. Both cards get `noteEditedAt` when saved (`db.saveNote`).
- New pure module `js/reverse.js`:
  - `isPair(card)`: has `noteId`, and no `cloze`, `occlusion` or `noteText`;
  - `canReverse(card)`: not cloze, occlusion, steps or elements, and both sides have text or a picture;
  - `reverseOf(card, id)`;
  - `pairPlan(forward, reverse, edits)`;
  - `healPairs(cards)`: after a sync clash, the newer `noteEditedAt` wins and rewrites the other card. A lone survivor loses `noteId`/`reverse`;
  - `playPool(cards, qtype)`.
- The queue needs **no change:** `limitSiblings`, `answeredNotes` and Review ahead's sibling hold already work on any `noteId`. So Review shows one card of a pair a day, like cloze, and Today counts the same way.
- `sync.js` `healNotes()` also runs `healPairs`.
- `checkBackup`: `reverse` must be `true` or absent, and only with a string `noteId`.
- **Anki import:**
  - `anki-read.js` reads the note types' **templates**. In the new layout that is `SELECT ntid, ord, config FROM templates`, with `config` field 1 being the front template text (`q_format`). In the old layout it is `m.tmpls[].qfmt`. Models gain `templates: [{ ord, qfmt }]`.
  - `anki.js` `reverseModel(model)` is true when the model has exactly 2 templates and template ord 1 uses `fields[1]` (for example `{{Back}}`, including `{{#Add Reverse}}{{Back}}{{/Add Reverse}}`) and not `fields[0]`.
  - When a note of such a model has `note.cards[1]`, the row gets `reversed[i] = { ankiId: note.cards[1] }`. So "Basic (and reversed card)" brings both, and "Basic (optional reversed card)" brings the reverse only when Anki made one.
  - The save step makes both cards. The reverse card's history is replayed from its own Anki id.
  - Notes of models with other or more templates bring only card 1, as today, with the summary line "12 notes have more card types in Anki (like a listening card); only the first card of each comes in."
- **Anki export:** pairs go out as one note of a new type "Study Sprint Basic (and reversed card)" (`BASIC_REV_ID = 1_600_000_000_004`, templates `{{Front}}` and `{{Back}}`). Ord 0 is the forward card and ord 1 the reverse. The guid comes from the forward card's `ankiGuid`, or `ankiGuid(noteId)`.
- **CSV export:** one row per pair (the forward card), plus a **"Both directions"** column holding `yes` when there is any pair. Import reads that column only for a file with the export's own header, as for Tags. That keeps the CSV round trip whole.

**UI and wording**
- **Basic editor** (Add card and Edit): switch **"Both directions"**, with "Also asks the back and expects the front. Each direction has its own schedule; Review shows one of the two a day." It is hidden while "Answer in steps" or elements is on, with the note "Step-by-step and elements cards can't be reversed."
  - Turning it off on an existing pair shows an in-page confirm: "Remove the reverse card? Its schedule and history go." [Remove reverse card].
  - The switch's HTML comes from `reverseSwitchHTML()` in `reverse.js`. It is inserted in `browse.js` `openAddCard`/`openCardEdit` **after** `basicFields(...)`, so Batch 3's changes inside `basicFields` don't collide.
- **Editing either card** saves both, swapped, in one `db.saveNote({ update: [a, b] }, common)`.
- **Card list:** reverse cards show a small "Reverse" label (`.st-pill` style). The card panel shows "Reverse card · Open the other direction".
- **Bulk action** (selected cards): **"Both directions"**, which asks "Add reverse cards to 21 cards? 3 can't be reversed (cloze, picture-only or step cards)." [Add 21 reverse cards].
- **Delete** a card of a pair: "This card has a reverse card." [Delete both] [Only this one]. "Only this one" turns the other into an ordinary card (removes `noteId`/`reverse`).
- **Move** and **tags** already apply to the whole note (`cardOps` `wholeNote`). Flag, bury and suspend stay per card.
- **Import preview:** pair rows show "Both directions: makes 2 cards". The switch row **"Make the reverse cards too"** is on by default and shown only when any row has one. The Add button counts both cards.
- **Play** (`playPool`): front → back and typing rounds use the forward card and skip the reverse. Back → front rounds use the **reverse card asked front → back** and skip the forward. So with "Count Play answers as reviews" on, the right direction's schedule is graded. `pickDistractors` already leaves out siblings.
- **Leech coach:** Split is already hidden for cards with a `noteId`. Memory hook saves to both cards.

**Edge cases**
- A new pair takes two days to introduce both cards (one a day), as in Anki with siblings buried. The help text says so.
- A forward card edited into steps or elements: saving asks "Step-by-step cards can't have a reverse card. Save and remove the reverse card?"
- One device edits the front while another edits the back of the reverse card: `healPairs` keeps the newer one.
- One card deleted on another device: the other becomes ordinary after `healPairs`.
- A picture-only front: the reverse card's back is the picture, and typing is turned off for it (`canType`).
- Find and replace on a pair card: `replaceInCards` changes one card, and `healPairs` won't fix it because both have the same `noteEditedAt`. So Find and replace must use `pairPlan` for paired cards. That is in scope here.
- Duplicate check: the reverse card's front is the forward card's back, so it is left out of the Duplicates filter (`dupKey` skip when `reverse`).
- Exam prep shows both directions, like cloze siblings.

**Tests**
- Unit: `reverse.test.js` (new: `reverseOf`, `canReverse`, `healPairs`, `playPool`); `queue.test.js` (a pair shows one card a day); `anki.test.js` (`reverseModel` on Basic, optional-reversed and a 3-template model; `reversed` rows); `export.test.js` (a pair gives one note with 2 cards); `csv-roundtrip.test.js`; `backup.test.js`.
- Fixture: `anki-reversed-{legacy,new}.apkg` with scheduling, so the reverse card's history is tested too.
- e2e: `e2e-reverse.mjs`:
  - add with the switch, then 2 cards; Review shows one of them today;
  - edit the reverse card and the forward card changes;
  - delete "Only this one";
  - bulk add;
  - Anki import of both directions, with history;
  - export, then import, and the pair is kept;
  - Play back → front grades the reverse card (with the setting on).

**Effort:** M–L, 3 days.

### Item 1: study by tag or question ID (Batch 2)

**Data model:** none. Tags are already lowercase on import, and that stays (decided below).
- New pure module `js/tag-tree.js`, shared with D:
  - `tagTree(cards)` → nodes `{ path, name, count, children }`;
  - `cardsUnder(cards, path)` (a tag equal to `path`, or starting with `path + '::'`);
  - `parseIds(text)`: split on whitespace, commas and semicolons, trim punctuation, de-duplicate, keep the order, at most 5,000 tokens;
  - `matchIds(cards, ids, { under })` → `{ cards, found, missing, sources: [{ path, ids, cards }] }`. An ID matches a tag whose **last `::` segment** equals it, ignoring case. Numeric IDs are compared without leading zeros. `sources` groups the matches by the tag's parent path (for example `#ak_step1_v12::#uworld::step`).
- `queue.js` `pickedQueue(cards, states, ids, { spread })` with `spreadSiblings`: cards of one note are kept apart in the queue, never next to each other.
- `study-data.js`: `customQueue('ids', ..., { includeSuspended })` and `launchStudy({ kind: 'ids', cardIds, includeSuspended, label })`. `scopeKey` stays as it is.

**UI and wording** (a new lazy `js/tag-study-sheet.js`)
- **Entry points:**
  - Today → Options → Custom study, a new `.cs-opt` at the top: **"By tag or question ID"**, "Find the cards for the questions you missed in a question bank, or for one tag." [Choose…];
  - Browse → Tools: **"Find by tag or question ID"**.
  
  Both search **all decks**. The sheet says "In all decks", because Custom study's deck choice doesn't apply here.
- **Sheet "Study by tag or question ID":** a segmented control **[Question IDs] [Tag]**.
  - **Question IDs:** a textarea labelled "Paste question IDs", placeholder "For example 12345, 23456 34567: copy them from your UWorld or AMBOSS block".
    - The result updates as you type: **"Found 41 of 45 IDs · 183 cards (120 suspended)"**.
    - When the matches fall under more than one tag folder, a "Look in" select appears ("#AK_Step1_v12 › #UWorld › Step (41 IDs)"). It defaults to the folder with the most IDs.
    - "Not found: 1234, 5678" lists up to 20, then "+ 12 more", with a Copy button.
  - **Tag:** the searchable tag tree from D. Picking a folder or tag shows "#ak_step1_v12 › #uworld › step · 2,410 cards (2,300 suspended)".
- **Footer:** [Unsuspend 120] (ghost) and [Study 183 now] (primary). The study button's exact behaviour depends on decision D3; the recommended version is in the toast below.
  - Unsuspend toast: "Unsuspended 120 cards. New ones join your daily new cards."
  - Study now: closes the sheet and starts Review with the session label "Question IDs" or "Tag: step". With D3 as recommended, the toast is "Unsuspended 120 cards and started a session."
- **No tags at all:** "No cards have tags yet. Anki decks like AnKing bring their tags."

**Edge cases**
- IDs that exist in two question banks (the source picker handles it).
- A pasted table with other numbers in it (only the tokens that match count; the "Not found" list makes that visible).
- Leading zeros.
- 5,000 IDs (matching is one pass building a map from last segment to cards).
- Cards buried today: they are included in "Study now", and the burial is left alone.
- Cloze siblings all carry the note's tags, so all are included, spaced apart.
- New cards studied this way use up today's new-card count, because `newLimits` reads today's log. That is accepted and explained by the "join your daily new cards" wording.
- Leeches tagged "leech" and suspended: Unsuspend includes them. The count line notes "(4 are leeches)".
- Sessions over 500 cards: no limit, and the progress bar shows the size.

**Tests**
- Unit: `tag-tree.test.js` (new: `parseIds`, `matchIds` with the source split and leading zeros, `tagTree` counts, `cardsUnder`); `queue.test.js` (`spreadSiblings`, `includeSuspended`); `study-data.test.js`.
- e2e: `e2e-tagstudy.mjs` with the AnKing fixture:
  - paste 3 IDs, one missing, and the counts match;
  - Unsuspend;
  - Study now runs the session and the cards come in the IDs' order;
  - the Tag tab picks a folder.

**Effort:** M, 2 days.

### Item D: `::` tags shown as folders (Batch 2)

- **Data:** none. `browse-logic.js` gets:
  - `renameTagPrefix(cards, from, to)`: renames the folder and every tag under it, and merges with tags that already exist;
  - search syntax **`tag:<path>`** in `browseCards`: the path or anything under it, ignoring case. It combines with other words.
- **UI** (Browse → Tools → "Tags in all decks"):
  - When any tag contains `::`, the list becomes a tree. A folder row shows ▸ name · "1,204 cards" and opens to show its children. Children are built when the folder opens, because AnKing has thousands of tags and today's flat list draws them all.
  - Folder actions: **Rename** ("Rename the folder “#uworld” to"), **Remove** ("Remove the folder “#uworld” and its 1,204 tags from every card in all decks? The cards stay.") and **Show cards** (closes the sheet and puts `tag:#ak_step1_v12::#uworld` in the search box).
  - A tag at the end of a path has today's Rename and Remove.
  - Tags without `::` show flat, as now.
  - The Item 1 sheet's Tag tab reuses the same tree component, `tagTreeHTML()` in `tag-tree.js`.
- **Edge cases:**
  - A tag that is both a tag and a folder (`a` and `a::b`): the folder row has its own "(this tag) · N cards".
  - Renaming into an existing folder merges.
  - Empty segments (`a::::b`) are treated as `a::b` for display only.
  - Very deep paths are indented to 6 levels and flat after that.
- **Tests:** `tag-tree.test.js`; `browse.test.js` (`tag:` search, `renameTagPrefix`); e2e inside `e2e-tagstudy.mjs` (open a folder, Show cards fills the search).
- **Effort:** S, 1 day.

### Item 10: postpone (Batch 2)

**Data:** no new fields, no log rows (so the FSRS optimizer's data stays clean). It only rewrites `cardStates.due` and `scheduledDays`, which sync as usual.
- New pure module `js/postpone.js`:
  - `postponeCandidates(cards, statesById, { days, now, recallAt, skip })`. Candidates are cards in the Review state, due by `dayEnd(now)` (due today or overdue), not hidden, and not in a deck whose exam (inherited) is within `days + FINAL_DAYS`. Each gets `before = recallAt(st, dayEnd(now))`, `after = recallAt(st, dayEnd(now, days))` and `damage = before − after`, sorted **from least damage up** (the most stable cards first).
  - `postponeStates(list, days, now)`: new `due = dayEnd(now, days − 1)` (4am, N days ahead), and `scheduledDays` worked out again.
  - `recallAt` is **passed in** (exam.js's `recallAt`), so the FSRS PR's decay change applies without editing postpone.js.

**UI and wording** (Today → Options → Custom study, a new `.cs-opt` after Review ahead; lazy `js/postpone-sheet.js`, or inline if small)
- Title **"Postpone reviews"**, with "Busy few days? Push back the reviews you'll still remember best."
- Chips: [1 day] [2 days] [3 days] [1 week].
- A "How many" stepper. Its default is every candidate whose recall stays at 80% or better after the delay; it never goes over the candidates.
- A live line: **"Moves 74 of 148 due reviews to Sunday. Expected recall on them: 93% now, 88% then."**
- When it applies: "Decks with an exam in the next 10 days are left out."
- Button **[Postpone 74 reviews]**.
- Afterwards the toast is "Postponed 74 reviews to Sunday", with an **Undo** link until you leave Today. That puts the old states back with `db.putStates`. This needs `toast`'s `link` option to take an `onClick` (a small `ui.js` change).
- With no candidates: "Nothing to postpone: no reviews are due." (button off).

**Edge cases**
- Learning and new cards are never moved.
- Cards brought forward by an exam (`exam.caps`) are left out.
- Overdue cards move to N days from **today**, not from their old due date.
- Daylight-saving changes (`dayEnd` handles them).
- A catch-up plan running: postponed cards just leave the backlog.
- Postponing twice adds up.
- Sync: newest wins per state, as for any edit.
- The scope is the decks chosen in Options, the same as Custom study.

**Tests**
- Unit: `postpone.test.js` (new: ordering, exclusions for exam, learning, hidden and caps; the due time at 4am over a daylight-saving change, run like `stats-dst.child.mjs`; the default count rule).
- e2e: `e2e-postpone.mjs` (seed 10 due cards with different stabilities; postpone 2 days; the most stable ones move; Today's count drops; Undo puts them back).

**Effort:** S–M, 1.5 days.

### Item C: Play "I was right" and "Accept this answer from now on" (Batch 2)

**Data model**
- New card field `acceptAnswers: [string]`: at most 10, each up to 60 characters, plain text. These are answers accepted for **this card's back**. They are kept on the card, so they sync and are backed up with it. `importAll` cleans them with `cleanAccept(card)`, the same pattern as `cleanMixedWith`, which keeps the edit out of `checkBackup` (Batch 1 owns that).
- New log field `overridden: true` on a Play row corrected by the user. It exists only when Play counts as reviews.
- `match.js`: no change. The callers pass `[...answerTargets(answer), ...accepted]` to `checkTyped`, and use the accepted answers only when the question asks for `card.back` (front → back, typing). For a reverse card that is its own back.

**UI and wording**
- **Play feedback after a wrong typed answer** (not multiple choice, a time-out or a skip): a ghost button **"I was right"** next to Next. After a tap:
  - the heading changes to **"Counted as right"**;
  - a second button appears: **"Accept “{typed}” from now on"**. It is shown only when the typed text is 1–60 characters and isn't already accepted;
  - its toast is "Accepted for this card".
- **Lightning** moves on automatically, so the same two buttons are on each typed row of the results' **Missed** list.
- **What the override changes:** the entry counts as right in accuracy, the grade and the Missed list.
  - The **score, streak, lives and Lightning clock don't change** (decision D5).
  - With **"Count Play answers as reviews"** on (v4.10): wait for `round.saving`. If the saved answer changed the schedule, undo it with `db.undoReview(cardId, prev, logId)`, then record it again as right (the same `autoRating` with `ok: true`) with `overridden: true`. If it was only logged, delete the row and log it again as right. For this, `record()` stores `entry.logId` and `entry.prev`.
  - In practice mode (the v4.10 default), nothing is saved, so only the round's results change.
- **Review typing:** under a wrong typed result, a link **"Accept my answer from now on"**. Review already lets you pick the rating, so there is no override button.
- **Card panel → Edit:** a field **"Other accepted answers"** (comma-separated) when the card has any.

**Edge cases**
- Hard mode (no typo forgiveness) still offers the override.
- An accepted answer matching another card's answer: the mix-up check (`typedMixup`) only runs on wrong answers, so it is fine.
- Override after "Card ⋯" edited or deleted the card: the action is skipped and the toast says "That card changed; nothing to fix."
- Two quick taps: the button is disabled while working.
- The leech check: re-recording as right can't make a new leech. Undo puts the old state back first; if the undone answer had made a leech, its tag stays, which is accepted and documented.
- Accepted answers go into Play options? No. They are only for typed checks.

**Tests**
- Unit: `match.test.js` (extra targets accepted, with the diff target being the accepted answer); a pure `overrideEntry(round, entry)` in `game.js`, tested in `game.test.js` (accuracy and grade change; score doesn't).
- e2e: `e2e-play-override.mjs`:
  - a typing round, a wrong answer, "I was right", and the results count it right;
  - Accept, then the next round marks the same text right;
  - with `playCountsAsReviews: true`, the card's state equals a right answer (not Again) and the log row has `overridden`.

**Effort:** S–M, 1.5 days.

### Item E: exam readiness is an estimate (Batch 2)

- `stats.js` readiness card: after `.ready-note`, a `<details class="fine">` like the Retention one. Summary **"How sure is this?"**, text:
  - before the optimizer: "It's an estimate. It uses the standard FSRS memory model, not one tuned to you yet, and assumes you stop reviewing now. Treat it as a guide, not a promise.";
  - after the optimizer (`settings.fsrsParams?.w` is set): "It's an estimate from your own memory model (tuned on 12 Oct from 4,812 reviews), assuming you stop reviewing now."
  
  The date and count come from `fsrsParams`' metadata; the FSRS plan should keep `fittedAt` and `reviews` in it. Until FSRS PR 1 lands, the code only reads `fsrsParams` with optional chaining.
- Add the same sentence to the README's Stats bullet.
- **Test:** an `e2e-stats.mjs` check that the text is there.
- **Effort:** XS, 0.25 day. Only the markup next to `.ready-note` changes, not the `readiness()` call that FSRS PR 2 edits.

### Item 4: elements cards (Batch 3)

**Data model:** **none.** Elements are written as text, the same way step cards are: an optional intro, then two or more numbered lines.
```
Negligence
Element 1: Duty
Element 2: Breach
Element 3: Causation
Element 4: Damages
```
Writing it as text means Anki, CSV, backups and older app versions all show a readable list. So `anki.js`, `export.js` and `db.js` need no change, and there is no new field.
- `steps.js`: the parser takes a marker (`step` or `element`) internally; `parseSteps` behaves exactly as before. New exports:
  - `parseElements(back, { mask })` → `{ intro, items }` (no "Answer:" line);
  - `joinElements` and `elementsRoundTrip`;
  - `suggestRating(n, missed)`: 0 missed → Good; missed ÷ n ≤ 0.25 → Hard; otherwise Again. Easy is never suggested. Examples: 4 elements with 1 missed → Hard; 3 with 1 missed → Again; 8 with 2 missed → Hard.
- If a back reads as both steps and elements, steps win.
- No log field: the rating carries the result (decided below).

**UI and wording**
- **Review front:** the card's front, plus a muted line **"4 elements"**.
- **After the flip:** the elements list with each item hidden (the same `stepsOf` path; `sp.kind = 'elements'`, so the `answerHTML` line in review.js doesn't change).
  - The bar reads **"Recall element 1 of 4, then reveal."** with [Reveal element 1 of 4 · Space] and [Show all · A].
  - Each revealed element has a toggle `<button aria-pressed="true" class="el-tick">✓ Got it</button>`. Tapping it, or **X** for the latest one, switches it to **"✗ Missed"**. Space reveals the next one.
  - After the last, the rating bar shows above it **"You got 3 of 4. Suggested: Hard."**, and the suggested button has a `.suggested` ring with "Suggested" under its interval. The existing `R.suggest` makes Space/Enter press it; 1–4 pick any rating.
  - Show all reveals every element ticked "Got it"; you untick the missed ones.
- **Typing mode:** no typing for these cards (like steps; the note reads "Elements card: recall them in your head, then flip.").
- **Read aloud:** `elementsSpeech` reads the elements revealed so far.
- **Play:** front-only (`game.js` `stepped` → `structured`). Multiple choice asks front → back, with the answer being the elements joined with " · ". Typing leaves them out (`canType` fails).
- **Editor:** "Answer in steps" becomes a 3-way choice, **"Answer: [Text] [Steps] [Elements]"** (a radio group inside `basicFields`).
  - Elements mode reuses the step rows: "+ Add element", up/down, delete, and **"Rule or intro (optional)"**. There is no final answer.
  - Checks: "Add at least two elements, or choose Text." and "A line inside an element can't start with 'Element N:'."

**Edge cases**
- Maths inside elements (`maskMath`).
- An element over several lines.
- Leech coach Split prefills from the elements.
- A chemistry card listing "Elements: H, O" isn't affected, because the marker is "Element N:".
- An edit that changes the number of elements mid-review (handled like steps).
- Undo puts back the step position at 0.

**Tests**
- Unit: `steps.test.js` (`parseElements`; `parseSteps` unchanged; the round trip; `suggestRating` table); `game.test.js` (front-only; multiple-choice answer); `speech.test.js`.
- e2e: `e2e-elements.mjs` (create in the editor; Review reveal, X marks a miss, the suggestion is Hard, Space rates Hard and the state matches; Show all; Play multiple choice).

**Effort:** S–M, 2 days.

### Item 12: your own glossary (Batch 3)

**Data model** (no new store and no server change)
- Each term is its own **synced setting** with the key `gloss:<id>` and the value `{ term, aliases: [], def, at }`, or `null` once deleted. The newest copy wins per term, so two devices adding different terms keep both.
- `sync-data.js`: `isSyncedSetting(key)`, which is `SYNCED_SETTINGS.includes(key) || key.startsWith('gloss:')`.
- `db.js` uses it in `setSetting`, in `localChangesSince` (loop over the `_times` keys, not only the fixed list), in `applyRemote` and in `importAll({ everywhere })`. Backups already include every setting.
- `importAll` drops bad entries (`cleanGlossary`) instead of rejecting the whole backup.
- Limits: term up to 80 characters, up to 5 other spellings of 80, definition up to 1,000 characters (card marks allowed), at most 2,000 terms.
- Older app versions ignore `gloss:*` rows (`applyRemote` skips settings it doesn't know), so nothing breaks.

**Modules:** `js/glossary.js` (pure: `entriesFrom(settings)`, `buildMatcher(entries)`, `findTerms(text, matcher)`), `js/glossary-view.js` (DOM: `underline(root, matcher, { avoid })`, popover), and `js/glossary-sheet.js` (lazy management).

**Matching**
- Case-insensitive, whole words for scripts with spaces (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`), plain substring for CJK.
- Terms of 2 characters or fewer must match capitals exactly, so "Na" doesn't match "na".
- The longest term wins ("ATP synthase" before "ATP").
- **Only the first time** a term appears on each face.
- Skipped inside `.tex`/`.katex`, buttons, inputs, links, `.cloze` blanks, the typed-answer diff and `.occ-*`.
- **On the front, a term that also appears in the card's back isn't underlined**, so it doesn't give the answer away.
- One regular expression is built per glossary version and cached.

**UI and wording**
- **Review** (both faces; not Play, because rounds are timed and a definition can give the answer away; and the card panel's preview): `<button type="button" class="gl-term">ATP</button>` with a **dotted underline**, so it isn't colour alone.
  - Mouse hover (after 300 ms), a tap or Enter opens a small popover: the **term** in bold, the definition (`formatHTML`) and an "Edit" link.
  - Escape or a tap outside closes it, and tapping a term never flips the card (the `#flash` click handler ignores `.gl-term` and `.gl-pop`).
  - review.js calls `underline()` after `drawSessionPage` and after `flip`. That is a two-line hook; the module is loaded only when any terms exist.
- **Manage:** Settings → Study → **"Glossary"** · "12 terms" → the glossary sheet:
  - a search box;
  - rows (term, first line of the definition, Edit, Delete);
  - **"+ Add term"**, a form with Term, "Other spellings (optional, separated by commas)" and Definition;
  - **"Paste a list"**: `term - definition` lines, using import.js's detection. It previews "Adds 34 terms. 2 are already in your glossary and stay as they are."
- **Quick add:** Review's card ⋯ sheet gets **"Add to glossary"**. It opens the form with Term filled from text selected on the card, if any.
- **Device setting:** Settings → Appearance **"Glossary underlines"** (on by default, this device only).
- **Empty glossary:** "Define a term once and it's underlined on every card, with its definition a tap away."

**Edge cases**
- Overlapping terms.
- A term with characters that mean something in a regular expression (escaped).
- RTL text.
- Two devices editing the same term (newest wins). Delete against edit (newest wins).
- An alias that is the same as another term (the longer or first-defined one wins; the form warns "“ATP” is already a term").
- 2,000 terms × long cards (matching runs once per face, on text nodes, and is fast enough; measured in the e2e test with 2,000 synthetic terms and a budget of under 20 ms per card).
- A term inside an occlusion label (skipped).
- A definition with maths (KaTeX loads lazily, as on cards).

**Tests**
- Unit: `glossary.test.js` (new: matcher boundaries, CJK, the short-term capitals rule, longest first, first time only, the front-answer rule, limits); `sync.test.js` (`isSyncedSetting`; `localChangesSince` picks up `gloss:` keys; `applyRemote` newest wins); `backup.test.js` (`gloss:` entries round trip and bad ones are dropped).
- e2e: `e2e-glossary.mjs` (add a term; underlined on the back; popover on tap; the card doesn't flip; Escape closes; front-answer rule; paste a list; a 2,000-term time budget).

**Effort:** M, 3 days.

---

## 4. Build batches

Batches 1a, 2 and 3 run at the same time in separate worktrees. 1b starts when 1a has merged. **Batch 2 starts after v4.10 has merged**, because v4.10 rewrites parts of `today.js`, `play.js` and `study-data.js`.

A shared first step (half a day, merged before any batch branches): fixtures `anki-anking.apkg`, `anki-reversed-*.apkg` and `anki-sound-*.apkg` with their generator scripts, plus empty "Round 3" sections in `PLAN.md` and `README.md` with one placeholder bullet per batch. This removes the most common conflicts (fixtures and docs).

### Batch 1: sounds and Anki notes (1a: items 3 + B; then 1b: items 5 + A)

| File | 1a | 1b | Region / note |
|---|---|---|---|
| `js/audio.js` (new) | ✔ | | player, queue of sounds, unlock, `soundsHTML` |
| `js/reverse.js` (new) | | ✔ | pairs |
| `js/note-fields.js` (new) | | ✔ | `noteFieldsHTML`, `parseDetails`, `toDetails` |
| `js/media.js` | ✔ | | `saveSound`, `cardMediaHTML(card, side)`, types |
| `js/anki.js` | ✔ | ✔ | `soundNames`; `reverseModel`; field names in `notesToImport` |
| `js/anki-read.js` | ✔ | ✔ | `audioType`; templates |
| `js/import.js` | | ✔ | `buildCards` (`noteFields`, `reversed`, CSV "Both directions") |
| `js/import-screen.js` | ✔ | ✔ | switches, summary lines, save step |
| `js/export.js` | ✔ | ✔ | `[sound:]`; reversed note type; `<details>` |
| `js/db.js` | ✔ | ✔ | **only** `cleanMedia`, `checkBackup`, `exportAll`, `BACKUP_VERSION`, `ALLOWED_MEDIA_TYPES` |
| `js/sync.js` | ✔ | ✔ | `syncMedia`; `healNotes` calls `healPairs` |
| `js/supa.js` | ✔ | | type-rejection error code |
| `supabase/media.sql`, `docs/sync-setup.md` | ✔ | | |
| `js/card-editor.js` | ✔ | | **only** `cardTextField` (sound button and row). Not `basicFields` |
| `js/browse.js` | ✔ | ✔ | `openAddCard`/`openCardEdit` (reverse switch after `basicFields`), `cardOps`, delete confirm, bulk action, ♪ mark, Find and replace for pairs. **Not `openTools` or `openCardActions`** |
| `js/review.js` | ✔ | ✔ | the `imgHTML(...)` calls → `cardMediaHTML`; `readAloud`/`autoSpeak`; a `noteFieldsHTML` line after `.flash-extra` |
| `js/play.js` | ✔ | ✔ | `showQuestion` (▶); round pool through `playPool` (in `renderPlay`/`start`) |
| `js/decks.js` | ✔ | | "Play sounds automatically" switch |
| `js/app.js` | ✔ | | Settings → Your data storage line; backup "Include sounds" |
| `js/leech-coach.js` | | ✔ | hook saves to both cards of a pair |
| `css/styles.css` | ✔ | ✔ | after section "Card formatting (format.js, card-editor.js)" |
| tests | ✔ | ✔ | `anki`, `export`, `backup`, `sync`, `media-clean`, `reverse`, `queue`, `csv-roundtrip` · e2e `e2e-sounds`, `e2e-reverse`, `e2e-anki-fields` |

### Batch 2: find and schedule (items 1, D, 10, C, E)

| File | Region / note |
|---|---|
| `js/tag-tree.js` (new) | tree, IDs, matching, `tagTreeHTML` |
| `js/tag-study-sheet.js` (new) | Item 1 sheet |
| `js/postpone.js` (new), `js/postpone-sheet.js` (new) | Item 10 |
| `js/browse-logic.js` | `tag:` search, `renameTagPrefix` |
| `js/browse.js` | **only** `openTools` (tree, "Find by tag or question ID") |
| `js/queue.js` | `pickedQueue` options, `spreadSiblings` |
| `js/study-data.js` | `customQueue('ids')` options, `launchStudy` pass-through |
| `js/today.js` | **only** `openCustomStudy`: two new `.cs-opt` blocks |
| `js/play.js` | **only** `answer()` feedback buttons, `record()` keeps `logId`/`prev`, `finish()` Missed rows |
| `js/game.js` | `overrideEntry` (pure) |
| `js/review.js` | **only** `typedResultHTML` ("Accept my answer from now on") |
| `js/db.js` | **only** the `importAll` card loop (`cleanAccept`) |
| `js/ui.js` | `toast` `link.onClick` |
| `js/stats.js` | **only** the `.ready-note` markup |
| `css/styles.css` | after section "Custom study (Review screen)" |
| tests | `tag-tree`, `browse`, `queue`, `study-data`, `postpone`, `match`, `game` · e2e `e2e-tagstudy`, `e2e-postpone`, `e2e-play-override`, `e2e-stats` |

### Batch 3: elements and glossary (items 4, 12)

| File | Region / note |
|---|---|
| `js/glossary.js`, `js/glossary-view.js`, `js/glossary-sheet.js` (new) | Item 12 |
| `js/steps.js` | `parseElements`, `suggestRating` (shared parser; `parseSteps` behaviour unchanged) |
| `js/review.js` | `stepsOf`/`stepsHTML`/`backBarHTML`/`revealStep`, X key, glossary hook after `drawSessionPage`/`flip`. **Not** the `answerHTML` lines |
| `js/card-editor.js` | **only** `basicFields` and the step-row helpers (3-way mode) |
| `js/game.js` | `stepped` → `structured` (front-only for elements) |
| `js/speech.js` | `elementsSpeech` |
| `js/sync-data.js` | `isSyncedSetting` (a new function; the `SYNCED_SETTINGS` array isn't touched) |
| `js/db.js` | **only** `setSetting`, `localChangesSince`, `applyRemote`, `importAll` settings part (`cleanGlossary`) |
| `js/browse.js` | **only** `openCardActions` ("Add to glossary") |
| `js/app.js` | Settings → Study "Glossary" row; Appearance "Glossary underlines" |
| `css/styles.css` | after section "11. Review" block "The question again, smaller…" (elements) and the sheet section (glossary) |
| tests | `steps`, `game`, `speech`, `glossary`, `sync`, `backup` · e2e `e2e-elements`, `e2e-glossary` |

### Where conflicts are expected, and the merge order
- **Every batch:** `sw.js` (CACHE, CORE, hash), `README.md`, `PLAN.md` and `js/app.js` `APP_VERSION`. These are trivial; whoever merges second rebases and runs `node tests/update-sw-hash.mjs`.
- **`review.js`:** all three batches change it, in separate functions (listed above). Batch 3 must not touch the `answerHTML` lines that Batch 1 changes.
- **`browse.js`:** each batch has its own functions (Batch 1: editor, card operations and bulk; Batch 2: `openTools`; Batch 3: `openCardActions`).
- **`db.js`:** separate functions per batch. v4.10 and FSRS PR 1 both edit `DEFAULT_SETTINGS`, `checkBackup` and the `SYNCED_SETTINGS` array, which conflict with each other (not with this round). Batch 1's `checkBackup` edits land after them.
- **`play.js`:** v4.10's `record()` gets an early return for practice mode. Batch 2 builds on top of that (hence the start after v4.10). Batch 1 only touches `showQuestion` and the round pool.
- **`stats.js`:** FSRS PR 2 changes the `readiness()` call; Batch 2 only adds markup under `.ready-note`.
- **`exam.js`:** no batch edits it. Postpone imports `recallAt` and gets the decay from FSRS PR 1 automatically.
- **Suggested merge order:** v4.10 → FSRS PR 1 → Batch 3 → Batch 2 → Batch 1a → Batch 1b. Batch 1 is the longest, so it merges last and rebases once.

---

## 5. CSS placement (for the Clinical restyle)

New class names to hand to the restyle:
- Batch 1: `.snd-row`, `.snd-btn`, `.snd-btn.pulse`, `.note-field`, `.rev-pill`.
- Batch 2: `.tag-tree`, `.tag-folder`, `.ts-result`, `.ts-missing`, `.pp-line`.
- Batch 3: `.el-tick`, `.el-tick[aria-pressed=false]`, `.rate.suggested`, `.gl-term`, `.gl-pop`, `.gl-list`.

All of them use only tokens (`--text`, `--muted`, `--line`, `--accent`, `--surface-*`, `--r-*`, `--s-*`), so `html[data-ui="clinical"]` overrides apply without changes. Each batch adds its CSS block after the section named in its file map, never at the end of the file.

---

## 6. Decisions

### Decisions for the owner (each with a recommended default)

- **D1. Approve these data format changes** (PLAN.md asks for approval). Recommended: approve all.
  - Card fields `frontSounds`, `backSounds` (3), `noteFields` (A), `reverse` (5) and `acceptAnswers` (C).
  - Media rows may hold sounds, and backups with sounds are version 2.
  - Settings keys `gloss:<id>`, synced per term (12).
  - Log field `overridden` (C).
  - Deck field `soundAuto` (3).
  - None needs a database upgrade or a change to the Supabase table. Only the file-type list in `supabase/media.sql` changes, and the owner re-runs that file once.
- **D2. Sounds sync like pictures, with a 1 MB cap per sound.** Recommended: yes. Sounds upload to the same private bucket after you re-run `media.sql`, every device downloads them once, and the import shows the total size ("Bring sounds (about 96 MB)") with a switch to leave them out. The alternative is sounds staying on the device that imported them. That saves Supabase space, but other devices would show "Sound not available on this device yet".
- **D3. What "Study these now" does with suspended cards.** Recommended: **it unsuspends them as well and starts the session** (toast "Unsuspended 120 cards and started a session"). In the AnKing workflow, the cards for missed questions should join your reviews from then on; otherwise they disappear again after one session. The alternative is a one-off session that leaves them suspended (they keep their new schedule but never come back by themselves).
- **D4. One glossary for all decks, or one per deck.** Recommended: **one for all decks** (simpler, and terms like "ATP" are the same everywhere). A per-deck scope can be added later as an optional field on each term.
- **D5. "I was right" in Play changes the schedule, stats, accuracy and grade, but not the score, streak or lives.** Recommended: yes, so the game can't be won by overriding. The alternative is restoring the points too.

### Decisions I'm making myself (the owner can override any)

1. Tags stay lowercase (as today). Folders and IDs match ignoring case. Original capitals aren't kept, because that would mean a tag data change.
2. Question IDs match the **last `::` segment** of a tag. When IDs fall under more than one folder, a "Look in" folder picker resolves it.
3. "Study by tag or ID" searches **all decks**, unlike Custom study's chosen decks, and says so in the sheet.
4. Elements are **text-defined** ("Element N:" lines, like step cards), with no new field. The rating is **suggested** (0 missed → Good, 25% or less → Hard, more → Again, never Easy) and you can still pick any rating. Results per element aren't logged.
5. Reverse cards are full copies with swapped text, kept in sync through `noteEditedAt` and `healPairs`, like cloze. In Play, each direction grades its own card. CSV round trip uses a "Both directions" column.
6. Anki notes count as reversible only when the note type has exactly 2 templates and the second asks with the Back field. Other card types bring card 1 only, with a summary line saying so.
7. Note fields export to Anki as `<details>` sections inside Back Extra and are read back from them. Search doesn't look in them.
8. Sounds: R and the speaker button play the side's sounds when it has any, otherwise they read aloud. Auto-play is **on by default per deck** (like Anki). Play never auto-plays. There is no recording in this round (idea 13 is separate).
9. Postpone changes only `due`/`scheduledDays` (no log rows), moves the most stable due reviews first, defaults to the ones that stay at 80% or better, and leaves out decks with an exam within days + 3.
10. The glossary underlines only the first time a term appears on each face, skips on the front any term that is in the answer, matches 1–2 character terms with exact capitals, and isn't used in Play.
11. Glossary terms are stored as per-term synced settings, not a new store, so the server stays as it is and older versions ignore them.
12. Storage: `persist()` is requested after the first sound, the backup switch for sounds is on up to 150 MB, and sound downloads run 4 at a time.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| The owner hasn't re-run `media.sql`, so sound uploads are rejected | Each file's error is caught, the uploads are marked blocked, a plain note explains it, and pictures keep syncing |
| A huge language deck fills phone storage or Supabase | The 1 MB cap, the size shown before import, the free-space check, the Settings storage line, and a switch to leave sounds out |
| An old tab's `cleanMedia` deletes sounds | The app reloads every tab when the new service worker takes over, plus the one-hour grace period |
| Very large backups fail on phones | The "Include sounds" switch, off above 150 MB |
| `review.js` changed by three branches | Each batch owns named functions (section 4); merge order and rebase |
| Reverse pairs and cloze both rely on `noteId` | `isPair` excludes cloze and occlusion; `healPairs` runs separately from cloze `healNotes`; tests cover each |
| Glossary regular expression cost with 2,000 terms | One cached matcher per glossary version, matching on text nodes once per face, an e2e time budget |
| v4.10 and FSRS PR 1 conflict with each other in `db.js` and `sync-data.js` | Not this round's files; Batch 1 rebases after them |

### Critical Files for Implementation
- /home/user/study-sprint/js/anki.js
- /home/user/study-sprint/js/import-screen.js
- /home/user/study-sprint/js/review.js
- /home/user/study-sprint/js/db.js
- /home/user/study-sprint/js/sync.js
