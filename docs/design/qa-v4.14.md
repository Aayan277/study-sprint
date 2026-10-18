# Exploratory QA of Study Sprint v4.14 (origin/main de0cf3c)

I tested in a detached worktree, served on port 8231 and driven by Playwright Chromium. I used four browser contexts:
- **Phone 375×800:** Original dark, later Original light and Clinical dark.
- **Desktop 1440×900:** Original dark and Clinical light.
- **Desktop 1920×1080:** Clinical light, then Original dark.
- **Phone 375 with the service worker on:** for the offline test.

**No blockers found.** Nothing lost data or crashed, and I saw no page errors apart from the offline module-load case described in minor issue 7.

Screenshots are in `/tmp/claude-0/-home-user-study-sprint/b156d69a-a765-5609-999d-2835cc7accb8/scratchpad/qa-shots/`; below, "shots/" means that folder. The worktree is removed. Both processes I started (the static server and my Playwright driver) were killed by their own PIDs.

## Findings, most serious first

### Major

**1. The answer-button intervals are random and don't match where the card actually goes.**
- **Screen:** all sizes and styles; seen at 375 Original dark and 1920 Original dark.
- **Repro:**
  1. Review a graduated card.
  2. Read the Easy label, press 4, then read the card's due date from the database.
- **Expected:** the label matches the new interval, give or take a day.
- **Actual:**

  | Easy label | Actually scheduled |
  |---|---|
  | 3d | 4d |
  | 6d | 9d |
  | 16d | 17d |
  | 26d | 27d |

  The labels also change on re-render: on the warfarin card, Easy read 6d, then 8d after pressing "Accept my answer from now on".
- **Cause:** `previewIntervals` in `js/srs.js` runs the scheduler with random fuzz on. `rate()` instead takes the exact gap and lets "Spread out due dates" (on by default) pick a day. So the label is a random draw that is independent of the real choice.
- **Evidence:** text log of the 4 cards; shots/117-orig-dark-1920-review-back.png (labels 10m/1d/2d/3d, card actually due in 4d); shots/39-accept-typed-375.png (Easy 8d after Accept).

**2. "Add to glossary" from selected card text can't work in Review.**
- **Screen:** all; tested at 1440 Clinical light.
- **Repro:**
  1. In Review, flip a card.
  2. Double-click (or long-press) a word in the answer.
  3. Open ⋯, then Add to glossary.
- **Expected:** the Term field is filled with the selected word, as PLAN v4.12 describes ("⋯ > Add to glossary from selected card text").
- **Actual:** nothing can be selected, and the Term field is empty. `.flash{user-select:none}` (styles.css line 724) blocks selection on the whole card, so `getSelection()` is always empty. The prefill code in `browse.js` (`selectedText`/`pressed`) never gets a selection. The e2e test only checks the empty form.
- **Evidence:** shots/109-more-menu-1440.png (the menu shows no quoted word), shots/110-add-to-gloss-1440.png (empty Term).

**3. In the card editor, space-separated tags are saved as a single tag with a space in it, and it then breaks study by question ID.**
- **Screen:** 375 Original dark.
- **Repro:**
  1. Add a card with Tags `#AK_Step1_v12::#UWorld::23456 #AK_Step1_v12::#Subject::Pulm`, the way Anki users type tags.
  2. Go to Custom study, then By tag or question ID, and paste `23456`.
- **Expected:** two tags, or at least a warning. Anki tags can't contain spaces.
- **Actual:** one tag is stored: `#ak_step1_v12::#uworld::23456 #ak_step1_v12::#subject::pulm`. The result says "Not found: 23456", and Tag folders shows a bogus folder "23456 #ak_step1_v12". The label does say "separated by commas", but AnKing users will type spaces.
- **Evidence:** shots/66-tagstudy-ids-375.png, shots/70-tag-tree-open-375.png, shots/113-tagstudy-tag-search-375.png.

### Minor

**1. Glossary "Paste a list" drops every line when the list mixes separators, and the message is wrong.**
- **Screen:** 1440 Clinical light.
- **Repro:** paste these lines:
  ```
  beta-agonist - stimulates beta receptors
  Mallory-Weiss tear - mucosal tear at the GE junction
  Anti-HBs: antibody showing immunity
  ```
- **Expected:** 3 terms. Each line on its own parses fine.
- **Actual:** "Adds 0 terms. 3 lines without a definition are left out." With 5 lines (3 dash, 1 colon, 1 tab) it is also 0, but with 4 lines it is 2. `parseText` picks one separator for the whole list.
- **Evidence:** shots/111-gloss-paste-preview-1440.png.

