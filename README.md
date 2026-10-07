# Study Sprint ⚡

A mobile-first flashcard app for university courses: real spaced repetition (like Anki) plus timed game rounds for cramming.

The full plan is in [PLAN.md](PLAN.md). **Current status: Milestone 5 (auto-grading).**

**Live:** [aayan277.github.io/study-sprint](https://aayan277.github.io/study-sprint/)

## What works so far

- Deck library: create, rename, recolor and delete decks (with an in-page confirmation)
- A sample Intro to Psychology deck on first open
- Import cards by pasting text (format detected automatically), uploading .csv / .tsv / .txt / .xlsx, or loading a Google Sheet, with an editable preview and duplicate flags
- "Make cards with Claude" copies a ready-made prompt with your notes
- Daily review with FSRS-6 scheduling (via ts-fsrs): flip or type the answer, rate Again / Hard / Good / Easy with the next interval shown, undo, and a summary at the end
- Play: timed Classic, Survival and Lightning rounds (front → back, back → front, or typing), with Hard mode, Flash, streak scoring, letter grades and best scores
- Auto-grading: Play answers on due cards count as their review (fast, normal, slow or wrong becomes Easy/Good/Hard/Again), misses on any studied card bring it back, and each card changes at most once a day from Play
- 6 color themes (Ink, Blossom, Sage, Cobalt, Neon, Onyx), most with light and dark versions
- Installable on your phone, works offline
- Everything is saved on your device in IndexedDB

## How it's built

Plain HTML, CSS and JavaScript modules. No build step, so GitHub Pages serves the files as they are.

| File | What it does |
| --- | --- |
| `index.html` | Page frame: header, screen area, bottom tab bar |
| `css/styles.css` | All styles. The theme colors are at the top |
| `js/app.js` | Starts the app, switches screens, Settings screen |
| `js/db.js` | Saving and loading (IndexedDB) |
| `js/decks.js` | Deck list, deck page, create/edit/delete sheet |
| `js/import.js` | Format detection for pasted text, files and sheets (no page code, so it can be tested) |
| `js/import-screen.js` | The Import screen and its preview |
| `js/play.js` | The Play screen |
| `js/autograde.js` | Turning Play answers into review ratings, and when they may change the schedule |
| `js/game.js` | Game rules: scoring, timers, wrong-answer options |
| `js/review.js` | The Review screen |
| `js/srs.js` | FSRS-6 scheduling (wraps the ts-fsrs library) |
| `js/queue.js`, `js/days.js` | Which cards are due today (a study day starts at 4am) |
| `js/match.js` | Checking typed answers (typos, alternates, articles) |
| `js/themes.js` | Theme switching and the theme picker |
| `js/sample.js` | The starter deck |
| `js/ui.js` | Small shared helpers |
| `tests/*.test.js` | Tests for import detection, answer checking, the review queue, game rules and auto-grading |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installing as an app |

## Running it on your computer

ES modules don't load from a `file://` address, so use a tiny local server:

```
npx http-server -c-1
```

then open the address it prints.

## Running the tests

```
node --test
```

(or one file, e.g. `node tests/import.test.js`). No install needed: it uses Node's built-in test runner. (`package.json` only tells Node the files are modules.)
