// Pure helpers behind the keyboard and screen-reader fixes (WCAG 2.2 flows): errors, toolbar arrows, spoken intervals, untimed Play, shortcuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleToken, toolbarTarget } from '../js/a11y.js';
import { formatInterval, formatIntervalLong } from '../js/queue.js';
import { timeLimit, scoreAnswer, bestKey, questionAnnouncement } from '../js/game.js';
import { spokenCard, spokenRow } from '../js/format.js';
import { gradeFor, spokenPrompt } from '../js/game.js';
import { autoRating, speedProfiles, playLogRow, SPEED } from '../js/autograde.js';
import { configureShortcuts, singleKeysOn, stripKeys, keyHint } from '../js/shortcuts.js';

test('toggleToken adds and removes one id in an aria-describedby list', () => {
  assert.equal(toggleToken('', 'e1', true), 'e1');
  assert.equal(toggleToken(null, 'e1', true), 'e1');
  assert.equal(toggleToken('help', 'e1', true), 'help e1');
  assert.equal(toggleToken('help e1', 'e1', true), 'help e1');          // never twice
  assert.equal(toggleToken('help e1', 'e1', false), 'help');
  assert.equal(toggleToken('e1', 'e1', false), '');
  assert.equal(toggleToken('a  b', 'c', true), 'a b c');
});

test('toolbarTarget: arrows wrap, Home/End jump, other keys do nothing', () => {
  assert.equal(toolbarTarget('ArrowRight', 0, 4), 1);
  assert.equal(toolbarTarget('ArrowRight', 3, 4), 0);
  assert.equal(toolbarTarget('ArrowLeft', 0, 4), 3);
  assert.equal(toolbarTarget('ArrowLeft', 2, 4), 1);
  assert.equal(toolbarTarget('Home', 2, 4), 0);
  assert.equal(toolbarTarget('End', 0, 4), 3);
  assert.equal(toolbarTarget('a', 0, 4), null);
  assert.equal(toolbarTarget('ArrowRight', -1, 4), null);      // focus is not on a button of the bar
});

test('formatIntervalLong says the interval in words, with the same rounding as formatInterval', () => {
  const MIN = 60000, H = 60 * MIN, D = 24 * H;
  assert.equal(formatIntervalLong(20000), 'less than a minute');
  assert.equal(formatIntervalLong(MIN), '1 minute');
  assert.equal(formatIntervalLong(10 * MIN), '10 minutes');
  assert.equal(formatIntervalLong(H), '1 hour');
  assert.equal(formatIntervalLong(5 * H), '5 hours');
  assert.equal(formatIntervalLong(D), '1 day');
  assert.equal(formatIntervalLong(5 * D), '5 days');
  assert.equal(formatIntervalLong(45.6 * D), '1.5 months');
  assert.equal(formatIntervalLong(30.4 * D), '1 month');
  assert.equal(formatIntervalLong(400 * D), '1.1 years');
  assert.equal(formatIntervalLong(365 * D), '1 year');
  // The two forms agree about which unit is used.
  for (const ms of [30000, 5 * MIN, 3 * H, 12 * D, 100 * D, 800 * D]) {
    const unit = formatInterval(ms).replace(/[\d.<]/g, '');
    const long = formatIntervalLong(ms);
    assert.ok({ m: /minute/, h: /hour/, d: /day/, mo: /month/, y: /year/ }[unit].test(long) || /less than/.test(long), `${ms}: ${unit} vs ${long}`);
  }
});

