// Tests for js/reading-cards.js ("Suggest cards" from a reading). Run with: node --test tests/reading-cards.test.js
//
// The four fixtures in tests/fixtures/reading/ are pasted text as a student would paste it. They were written before the rules, and the rules
// were built until these measurable tests passed: recall (the key things in the text that are found), junk (suggestions that are plainly
// wrong), volume and speed. The numbers are printed so a run shows how good the suggestions are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestCards, suggestSteps, splitSentences, pairSplit, definitionIn, appositiveIn, calledIn, matchesAbbreviation, abbreviationsIn, looksLikeProse, MAX_SUGGESTIONS, MAX_CHARS } from '../js/reading-cards.js';
import { words } from '../js/keywords.js';
import { foldText } from '../js/match.js';
import { dupKey, parseText } from '../js/import.js';
import { parseElements } from '../js/steps.js';

const fixture = name => fs.readFileSync(new URL(`./fixtures/reading/${name}.txt`, import.meta.url), 'utf8');
const TEXT = { biology: fixture('biology'), history: fixture('history'), vocab: fixture('spanish-vocab'), messy: fixture('lecture-messy'),
  // Held out: written by a reviewer who had not seen the rules. The rules were not tuned to these three beyond general fixes.
  econ: fixture('heldout-econ'), french: fixture('heldout-french'), psych: fixture('heldout-psych'),
  // (a second reviewer round: texts written before the second round of fixes)
  geo: fixture('heldout-geo'), pharm: fixture('heldout-pharm') };
const RESULT = Object.fromEntries(Object.entries(TEXT).map(([k, t]) => [k, suggestCards({ text: t })]));
const wordCount = t => (t.match(/\S+/g) || []).length;

// ---------- recall ----------

const answersOf = s => (s.type === 'cloze' ? [...s.cloze.matchAll(/\{\{c1::(.*?)\}\}/g)].map(m => m[1]) : []);
// What a suggestion is "about": a basic card's front (an abbreviation's back too), or a cloze card's hidden words.
const aboutOf = s => foldText([s.type === 'cloze' ? answersOf(s).join(' ') : s.front, s.kind === 'acronym' ? s.back : ''].join(' '));
const found = (suggestions, alts) => suggestions.some(s => alts.some(a => aboutOf(s).includes(foldText(a))));
const foundList = (suggestions, items, intro) => suggestions.some(s => s.kind === 'list' && items.every(i => foldText(s.back).includes(i)) && (!intro || foldText(s.front).includes(intro)));

