# Study Sprint: who we're up against, what we're missing, and where we can win

*Research date: 18 October 2026. App version checked: origin/main (v4.32).*

## Read this first

**In short:** Study Sprint already matches Anki on the hard parts: FSRS-6 with an optimizer on your device, cloze cards, image occlusion, .apkg import with review history, and study by tag or question ID. It's also free on iPhone, where AnkiMobile costs $24.99. And it's ahead of Quizlet, Knowt and Brainscape on scheduling and exam dates. The market moved in 2025 and 2026, though. "FSRS + AI card maker + Anki import" is now the standard pitch for new apps (MintDeck, Quanta, StudyGlen, Space), so FSRS alone no longer sets us apart. Our biggest gaps are the things students now expect without asking:

1. a way to turn a PDF or lecture into cards in one step,
2. practice tests,
3. reminders, and
4. a way to share a deck.

All four can be built cheaply without a paid backend.

**How sure the evidence is.**
- Reddit wouldn't load directly (WebFetch is blocked, and search engines rarely returned Reddit threads). The previous research file had the same problem. Student complaints below therefore come from App Store listings, Trustpilot, the official Anki, RemNote and AnkiHub forums, vendor help pages and review roundups.
- Where a source is a competitor's own marketing, I say so.
- Prices come from official pages where I could open them (RemNote, Knowt, Brainscape, Mochi, Supabase). Quizlet's pricing page returned 403, so its prices come from 2026 third-party sources and are marked as such.

**What I didn't repeat.** The earlier `docs/design/student-research.md` covered ideas 1–13. Most are now built: tag/QID study, the optimizer, sounds, Elements cards, both directions, Postpone, Anki field names and "I was right". Still open from that list: listening cloze (6), reading-to-cards (7), keyword-marked typed answers (8), the missed-question log (9), furigana (11), the glossary (12) and record-and-compare (13). I only bring one back (9), because the med edge below needs it.

---

## 1. Comparison table

Legend for the last column, from Study Sprint's point of view: **▲ ahead**, **= about equal**, **▼ behind**. "Field" means the best of the mainstream apps.