test('Play: an untimed Classic or Survival round has no limit and no speed bonus; Lightning stays timed', () => {
  assert.equal(timeLimit({ fmt: 'classic', pace: 8, untimed: true }), Infinity);
  assert.equal(timeLimit({ fmt: 'survival', pace: 8, untimed: true, i: 30 }), Infinity);
  assert.equal(timeLimit({ fmt: 'classic', pace: 8 }), 8000);
  assert.equal(timeLimit({ fmt: 'lightning', pace: 8 }), Infinity);
  const timed = scoreAnswer({ ok: true, seconds: 1, limitMs: 8000, fmt: 'classic', streak: 0, hard: false, flash: 0, score: 0 });
  const untimed = scoreAnswer({ ok: true, seconds: 1, limitMs: Infinity, fmt: 'classic', streak: 0, hard: false, flash: 0, score: 0 });
  assert.equal(untimed.speed, 0);
  assert.equal(untimed.pts, 100);
  assert.ok(timed.pts > untimed.pts);
  const lightning = scoreAnswer({ ok: true, seconds: 1, limitMs: Infinity, fmt: 'lightning', streak: 0, hard: false, flash: 0, score: 0 });
  assert.ok(lightning.speed > 0);
});

test('Play: best scores of untimed rounds are kept apart; the old keys do not change', () => {
  const base = { deckId: 'd', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20 };
  assert.equal(bestKey(base), 'd|classic|front|normal|0|20');
  assert.equal(bestKey({ ...base, untimed: false }), 'd|classic|front|normal|0|20');
  assert.equal(bestKey({ ...base, untimed: true }), 'd|classic|front|normal|0|20|untimed');
  assert.equal(bestKey({ ...base, fmt: 'lightning', untimed: true }), 'd|lightning|front|normal|0|-');
});

test('questionAnnouncement: number, total and the prompt as plain words', () => {
  assert.equal(questionAnnouncement({ fmt: 'classic', i: 2, total: 20 }, { prompt: 'Antidote for **warfarin**' }), 'Question 3 of 20: Antidote for warfarin');
  assert.equal(questionAnnouncement({ fmt: 'classic', i: 25, total: 20 }, { prompt: 'x' }), 'Question 20 of 20: x');
  assert.equal(questionAnnouncement({ fmt: 'survival', i: 4, total: null }, { prompt: 'Why?' }), 'Question 5: Why?');
  assert.equal(questionAnnouncement({ fmt: 'lightning', i: 0 }, { prompt: '$\\frac{a}{b}$' }), 'Question 1: a/b');
  assert.match(questionAnnouncement({ fmt: 'classic', i: 0, total: 10 }, { prompt: '', occ: true }), /highlighted box/);
  assert.match(questionAnnouncement({ fmt: 'classic', i: 0, total: 10 }, { prompt: '  ' }), /picture/);
});

test('spokenCard: a card as one phrase, formulas as words, blanks as "blank", long text cut', () => {
  assert.equal(spokenCard('What is $\\frac{1}{2}$?', 'Half'), 'What is 1/2? Answer: Half');
  assert.equal(spokenCard('The [...] makes ATP', ''), 'The [...] makes ATP');
  assert.equal(spokenCard('The mitochondria makes […]', 'ATP'), 'The mitochondria makes blank. Answer: ATP');
  assert.equal(spokenCard('', 'x'), 'Picture. Answer: x');
  assert.equal(spokenCard('**bold** front', 'back'), 'bold front. Answer: back');
  assert.ok(spokenCard('a'.repeat(500), 'b').length < 200);
});

test('single-key shortcuts: on by default; off hides the hints and aria-keyshortcuts, modifier hints stay a caller choice', () => {
  const html = '<button aria-keyshortcuts="E">Edit <kbd aria-hidden="true">E</kbd></button><kbd class="key-hint">Space</kbd>';
  configureShortcuts({});
  assert.equal(singleKeysOn(), true);
  assert.equal(stripKeys(html), html);
  assert.equal(keyHint('<kbd>E</kbd>'), '<kbd>E</kbd>');
  configureShortcuts({ singleKeys: false });
  assert.equal(singleKeysOn(), false);
  assert.equal(stripKeys(html), '<button>Edit</button>');
  assert.equal(keyHint('<kbd>E</kbd>'), '');
  configureShortcuts({ singleKeys: true });
  assert.equal(singleKeysOn(), true);
});