const MUST = {
  biology: [['osmosis'], ['diffusion'], ['active transport'], ['mitochondria'], ['atp', 'adenosine triphosphate'], ['dna', 'deoxyribonucleic acid'], ['ribosomes'],
    { list: ['prophase', 'metaphase', 'anaphase', 'telophase'], intro: 'stages of mitosis' }, ['photosynthesis'], ['chlorophyll'], ['46'], ['phospholipid bilayer']],
  history: [['franz ferdinand'], ['1914'], ['treaty of versailles'], ['1919'], ['triple entente'], ['triple alliance'],
    { list: ['militarism', 'alliances', 'imperialism', 'nationalism'] }, ['league of nations'], ['trench warfare'], ['schlieffen plan'], ['armistice', '11 november 1918'], ['total war']],
  messy: [['classical conditioning'], ['operant conditioning'], ['cs', 'conditioned stimulus'], ['ucs', 'unconditioned stimulus'], ['reinforcement'], ['punishment'],
    { list: ['fixed ratio', 'variable ratio', 'fixed interval', 'variable interval'], intro: 'schedules of reinforcement' }, ['extinction'], ['spontaneous recovery']],
  econ: [['price elasticity of demand'], ['total revenue'], ['income elasticity of demand'], ['normal goods'], ['inferior goods'], ['cross price elasticity'],
    ['opec', 'organization of petroleum exporting countries'], ['1973'], ['1986'], ['elasticity of supply'], ['substitutes']],
  french: ['cuisine', 'chambre', 'salon', 'salle de bains', 'grenier', 'cave', 'escalier', 'jardin', 'toit', 'fenetre', 'mur', 'placard', 'ranger', 'nettoyer',
    'demenager', 'louer', 'avoir du mal', 'faire le menage', 'mettre la table', 'librairie', 'bibliotheque'].map(w => [w]),
  psych: [['atkinson shiffrin'], ['sensory memory'], ['stm', 'short term'], ['chunking'], ['ltm'], ['working memory'], ['central executive'], ['phonological loop'],
    ['visuospatial sketchpad'], ['episodic buffer'], ['explicit'], ['episodic memory'], ['semantic memory'], ['procedural memory'], ['serial position'],
    ['proactive interference'], ['retroactive interference'], ['henry molaison', 'hm'], ['anterograde amnesia']],
  geo: [['lithosphere'], ['asthenosphere'], ['subduction'], ['earthquake'], ['focus'], ['epicentre'], ['primary waves', 'p waves'], ['secondary waves', 's waves'],
    ['moment magnitude scale', 'mw'], ['2004'], ['wegener'], ['continental drift'], ['seafloor spreading', '1960s'], ['mesosaurus'], ['mid atlantic ridge'], ['san andreas fault']],
  pharm: [['beta blockers moa'], ['beta blockers uses'], ['beta blockers se'], ['beta blockers ci'], ['cardioselective'], ['ace inhibitors moa'], ['ace inhibitors se'],
    ['ace inhibitors ci'], ['paracetamol overdose'], ['paracetamol max dose'], ['nsaids inhibit', 'nsaids moa'], ['nsaids se'], ['aspirin'], ['opioids'], ['opioids se'], ['naloxone']]
};
const recall = name => {
  const items = MUST[name], list = RESULT[name].suggestions;
  const hits = items.filter(it => (Array.isArray(it) ? found(list, it) : foundList(list, it.list, it.intro)));
  const missed = items.filter(it => !hits.includes(it)).map(it => (Array.isArray(it) ? it[0] : it.list[0] + ' list'));
  return { hits: hits.length, of: items.length, rate: hits.length / items.length, missed };
};

// ---------- junk ----------

const PRON = /^(?:it|this|that|these|those|they|there|he|she|we|you|i|one|such|which)\b/i;
const ADMIN = /\b(?:page|slide|lecture|lec|week|todo|midterm|room|office|figure)\b/i;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'is', 'are', 'was', 'to', 'in', 'it', 'this', 'that', 'with', 'for', 'on', 'by']);
const alnum = s => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;
// Why a suggestion is plainly wrong (an empty list means nothing is wrong with it).
function junkReasons(s, seen = new Set()) {
  const out = [];
  const ans = answersOf(s);
  if (alnum(s.front) < 2 || alnum(ans.length ? ans.join('') : s.back) < 2) out.push('too short');
  if (foldText(s.front) === foldText(s.back)) out.push('front equals back');
  if (s.type === 'basic' && s.kind !== 'vocab' && s.kind !== 'acronym' && PRON.test(s.front.trim())) out.push('front starts with a pronoun');
  if (s.type === 'basic' && ADMIN.test(s.front)) out.push('label or admin word in the front');
  if (ans.some(a => STOP.has(a.trim().toLowerCase()) || words(a).length > 6)) out.push('bad blank');
  if (s.type === 'cloze' && words(s.front).length < 6) out.push('cloze sentence under 6 words');
  if (/https?:|www\.|\S+@\S+|\b\d{1,2}:\d{2}\b/.test([s.front, s.back, s.cloze].join(' '))) out.push('url, e-mail or time');
  const k = dupKey(s.front);
  if (seen.has(k)) out.push('same front twice');
  seen.add(k);
  return out;
}
const junkOf = name => {
  const seen = new Set();
  const list = RESULT[name].suggestions;
  const bad = list.map(s => ({ s, why: junkReasons(s, seen) })).filter(x => x.why.length);
  return { bad, rate: bad.length / Math.max(1, list.length), n: list.length };
};