**2. Import's "Add to deck" defaults to the deck you used last.**
- **Screen:** 375 Original dark.
- **Repro:**
  1. Import an .apkg into a new deck.
  2. Go to Decks, then Import, and pick a different file.
- **Expected:** a new deck (named after the file, as on the first import) when you didn't start from a deck page.
- **Actual:** it defaults to the previous deck ("Add 5 cards to “Neuro Psych”"), so a second subject's Anki deck merges into the first one unless the student notices.
- **Evidence:** shots/14-import2-default-deck-375.png, shots/15-import-broken-375.png (defaulted to anki-legacy).

**3. Text still says Play counts, although Play is practice-only by default since v4.10.**
- **Screen:** all.
- **Where:**
  - First run: "Cram with games. Timed rounds that still count." (shots/01-firstrun-375-light.png)
  - Stats streak: "Review or play today to start a streak." (shots/93-stats-usmle-clinical-1920.png)
  - Custom study: "Cards I forgot today … or got wrong in Play, today" (shots/59-extra-study-sheet-1440.png)
- **Problem:** with the default setting, Play writes no log row, so none of these are true.

**4. "Nothing due today" contradicts the streak line.**
- **Screen:** 1440 Original dark.
- **Repro:** finish all cards, then come back the next day with nothing due.
- **Actual:** the ring says "Nothing due today", while the streak says "Study today to keep it". The streak really does break (or uses a freeze) unless you do Extra study, so a caught-up student is penalised.
- **Evidence:** shots/58-today-nothingdue-1440.png.

**5. Postpone says "no reviews are due" when the due reviews are only excluded by an exam.**
- **Screen:** 1440 Original dark.
- **Repro:** have 3 due cards in a deck whose exam is in 4 days, then open Postpone.
- **Actual:** "Nothing to postpone: no reviews are due." The real reason is the exam rule; the line under it only mentions that rule in general.
- **Evidence:** shots/64-postpone-with-exam-1440.png.

**6. "I was right" can record Easy.**
- **Screen:** 375 Original dark, with "Count Play answers as reviews" on.
- **Repro:** answer quickly with a wrong typed answer, then press "I was right".
- **Actual:** the log row is `rating: 4` with `overridden: true`. `autoRating` gives Easy for fast typed answers, so an answer that was wrong as typed can jump the interval.
- **Suggestion:** cap overridden answers at Good.
- **Evidence:** the log dump; shots/78-play-iwasright-375.png.

**7. Offline without the service worker leaves a screen stuck after you reconnect.**
- **Screen:** 375. This only happens when the service worker isn't controlling the page; with it, offline works fully.
- **Repro:** go offline, open Stats, go back online, open Stats again.
- **Actual:** "Couldn't load this screen" again until you press Reload, because Chromium caches the failed `import()`.
- **Clinical:** the Reload button looks disabled in Clinical dark (grey on grey).
- **Evidence:** shots/99-clin-dark-375-stats.png.

**8. With typing on, the single-key shortcuts don't work, but the footer still advertises them.**
- **Screen:** 375 and 1440.
- **Actual:** focus sits in the answer box, so D, E, I, -, @ and R go nowhere. The footer still reads "D scratchpad".
- **Related:** Review has no undo shortcut at all (Ctrl+Z or Z).
- **Evidence:** shots/40-scratchpad-375.png.

**9. The finish screen's "Cards reviewed" counts answers, not cards.**
- **Screen:** 1440 Original dark.
- **Actual:** a 3-card session where one card was answered twice shows "4 Cards reviewed".
- **Evidence:** shots/56-finish-1440.png.

**10. The glossary doesn't match plurals.**
- **Actual:** "ACE inhibitors" and "ACE-inhibitor" are not underlined for the term "ACE inhibitor". Students write plurals all the time.
- **Evidence:** shots/108-gloss-variants-1-1440.png.

### Cosmetic

