// A small starter deck, added the first time the app opens so it isn't empty.
// Delete it whenever you like; it won't come back (unless you reset all data).

import * as db from './db.js';

export const SAMPLE_DECK = {
  name: 'Intro to Psychology (sample)',
  course: 'PSYC 101',
  color: '#3E63DD',
  cards: [
    ['Classical conditioning', 'Learning by pairing a neutral stimulus with one that already causes a response, until the neutral one causes it too (Pavlov’s dogs).'],
    ['Operant conditioning', 'Learning from consequences: behavior followed by reward becomes more likely, behavior followed by punishment less likely (Skinner).'],
    ['Negative reinforcement', 'Removing something unpleasant to make a behavior more likely. Not the same as punishment.'],
    ['Confirmation bias', 'Favoring information that supports what you already believe and ignoring what contradicts it.'],
    ['Working memory', 'Short-term mental workspace that holds and manipulates about 4 chunks of information at once.'],
    ['Cognitive dissonance', 'Discomfort from holding two conflicting beliefs, or acting against a belief, which pushes people to change one of them.'],
    ['Independent variable', 'The factor the researcher changes on purpose to see its effect.'],
    ['Dependent variable', 'The outcome that is measured to see if the independent variable had an effect.'],
    ['Placebo effect', 'Real improvement caused by believing you received a treatment, not by the treatment itself.'],
    ['Fundamental attribution error', 'Blaming other people’s behavior on their personality while underrating the situation they were in.'],
    ['Neuroplasticity', 'The brain’s ability to rewire itself by forming and pruning connections throughout life.'],
    ['Maslow’s hierarchy', 'Needs in order: physiological, safety, love and belonging, esteem, self-actualization.']
  ]
};

// Add the sample deck, unless a deck with the sample's id is already there (an edited copy is never overwritten).
// Fixed ids (not random), so the sample deck added on two devices is the same deck once they sync.
// Used by the first-run start and by the empty Today screen ("Try sample cards"), and by app.js for the first open.
export async function addSampleDeck() {
  const deckId = 'sample';
  if (await db.getDeck(deckId)) return false;
  const now = Date.now();
  await db.addDeckWithCards(
    { id: deckId, name: SAMPLE_DECK.name, course: SAMPLE_DECK.course, color: SAMPLE_DECK.color, created: now },
    // created + i keeps the cards in their original order.
    SAMPLE_DECK.cards.map(([front, back], i) => ({ id: `sample-${i}`, deckId, front, back, tags: [], created: now + i })),
    { at: 1 }
  );
  await db.setSetting('seeded', true);
  return true;
}