// (The held-out texts are scored too: the floors are set under what they got, so a rule change that makes them worse shows. They are lower
// than for the first fixtures, and that is the honest number.)
for (const [name, min] of [['biology', 0.8], ['history', 0.8], ['messy', 0.75], ['econ', 0.5], ['french', 0.7], ['psych', 0.65], ['geo', 0.4], ['pharm', 0.5]]) {
  test(`recall: ${name} finds at least ${min * 100}% of what matters`, () => {
    const r = recall(name);
    console.log(`  recall ${name}: ${r.hits}/${r.of} = ${(r.rate * 100).toFixed(0)}%${r.missed.length ? ', missed: ' + r.missed.join(', ') : ''}`);
    assert.ok(r.rate >= min, `${name}: ${r.hits}/${r.of}, missed ${r.missed.join(', ')}`);
  });
}

for (const [name, max] of [['biology', 0.1], ['history', 0.1], ['vocab', 0.1], ['messy', 0.15], ['econ', 0.15], ['french', 0.15], ['psych', 0.15], ['geo', 0.15], ['pharm', 0.15]]) {
  test(`junk: ${name} has at most ${max * 100}% junk and no junk among the pre-ticked`, () => {
    const j = junkOf(name);
    console.log(`  junk ${name}: ${j.bad.length}/${j.n} = ${(j.rate * 100).toFixed(1)}%${j.bad.length ? ' (' + j.bad.map(x => x.why.join('+')).join(', ') + ')' : ''}`);
    assert.ok(j.rate <= max, `${name}: ${j.bad.map(x => x.s.front + ' / ' + x.why).join('; ')}`);
    assert.deepEqual(j.bad.filter(x => x.s.strong).map(x => x.s.front + ': ' + x.why), []);
  });
}