1. **Tags are lowercased on save** (`#AK_Step1_v12::#UWorld` becomes `#ak_step1_v12::#uworld`), and folders show lowercase. Anki keeps the case. Evidence: shots/66-tagstudy-ids-375.png.
2. **The broken-file message keeps a stale status:** "broken.apkg · reading…" stays under the error. Evidence: shots/15-import-broken-375.png.
3. **An unlabelled occlusion box shows "No label"** on the back, which reads like an error. Evidence: shots/47-card-1-back-375.png.
4. **Clinical Settings at 1920:** the in-page confirm buttons (Cancel and Reset are about 800px each) and the Learning steps box stretch the full width, and the "Spread out due dates" switch sits about 1,600px from its label. Evidence: shots/89-reset-confirm-1920.png, shots/88-optimize-done-1920.png. This is separate from the known 1220px content cap on the other screens.
5. **The Play typed diff doesn't mark the extra word:** for "a cough", the "a" isn't highlighted. Evidence: shots/77-play-wrong-375.png.

## Confusing wording and friction a student would hit

- **"Try it: 30 seconds"** first asks you to name a course before the sample cards. The first run is always dark, even with a light device setting (dark is the documented default).
- **Typing vs flipping** is only set in Today → Options. It isn't in Settings or on the Review screen.
- **The optimizer result** shows "log loss 0.349 → 0.342 · RMSE 5.6% → 4.8%" in the main text. That's jargon for med and law students; it could move under Details.
- **Tag folders on a phone** have three buttons per row on every tag (shots/70-tag-tree-open-375.png). With AnKing-size tag trees this list gets very long.
- **Steps cards:** after the last step, one more Space rates the card Good straight away. A student pressing Space to see the "Final answer" can rate by accident.
- **Ending a deck session** offers "Keep going · 22 cards", which counts all decks, not the deck you were in.
- **The glossary list** doesn't show aliases.
- **In Play,** Esc and Quit end a round with no confirmation.

## What worked well

- **First run:** onboarding into the sample walk-through and then Today was clean.
- **Imports:** all Anki fixtures (new and legacy, media, replay with occlusion, scheduling history), Quizlet .txt and .xlsx imported with correct counts. broken.apkg failed gracefully.
- **Card types:** I created basic, cloze (2 cards), steps, elements (the Got it / Missed toggle with X and "Suggested: Hard"), picture and image-occlusion cards (3 boxes, 3 cards).
- **Review:** typed answers with a character diff, "Accept my answer from now on", undo that restores state and log exactly, and a scratchpad that clears per card. Reloading mid-session resumes the same card.
- **Glossary:** hyphenated terms (X-ray, beta-blocker, "C++ (test)") underline correctly. The front is suppressed when the answer contains the term. The popover's Escape returns focus.
- **Today ring:** "N to go", "All done for today", "Nothing due today" and "All cards learned · only reviews from now" all appeared at the right times. The Extra study button shows in the done and nothing-due states, and the sidebar footer matches.
- **Postpone:** 2 days moved cards to Wednesday 06:00; 1 week moved the 2 least-costly cards to Monday Nov 2, 06:00. Undo restored the exact due dates.
- **Study by tag or question ID:** non-ID words are ignored, leading zeros are handled, "Look in" appears for IDs in two banks, and the "Start over?" guard works. Tag folders Rename, Remove (in-page confirm) and Show cards all work.
- **Play:** practice-only by default left every card state and the log count unchanged and said so on the results. With counting on, "I was right" replaced the log row as designed.
- **Exams:** readiness and "How sure is this?" correctly switch between the standard model and "your own memory model (tuned on Oct 17 from 1,155 reviews)".
- **Optimizer:** ran in about 2 s on 1,155 seeded reviews, kept the better weights, and Reset set `w` back to null.
- **Backup:** export and restore round-tripped 58 cards, 11 decks, 44 log rows, 18 states, 6 media, 5 glossary terms and accepted answers.
- **Offline:** with the service worker, every screen, Review, Play and the glossary sheet worked offline.
- **Layout:** no sideways scroll on any screen at 375.

## Not tested, or only partly

- **Sync** (needs a backend).
- **Speech and read-aloud.**
- **Starter (JLPT) decks** and **Google Sheets import.**
- **The rescue plan sheet:** the banner appeared but I didn't run the plan.
- **Leech handling.**
- **Easy days.**
- **Stats tables:** I only skimmed them.
- **Original light** was only checked at 375 on Today, Decks, Stats and Settings.
- **Clinical:** I checked Today, Decks, the deck page, Play, Settings and Import at 375 dark, and Review, Today, Stats and Exam prep at 1440 and 1920 (light and dark). I didn't do a full Clinical pass on Browse, the card editor or Play results.
- **Ring transitions** were tested with Playwright's clock (`clock.install` / `setFixedTime`), not by waiting real days.
- **About the 90 minutes:** coverage is broad, but I didn't spend real study time per area.