| Feature | **Study Sprint** | Anki (desktop / AnkiDroid / AnkiMobile) | Quizlet | Knowt | Brainscape | RemNote | Mochi | Noji (ex-AnkiPro) | Gizmo | NotebookLM | New FSRS+AI apps (Quanta, MintDeck) | **Us vs field** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Price to study your own cards | Free, no ads | Free; **iPhone $24.99** | Free with ads; Learn and Test capped | Free with ads | Free (own cards) | Free | Free (sync is paid) | Free, daily cap | Free, daily "lives" | Free | Free core, paid AI | **▲** (no caps, no ads, free on iPhone) |
| Scheduler | FSRS-6 + on-device optimizer, FSRS-7 beta | FSRS-6 (6.6.2 in 26.09) + optimizer | Proprietary ("adaptive") | Weak (disputed; see Knowt below) | Confidence-based (1–5) | SM-2 by default, FSRS-6 beta | Own algorithm, FSRS optional | Undisclosed "presets" | "Spaced repetition", undisclosed | None (got it / missed it) | FSRS / FSRS-6 | **= Anki, ▲ everyone else** |
| Exam date scheduling | Yes: final pass, retention ramp, Exam prep, readiness | No (add-ons only) | No | No | No | Yes ("exam scheduler", Pro; free = 1 exam) | No | No | No | No | Quanta: readiness score and exam simulation (paid) | **▲** |
| AI card generation | Copy-paste prompt to Claude | No (add-ons) | Yes (Magic Notes) | Yes (free, capped) | Yes ("100s" free) | Yes (250 credits/month free) | Yes (small free quota) | Not stated | Yes (core feature) | Yes (core feature) | Yes (credits) | **▼** |
| PDF / slides / lecture import | No (paste or file text only) | No | Yes (paid tiers) | Yes (PDF, video, lecture recording) | Yes | Yes (3 PDFs free) | No | No | Yes (PDF, PPT, YouTube, scans) | Yes (core feature) | Yes | **▼** |
| Practice test / mock exam | No (Play is timed rounds) | No | Yes (capped on free) | Yes, free | No | Partial | No | No | Quizzes | Quizzes | Quanta: exam simulation | **▼** |
| Cloze | Yes | Yes | No | No | No | Yes | Yes | Not stated | No | No | Partly | **= Anki, ▲ rest** |
| Image occlusion | Yes, free | Yes | No | No | No | 5 free, then Pro | No | No | No | No | MintDeck: no | **= Anki, ▲ rest** |
| Maths (LaTeX) | KaTeX | MathJax | Limited | Limited | Limited | Yes | Yes | No | No | Yes | Quanta: yes | **=** |
| Audio on cards | Yes, and kept from Anki | Yes | Paid images; TTS | Some | Pro only | Yes | Yes | Premium TTS | Some | Audio overviews | MintDeck TTS | **=** |
| Anki .apkg import | Yes, with history, media, IO, fields | Native | No | No | Import | Yes | Yes | Says "import from other apps" | Yes (says it imports Anki) | No | MintDeck: with history; Quanta: text only | **▲ vs all but Anki** |
| Anki export | Yes (.apkg, cards only) | Native | No | No | No | Some | Yes | ? | No | No | ? | **▲** (but progress isn't exported) |
| Study by tag or question ID (UWorld/AMBOSS) | Yes, free | Yes (plus paid AnkiHub / AMBOSS add-on extras) | No | No | No | No | No | No | No | No | No | **= Anki, ▲ rest** |
| Game modes that feed the schedule | Yes (opt-in) | No | Games, separate from Learn | Games | No | No | No | No | Games and leaderboards; SRS link unclear | No | No | **▲** |
| Shared / public decks | No | AnkiWeb shared decks (free); AnkiHub (~$5/mo, unverified) | Huge library | 5M+ resources | Certified decks (Pro) | Some | Publishing (Pro) | 50,000+ decks | 1M+ decks | Share by link | Small | **▼▼** |
| Collaboration | No | AnkiHub (paid) | Classes | Live collaboration | Share and edit permissions | Some | No | Yes | Friends | Share link | No | **▼** |
| Reminders / notifications | No | AnkiDroid and AnkiMobile: yes | Yes | Yes | Yes (free) | Yes | ? | Yes | Yes (streaks) | No | Likely | **▼** |
| Home-screen widget | No (PWAs can't have them on phones) | AnkiDroid: yes | Yes | ? | ? | ? | ? | ? | ? | No | ? | **▼** (can't fix as a PWA) |
| Native app store listing | No (installs from the browser) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | MintDeck: iOS; Quanta: PWA | **▼** |
| Offline | Full, local-first | Full | Mobile apps; browser offline said to be Plus (unverified) | Partial | Partial | Yes | Yes | Yes | Partial | No | Partial | **▲** |
| Account needed | No | No (AnkiWeb for sync) | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes (Google) | Yes | **▲** |
| Sync | Free, optional (Supabase) | Free (AnkiWeb) | Yes | Yes | Yes | Yes | **Pro** ($5/mo) | Yes | Yes | Yes | Yes | **=** |
| Leaderboards / social | No | No | Class progress | Some | No | No | No | No | Yes | No | No | **▼** (minor) |
| Stats | Strong: retention, calendar, readiness, mix-ups, leeches | Strong but hard to read | Basic | Basic (more on paid) | Basic | Good | Basic | Basic | Basic | Minimal | Readiness score | **▲** |

Sources for this table are in section 2.

---

## 2. Competitor profiles

For each app: who it's for · price and free limits · headline features · scheduler · AI · offline/sync · platforms · loved · hated.

### Anki (desktop, AnkiDroid, AnkiMobile)
- **Who:** med students, language learners, power users.
- **Price:** desktop, AnkiDroid and AnkiWeb are free. **AnkiMobile is $24.99** in the US App Store (€29.99 in France and Germany) ([App Store](https://apps.apple.com/app/id373493387), [apps.ankiweb.net](https://apps.ankiweb.net/)).
- **News:** the latest desktop release is **26.09.3** (23 Sep 2026). 26.09 moved FSRS to 6.6.2 and loads MathJax only when needed ([GitHub releases](https://github.com/ankitects/anki/releases)). In February 2026 its creator, Damien Elmes, began handing business operations to **AnkiHub** (founded by The AnKing). The stated promises: Anki stays open source and pricing doesn't change ([forum: "Anki's Growing Up"](https://forums.ankiweb.net/t/ankis-growing-up/68610)). Watch this: AnkiHub may make Anki friendlier, and that would eat into our "Anki without the pain" pitch.
- **Scheduler:** FSRS-6 (from 25.07) with an optimizer; SM-2 is still the legacy option, and FSRS is switched on in deck options.
- **AI:** none built in. Add-ons only.
- **Loved:** shared decks (AnKing), add-ons, total control, free on Android and desktop.
- **Hated:**
  - the iPhone price ("free on Android and PC but $25 on iPhone"),
  - the steep setup,
  - sync conflicts and due counts that differ between devices ([AnkiDroid due-count thread](https://forums.ankiweb.net/t/more-cards-due-on-desktop-anki-vs-ankidroid/58487), [settings broken by sync](https://forums.ankiweb.net/t/syncing-breaks-my-settings/69150)),
  - review backlogs ("Anki hell") ([summary, vendor blog](https://studycardsai.com/blog/best-flashcard-app-for-medical-students-reddit)),
  - complaint categories in a 2026 review roundup ([Unstar, editorial; its quotes may be illustrative](https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026)).
- **Add-on economy:**
  - **AnkiHub** keeps the AnKing deck updated for about $5–6 a month (unverified; [Reddit snapshot](https://reddit.sentinel-team.org/posts/1qwm8yz/snapshots/2026-02-06T13%3A50%3A22.23607Z), [guide](https://studycardsai.com/blog/ankihub-guide)).
  - The **AMBOSS add-on** adds pop-up definitions and starts Qbank sessions from cards ([AMBOSS](https://www.amboss.com/us/anki-amboss)).

### Quizlet
- **Who:** high-school and college students; very broad.
- **Price (third-party, mid-2026; official page blocked):** Plus is about $7.99/month or $35.99/year, and Plus Unlimited about $9.99/month or $44.99/year. Plus is reportedly **still metered** (about 20 Learn rounds and 3 practice tests a month). Unlimited removes the caps ([recurdash](https://recurdash.com/subscription-pricing/quizlet-plus), [nibble](https://nibble-app.com/blog/quizlet-cost), [myengineeringbuddy](https://www.myengineeringbuddy.com/blog/quizlet-reviews-alternatives-pricing-offerings/)). The free tier puts Learn and Test behind a paywall after a few rounds ([school paper](https://thendbcatalyst.com/10077/news/quizlet-moves-many-popular-features-to-payment-plan/), [BFA Mercury](https://bfamercury.org/6555/news/quizlets-shift-to-quizlet-plus/)).
- **AI:** the Q-Chat tutor was retired in June 2025 ([quizgecko](https://quizgecko.com/de/blog/best-q-chat-alternative)). Magic Notes still turns notes into cards and tests. An early-2026 ChatGPT-based replacement is reported by one vendor only (**unverified**; [mindomax](https://www.mindomax.com/spaced-repetition-apps-updates-2026)).
- **Scheduler:** proprietary "adaptive" Learn. No FSRS.
- **Offline:** Quizlet's help page says offline works in the iOS and Android apps ([help.quizlet.com](https://help.quizlet.com/hc/articles/360030565412)). A Klett help page says browser offline is Plus-only ([Klett](https://hilfe.klett-sprachen.de/hc/en-gb/articles/360021020378-Does-Quizlet-work-offline)). **Our README says Quizlet offline "Needs the paid app"; that's only partly supported. Reword it.**
- **Loved:** the biggest library of sets, simple, everyone already has it.
- **Hated:** **Trustpilot 1.4/5 from 662 reviews** ([Trustpilot](https://www.trustpilot.com/review/www.quizlet.com)). Complaints: paywalls, pop-ups, charges after cancelling, removed features (auto-play), lag. Shared sets contain errors.

### Knowt
- **Who:** high school (AP), college students leaving Quizlet.
- **Price (official):** Basic is free ("unlimited file creation, live collaboration, storage", ads). Ultra is $149.99/year or $24.99/month, with AI summaries of PDFs, videos and lectures, a podcast generator, a voice tutor and AP/SAT/ACT prep ([knowt.com/plans](https://knowt.com/plans)). Third-party pages also list a cheaper "Premium" at about $35/year ([frontdeskreview](https://frontdeskreview.com/software/ai-study-tools/knowt/)), so tier names conflict.
- **Headline features:** free Learn and practice tests with no cap, Quizlet import, AI notes from lectures ([heuristi.ca](https://www.heuristi.ca/posts/quizlet-alternatives), [fiveable](https://fiveable.me/knowt-vs-quizlet.md)).
- **Scheduler:** listed as "spaced repetition". A RemNote post says it's only a priority queue (competitor claim; [RemNote blog](https://alpha.remnote.com/blog/knowt-alternatives)).
- **Hated:** AI questions "don't always make sense" ([Common Sense Education](https://www.commonsense.org/education/reviews/knowt)); ads (mostly called tolerable); reports of lost generated cards.

### Brainscape
- **Who:** certification and exam learners, schools.
- **Price (official):** Basic is free (your own cards, sharing, reminders, "100s" of AI cards). Pro is **$7.99/month** and adds images and sounds, reverse cards, private decks and certified decks ([brainscape.com/pricing](https://www.brainscape.com/pricing)). In-app on iPhone, Pro is $19.99/month or $95.99/year, and lifetime $199.99 ([summary](https://www.mindomax.com/brainscape-vs-anki)).
- **Scheduler:** confidence-based repetition (you rate 1–5).
- **Hated:** the paywall ("the free version is a demo"); images and reverse cards are Pro-only.

### RemNote
- **Who:** note-takers and med students who want notes and cards in one place.
- **Price (official):** Free; Pro $8/month (yearly); Pro with AI $18/month ([remnote.com/pricing](https://www.remnote.com/pricing)). **Free limits:** 3 annotated PDFs, 5 image occlusions, 1 exam, 250 AI credits a month, 5 AI cards from text, 20 uploads a day of up to 8 MB.
- **Scheduler:** SM-2 by default. **FSRS-6 is "beta/alpha" and has to be switched on**, and RemNote advises against using it on critical cards ([help](https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm)).
- **Loved:** notes become cards, PDF annotation.
- **Hated:** sync and performance problems on large knowledge bases ([feedback board](https://feedback.remnote.com/p/make-remnote-less-buggy-syncing-issues), [forum](https://forum.remnote.io/t/serious-performance-issues/7834)).

### Mochi
- **Who:** programmers and Markdown fans.
- **Price (official):** free with unlimited offline use; **sync is Pro at $5/month**. The free AI quota is tiny (5,000 tokens a month) ([mochi.cards/pricing](https://mochi.cards/pricing/)).
- **Scheduler:** its own algorithm by default, FSRS optional ([docs](https://mochi.cards/docs/reviewing/fsrs/)).
- **Platforms:** macOS, Windows, Linux, web and mobile.

### Noji (formerly AnkiPro)
- **Who:** mainstream phone users, language learners.
- **Price:** the free version has essential features. **Premium adds "unlimited daily learning"** (so free has a daily cap), pictures and auto audio ([noji.io](https://noji.io/)). The US App Store shows about $29.99/year, and up to $89.99 (third-party snapshot; [apppricinglab](https://apppricinglab.com/app/apple/1573585542)). Rated about 4.6–4.8 from 13k–55k ratings.
- **Scheduler:** undisclosed ("custom presets", premium).
- **Note:** its name trades on Anki's, which confused users. Not affiliated with Anki.

### Gizmo
- **Who:** high-school and college students who want AI plus games.
- **Price:** free with daily limits. Reports say about 15 lives a day, 10 AI quizzes a day, and a wait to refill lives ([itechguides](https://www.itechguides.com/best/ai-study-tools/gizmo/), [aiera](https://aiera.blog/gizmo-ai-review-2026-is-this-study-app-worth-it/)). App Store in-app purchases run **$6.99 to $309.99** ([App Store](https://apps.apple.com/app/id1610516671)).
- **Headline features:** AI import from Quizlet, Anki, YouTube, PDF, PPT and handwriting scans; leaderboards; 1M+ public decks. Rated 4.8 from 14k.
- **Hated:**
  - lockouts mid-cram;
  - "older cards in large decks resurface too rarely, unlike Anki" (App Store review);
  - AI asks about material not covered yet.

### StudyFetch
- **Free:** 10 AI chats, 1 study set, 2 uploads, no audio or video. **Base** is about $7.99/month, **Premium** about $11.99/month (third-party; [toolsforhumans](https://www.toolsforhumans.ai/ai-tools/study-fetch), [frontdeskreview](https://frontdeskreview.com/software/ai-study-tools/studyfetch/)).
- **Hated:** the free tier is very restrictive, customer service, it misreads anatomy diagrams, and the Android app is buggy.

### Memrise
- **Now:** a language app with an AI conversation partner (MemBot). Community courses were removed from the main app in July 2024 and users were angry ([Wikipedia](https://en.wikipedia.org/wiki/Memrise), [Kimola](https://kimola.com/reports/uncover-the-impact-memrise-apps-user-feedback-report-app-store-us-147885)).
- **Price:** conflicting, from about $60/year to €69.99/year ([subger](https://subger.com/en/service/memrise), [toolradar](https://toolradar.com/tools/memrise/pricing)).
- **Relevance to us:** low. It mainly shows that removing user-made content drives people away.

### SuperMemo
- **Status:** moved to a web platform and dropped its legacy clients (vendor report, **unverified**). Its SM-20 algorithm was announced in 2026, and a developer API launched in early access with 100 free reviews a day ([SuperMemo blog](https://www.supermemo.com/blog/supermemo-api-launch-the-spaced-repetition-algorithm-is-now-available-to-developers), [Wikipedia](https://en.wikipedia.org/wiki/SuperMemo)).
- **Consumer price:** not found (**unverified**).
- **Relevance to us:** low. Few students use it.

### Osmosis / AMBOSS / Boards & Beyond (med)
- **Osmosis (Elsevier):** about 15,000 preclinical flashcards with built-in spaced repetition (flashcards only, not questions) ([Elsevier support](https://www.elsevier.support/osmosis/answer/consume-flashcards-for-future-spaced-repetition)). About $399/year (third-party; [testpreppal](https://testpreppal.com/usmle/study-tools/osmosis)). Some schools are dropping their licences (e.g. WSU, July 2026; [WSU](https://tech.medicine.wsu.edu/technology/osmosis/)).
- **AMBOSS:** roughly $12.50–20/month, and about $428–448/year with the Qbank (secondary; [youlearn](https://www.youlearn.ai/blogs/best-ai-tools-medical-students-2026), [iatrox](https://www.iatrox.com/blog/why-amboss-costs-what-it-costs-honest-breakdown)). It works *with* Anki rather than replacing it.
- **Boards & Beyond:** price not found (**unverified**).
- **What this means for us:** these aren't flashcard competitors. They're the **question banks** students study around, and we already accept their question IDs.

### AI card makers (Wisdolia and similar)
- **Wisdolia:** may have rebranded to JungleAI (one catalog only, **unverified**; [UCD OER](https://infiniteoer.ucd.ie/items/show/32)). The old free plan gave 15 cards a month. I found no source for "Seenode" (**couldn't verify**).
- **The category:** turn a PDF, YouTube video or webpage into cards, sold on credits. Many 2025–26 newcomers fit here: StudyGlen, FlashRecall, LectureScribe, Laxu ([mindomax roundup, a competitor](https://www.mindomax.com/spaced-repetition-apps-updates-2026)).

### NotebookLM (Google)
- **What it does:** since September 2025 it turns uploaded sources into flashcards and quizzes, with an "explain" button citing the source. Sets can be shared by link ([Workspace Updates](https://workspaceupdates.googleblog.com/2025/09/flashcards-quizzes-reports-notebook-lm-google-education.html)). Since March 2026 it saves progress, marks "Got it / Missed it" and lets you re-run missed cards ([Workspace Updates](https://workspaceupdates.googleblog.com/2026/03/new-ways-to-customize-and-interact-with-your-content-in-NotebookLM.html?hl=en)).
- **Scheduling:** none that I found. Treat it as a free card *source*, not a scheduler.
- **Why it matters:** it makes "AI cards" free and normal for students, so a paid AI tier is a hard sell for anyone. **Importing from NotebookLM** is an opportunity for us.

### 2026 newcomers worth watching
- **Quanta** (Germany, a **PWA like us**):
  - FSRS-6, AI cards with a "source-first" quote check, LaTeX and chemistry, an exam simulation and a readiness score.
  - .apkg import keeps text only.
  - Free plan: 20 cards total. Paid from €9.75/month ([quanta-study.de](https://quanta-study.de/en/flashcard-app), vendor page).
  - **The closest direct competitor in concept**, but heavily paywalled.
- **MintDeck** (iOS, late 2025): native FSRS, .apkg import *with scheduling and media* (it pitches AnkiHub decks: MilesDown, Ortho528), 10 free AI credits, offline TTS. No image occlusion ([mintdeck](https://www.mintdeck.app/blog/mcat-flashcard-app-2026), vendor page).
- **Space:** moved to FSRS in 2025 and makes AI cards from URLs, PDFs and EPUBs ([mindomax, a competitor](https://www.mindomax.com/spaced-repetition-apps-updates-2026)).

---

## 3. Top student pain points across the market

1. **Paywalls that show up mid-semester or the night before an exam.** Quizlet's Learn and Test caps; Brainscape images and reverse cards; Gizmo lives; StudySmarter daily AI caps; RemNote 5 image occlusions. "Paywalled features" is the largest complaint group (26%) in one 2026 roundup ([Unstar](https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026); [Trustpilot](https://www.trustpilot.com/review/www.quizlet.com); [Brainscape pricing](https://www.brainscape.com/pricing); [itechguides on Gizmo](https://www.itechguides.com/best/ai-study-tools/gizmo/)).
2. **Making cards takes too long.** This is why every new app leads with AI. Med students call it "card fatigue" ([studycardsai, vendor](https://studycardsai.com/blog/best-flashcard-app-for-medical-students-reddit)).
3. **AI cards are sometimes wrong**, with definitions flipped or questions that don't make sense, so students memorise errors ([Common Sense on Knowt](https://www.commonsense.org/education/reviews/knowt); [StudyFetch diagram misreads](https://www.toolsforhumans.ai/ai-tools/study-fetch); Google's own warning in [NotebookLM help](https://support.google.com/notebooklm/answer/16296687?hl=en&co=GENIE.Platform%3DiOS)). Human review is the accepted fix ([Reading Matrix](https://readingmatrix.com/files/34-tkcqbk1u.pdf), [Northeastern](https://learning.northeastern.edu/ai-gallery-post-ai-generated-flashcards-for-end-of-semester-exam-review/)).
4. **Review backlogs and burnout ("Anki hell").** Too many reviews after a break or too many new cards ([USMLE Privateers digest of r/medicalschool](https://sites.google.com/view/usmleprivateers/journal-of-reddit/medicalschool/2025/march/anki-14032025)). *We already address this with Catch-up plan, Postpone, FSRS and easy days.*
5. **Anki is hard to set up, and AnkiMobile costs $25** ([G2 summary](https://www.g2.com/products/Anki/reviews), [AlternativeTo](https://alternativeto.net/software/anki/about), [App Store](https://apps.apple.com/app/id373493387)).
6. **Sync conflicts and lost data** across Anki, RemNote, Quizlet and Knowt ([Anki forum](https://forums.ankiweb.net/t/syncing-breaks-my-settings/69150), [RemNote feedback](https://feedback.remnote.com/p/make-remnote-less-buggy-syncing-issues), [Unstar](https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026)).
7. **Shared decks contain errors** (Quizlet), and **removing community content makes users angry** (Memrise) ([Unstar](https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026), [Kimola](https://kimola.com/reports/uncover-the-impact-memrise-apps-user-feedback-report-app-store-us-147885)).
8. **Subscriptions that are hard to cancel and surprise charges** (Quizlet Trustpilot; trials that auto-renew, per [nibble](https://nibble-app.com/blog/quizlet-cost)).
9. **Big decks feel slow on phones** (RemNote; AnKing-size decks in general) ([RemNote forum](https://forum.remnote.io/t/serious-performance-issues/7834)).

---

## 4. GAPS: what students expect that we don't have

Ranked by **impact ÷ effort for a tiny team on Supabase Free**. Size: S = under a week, M = 1–3 weeks, L = more than that. "Cheap" means no running cost.

| # | Gap | Impact | Effort | Running cost | Notes |
|---|---|---|---|---|---|
| 1 | **PDF / slides into cards** (pdf.js reads text in the browser; .pptx is a zip, which the app's fflate can open) | High | S–M | **Cheap: $0** | The text goes into the existing paste parser or into the Claude prompt, split by page or slide. The earlier plan already named pdf.js (PLAN "Exam practice (v3.6)"). Scanned PDFs have no text; say so clearly instead of attempting OCR. |
| 2 | **Practice test / mock exam** (mixed question types, score by tag, "Drill what I missed") | High | M | **Cheap: $0** | Quizlet charges for this, and Knowt makes it its free hook. Reuses Play's question builder and distractors. Already in the PLAN as "Test mode", never built. |
| 3 | **AI card generation with no paid backend** | High | M | **Cheap: $0 to the owner** | Options in section 5, edge 6: (a) a smoother copy-paste flow to *any* chatbot, (b) "bring your own key", (c) importing from NotebookLM. A paid Edge Function stays parked unless the owner chooses it. |
| 4 | **Reminders** | High (keeps the streak and retention going) | S, then M | Cheap | Phase 1 (S, $0): a "Daily study reminder" calendar file (.ics, repeats daily, links to the app); the app badge with the due count (`navigator.setAppBadge`, supported on iOS 16.4+ for installed web apps, per [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.md)). Phase 2 (M): real Web Push for signed-in users through a Supabase Edge Function plus pg_cron. Free includes 500k invocations a month ([supabase.com/pricing](https://supabase.com/pricing)). On iPhone it only works once the app is installed, and it's flakier than on Android ([webscraft](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en)). |
| 5 | **Sharing a deck** | High (it's how decks spread among classmates) | S (file), then M (link) | Cheap | The owner said earlier "not wanted for now". Revisit it in two steps. Step 1 (S, $0): a **Share** button that hands the .apkg/CSV file to the phone's share sheet (Web Share API with files), so it goes to WhatsApp, AirDrop or Discord. Step 2 (M): a read-only link stored in a public Storage bucket, with size caps (Free has 1 GB of storage in total). |
| 6 | **Native store listing** | Medium (people find apps in stores; schools trust them) | S–M | $25 once (Google Play) | Package the PWA for Google Play as a Trusted Web Activity (PWABuilder or Bubblewrap) ([capgo](https://capgo.app/alternatives/pwabuilder/), [adalo](https://www.adalo.com/posts/pwa-store-publishing-ultimate-guide/)). The Microsoft Store also takes PWAs. **iOS App Store: skip.** It costs $99 a year, and Apple tends to reject "website wrappers" ([PWABuilder blog](https://blog.pwabuilder.com/posts/publish-your-pwa-to-the-ios-app-store/)). |
| 7 | **Missed-question log** (med and law), idea 9 from the earlier research | Medium-high for med | M | $0 | See edge 3. |
| 8 | **Export progress back to Anki** (scheduling in .apkg) | Medium (removes the fear of being locked in) | M | $0 | MintDeck brings scheduling *in*; nobody sends it back out. |
| 9 | **Collaboration / study groups / leaderboards** | Low-medium | M–L | Some database rows | Gizmo and Quizlet have them. A cheap first step: **share a Play result card** as an image (S, $0). Real-time collaboration: not now. |
| 10 | **Widgets** | Low | n/a | n/a | **Not possible** for a PWA on iOS or Android. The badge and notifications above are the closest we can get. |
| 11 | **A big library of ready-made decks** | Medium | L (content and moderation) | Storage | Don't build a library. Instead, make importing **AnkiWeb shared decks** and Quizlet sets (already supported) a guided, one-screen flow ("Get the AnKing deck" instructions). |

**Cheapest high-value wins:** 1, 4 (phase 1), 5 (step 1), plus the copy-paste AI improvements in gap 3. All four cost $0 to run and are each under about a week.

---

## 5. EDGES: where Study Sprint can credibly win

### Edge 1: "Anki's brain, free on iPhone, without Anki's pain"
- **Why it's credible:** we already do FSRS-6 with an on-device optimizer (checked against the official one in `docs/design/fsrs-realdata.md`), cloze, image occlusion, .apkg import with review history, Anki field names, sounds and tag/QID study. On iPhone, Anki costs $24.99, and Anki's #1 complaint category is that price plus the setup ([Unstar](https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026)). RemNote still calls its FSRS a beta ([help](https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm)).
- **Threats:** AnkiHub now runs Anki and may improve its UX. MintDeck pitches the same "AnkiHub decks on iPhone" story.
- **Ideas that sharpen it:**
  - **"Switch from Anki in 2 minutes" screen:** pick the .apkg, keep history, done, with a short checklist of what carries over.
  - **Progress export to Anki** (gap 8), so trying us carries no risk.
  - **AnKing-size stress test:** about 35k notes with media on a mid-range Android phone and an iPhone. Publish the timings in the README.
  - Correct the README comparison: Quizlet offline is "partly paid", and Anki has FSRS-6.

### Edge 2: exam-date scheduling (nobody else does it properly for free)
- **Why it's credible:** we have a final pass, a retention ramp, Exam prep, a readiness ring, "N new a day to finish by the exam" and a one-tap day off on exam day. RemNote charges for more than one exam. Quanta's readiness and exam simulation are paid. Anki needs add-ons.
- **Ideas that sharpen it:**
  - **Exam forecast:** "On exam day you'll remember about 78%. Do 25 a day for 90%." Already in the PLAN under "My own algorithm" and not built yet.
  - **Mock exam on exam week:** gap 2, pre-set to the exam deck and its tags.
  - **Syllabus pacing:** paste lecture dates, and new cards unlock by date.
  - **Several exams per course** (midterm and final), each with its own final pass.
  - **Calendar file of the study plan** (.ics): already planned in the "Quick wins" list.

### Edge 3: med-school workflow for free (what AnkiHub and AMBOSS charge for)
- **Why it's credible:** study by tag or question ID is built in. Paid add-ons exist just to do this ([earlier research](https://forums.ankiweb.net/t/new-add-on-atlas-uworld-results-to-anking-cards-resources/70098)). We also have folded Anki fields (First Aid, Sketchy) and image occlusion for anatomy.
- **Ideas that sharpen it:**
  - **Missed-question log:** after a UWorld/AMBOSS block, paste the IDs you missed, tag why ("didn't know", "misread", "mixed up"), unsuspend in one tap, and see "your weakest systems" in Stats.
  - **Personal glossary pop-ups:** an AMBOSS-style hover, but your own definitions.
  - **Step 1/2 presets:** retention, a new-card pace from the exam date, and a recommended daily review cap.

### Edge 4: free, no ads, no account, offline: trust as a feature
- **Why it's credible:** Quizlet sits at 1.4/5 on Trustpilot over paywalls, pop-ups and billing ([Trustpilot](https://www.trustpilot.com/review/www.quizlet.com)). Gizmo locks you out. Mochi charges for sync. We have no account by default, local-first data, free sync and nothing to cancel.
- **Ideas that sharpen it:**
  - **A "Free forever" promise in the README and on the welcome screen:** list what is free and say "no daily caps, no lives, no ads".
  - **A plain-language privacy page:** what stays on the device, what syncs, and nothing else.
  - **"Your data, any time":** one-tap full export (already exists) shown prominently, answering the "lost my sets" complaints.

### Edge 5: games that actually count (Play that feeds FSRS)
- **Why it's credible:** Gizmo and Quizlet have games, but their game answers don't update a real FSRS schedule. Ours can (opt-in, with recognition-vs-recall weighting tested in simulation). There's also "You mix these up" and the leech coach.
- **Ideas that sharpen it:**
  - **Shareable Play result card** (an image: grade, score, deck name): free word of mouth.
  - **Friend challenge by link,** later: the same seed and the same question order for a shared deck. Needs sharing (gap 5) first.
  - **Exam-day "Lightning warm-up":** a 60-second round from the cards with the lowest recall.

### Edge 6: honest AI, at zero cost to the owner
- **Why it's credible:** AI accuracy is a top complaint (pain point 3), and AI paywalls are another (pain point 1). We can be the app where **AI is optional, free, and checked**: every AI card lands in our editable preview, gets an "AI-made" tag, and can carry a quote from the source.
- **Options, cheapest first:**
  1. **Better copy-paste:** buttons for Claude, ChatGPT and Gemini, and for NotebookLM. Long notes are split into prompt-sized chunks ("part 1 of 3"). The prompt asks the AI to include the source sentence for each card. *Opening claude.ai with the prompt already filled in through a URL parameter is unreliable* ([GitHub issue](https://github.com/anthropics/claude-code/issues/8827)), so keep it as copy-to-clipboard. **S, $0.**
  2. **Import from NotebookLM:** it has no export button I could confirm (**unverified**), so this means a tested "copy your NotebookLM cards and paste them here" path through the paste parser. **S, $0.**
  3. **Bring your own key** (Gemini, Claude or OpenAI), stored only on the device and never synced, with calls going straight from the browser. Gemini's free API tier is shrinking and unclear in 2026 ([agentdeals](https://agentdeals.dev/gemini-api-pricing-changes), [yingtu](https://yingtu.ai/en/blog/google-gemini-api-free-tier-limits-2026)), so present this as a power-user option. **M, $0.**
  4. **On-device AI in Chrome (Gemini Nano Prompt API):** Chrome lists it as stable for extensions only, with web-page support at Chrome 148 ([developer.chrome.com](https://developer.chrome.com/docs/ai/built-in-apis)). It's desktop-only with heavy hardware needs, so it won't reach phones or iPhone. **Wait.**

### Edge 7: a PWA that installs anywhere
- **Why it's credible:** one link works on iPhone, Android and desktop with no store fee. Quanta is the only other PWA, and it's paywalled.
- **Ideas that sharpen it:**
  - A Google Play listing (gap 6) for people who search the store.
  - An Android **Share Target** in the manifest, so "Share → Study Sprint" sends text or a PDF straight into Import. Android/Chrome only; iOS doesn't support it (**unverified for 2026**).

---

## 6. Recommended roadmap (next 7 things, in order)

Each item works within Supabase Free and has no paid API.

| # | Build | Why | Size | Risks |
|---|---|---|---|---|
| 1 | **PDF and slides import** (pdf.js and .pptx text in the browser → paste parser or a chunked AI prompt with Claude, ChatGPT and Gemini buttons and a "source sentence" field; Android Share Target) | Closes the biggest expectation gap (pain point 2) at $0. Every competitor has it. | **S–M** | Scanned PDFs have no text (explain and skip). pdf.js is about 1 MB from the CDN, so load it only when needed, the way SheetJS is. Bad layouts produce messy text, so the preview has to stay the gate. |
| 2 | **Practice test mode** (mixed MCQ, typed and cloze questions; timer optional; score by tag; "Drill missed"; optional "count as reviews" with the same rules as Play) | Quizlet's paywalled hook and Knowt's free one; also sharpens the exam edge. | **M** | Overlap with Play could confuse people. Keep Test under Exam prep and on the deck page, and keep Play as "fun". Weak distractors on definition decks (AI distractors are parked). |
| 3 | **Reminders, phase 1** (daily-reminder calendar file; app badge with the due count; "remind me" in the first run) | Retention and streaks; $0; works on iPhone today. | **S** | Calendar reminders don't change with the due count (keep the wording general, e.g. "Study Sprint: today's cards"). The badge only updates when the app opens (no background on iPhone). |
| 4 | **Share a deck as a file** (share sheet with .apkg/CSV; import opens from a received file) | Classmates spreading decks is how study apps grow, at $0, without building a library. | **S** | Needs the owner to agree to revisit "no sharing for now". File-sharing support varies by browser, so fall back to download. |
| 5 | **Exam forecast and several exams per course** ("on exam day ~78%; 25 a day for 90%"; midterm and final) | Makes our most unusual feature visible and measurable. Quanta and RemNote charge for theirs. | **M** | The estimate has to be honest: reuse the "How sure is this?" note and test it in the simulator first, as the repo already does. More exam dates means more scheduler edge cases. |
| 6 | **Missed-question log and weakest topics** (med/law) | Builds on the free tag/QID study and turns it into a full loop. Strengthens the med edge against AnkiHub and AMBOSS add-ons. | **M** | Keep it fast (a few seconds per entry) or nobody will use it. Tag names differ between decks (AnKing vs personal). |
| 7 | **Google Play listing (TWA)**, after 1–4 ship | Discoverability; Android students search the store. | **S–M** (+$25 once) | Store rules (privacy policy, data-safety form), Digital Asset Links setup on GitHub Pages, and one more release channel to look after. Skip iOS. |
| *8 (optional)* | **Reminders, phase 2: Web Push** for signed-in users (Edge Function plus a daily pg_cron job) | Real "You have 34 cards due" pushes. | **M** | iPhone needs the app installed and push is flaky there. Free projects pause after 7 days without activity, which stops cron ([supabase pricing](https://supabase.com/pricing), [runhooks](https://runhooks.app/blog/preventing-supabase-free-tier-pausing/)). Needs VAPID key handling and an opt-in screen. |

**Deliberately left out for now:** a paid AI backend (owner's choice; still parked), real-time collaboration, leaderboards, widgets (not possible), the iOS App Store, and a public deck library.

**One quick fix to do alongside:** correct the README comparison table. Quizlet offline works in its mobile apps and only browser offline is said to be Plus ([help.quizlet.com](https://help.quizlet.com/hc/articles/360030565412)). "Spaced repetition: Basic" for Quizlet is fair.

---

## What I couldn't verify
- Quizlet's official prices and free caps (its pricing page returned 403; figures are third-party, mid-2026), and the early-2026 ChatGPT-based replacement for Q-Chat.
- Exact Noji, Gizmo and AnkiHub prices (App Store snapshots and third-party pages only).
- Boards & Beyond pricing; SuperMemo consumer pricing; whether Wisdolia became JungleAI; any product called "Seenode" (I found none).
- Whether Knowt's scheduler is real spaced repetition (only a competitor's claim).
- First-hand Reddit threads: Reddit was blocked for fetching and rarely appeared in search. The Reddit-flavoured points come from digests (USMLE Privateers) and vendor blogs, which are labelled as such.
- The Unstar roundup's quotes may be illustrative rather than verbatim; its percentages are for all five apps combined.
- iOS support for Web Share Target in 2026, and the exact free Gemini API limits.