test('held-out texts: none of the wrong cards a reviewer found (OPEC, Inelastic, Key takeaway, a title line)', () => {
  const econ = RESULT.econ.suggestions, fr = RESULT.french.suggestions;
  const opec = econ.find(s => s.kind === 'acronym' && s.front === 'OPEC');
  assert.ok(opec && /^Organization of Petroleum/.test(opec.back), 'OPEC: ' + opec?.back);
  for (const s of econ) assert.ok(!['inelastic', 'key takeaway', 'study'].includes(foldText(s.front)), 'a card for "' + s.front + '"');
  assert.ok(!econ.some(s => s.type === 'basic' && /^the revenue of OPEC/.test(s.back)));
  assert.ok(!fr.some(s => /francais|unite/.test(foldText(s.front + ' ' + s.back))), 'the title line is not a card');
  assert.ok(fr.filter(s => s.kind === 'vocab' && s.both).length >= 12, 'one-word meanings count in a word list');
  for (const n of ['econ', 'psych', 'french', 'geo', 'pharm']) assert.deepEqual(RESULT[n].suggestions.filter(s => s.strong).map(s => junkReasons(s)).filter(r => r.length), []);
  assert.ok(!RESULT.psych.suggestions.some(s => answersOf(s).some(a => /->/.test(a))), 'an arrow inside a blank');
});
test('held-out notes: a label like MOA, SE or overdose carries its heading, and is not ticked without one', () => {
  const ph = RESULT.pharm.suggestions;
  for (const s of ph) assert.ok(!['moa', 'overdose', 'se', 'ci', 'uses', 'dose'].includes(foldText(s.front)), 'a card for the bare label "' + s.front + '"');
  const fronts = ph.map(s => s.front);
  assert.ok(fronts.includes('Beta blockers: MOA') && fronts.includes('ACE inhibitors: MOA'), 'the two MOA lines are two cards: ' + fronts.slice(0, 8).join(' | '));
  assert.ok(fronts.includes('Paracetamol: overdose') && fronts.includes('Beta blockers: SE'));
  assert.ok(!ph.some(s => /quiz|zoom|calculator|tutor/i.test(s.front + s.back)), 'admin lines make no cards');
  const bare = suggestCards({ text: 'MOA: blocks beta receptors and lowers heart rate\nSE: slow heart rate and tiredness' }).suggestions;
  assert.ok(bare.every(s => !s.strong), 'a label with no heading is not ticked');
  assert.equal(pairSplit('Down syndrome: trisomy 21').def, 'trisomy 21');
  assert.equal(pairSplit('Neutral water at 25 °C: pH 7').def, 'pH 7');
  assert.equal(pairSplit('Français – Unité 5 : La maison'), null);
  const heading = suggestCards({ text: 'Beta blockers (e.g. propranolol, atenolol)\n- MOA: block beta receptors\n- SE: bradycardia and fatigue and cold hands' }).suggestions;
  assert.ok(heading.some(s => s.front === 'Beta blockers: SE'), JSON.stringify(heading.map(s => s.front)));
});
test('names, numbers and namings in one sentence', () => {
  const one = t => suggestCards({ text: t, debug: [] }).suggestions;
  const geo = RESULT.geo.suggestions;
  assert.ok(geo.some(s => /\{\{c1::Alfred Wegener\}\}/.test(s.cloze || '')), 'a whole name is the blank when the sentence has one');
  assert.ok(geo.some(s => /\{\{c1::2 to 10\}\}/.test(s.cloze || '')), 'a range is hidden whole');
  assert.ok(!geo.some(s => /to \{\{c1::10\}\}/.test(s.cloze || '')));
  assert.ok(geo.some(s => s.kind === 'definition' && /^Subduction/.test(s.front)), '"in a process called subduction"');
  assert.ok(geo.some(s => s.kind === 'definition' && /^Focus \(hypocentre\)/.test(s.front)) && geo.some(s => s.front === 'Epicentre'), '"is called the focus, or hypocentre, and … is the epicentre"');
  assert.ok(!geo.some(s => /\{\{c1::plates move\}\}/.test(s.cloze || '')), 'a noun and its verb are not one blank');
  assert.ok(RESULT.biology.suggestions.some(s => s.type === 'cloze' && /\{\{c1::46\}\}/.test(s.cloze)), 'with no name in it, the number is hidden');
  assert.deepEqual(calledIn('The denser oceanic plate sinks beneath the other in a process called subduction.').map(x => x.term), ['subduction']);
});
test('a blank never cuts a name or a hyphenated word, and a lone verb is not blanked', () => {
  for (const name of Object.keys(RESULT)) for (const s of RESULT[name].suggestions.filter(x => x.type === 'cloze')) {
    assert.ok(!/[\p{L}\-–]\{\{c1::/u.test(s.cloze) && !/\}\}[\-–]\p{L}/u.test(s.cloze), name + ': ' + s.cloze);
  }
  const hb = suggestCards({ text: 'The Henderson–Hasselbalch equation relates the pH of a buffer to its pKa. A buffer resists change. The Henderson–Hasselbalch equation is used for buffers, and each buffer has a pKa.' });
  assert.ok(!hb.suggestions.some(s => /\{\{c1::Henderson\}\}/.test(s.cloze || '')));
  const verbs = RESULT.econ.suggestions.filter(s => s.type === 'cloze').flatMap(answersOf);
  assert.ok(!verbs.includes('reduces') && !verbs.includes('demand measures'));
});
test('the messy notes make no card out of times, links, e-mail, admin lines, headers or footers', () => {
  const everything = RESULT.messy.suggestions.map(s => [s.front, s.back, s.cloze, ...answersOf(s)].join(' ').toLowerCase()).join('\n');
  for (const bad of ['midterm', 'room 204', 'office', 'todo', 'http', '@', '10:32', 'psyc 101', 'slide 4', 'lec 5']) assert.ok(!everything.includes(bad), `a card has "${bad}"`);
});