test('spokenRow: badges, picture, deck and status, no double full stops, about 160 characters', () => {
  assert.equal(spokenRow({ front: 'Q?', back: 'A', status: 'New' }), 'Q? Answer: A. New');
  assert.equal(spokenRow({ front: 'Q', back: 'A', reverse: true, pic: true, sound: true, where: 'Bio › Cells', status: 'Due', flag: 'Red' }),
    'Reverse card. Q. Answer: A. Has a picture. Has a sound. In Bio › Cells. Due. Red flag');
  assert.equal(spokenRow({ front: 'The [...] x', back: '', cloze: 2, status: 'New' }), 'Cloze card, blank 2. The [...] x. New');
  assert.ok(!/\.\./.test(spokenRow({ front: 'What?', back: 'Yes.', status: 'New' })));
  assert.ok(spokenRow({ front: 'a'.repeat(400), back: 'b'.repeat(400), status: 'New' }).length < 200);
});

test('Play: a cloze blank is read "blank" in the announcement', () => {
  assert.equal(spokenPrompt({ prompt: 'The mitochondria makes […] for the cell' }), 'The mitochondria makes blank for the cell');
  assert.equal(questionAnnouncement({ fmt: 'classic', i: 0, total: 5 }, { prompt: 'It is […]' }), 'Question 1 of 5: It is blank');
  assert.equal(questionAnnouncement({ fmt: 'classic', i: 0, total: 5 }, { prompt: 'It is […]' }, { withText: false }), 'Question 1 of 5');
  assert.equal(questionAnnouncement({ fmt: 'survival', i: 3 }, { prompt: 'x' }, { withText: false }), 'Question 4');
});

test('Play untimed: grade on accuracy alone, a right answer is Good, and it stays out of the speed profile', () => {
  assert.equal(gradeFor(1, 0).letter, 'A');                              // timed: no speed, no S
  assert.equal(gradeFor(1, 0, { untimed: true }).letter, 'S');
  assert.equal(gradeFor(0.5, 1, { untimed: true }).letter, gradeFor(0.5, 0, { untimed: true }).letter);
  assert.equal(autoRating({ ok: true, ms: 60000, limitMs: Infinity, typing: false, untimed: true }), 3);
  assert.equal(autoRating({ ok: true, ms: 100, limitMs: Infinity, typing: true, untimed: true }), 3);
  assert.equal(autoRating({ ok: false, ms: 100, limitMs: Infinity, typing: true, untimed: true }), 1);
  assert.equal(autoRating({ ok: true, ms: 60000, limitMs: Infinity, typing: false }), 2);      // without the flag it is Hard, as before
  assert.equal(playLogRow({ cardId: 'c', now: 1, qtype: 'front', fmt: 'classic', ok: true, ms: 9000, rating: 3, untimed: true }).untimed, true);
  assert.equal(playLogRow({ cardId: 'c', now: 1, qtype: 'front', fmt: 'classic', ok: true, ms: 9000, rating: 3 }).untimed, undefined);
  const mk = (n, extra) => Array.from({ length: n }, (_, i) => ({ source: 'play', correct: true, ms: 2000, chars: 10, mode: 'front', hard: false, ...extra }));
  assert.equal(speedProfiles([...mk(SPEED.minN, {}), ...mk(300, { untimed: true, ms: 90000 })]).get('front'), 2000 / (SPEED.c0 + 10));
  assert.equal(speedProfiles(mk(SPEED.minN, { untimed: true })).size, 0);
});

test('spokenRow: a typing card says so after the sound and before the deck', () => {
  assert.equal(spokenRow({ front: 'Q', back: 'A', sound: true, typing: true, where: 'Bio', status: 'New' }), 'Q. Answer: A. Has a sound. Typing card. In Bio. New');
  assert.equal(spokenRow({ front: 'Q', back: 'A', status: 'New' }), 'Q. Answer: A. New');
});
