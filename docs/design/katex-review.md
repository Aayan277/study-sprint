# Review findings: KaTeX maths (v4.2, commit 47b1921)

Opus review. Nothing blocking. KaTeX's `trust:false` blocks `\href`/`\url`/`\html*`/`\includegraphics`; escaping is correct. Fix after the v4.2.1 fixer lands. Each fix gets a test.

## Decisions (Claude, owner delegated)
- **Supply chain (finding 7):** keep the CDN (house rule: CDN, pinned versions) but enforce integrity.
  - Add an import map in index.html with an `integrity` entry for the katex.mjs URL:
    `sha384-7P2cqEHJR2IlPITv70b7D/BOl8yOGOe/LHzf5acWjXiVJl0HVGb0aGUG8Jc8FA+2`
  - CSS link: `integrity="sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA"` + `crossorigin="anonymous"`.
  - If ts-fsrs or other CDN modules are imported by URL, add integrity entries for them too (compute the hashes from the pinned files).
  - Drop the `?again=N` retry URL (it conflicts with integrity): retry the same URL after clearing the memo. If the browser caches the failed import, fall back to `fetch` → SHA-384 check → blob `import()`.
- **Existing non-maths cards (finding 1):** no per-deck switch for now. Instead:
  - (a) typed answers accept a match against either `answerText(back)` or the raw text with `\$` unescaped (so typing LaTeX or the literal text both work);
  - (b) in `renderMath`, if the output contains `.katex-error`, restore the raw text with `tex-raw`.

## Should fix
1. Finding 1 above (math.js 35-74, format.js 319 `answerText`, review.js `submitTyped`, play.js `answer`). Tests: regex/shell/URL texts, pinned.
2. **anki.js:20 `ankiMath`:** map `[$]t[/$]` → `\(t\)` and `[$$]t[/$$]` → `\[t\]`. Test: spaces and `<br>` inside.
3. **cloze.js:** run `holdMath` before the CLOZE regex in `renderCloze`/`clozeCard`/`clozeNumbers`/`clozeFull`, so `}}` inside a formula doesn't end a blank (`{{c1::$\sqrt{x^{2}}$}}`). README: Anki cloze-inside-maths shows raw.
4. **import.js 129-135 `delimitedRows`:** for `sep === ','`, parse `maskMath(line)` and slice the original at the same positions. Test: "Point, $f(a,b)$".
5. **sw.js 37-49 `keepLibraries`:**
   - skip `res.type === 'opaque'` or `!res.ok`
   - copy only from the newest old cache, and only URLs still pinned in this release (KATEX_BASE, PRELOAD, fonts)
   - `link.crossOrigin='anonymous'`
   - Tests in sw.test.js.
6. **`?again` cache key:** resolved by the integrity decision above. Also, the service worker cache-first branch for cdn.jsdelivr.net should try `caches.match(req, {ignoreSearch:true})`.
8. **Browse/Stats performance:** cache rendered HTML in a Map keyed by display+tex (`katex.renderToString`); render more than ~50 spans in `requestIdleCallback` chunks.
9. **format.js:279:** don't strip private-use characters. `holdMath` should swap existing U+E100–EFFF characters for placeholders that output themselves, so the rich editor round trip keeps them. Test.

## Nits
- **Anki export:** keep newlines in TeX (`%` comments).
- **`$$`:** the header comment wrongly claims an own-line rule. Either add the rule or fix the comment (prefer fixing the comment, plus a test that pins "$$5 and $$10" → decide: treat as not maths if the content starts with a digit and has spaces?). Keep it simple: fix the comment.
- **math.js:62:** off-by-one on the 1000-character limit (allow exactly 1000).
- **`fit`:**
  - re-run on a debounced resize
  - remove `tabindex` when no longer overflowing
  - add `role="group"` + `aria-label="Formula"`
- **`loadKatex`:** on success, clear the `data-done="raw"` marks and re-render.
- **`warmFonts`:** document that only 7 of 20 fonts are cached.
- **review.js `answerSize` / play.js `sizeClass` and `chars`:** measure `answerText()`, not raw LaTeX.
- **texToSpeech:** `|x|` → "absolute value of x"; `\int_0^1` → "integral from 0 to 1"; typing `α` should match `\alpha` (map Greek letters in `texToPlain` to both).
- **Desktop ∑:** unwrap when the selection is already wrapped.