// ---------- volume and kinds ----------

test('volume: between a card per 40 words and a card per 12 words, and enough that are strong', () => {
  for (const name of ['biology', 'history']) {
    const n = RESULT[name].suggestions.length, w = wordCount(TEXT[name]);
    console.log(`  ${name}: ${n} suggestions for ${w} words, ${RESULT[name].suggestions.filter(s => s.strong).length} strong`);
    assert.ok(n >= w / 40 && n <= w / 12, `${name}: ${n} for ${w} words`);
    assert.ok(RESULT[name].suggestions.filter(s => s.strong).length >= MUST[name].length / 2, `${name}: too few strong ones`);
  }
});

test('kinds: the biology text has an abbreviation, a list, a definition and a fact; the history a list and facts', () => {
  const kinds = n => RESULT[n].suggestions.map(s => s.kind);
  for (const k of ['acronym', 'list', 'definition', 'fact']) assert.ok(kinds('biology').includes(k), 'biology: ' + k);
  const list = RESULT.biology.suggestions.find(s => s.kind === 'list');
  assert.equal(parseElements(list.back).items.length, 4, 'the list is an Elements card with 4 items');
  assert.ok(kinds('history').filter(k => k === 'fact').length >= 3, 'history facts');
  assert.ok(kinds('history').includes('list'));
});

test('word pairs: at least 28 of the 30 pairs, both directions, the Spanish on the front, no cloze, no title', () => {
  const list = RESULT.vocab.suggestions;
  const pairs = list.filter(s => s.kind === 'vocab' && s.both);
  console.log(`  vocab: ${pairs.length} of 30 pairs`);
  assert.ok(pairs.length >= 28);
  assert.ok(pairs.some(s => s.front === 'la cocina' && s.back === 'the kitchen'));
  assert.ok(pairs.some(s => s.front === 'la nevera' && s.back === 'the fridge'), 'a tab-separated pair');
  assert.ok(pairs.some(s => s.front === 'la escalera (f.)'), 'a (f.) note stays on the word');
  assert.equal(list.filter(s => s.type === 'cloze').length, 0);
  assert.ok(!list.some(s => /unidad/i.test(s.front + s.back)), 'the title is not a card');
  assert.ok(!list.some(s => /ejemplo|mi casa|vivimos/i.test(s.front + s.back)), 'the example sentences are not cards');
});

// ---------- the rules, one by one ----------

const one = (text, kind) => suggestCards({ text }).suggestions.filter(s => !kind || s.kind === kind);

test('definition: "X is the…", "X refers to…", the reverse "…is called X"', () => {
  assert.deepEqual(definitionIn('Osmosis is the movement of water across a partially permeable membrane.'), { term: 'Osmosis', back: 'the movement of water across a partially permeable membrane', base: 0.8 });
  assert.equal(definitionIn('A gene is a short section of DNA that codes for one protein.').term, 'gene');
  assert.equal(definitionIn('Inflation refers to a general rise in prices over time.').back, 'a general rise in prices over time');
  const rev = definitionIn('The process by which plants make glucose from light is called photosynthesis.');
  assert.equal(rev.term, 'photosynthesis');
  assert.equal(rev.back, 'The process by which plants make glucose from light');
  assert.equal(definitionIn('It is the movement of water across a membrane.'), null, 'a pronoun is not a term');
  assert.equal(definitionIn('The cell is small.'), null, 'a short predicate is not a definition');
  assert.equal(definitionIn('Is osmosis the movement of water across a membrane?'), null);
});

