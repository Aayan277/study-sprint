# Study Sprint ⚡

A mobile-first flashcard app for university courses: real spaced repetition (like Anki) plus timed game rounds for cramming.

The full plan is in [PLAN.md](PLAN.md). **Current status: Milestone 1 (scaffold).**

**Live:** [aayan277.github.io/study-sprint](https://aayan277.github.io/study-sprint/)

## What works so far

- Deck library: create, rename, recolor and delete decks (with an in-page confirmation)
- A sample Intro to Psychology deck on first open
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
