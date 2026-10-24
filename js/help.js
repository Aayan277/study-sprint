// The Help page (#/help, and #/help/<id> to open one answer). Short answers to the questions students ask most.
// This is the ONE place explanations live: screens keep their labels short and send "why?" here.
// Every label quoted here ("Start", "Target retention", "Export backup"...) is a real button or setting in the app:
// when one is renamed, change it here too (tests/browser/e2e-help.mjs checks a few against the screens).
//
// To add an answer: add { id, q, a } to the right group in SECTIONS (or a new group { title, items }).
//   id  stable and unique, lowercase with dashes. It is the deep link #/help/<id> and the element id h-<id>: never rename one.
//   q   the question, plain text.
//   a   the answer as HTML written here, never from user data. Use helpLink() to point at another answer.
// Link to an answer from a screen with <a href="#/help/<id>">.
import { esc } from './ui.js';
import { contactHTML } from './legal.js';

const code = s => `<code>${s}</code>`;
// label: an aria-label for short link text such as "?"
// With a label, the link is a short "?" (named by the label) and gets the help-q class, a tap target of at least 24px.
export const helpLink = (id, text, label = '') => `<a href="#/help/${id}"${label ? ` class="help-q" aria-label="${label}"` : ''}>${text}</a>`;

export const SECTIONS = [
  { title: 'Studying', items: [
    { id: 'ratings', q: 'What do Again, Hard, Good and Easy mean?', a: `
      <p>After you flip a card, tell the app how it went.</p>
      <ul>
        <li><b>Again</b>: you forgot it or got it wrong. It comes back in a few minutes.</li>
        <li><b>Hard</b>: you got it, but it was a struggle. It comes back sooner than Good would.</li>
        <li><b>Good</b>: you remembered it. This is the usual answer.</li>
        <li><b>Easy</b>: you knew it instantly. It comes back much later.</li>
      </ul>
      <p>Each button shows when the card will come back. Be honest: pressing Good on a card you forgot just means you’ll forget it again before the exam.</p>` },
    { id: 'scheduling', q: 'How does the app decide what I review?', a: `
      <p>Study Sprint uses FSRS, the scheduler Anki also offers. It estimates how well you know each card and brings it back just before you’d be likely to forget it. New cards come back a few times on the first day. Each time you remember one, the wait grows: days, then weeks, then months. A card you forget starts again with short gaps.</p>
      <p>By default it aims for a 90% chance that you still remember a card when it comes back (Settings → Study → Target retention). If a course has an exam date, cards you might forget come back in the last days before the exam.</p>` },
    { id: 'daily', q: 'How much should I study each day?', a: `
      <p>Press <b>Start</b> on Today and keep going until it says <b>All done for today</b>. That’s everything due plus up to 20 new cards (Settings → Study → New cards per day). A new day starts at 4 am, so a late-night session still counts for the day before.</p>
      <p>Lots of new cards today means lots of reviews over the next few days. If Today feels too long, lower New cards per day.</p>` },
    { id: 'missed', q: 'What if I miss a day?', a: `
      <p>Nothing is lost: cards you didn’t review wait for you. One missed day a week (the week runs Monday to Sunday) is covered by a streak freeze, so a single slip doesn’t end your streak (two missed days in a row still do). Back after a longer break? Today offers to spread the overdue cards over 2 or 3 days (<b>Spread them out</b>).</p>` },
    { id: 'custom-study', q: 'What can I do in Today → Options and Custom study?', a: `
      <p><b>Options</b> on Today picks which decks you study (each chip shows what’s due · new), how you answer (flip or type), and opens <b>Custom study…</b>. Custom study is for extra work beyond today’s cards:</p>
      <ul>
        <li><b>By tag or question ID</b>: study just the cards you pick.</li>
        <li><b>More new cards today</b>: raise today’s new-card limit with the + and − buttons, then <b>Add</b>.</li>
        <li><b>Postpone reviews</b>: push chosen reviews to later.</li>
        <li><b>Review ahead</b>: study cards that aren’t due yet; each is rescheduled from today.</li>
        <li><b>Exam prep</b>: review cards you haven’t seen lately. It shows only when a deck has an exam date, and it is greyed out when you’ve seen everything recently.</li>
        <li><b>Cards I forgot today</b>: go over them again.</li>
      </ul>` },
    { id: 'review-counts', q: 'What are the New, Learn and Due numbers at the top of Review?', a: `
      <p><b>New</b> is cards you haven’t seen yet, <b>Learn</b> is cards still on their short learning steps, and <b>Due</b> is reviews that are waiting. The one you’re working on is underlined, and the numbers go down as you answer.</p>` },
    { id: 'compare', q: 'What is Compare?', a: `
      <p>When two cards keep getting mixed up, the end of a session, the leech helper and a card’s page in Browse offer <b>Compare</b>: it shows them side by side, with how many times you mixed them up recently, and can add a card that sets them apart. <b>Not confused</b> hides the pair until you mix them up twice more (on this device).</p>` },
    { id: 'play', q: 'What are Play and Practice test? Do they change my schedule?', a: `
      <p><b>Play</b> turns a deck into timed game rounds for cramming. By default it’s practice only: it doesn’t change when cards are due, your stats or your streak (to change that, turn on Settings → Study → Count Play answers as reviews). <b>Practice test</b>, on a deck’s page, is a calm mock exam that’s marked at the end.</p>` },
    { id: 'play-scoring', q: 'How does scoring work in Play?', a: `
      <p>In <b>Play</b>, tap <b>How scoring works</b> under the start button. A right answer scores 100, plus up to 100 for speed, times your streak (up to ×1.5). In Lightning the clock pauses while you read an answer. Your best score for a setup shows on the Play screen once you have one.</p>
      <p>Multiple choice needs at least 4 cards in the deck to offer wrong answers, which is why it is greyed out on smaller decks.</p>` },
    { id: 'accuracy', q: 'What does Accuracy mean on the finish screen?', a: `
      <p>Accuracy counts every rating except <b>Again</b>. Hard, Good and Easy all count as remembered.</p>` },
    { id: 'exam-date', q: 'What does an exam date change?', a: `
      <p>Add one with <b>Add exam date</b> (Today, a deck’s page, or <b>Edit deck</b> → Exam date). Until then, every card in that deck and its subdecks is scheduled to come back before the exam, reviews get a bit stricter in the last two weeks, and <b>Exam prep</b> goes over what you haven’t seen lately. Clear the date to turn this off.</p>
      <p>A subdeck with no date of its own uses its parent’s. Set a date in its Edit deck to give it its own.</p>` },
    { id: 'shortcuts', q: 'What are the single-key shortcuts? How do I turn them off?', a: `
      <p>In Review, Play and the card sheet, single keys act on a card: E, I, R, D, Z, A, X, M, -, @ and 1 to 6. Space and Enter always work on the focused card.</p>
      <p>If voice control or a switch triggers them by accident, turn off <b>Single-key shortcuts</b> in Settings → Study. That setting is for this device only.</p>` }
  ] },
  { title: 'Your cards', items: [
    { id: 'adding', q: 'How do I add my own cards?', a: `
      <p>Tap <b>Import</b> (on the Decks screen or on a deck’s page), or <b>Add cards</b> in the sidebar on a computer. Paste one card per line, with the front and back separated by a dash, tab, colon, <code>|</code>, <code>=</code> or comma, for example ${code('Mitosis - cell division into 2 identical cells')}. Quizlet exports and tables from Notion, Excel or Google Sheets work too, and so do .csv and .xlsx files and Anki decks (.apkg).</p>
      <p>Notes written in paragraphs don’t split into cards by themselves. Tap <b>Suggest cards</b> and the app picks out definitions, lists, key terms and dates for you to tick and check (it works on your device), or use <b>Make cards with Claude</b> for an AI version.</p>` },
    { id: 'tags', q: 'Can the app tag my cards for me?', a: `
      <p>Yes. To rename or remove a tag on every card in the list you’re looking at, use Browse → <b>Tools</b>. To get tags suggested: open a deck, tap ⋯ → <b>Suggest tags</b> (or in Browse, Tools → <b>Suggest tags for these cards</b>). The app reads your cards on your device and suggests topics. Only the ones it’s confident about start ticked; check the others and tick any you want. You can rename a tag or untick single cards, and nothing changes until you tap Add. Changed your mind? Tap Undo.</p>` },
    { id: 'tools', q: 'What is in Browse → Tools?', a: `
      <p>Tools works on the cards in the list you’re looking at: <b>Find by tag or question ID</b>, rename or remove a tag everywhere in the list, <b>Suggest tags for these cards</b> (needs 10 or more cards), and <b>Link cloze cards</b>, which turns older separate fill-in-the-blank cards into one note.</p>` },
    { id: 'reverse', q: 'What is a reverse card?', a: `
      <p>A reverse card asks the back and expects the front, with its own schedule, so you can know a term but not its definition. In Browse a pair shows “Has a reverse card” with <b>Open the other direction</b>. Cloze, image-occlusion, step-by-step and elements cards can’t have one.</p>` },
    { id: 'anki-import', q: 'What happens to my Anki deck when I import it?', a: `
      <p>Subdecks stay subdecks (“Psych 101::Unit 1” becomes a subdeck inside the deck you add them to); turn that off and everything goes in one deck. Anki notes with more than two fields keep the extras while <b>Keep the other fields</b> is on. Importing the same deck again updates the cards you already have. Cards you may have edited here are left alone unless you turn on <b>Overwrite … you may have edited here too</b>. Each of those rows says “Kept as you edited it”, or “Overwrites your edits” when that switch is on.</p>` },
    { id: 'typing', q: 'Can I type my answers instead of flipping?', a: `
      <p>Yes, and the app shows which letters were wrong. For one session: Today → <b>Options</b> → Answer by → <b>Typing the answer</b> (answers of 40 characters or less). To keep it: open a card and set <b>Answer by</b> to Typing the answer, select several cards in Browse and choose <b>Answer by…</b>, or turn on <b>Type the answers</b> in a deck’s Edit deck sheet (it applies to that deck and its subdecks, and <b>Answer by</b> in a card’s editor sets one card differently). Anki cards with a “type in the answer” box come in as typing cards. Cloze, image-occlusion and elements cards always just flip: they have no typing box.</p>` },
    { id: 'cloze', q: 'How do I write cloze (fill in the blank) cards?', a: `
      <p>In the card editor, select the words to hide and tap <b>New blank</b>. Each blank becomes its own card. <b>Same blank as the last one</b> hides another word on that same card. To show a hint instead of […], type two colons and the hint inside the blank, after the answer. The preview under the box says how many cards you will get.</p>` },
    { id: 'maths', q: 'How do I write maths on a card?', a: `
      <p>Put it between $ signs, like ${code('$x^2$')}. It works on the front, the back and inside blanks, and a preview shows how it will look.</p>` },
    { id: 'subdecks', q: 'Why do a deck’s numbers include its subdecks?', a: `
      <p>A deck’s counts, such as the numbers on its tile and on its <b>Subdecks</b> list, include the cards in its subdecks, so a course shows its whole workload. Open the course and look under <b>Subdecks</b> to see each part on its own. Study from the course to cover all of them, or from a subdeck to study just that part.</p>` },
    { id: 'deck-options', q: 'What do the options in Edit deck do?', a: `
      <p><b>New cards per day</b> and <b>Reviews per day</b> left blank (shown as “Overall”) use only the limits in Settings, which still cap the total across all decks. <b>Use my overall settings</b> takes retention, steps and maximum interval from Settings; a subdeck uses the deck it’s inside.</p>` },
    { id: 'read-aloud', q: 'How do I get cards read aloud or sounds played automatically?', a: `
      <p>In <b>Edit deck</b>, <b>Read cards aloud automatically</b> reads the front when it appears and the back when you flip in Review. The speaker button, or R, reads it any time. <b>Play sounds automatically</b> plays the front’s sounds when a card appears and the back’s when you flip.</p>` },
    { id: 'export', q: 'Which export should I pick, spreadsheet or Anki?', a: `
      <p>A spreadsheet (.csv) opens in Excel, Google Sheets or Numbers, and can be imported into Quizlet or back into Study Sprint. An Anki deck (.apkg) is for Anki, AnkiDroid or AnkiMobile, through File → Import.</p>` },
    { id: 'deck-ring', q: 'What does the percentage ring on a deck mean?', a: `
      <p>The “N% learned” ring counts the cards that are young or mature. ${helpLink('stats-terms', 'What those mean')}.</p>` },
    { id: 'glossary', q: 'What is the Glossary?', a: `
      <p>Define a term once in Settings → Study → <b>Glossary</b> and it’s underlined on every Review card, with its definition a tap away. Turn the underlines off with <b>Glossary underlines</b> in Settings → Appearance.</p>` },
    { id: 'share', q: 'Can I share a deck with a friend?', a: `
      <p>Yes. Open the deck and tap ⋯ → <b>Share</b>. It makes an Anki deck file (.apkg); your friend opens it in Study Sprint with Add cards → File, or in Anki. Only the cards are shared, not your progress.</p>` }
  ] },
  { title: 'Your data and account', items: [
    { id: 'account', q: 'Do I need an account?', a: `
      <p>No. Everything works without one, offline too. An account only matters if you want the same cards on more than one device, like your phone and your laptop. It’s free: Settings → Sync → Create account.</p>` },
    { id: 'safe', q: 'Is my data safe? Where is it kept?', a: `
      <p>Without an account, your cards are stored only in this browser on this device. Nobody else can see them, not even the developer. They can be lost if you clear your browser’s data or lose the device. On iPhone and iPad, Safari may also clear them if you don’t open Study Sprint for about a week. Adding it to your Home Screen avoids that, and <b>Settings → Your data → Export backup</b> saves everything to a file you can keep.</p>
      <p>With an account, a copy is also kept on the app’s server (Supabase), and each account can only read its own data. Details are on the <a href="privacy.html">Privacy</a> page.</p>` },
    { id: 'device-only', q: 'Which settings are only on this device?', a: `
      <p>Look and feel stays on the device you set it on: everything under Settings → Appearance (style, colours, Light or dark, OLED black, Card text alignment, Compact deck list, Rating feedback, Smooth transitions, Exam readiness in Stats and Glossary underlines), Single-key shortcuts, Play timer, Cards due on the app icon and the reminder time.</p>
      <p>With an account, your study settings sync to your other devices: New cards per day, Reviews per day, Target retention, the scheduling options, Play counting as reviews, your Stats layout and your Glossary.</p>` },
    { id: 'device', q: 'How do I move my cards to a new phone?', a: `
      <p>Easiest: make an account on the old device (Settings → Sync), then sign in with the same email on the new one. Without an account: Settings → Your data → <b>Export backup</b> on the old device, send the file to the new one, and use <b>Import backup</b> there.</p>` },
    { id: 'email', q: 'I didn’t get the confirmation or password email.', a: `
      <p>Check your spam or junk folder and give it a few minutes. Then ask for it again: tap <b>Send the link again</b> (it appears in Settings → Sync after you create an account here), or Create account again with the same email and password. Forgot your password? Type your email in Settings → Sync and tap <b>Forgot password?</b></p>` },
    { id: 'install', q: 'How do I install it as an app?', a: `
      <p><b>iPhone or iPad (Safari):</b> tap Share, then Add to Home Screen. <b>Android (Chrome):</b> tap ⋮, then Install app or Add to Home screen. <b>Computer (Chrome or Edge):</b> click the install icon in the address bar. Installed, it opens full-screen, works offline and keeps your data safer.</p>` },
    { id: 'contact', q: 'Something isn’t working.', a: `
      <p>Try reloading the app first. Still wrong? Contact: ${contactHTML()}. Never send your password.</p>` }
  ] },
  { title: 'Settings and Stats', items: [
    { id: 'steps', q: 'How do I type learning steps?', a: `
      <p><b>Learning steps</b> are the short gaps while a card is new: you see it again after each one, until it moves on to normal reviews. <b>Relearning steps</b> are the gaps after you press Again on a normal review.</p>
      <p>Type the gaps separated by spaces: <b>m</b> = minutes, <b>h</b> = hours, <b>d</b> = days. The defaults are the grey text in each box (1m 10m and 10m). The list under the box spells out what each button does as you type, and <b>Reset</b> puts the default back.</p>` },
    { id: 'advanced', q: 'What do the other Advanced scheduling settings do?', a: `
      <p>Changes apply to future reviews; cards already scheduled keep their dates until you next review them.</p>
      <ul>
        <li><b>Maximum interval</b>: the longest a card can go without being shown. Lower it before an exam so nothing drifts too far out.</li>
        <li><b>Spread out due dates</b>: moves longer gaps by a day or so (within what FSRS allows) onto the least busy days, so reviews don’t pile up.</li>
        <li><b>Easy days</b>: give busy days fewer reviews. Reduced days get about half; Minimum days as few as possible. It needs Spread out due dates.</li>
        <li><b>Play timer</b>: the default seconds per question in Play. The Play screen has the same slider.</li>
        <li><b>Leech after</b>: a card you forget this many times is a leech, and again every half that many after (8, 12, 16…). 0 turns this off. Leeches are tagged “leech”: find them in Browse with the Leeches filter, then rewrite or split them.</li>
        <li><b>Scheduler</b>: FSRS-7 (beta) models short-term memory better, for same-day repeats and cramming. It is off by default, your cards keep their history, and switching back is safe.</li>
      </ul>` },
    { id: 'fit-check', q: 'What does “Check how well it fits you” do?', a: `
      <p>In Settings → Study → Advanced scheduling → Personal parameters, <b>Check how well it fits you</b> compares what the scheduler predicted with what you actually remembered, and says whether to tune it or leave it. See “How is the fit judged?” for the three checks.</p>
      <p><b>Ignore reviews before</b> skips old history when tuning and checking, for example a messy Anki import. Cards first studied before that date are skipped too, since their start is unknown.</p>` },
    { id: 'health-check', q: 'How is the fit judged?', a: `
      <p>Three checks, and the verdict is the worst of them. (1) Do the average predicted and the actual chance of remembering match? (2) How far off are the predictions in each band of confidence, with the luck of a small sample removed? (3) Do the predictions beat just guessing your own average every time? With only a few reviews the result is marked rough.</p>` },
    { id: 'optimize', q: 'What does Optimize do, and when should I run it?', a: `
      <p><b>Optimize…</b> tunes the scheduler to your own review history. It needs enough reviews; when it’s greyed out the reason shows under the button. Run it again every month or so as you review more. You can close the sheet while it runs: it keeps going.</p>` },
    { id: 'stats-terms', q: 'What do young, mature, retention and difficulty mean in Stats?', a: `
      <ul>
        <li><b>Young</b> cards had a gap of under 21 days since their last review; <b>mature</b> cards 21 days or more.</li>
        <li><b>Retention</b> is how often you remembered a card when it came due in the last 30 days. It counts flipping, typing and Anki answers, not multiple choice, because you can guess that.</li>
        <li><b>Retention vs target</b>: the dot is how often you remembered, the line is your Target retention, for young and for mature cards.</li>
        <li><b>Difficulty</b> is the scheduler’s estimate for each studied card, from 1 (easy) to 10 (hard).</li>
        <li><b>Answer buttons</b> shows how you answered in the last 30 days. Mostly Good is normal. Lots of Again on reviews means cards are coming back too late: try a higher Target retention in Settings.</li>
      </ul>` },
    { id: 'stats-calendar', q: 'How does the Study calendar work?', a: `
      <p>Each square in the <b>Study calendar</b> is a day; darker means more answers. Tap a day to read its numbers, or use <b>Pick a day</b> to do it without a mouse. A diagonal hatch is a day covered by a streak freeze, and a day off you planned is marked too.</p>` },
    { id: 'streak-freeze', q: 'What is a streak freeze?', a: `
      <p>One streak freeze a week covers a missed day. It keeps your streak but doesn’t add to the count. To rest on purpose, tap <b>Plan a day off</b>.</p>` },
    { id: 'readiness', q: 'What does Exam readiness mean?', a: `
      <p>On Stats, pick a course. <b>Exam readiness</b> is the share of its cards you would still remember (90% or better) on exam day if you stopped reviewing now. Without an exam date it shows <b>Readiness today</b>, and <b>Add exam date</b> lets you set one. It’s an estimate: <b>How sure is this?</b> says what it’s based on. You can turn the header off with Exam readiness in Stats in Settings → Appearance.</p>` },
    { id: 'retention-planner', q: 'How does Help me choose pick a retention?', a: `
      <p>Under Settings → Study → Target retention, <b>Help me choose</b> shows what each target would cost in reviews. It includes the exam’s own rules: the target rises over the last two weeks, and cards you would remember at under 99% on exam day get one more review in the final days, spread over those days.</p>` },
    { id: 'stats-layout', q: 'How do I change which Stats cards I see?', a: `
      <p>On Stats, tap <b>Edit</b>. Drag a card to move it, tap × to remove it, and use the <b>Half</b> / <b>Full</b> button to change its width (only some cards can be half width). <b>Add widget</b> brings hidden cards back, and <b>Reset</b> restores the default layout. <b>Edit as a list</b> opens <b>Customise Stats</b>, with move buttons and a switch for every card, which works without dragging. Every change is saved at once and syncs with your account.</p>` },
    { id: 'reminders', q: 'How do the calendar reminders work?', a: `
      <p><b>Add to my calendar</b> in Settings → Study makes a daily calendar alert at the time you pick. It works best in Apple Calendar and Outlook; in Google Calendar, alerts follow your default notifications. Exams get an alert 3 days before and one on the day.</p>
      <p><b>Cards due on the app icon</b> shows today’s card count on the Study Sprint icon and updates when you open or leave the app.</p>` }
  ] }
];

export function renderHelp(el, id) {
  el.innerHTML = `
    <a class="back" href="#/settings">‹ Settings</a>
    <div class="screen-head"><div><h1>Help</h1></div></div>
    ${SECTIONS.map((s, i) => `
      <section class="section help-sec" aria-labelledby="helpH${i}">
        <h2 id="helpH${i}">${esc(s.title)}</h2>
        ${s.items.map(({ id: qid, q, a }) => `<details class="help-q" id="h-${qid}"><summary>${esc(q)}</summary><div class="help-a">${a}</div></details>`).join('')}
      </section>`).join('')}
    <p class="note help-foot"><a href="#/welcome/again">Replay the welcome tour</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>
    <p class="note">Contact: ${contactHTML()}</p>`;
  const target = id && el.querySelector(`#h-${CSS.escape(id)}`);
  if (target) {
    target.open = true;
    // After the router's scroll to the top and its focus on the heading (route() in app.js): go to the answer next frame.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!target.isConnected) return;
      target.scrollIntoView({ block: 'start' });
      target.querySelector('summary').focus({ preventScroll: true });
    }));
  }
}