test('appositive: a term followed by what it is', () => {
  const t = s => appositiveIn(s, words(s));
  assert.deepEqual(t('Chloroplasts contain chlorophyll, the green pigment that absorbs light, mostly from the red part.'), { term: 'chlorophyll', back: 'the green pigment that absorbs light', base: 0.72 });
  assert.equal(t('An armistice, which is an agreement to stop fighting, came into effect on 11 November.').term, 'armistice');
  assert.equal(t('In practice, the rate of reaction depends on the temperature of the mixture.'), null, 'an opening phrase is not a term');
});

test('pairs: "term: meaning" in its spellings; labels, times and links are refused', () => {
  const p = l => pairSplit(l);
  assert.equal(p('classical conditioning: learning by association (Pavlov)').term, 'classical conditioning');
  assert.equal(p('mitosis - cell division into two identical cells').def, 'cell division into two identical cells');
  assert.equal(p('mitosis = cell division').term, 'mitosis');
  assert.equal(p('mitosis -> cell division').term, 'mitosis');
  assert.equal(p('**Ribosomes** build proteins').term, 'Ribosomes');
  assert.equal(p('the kitchen\tla cocina').sep, 'tab');
  assert.equal(p('Midterm: Tues Oct 14, room 204!!'), null, 'a label');
  assert.equal(p('Prof. Alvarez 10:32'), null);
  assert.equal(p('Unidad 3 – La casa'), null, 'a title with a number');
  assert.equal(p('Slide: see the link below'), null);
  assert.equal(p('Source: https://example.edu/page'), null);
  assert.equal(p('This is a sentence: with a colon in it that goes on.'), null, 'a pronoun at the start');
});

test('abbreviations: Schwartz and Hearst', () => {
  assert.equal(matchesAbbreviation('DNA', 'deoxyribonucleic acid'), 'deoxyribonucleic acid');
  assert.equal(matchesAbbreviation('DNA', 'the cat'), null);
  assert.deepEqual(abbreviationsIn('Genetic material is made of DNA (deoxyribonucleic acid), a long molecule.'), [{ short: 'DNA', long: 'deoxyribonucleic acid' }]);
  assert.deepEqual(abbreviationsIn('The cell stores energy as adenosine triphosphate (ATP) for later.'), [{ short: 'ATP', long: 'adenosine triphosphate' }]);
  assert.deepEqual(abbreviationsIn('Look at the cat (DNA) for clues.'), []);
  const s = one('UCS (unconditioned stimulus)\nCS = conditioned stimulus', 'acronym');
  assert.deepEqual(s.map(x => [x.front, x.back, x.both]), [['UCS', 'unconditioned stimulus', true], ['CS', 'conditioned stimulus', true]]);
});

test('list: a heading or a line ending in ":" and 2 to 8 bullets make one Elements card', () => {
  const s = one('Stages of mitosis:\n- prophase\n- metaphase\n- anaphase\n- telophase', 'list');
  assert.equal(s.length, 1);
  assert.equal(s[0].front, 'Stages of mitosis');
  assert.deepEqual(parseElements(s[0].back).items, ['prophase', 'metaphase', 'anaphase', 'telophase']);
  assert.equal(one('Stages of mitosis:\n- prophase', 'list').length, 0, 'one bullet is not a list');
  assert.equal(one('Things:\n' + Array.from({ length: 9 }, (_, i) => `- item number ${i + 1}`).join('\n'), 'list').length, 0, 'nine bullets are too many');
  const slide = one('Slide 2: Primary colours\nred\nyellow\nblue', 'list');
  assert.equal(slide[0]?.front, 'Primary colours');
});

test('key term: a bold term that nothing defines becomes a cloze of its sentence', () => {
  const s = one('## Cells\n\nThe **ribosomes** build proteins from amino acids inside the cell cytoplasm.', 'term');
  assert.equal(s[0].cloze, 'The {{c1::ribosomes}} build proteins from amino acids inside the cell cytoplasm.');
  assert.equal(s[0].strong, true, 'bold counts for more');
});

