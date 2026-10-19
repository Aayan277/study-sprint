// The Help page (#/help, and #/help/<id> to open one answer). Short answers to the questions students ask most.
// Every label quoted here ("Start", "Target retention", "Export backup"...) is a real button or setting in the app:
// when one is renamed, change it here too (tests/browser/e2e-help.mjs checks a few against the screens).
import { esc } from './ui.js';
import { contactHTML } from './legal.js';

const code = s => `<code>${s}</code>`;

// id, question, answer (HTML written here, never from user data)
export const SECTIONS = [
  { title: 'Studying', items: [
    ['ratings', 'What do Again, Hard, Good and Easy mean?', `
      <p>After you flip a card, tell the app how it went.</p>
      <ul>
        <li><b>Again</b>: you forgot it or got it wrong. It comes back in a few minutes.</li>
        <li><b>Hard</b>: you got it, but it was a struggle. It comes back sooner than Good would.</li>
        <li><b>Good</b>: you remembered it. This is the usual answer.</li>
        <li><b>Easy</b>: you knew it instantly. It comes back much later.</li>
      </ul>
      <p>Each button shows when the card will come back. Be honest: pressing Good on a card you forgot just means you’ll forget it again before the exam.</p>`],
    ['scheduling', 'How does the app decide what I review?', `
      <p>Study Sprint uses FSRS, the scheduler Anki also offers. It estimates how well you know each card and brings it back just before you’d be likely to forget it. New cards come back a few times on the first day. Each time you remember one, the wait grows: days, then weeks, then months. A card you forget starts again with short gaps.</p>
      <p>By default it aims for a 90% chance that you still remember a card when it comes back (Settings → Study → Target retention). If a course has an exam date, cards you might forget come back in the last days before the exam.</p>`],
    ['daily', 'How much should I study each day?', `
      <p>Press <b>Start</b> on Today and keep going until it says <b>All done for today</b>. That’s everything due plus up to 20 new cards (Settings → Study → New cards per day). A new day starts at 4 am, so a late-night session still counts for the day before.</p>
      <p>Lots of new cards today means lots of reviews over the next few days. If Today feels too long, lower New cards per day.</p>`],
    ['missed', 'What if I miss a day?', `
      <p>Nothing is lost: cards you didn’t review wait for you. One missed day a week (the week runs Monday to Sunday) is covered by a streak freeze, so a single slip doesn’t end your streak (two missed days in a row still do). Back after a longer break? Today offers to spread the overdue cards over 2 or 3 days (<b>Spread them out</b>).</p>`],
    ['play', 'What are Play and Practice test? Do they change my schedule?', `
      <p><b>Play</b> turns a deck into timed game rounds for cramming. By default it’s practice only: it doesn’t change when cards are due, your stats or your streak (to change that, turn on Settings → Study → Count Play answers as reviews). <b>Practice test</b>, on a deck’s page, is a calm mock exam that’s marked at the end.</p>`]
  ] },
  { title: 'Your cards', items: [
    ['adding', 'How do I add my own cards?', `
      <p>Tap <b>Import</b> (on the Decks screen or on a deck’s page), or <b>Add cards</b> in the sidebar on a computer. Paste one card per line, with the front and back separated by a dash, tab, colon or comma, for example ${code('Mitosis - cell division into 2 identical cells')}. Quizlet exports and tables from Notion, Excel or Google Sheets work too, and so do .csv and .xlsx files and Anki decks (.apkg).</p>
      <p>Notes written in paragraphs don’t split into cards by themselves. Tap <b>Suggest cards</b> and the app picks out definitions, lists, key terms and dates for you to tick and check (it works on your device), or use <b>Make cards with Claude</b> for an AI version.</p>`],
    ['typing', 'Can I type my answers instead of flipping?', `
      <p>Yes, and the app shows which letters were wrong. For one session: Today → <b>Options</b> → Answer by → <b>Typing the answer</b> (answers of 40 characters or less). To keep it: open a card and set <b>Answer by</b> to Typing the answer, select several cards in Browse and choose <b>Answer by…</b>, or turn on <b>Type the answers</b> in a deck’s Edit deck sheet. Anki cards with a “type in the answer” box come in as typing cards.</p>`],
    ['share', 'Can I share a deck with a friend?', `
      <p>Yes. Open the deck and tap ⋯ → <b>Share</b>. It makes an Anki deck file (.apkg); your friend opens it in Study Sprint with Add cards → File, or in Anki. Only the cards are shared, not your progress.</p>`]
  ] },
  { title: 'Your data and account', items: [
    ['account', 'Do I need an account?', `
      <p>No. Everything works without one, offline too. An account only matters if you want the same cards on more than one device, like your phone and your laptop. It’s free: Settings → Sync → Create account.</p>`],
    ['safe', 'Is my data safe? Where is it kept?', `
      <p>Without an account, your cards are stored only in this browser on this device. Nobody else can see them, not even the developer. They can be lost if you clear your browser’s data or lose the device. On iPhone and iPad, Safari may also clear them if you don’t open Study Sprint for about a week. Adding it to your Home Screen avoids that, and <b>Settings → Your data → Export backup</b> saves everything to a file you can keep.</p>
      <p>With an account, a copy is also kept on the app’s server (Supabase), and each account can only read its own data. Details are on the <a href="privacy.html">Privacy</a> page.</p>`],
    ['device', 'How do I move my cards to a new phone?', `
      <p>Easiest: make an account on the old device (Settings → Sync), then sign in with the same email on the new one. Without an account: Settings → Your data → <b>Export backup</b> on the old device, send the file to the new one, and use <b>Import backup</b> there.</p>`],
    ['email', 'I didn’t get the confirmation or password email.', `
      <p>Check your spam or junk folder and give it a few minutes. Then ask for it again: tap <b>Send the link again</b> (it appears in Settings → Sync after you create an account here), or Create account again with the same email and password. Forgot your password? Type your email in Settings → Sync and tap <b>Forgot password?</b></p>`],
    ['install', 'How do I install it as an app?', `
      <p><b>iPhone or iPad (Safari):</b> tap Share, then Add to Home Screen. <b>Android (Chrome):</b> tap ⋮, then Install app or Add to Home screen. <b>Computer (Chrome or Edge):</b> click the install icon in the address bar. Installed, it opens full-screen, works offline and keeps your data safer.</p>`],
    ['contact', 'Something isn’t working.', `
      <p>Try reloading the app first. Still wrong? Contact: ${contactHTML()}. Never send your password.</p>`]
  ] }
];

export function renderHelp(el, id) {
  el.innerHTML = `
    <a class="back" href="#/settings">‹ Settings</a>
    <div class="screen-head"><div><h1>Help</h1></div></div>
    <p class="lede help-lede">Short answers to the questions students ask most. Tap a question to open it.</p>
    ${SECTIONS.map((s, i) => `
      <section class="section help-sec" aria-labelledby="helpH${i}">
        <h2 id="helpH${i}">${esc(s.title)}</h2>
        ${s.items.map(([qid, q, a]) => `<details class="help-q" id="h-${qid}"><summary>${esc(q)}</summary><div class="help-a">${a}</div></details>`).join('')}
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
