# Study Sprint 学

A mobile-first flashcard app for university courses: real spaced repetition (like Anki) plus the timed game rounds from [Kanji Sprint](https://github.com/Aayan277/kanji-sprint).

The full plan is in [PLAN.md](PLAN.md). **Current status: Milestone 1 (scaffold).**

## What works so far

- Deck library: create, rename, recolor and delete decks (with an in-page confirmation)
- A sample Intro to Psychology deck on first open
- All 6 Kanji Sprint themes, each with light and dark versions
- Installable on your phone, works offline
- Everything is saved on your device in IndexedDB

## How it's built

Plain HTML, CSS and JavaScript modules. No build step, so GitHub Pages serves the files as they are.

| File | What it does |
| --- | --- |
| `index.html` | Page frame: header, screen area, bottom tab bar |
| `css/styles.css` | All styles. The theme colors at the top are copied from Kanji Sprint |
| `js/app.js` | Starts the app, switches screens, Settings screen |
| `js/db.js` | Saving and loading (IndexedDB) |
| `js/decks.js` | Deck list, deck page, create/edit/delete sheet |
| `js/themes.js` | Theme switching and the theme picker |
| `js/sample.js` | The starter deck |
| `js/ui.js` | Small shared helpers |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installing as an app |

## Running it on your computer

ES modules don't load from a `file://` address, so use a tiny local server:

```
npx http-server -c-1
```

then open the address it prints.