test('fact: a year, a date or a number with a unit is blanked; citations, times and "Figure 3" are not', () => {
  const f = t => one(t, 'fact').map(s => s.cloze);
  assert.deepEqual(f('Archduke Franz Ferdinand was assassinated in Sarajevo on 28 June 1914 by a nationalist.'), ['Archduke Franz Ferdinand was assassinated in Sarajevo on {{c1::28 June 1914}} by a nationalist.']);
  assert.ok(f('The enzyme works best at 37 degrees and stops working when the pH changes sharply.')[0].includes('{{c1::37 degrees}}'));
  assert.deepEqual(f('Smith found that memory fades quickly after learning something new (Smith, 2004) in many studies.'), []);
  assert.deepEqual(f('The graph in Figure 3 shows how the cell membrane changes over time in many cells.'), []);
  assert.deepEqual(f('The lecture starts at 10:32 in the big room and covers the cell membrane in detail.'), []);
});

test('key sentence: a term that comes back is blanked wherever it appears in the sentence', () => {
  const text = 'The Schlieffen Plan aimed to defeat France quickly. Germany feared a war on two fronts. Critics say the Schlieffen Plan failed because Belgium resisted.\n\nThe campaign was planned for years. Many officers trusted the Schlieffen Plan completely, and the Schlieffen Plan shaped the whole war.';
  const s = one(text, 'sentence');
  assert.ok(s.some(x => /\{\{c1::Schlieffen Plan\}\}/.test(x.cloze)), JSON.stringify(s.map(x => x.cloze)));
  assert.ok(s.every(x => !x.strong), 'key sentences start unticked');
  const all = [];
  suggestCards({ text, debug: all });
  assert.ok(all.some(x => x.kind === 'sentence' && (x.cloze.match(/\{\{c1::Schlieffen Plan\}\}/g) || []).length === 2), 'every occurrence in the sentence is blanked');
});

test('sentences are not split after abbreviations, initials or inside numbers', () => {
  assert.deepEqual(splitSentences('Dr. Smith met J. S. Bach in the U.S. about 3.5 times, e.g. twice a year. Then they left.'), ['Dr. Smith met J. S. Bach in the U.S. about 3.5 times, e.g. twice a year.', 'Then they left.']);
  assert.deepEqual(splitSentences('It works. It really works! Does it? Yes.'), ['It works.', 'It really works!', 'Does it?', 'Yes.']);
  assert.deepEqual(splitSentences('No end punctuation here'), ['No end punctuation here']);
});

test('page furniture: repeated headers, lone page numbers and "--- slide 4 ---" go; wrapped lines are joined', () => {
  const names = ['Osmosis', 'Diffusion', 'Mitosis', 'Meiosis'];
  const page = n => `Page ${n}\nBIO 101 Lecture ${n}\n${names[n - 1]} is the movement of water across a partially permeable membrane from dilute to concentrated\nsolution through the ${['wall', 'pore', 'gate', 'door'][n - 1]}.\n${n}`;
  const r = suggestCards({ text: [1, 2, 3, 4].map(page).join('\n\n') });
  const all = JSON.stringify(r.suggestions);
  assert.ok(!/BIO 101|Lecture/i.test(all), 'the running header is gone');
  const d = r.suggestions.find(s => s.kind === 'definition' && s.front === 'Osmosis');
  assert.ok(d && d.back.includes('concentrated solution through the wall'), 'the wrapped line is joined: ' + JSON.stringify(d));
  assert.ok(r.suggestions.every(s => !/^\d+$/.test(s.front)));
});

// ---------- caps, the same answer, speed ----------

test('caps: at most 200 suggestions, 600,000 characters read, and what was cut is said', () => {
  const big = Array.from({ length: 80 }, (_, i) => `Term${'abcdefghij'[i % 10]}${i}x is the thing number ${i} in the long list of important things we study.`).join('\n');
  const r = suggestCards({ text: big });
  assert.ok(r.suggestions.length <= MAX_SUGGESTIONS);
  const cards = Array.from({ length: 4000 }, (_, i) => `Word${i}x is the name number ${i} given to a very important idea in the course.`).join('\n');
  const r2 = suggestCards({ text: cards });
  assert.equal(r2.suggestions.length, MAX_SUGGESTIONS);
  assert.ok(r2.stats.total > MAX_SUGGESTIONS && r2.stats.shown === MAX_SUGGESTIONS);
  const long = ('Osmosis is the movement of water across a partially permeable membrane. ').repeat(MAX_CHARS / 60);
  const r3 = suggestCards({ text: long });
  assert.equal(r3.stats.cut, true);
  assert.equal(suggestCards({ text: TEXT.biology }).stats.cut, false);
});

test('the same text always gives the same suggestions', () => {
  for (const k of Object.keys(TEXT)) assert.deepEqual(suggestCards({ text: TEXT[k] }), RESULT[k]);
});

test('terms the student already has (the glossary, the deck) lift a key sentence', () => {
  const text = 'Mitochondria produce energy for the cell. Muscle cells contain many mitochondria and the cristae inside them.';
  const without = suggestCards({ text }).suggestions.filter(s => s.kind === 'sentence');
  const withKnown = suggestCards({ text, known: ['cristae'] }).suggestions.filter(s => s.kind === 'sentence');
  assert.ok(withKnown.some(s => s.cloze.includes('{{c1::cristae}}')), JSON.stringify(withKnown.map(s => s.cloze)));
  assert.ok(withKnown.length >= without.length);
});

test('speed: about 60,000 words in under 4 seconds, in small steps that never block for long', () => {
  const parts = [TEXT.biology, TEXT.history, TEXT.messy];
  const pieces = [];
  let n = 0, w = 0;
  while (w < 60000) {
    const t = parts[n % 3].replace(/\b(19|20)\d\d\b/g, y => String(+y + n)).replace(/\bTerm\b/g, 'Term' + n);
    pieces.push(`Page ${n + 1}\n${t}`);
    w += wordCount(t); n++;
  }
  const text = pieces.join('\n\n');
  const it = suggestSteps({ text });
  let yields = 0, longest = 0, last = performance.now();
  const t0 = last;
  let r;
  for (;;) {
    r = it.next();
    const now = performance.now();
    longest = Math.max(longest, now - last); last = now;
    if (r.done) break;
    yields++;
  }
  const total = performance.now() - t0;
  console.log(`  60k words (${w} counted): ${total.toFixed(0)} ms, ${yields} yields, longest step ${longest.toFixed(0)} ms, ${r.value.suggestions.length} suggestions`);
  assert.ok(total < 4000, `${total} ms`);
  assert.ok(yields >= 20, `${yields} yields`);
  assert.ok(longest < 100, `longest step ${longest} ms`);
  assert.ok(r.value.suggestions.length <= MAX_SUGGESTIONS && r.value.suggestions.length > 0);
});

// ---------- does the text read like notes? ----------

test('looksLikeProse: notes and articles yes; cards, a Quizlet export and Q:/A: text no', () => {
  const prose = t => looksLikeProse(t, parseText(t));
  assert.equal(prose(TEXT.biology), true);
  assert.equal(prose(TEXT.messy), true);
  assert.equal(prose(TEXT.vocab), false);
  assert.equal(prose('mitosis\tcell division\nmeiosis\tdivision into four gametes\nosmosis\tmovement of water'), false);
  assert.equal(prose('Q: What is mitosis?\nA: Cell division.\nQ: What is meiosis?\nA: Division into four gametes.'), false);
  assert.equal(prose('Mitosis - cell division\nMeiosis - division into four gametes'), false);
  assert.equal(prose('A short note.'), false, 'too short');
});
