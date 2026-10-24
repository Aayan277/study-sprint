// Suggesting flashcards from a reading: notes, a textbook page, the text of a PDF or slides. It finds definitions ("Osmosis is the
// movement of…"), pairs ("term: meaning"), word pairs, abbreviations, lists, key terms, facts with numbers or dates and key sentences,
// and gives each a score. Everything happens on this device, with rules and counting words: there is no AI in it, so a suggestion
// can be wrong, and the screen says so.
//
// Pure functions only (no page, no database), so they run in a worker (js/keywords-worker.js) and in node --test.
// Tested by tests/reading-cards.test.js, with the fixtures in tests/fixtures/reading/.
//
// The input is plain text with optional light Markdown: "## Heading" (or "# Heading") marks a heading, "**bold**" a key term, and lines
// like "Page 3" or "Slide 2: Title" (what doc-import.js writes) are page markers: they say where a card came from and never become cards.
//
//   suggestSteps({ text, known })   a generator: yields { phase, progress } now and then and returns { suggestions, stats }
//   suggestCards(input)             the same, all at once (tests)
//   suggestion: { kind, type: 'basic' | 'cloze', front, back, cloze?, source, where, score, strong, both, key, anchor }

import { words, keyOf, stem, STOPWORDS, FILLER, newCounts, addPhrases, termWeights, groupNear, candidatePhrases, isJunkTerm } from './keywords.js';
import { normalize, stripMarker, dupKey } from './import.js';
import { clozeCard, clozeBlanks } from './cloze.js';
import { joinElements } from './steps.js';

export const MAX_CHARS = 600_000;
export const MAX_SUGGESTIONS = 200;
const STRONG = 0.75;

export const KIND_LABEL = { definition: 'Definition', vocab: 'Word pair', acronym: 'Abbreviation', list: 'List', term: 'Key term', fact: 'Number or date', sentence: 'Key sentence' };
export const KIND_ORDER = ['definition', 'vocab', 'acronym', 'list', 'term', 'fact', 'sentence'];

// ---------- small tools ----------

const PRONOUNS = new Set('it this that these those they there he she we you i one such which'.split(' '));
const STARTERS = new Set('if when because although while since whereas as after before unless once though'.split(' '));
const INTRO = new Set(`in on at by for as after before during with from to if when while although because since once within under over through between
among without until about against towards toward upon`.split(/\s+/));
const LABELS = new Set(`note notes example examples e.g answer q a page slide figure fig table date time week lecture lec source reading homework
hw todo nb ref midterm final exam quiz test due deadline room office hours announcement reminder remember tip hint warning summary conclusion
agenda outline overview objective objectives aim goal question takeaway takeaways recap`.split(' '));
// One word that alone says nothing ("Treatment: rest"): the heading of a note, not a term.
const VAGUE = new Set(`treatment cause causes effect effects symptoms result results solution problem problems advantages disadvantages pros cons features
types type definition meaning description reason reasons use uses method methods steps process idea ideas point points`.split(/\s+/));
// Plain words that are rarely the thing a card is about.
const GENERIC = new Set(`experience system change thing part form number level kind time case area group factor role order fact way people person
place amount rate become include require produce provide contain involve develop increase decrease remain follow allow release happen
continue represent suggest depend appear present consider describe determine different important possible several another`.split(/\s+/));
const WH = new Set('why how what where when who whom whose whether'.split(' '));
const SUBJECT_LEAD = new Set('the a an this these those its their our your his her each every some many most all both any'.split(' '));
// The label of a line in notes on a topic ("MOA: …", "SE: …", "overdose -> …"): it only means something under the heading it is in.
const LABELISH = new Set(`moa se ci ae adr dx tx rx hx sx ix px uses use dose doses overdose indications indication contraindications contraindication
mechanism effects toxicity antidote onset duration examples cause causes treatment symptoms signs features types function functions structure location
side-effects interactions monitoring`.split(/\s+/));
const VERB_START = /^(?:inhibits?|blocks?|increases?|decreases?|causes?|lowers?|raises?|reduces?|activates?|stimulates?|binds?|produces?|prevents?|treats?|used|acts?)\s/i;
const labelish = term => VERB_START.test(term + ' ') || labelishWord(term);
const labelishWord = term => { const t = term.toLowerCase().replace(/[^\p{L}\s-]/gu, '').replace(/\s+/g, ' ').trim(); return LABELISH.has(t) || LABELISH.has(t.replace(/ /g, '-')) || t === 'side effects' || t === 'adverse effects' || t === 'half life'; };
const ABBREVIATIONS = new Set(`e.g i.e etc vs dr mr mrs ms prof fig no approx ca c st u.s u.k a.m p.m cf al inc ltd jr sr mt ch pp p vol ed est`.split(' '));
const EVENT_VERBS = /\b(?:signed|began|ended|founded|discovered|invented|published|died|born|declared|assassinated|launched|formed|won|lost|invaded|abdicated|arrived|built|established|introduced)\b/i;
const CUES = /\b(?:because|causes?|leads? to|results? in|therefore|responsible for|consists? of|known as|main|primary|key)\b/i;

const URL_RE = /https?:\/\/\S+|\bwww\.\S+/i;
const EMAIL_RE = /\S+@\S+\.\S+/;
const TIME_RE = /\b\d{1,2}:\d{2}\b/;
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const DAYMONTH_RE = new RegExp(`\\b(?:${MONTHS}|${DAYS})\\b`, 'i');
const ADMIN_RE = /\b(?:todo|midterm|office hours?|office hrs|deadline|homework|room \d+)\b|^(?:due|reminder|announcements?|see)\b|^next (?:time|week|class|lecture)\b|^(?:week|lecture|lec|module)\.? ?\d+\b/i;
export const NOT_TERMS = new RegExp(`^(?:${MONTH_NAMES}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$`, 'i');

const wc = s => (String(s).match(/\S+/g) || []).length;
const alnumCount = s => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;
const letterCount = s => (String(s).match(/\p{L}/gu) || []).length;
const hasAdminBits = s => URL_RE.test(s) || EMAIL_RE.test(s) || TIME_RE.test(s);
const isAdminLine = s => hasAdminBits(s) || ADMIN_RE.test(s);
const adminDate = s => DAYMONTH_RE.test(s) && /\d/.test(s);
const cap = s => (s && s === s.toLowerCase() ? s[0].toUpperCase() + s.slice(1) : s);
const clean = s => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const chop = s => s.replace(/[\s.]+$/, '').trim();
const firstWord = s => (s.split(/\s+/)[0] || '').replace(/[^\p{L}']/gu, '').toLowerCase();

// Cut a paragraph into sentences at ". ", "! " and "? " when a capital letter or a number follows, but not after abbreviations
// (e.g. Dr. etc.), initials (J. S. Bach) or inside decimals (3.5).
export function splitSentences(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const out = [];
  let from = 0;
  const re = /([.!?]["”')\]]?)(\s+)(?=["“(‘']?[\p{Lu}\p{N}])/gu;
  for (const m of t.matchAll(re)) {
    const end = m.index + m[1].length;
    if (m[1][0] === '.') {
      const last = (t.slice(from, m.index + 1).match(/(\S+)$/) || [, ''])[1].replace(/^[("'“]+/, '');
      const bare = last.replace(/\.$/, '');
      if (ABBREVIATIONS.has(bare.toLowerCase()) || /^\p{Lu}$/u.test(bare) || /^(?:\p{Lu}\.){2,}$/u.test(last)) continue;
    }
    out.push(t.slice(from, end).trim());
    from = end + m[2].length;
  }
  const rest = t.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

// ---------- pairs: "term: meaning" ----------

const SEPS = ['\t', ' – ', ' — ', ' - ', ' = ', ' -> ', ' → ', ': '];
function termOk(term, { loose = false } = {}) {
  term = term.trim();
  if (!term || term.length > 60 || !/^[\p{L}]/u.test(term)) return false;
  const ws = term.split(/\s+/);
  if (ws.length > 6) return false;
  const first = firstWord(term);
  if (PRONOUNS.has(first) || STARTERS.has(first)) return false;
  if (/[?!;]$/.test(term) || (!loose && /,/.test(term))) return false;
  if (/^[\p{L}.]+ \d+[a-z]?$/iu.test(term)) return false;                       // "Unidad 3", "Lec 5", "Chapter 4"
  const flat = term.toLowerCase().replace(/[^\p{L}\s.']/gu, '').trim();
  if (LABELS.has(flat) || LABELS.has(first)) return false;
  if (hasAdminBits(term) || /[$+"“”]|\(\s*\d{4}\s*\)/.test(term)) return false;
  if (ws.length === 1 && VAGUE.has(flat) && !loose) return false;
  if (ws.length === 2 && /^(?:key|main|major|core|big|top)$/.test(first) && (VAGUE.has(ws[1].toLowerCase()) || LABELS.has(ws[1].toLowerCase()))) return false;      // "Key takeaway", "Main idea"
  return true;
}

// "TERM: meaning" in its different spellings → { term, def, sep } or null.
export function pairSplit(line) {
  line = String(line).trim();
  if (hasAdminBits(line) && !/^\*\*/.test(line)) return null;
  let term = '', def = '', sep = '';
  const bold = line.match(/^\*\*(.+?)\*\*\s*(?:[:\-–—=]\s*)?(.*)$/);
  if (bold && bold[2].trim()) { term = bold[1].replace(/[:\s]+$/, ''); def = bold[2]; sep = '**'; }
  else {
    const plain = line.replace(/\*\*/g, '');
    let best = -1;
    for (const s of SEPS) {
      const at = plain.indexOf(s);
      if (at > 0 && (best < 0 || at < best)) { best = at; sep = s; }
    }
    if (best < 0) return null;
    term = plain.slice(0, best).trim();
    def = plain.slice(best + sep.length).trim();
  }
  def = def.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();
  const label = labelish(term);
  if (!termOk(term, { loose: label }) || wc(def) < 1 || adminDate(def) || hasAdminBits(def) || /^[\p{L}.]+ \d+\s*[:–—|-]/u.test(def)) return null;        // (a meaning that starts "Unité 5 :" is the rest of a title)
  return { term: term.replace(/\s+/g, ' '), def, sep: sep === '\t' ? 'tab' : sep.trim(), one: wc(def) < 2, label };
}

// "operant cond." in a section called "Operant conditioning": the heading, written out. → the heading or null
function fullHeading(term, heading) {
  if (!heading || !term.includes('.')) return null;
  const a = term.toLowerCase().split(/\s+/), b = heading.toLowerCase().split(/\s+/);
  if (a.length !== b.length) return null;
  const same = a.every((x, i) => { const t = x.replace(/\.$/, ''); return b[i] === t || (x.endsWith('.') && t.length >= 2 && b[i].startsWith(t)); });
  return same ? heading : null;
}

// ---------- abbreviations (Schwartz and Hearst) ----------

const LITTLE = new Set('of the and for in on to a an at by with'.split(' '));
const ACRONYM = /^[\p{Lu}][\p{L}\p{N}&]{1,7}$/u;
const isAcronym = s => ACRONYM.test(s) && (s.match(/\p{Lu}/gu) || []).length >= 2;
// Do the letters of `short` appear, in order, in `long`, with the first one starting a word? → the part of `long` that matches, or null.
export function matchesAbbreviation(short, long) {
  const s = short.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''), l = long.toLowerCase();
  if (s.length < 2) return null;
  let si = s.length - 1, li = l.length - 1;
  while (si >= 0) {
    const c = s[si];
    while (li >= 0 && (l[li] !== c || (si === 0 && ((li > 0 && /[\p{L}\p{N}]/u.test(l[li - 1])) || LITTLE.has((l.slice(li).match(/^[\p{L}]+/u) || [''])[0]))))) li--;
    if (li < 0) return null;
    si--; li--;
  }
  return long.slice(li + 1);
}
// The last words of `before` that spell `short`: LONG (SHORT).
function longBefore(short, before) {
  const ws = before.trim().split(/\s+/).filter(Boolean);
  const max = Math.min(short.length + 5, short.length * 2);
  const hit = matchesAbbreviation(short, ws.slice(-max).join(' '));
  if (!hit) return null;
  const n = wc(hit);
  return n <= max && n >= 2 ? hit.trim() : null;
}
// Abbreviations in a sentence: "adenosine triphosphate (ATP)", "UCS (unconditioned stimulus)". → [{ short, long }]
export function abbreviationsIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(/\(([^()]{2,70})\)/g)) {
    const inside = m[1].trim(), before = sentence.slice(0, m.index);
    if (isAcronym(inside)) {
      const long = longBefore(inside, before);
      if (long) out.push({ short: inside, long: long.replace(/^[,;:\s]+/, '') });
      continue;
    }
    const prev = (before.match(/(\S+)\s*$/) || [, ''])[1].replace(/[^\p{L}\p{N}&]/gu, '');
    if (isAcronym(prev) && wc(inside) >= 2 && wc(inside) <= Math.min(prev.length + 5, prev.length * 2) && matchesAbbreviation(prev, inside)) out.push({ short: prev, long: inside });
  }
  return out;
}
// "CS = conditioned stimulus" or "UCR = unconditioned response, the automatic reaction…" (only the first clause is the long form).
function abbreviationPair(term, def) {
  if (!isAcronym(term)) return null;
  const clause = def.split(/[,;(]| - | – /)[0].trim();
  const n = wc(clause);
  if (n < 2 || n > Math.min(term.length + 5, term.length * 2)) return null;
  return matchesAbbreviation(term, clause) ? { short: term, long: clause } : null;
}

// ---------- definitions in sentences ----------

const DEF_IS = /\s(?:(?:is|are)\s+(?:defined as\s+)?(?=(?:an?|the|one of the|anything|something|someone|any)\s)|(?:refers to|means(?: that)?|meant(?: that)?|is defined as|describes|denotes|measures)\s+|(?:is|are)\s+(?=\p{L}+(?:\s\p{L}+)?\s+(?:that|which|who|for which|in which|whereby)\s))/giu;
// A sentence that defines a term: "Osmosis is the movement of…", "X refers to…", "The process… is called photosynthesis."
export function definitionIn(sentence) {
  const s = chop(sentence.replace(/^["“(]+/, ''));
  if (!s || /[?]$/.test(sentence.trim())) return null;
  const rev = s.match(/^(.{15,}?),? (?:is|are) (?:called|known as|termed) ([^,;]+)$/i);
  if (rev && wc(rev[2]) <= 4 && termOk(rev[2]) && !hasAdminBits(s) && !PRONOUNS.has(firstWord(rev[1]))) return { term: rev[2].trim(), back: rev[1].trim(), base: 0.85 };
  for (const m of s.matchAll(DEF_IS)) {
    const term = s.slice(0, m.index).replace(/^(?:an?|the)\s+/i, '').trim();
    const pred = s.slice(m.index + m[0].length).trim();
    if (!term || /[,;()]/.test(term) || !termOk(term) || wc(pred) < 3) continue;
    return { term, back: pred, base: 0.8 };
  }
  return null;
}

// "…is called the focus, or hypocentre, and the point above it is the epicentre." / "…sinks beneath the other in a process called subduction."
// A term named in the middle of a sentence. → [{ term, back, base }]
const CALLED = /\b(?:(?:is|are) called|(?:an?|the) (?:[\p{L}-]+ )?called)\s+(?:(?:the|an?)\s+)?([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/gu;
export function calledIn(sentence) {
  const s = chop(sentence), out = [];
  for (const m of s.matchAll(CALLED)) {
    const ws = m[1].split(/\s+/);
    if (ws.length > 1 && (STOPWORDS.has(ws[1].toLowerCase()) || /^\p{Ll}/u.test(ws[1]) && ws[1].length < 4)) ws.pop();
    if (ws.length > 1 && STOPWORDS.has(ws[ws.length - 1].toLowerCase())) ws.pop();
    const term = ws.join(' ');
    if (!termOk(term) || isJunkTerm(term) || GENERIC.has(keyOf(words(term)))) continue;
    // what it names: the clause before, from the last ";" on, without the "in a process" that leads to the name
    let back = s.slice(0, m.index).split(/;\s+/).pop().replace(/\s+(?:in|by|through|as)$/i, '').replace(/^\s*(?:and|while|whereas)\s+/i, '').trim();
    if (/\b(?:in|by|through)\s+(?:an?|the)\s+(?:[\p{L}-]+\s+)?$/iu.test(back + ' ')) back = back.replace(/\s+(?:in|by|through)\s+(?:an?|the)(?:\s+[\p{L}-]+)?$/iu, '');
    if (wc(back) < 4 || wc(back) > 40 || PRONOUNS.has(firstWord(back))) continue;
    const alias = s.slice(m.index + m[0].length).match(/^,\s+or\s+([\p{L}][\p{L}'-]*)\b/u);
    out.push({ term: alias ? `${term} (${alias[1]})` : term, back, base: 0.72 });
    // "…, and the point on the surface directly above it is the epicentre": the next name in the same sentence
    const rest = s.slice(m.index + m[0].length + (alias ? alias[0].length : 0));
    const next = rest.match(/^,?\s+and\s+(the\s.{15,}?)\s+(?:is|are)\s+the\s+([\p{Ll}][\p{Ll}-]{4,})$/u);
    if (next && !GENERIC.has(next[2]) && wc(next[1]) >= 5) out.push({ term: next[2], back: next[1], base: 0.72 });
  }
  return out;
}

// A term followed by its explanation: "…contain chlorophyll, the green pigment that absorbs light", "…a phospholipid bilayer, which means
// two layers of lipid molecules". → { term, back, base } or null
const APPOSITIVE = /,\s+(?:which\s+(?:is|are|means)\s+|in which\s+|whereby\s+|(?=(?:the|an?)\s))/gi;
export function appositiveIn(sentence, toks) {
  const s = chop(sentence);
  for (const m of s.matchAll(APPOSITIVE)) {
    const left = toks.filter(t => t.end <= m.index);
    if (!left.length || s.slice(left[left.length - 1].end, m.index).trim()) continue;
    const run = [];
    for (let i = left.length - 1; i >= 0 && run.length < 4; i--) {
      const t = left[i];
      const stop = STOPWORDS.has(t.w) || FILLER.has(t.w);
      if (stop && !(t.w === 'of' && run.length && i > 0)) break;
      if (/^\d/.test(t.w)) break;
      run.unshift(t);
      if (t.brk) break;
    }
    // (a capital letter at the start of a sentence, or a verb, is not part of the term: "Chloroplasts contain chlorophyll")
    while (run.length > 1 && (run[0].w === 'of' || GENERIC.has(stem(run[0].w)) || (run[0].first && !/^\p{Lu}/u.test(run[1].raw)))) run.shift();
    if (!run.length) continue;
    const before = left.slice(0, left.length - run.length);
    if (!/which|whereby/.test(m[0]) && before.length <= 3 && before.some(t => INTRO.has(t.w))) continue;
    const lead = firstWord(s);
    if (!/which|whereby/.test(m[0]) && (STARTERS.has(lead) || INTRO.has(lead) || lead === 'according') && !s.slice(0, m.index).includes(',')) continue;             // "In practice, the rate…": not a term
    const term = s.slice(run[0].start, run[run.length - 1].end);
    const key = keyOf(run);
    if (!termOk(term) || isJunkTerm(term) || NOT_TERMS.test(term) || GENERIC.has(key) || VAGUE.has(key)) continue;
    if (!/^\p{Lu}/u.test(run[run.length - 1].raw) && /(?:ed|ing)$/.test(run[run.length - 1].w)) continue;          // "longer than expected, the…"
    let back = s.slice(m.index + m[0].length);
    const comma = back.indexOf(', ');
    if (comma > 0 && wc(back.slice(0, comma)) >= 3) back = back.slice(0, comma);
    if (wc(back) < 3 || wc(back) > 40 || PRONOUNS.has(firstWord(back)) || WH.has(firstWord(back))) continue;
    return { term, back: back.trim(), base: 0.72 };
  }
  return null;
}

// ---------- facts ----------

const DATE_RE = new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)? (?:${MONTH_NAMES}) \\d{4}|(?:${MONTH_NAMES}) \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|(?:${MONTH_NAMES}) \\d{4})\\b`);
const RANGE_RE = /\b(?:1[0-9]{3}|20[0-2]\d)\s?[–-]\s?(?:1[0-9]{3}|20[0-2]\d|\d{2})\b/;
const YEAR_RE = /\b(?:1[0-9]{3}|20[0-2]\d)\b/;
const UNIT_RE = /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|per cent|million|billion|thousand|trillion|°C|°F|degrees|km|kg|cm|mm|ml|mg|g|m|s|seconds?|minutes?|hours?|days?|weeks?|months?|years?|metres?|meters?|litres?|liters?|miles?|tonnes?|hertz|Hz|kJ|J|N|V|mol)\b/;
const COUNT_RE = /\b\d[\d,]*(?= \p{Ll}{4,}s\b)/u;
const CITATION = /\(\s*(?:[\p{Lu}][\p{L}.'’ -]+(?:,| and | & | et al\.?)?\s*)+,?\s*(?:1[0-9]{3}|20[0-2]\d)[a-z]?\s*\)|\p{Lu}\p{L}+ \(\s*(?:1[0-9]{3}|20[0-2]\d)\s*\)/u;
const LOCATOR = /\b(?:Figure|Table|Fig\.|p\.|pp\.|Chapter|Week|Slide|Page|Lecture|Lec\.?|Ch\.?|Section|Unit)\s*\d+/gi;

// A sentence with a number or a date to hide. → { cloze, base } or null
function factIn(sentence, phrases, weights, counts) {
  if (CITATION.test(sentence) || TIME_RE.test(sentence) || /\b\d{3}[-\s]\d{3,4}\b/.test(sentence)) return null;
  const masked = sentence.replace(LOCATOR, m => ' '.repeat(m.length));
  const countHit = masked.match(COUNT_RE);
  const m = masked.match(DATE_RE) || masked.match(RANGE_RE) || masked.match(YEAR_RE) || masked.match(UNIT_RE) || countHit;
  if (!m) return null;
  if (m === countHit && !(Number(m[0].replace(/,/g, '')) >= 10)) return null;             // "2 layers": a small count is not worth hiding
  let at = m.index, span = m[0], end = at + span.length;
  // a range is hidden whole, not by one end: "2 to {{c1::10}}"
  const lead = masked.slice(0, at).match(/\d[\d,.]*\s*(?:to|-|–|and|or)\s+$/);
  if (lead) { at -= lead[0].length; span = sentence.slice(at, end); }
  const tail = masked.slice(end).match(/^\s*(?:to|-|–)\s*\d[\d,.]*/);
  if (tail && !lead) { span = sentence.slice(at, end + tail[0].length); end += tail[0].length; }
  // some other content has to be left on the card
  const rest = phrases.filter(p => (p.end <= at || p.start >= end) && !isJunkTerm(p.text));
  if (!rest.length) return null;
  if (!rest.some(p => (weights.get(p.key) || 0) >= 0.2 || p.caps || p.n >= 2 || (counts.get(p.key)?.tf || 0) >= 2)) return null;
  const cloze = sentence.slice(0, at) + '{{c1::' + span + '}}' + sentence.slice(end);
  return { cloze, base: 0.6 + (EVENT_VERBS.test(sentence) ? 0.1 : 0) };
}

// ---------- key sentences ----------

// Hide every occurrence of a phrase in a sentence: "The {{c1::Schlieffen Plan}} aimed…". → the cloze text or null
const capBefore = t => { const m = t.match(/(\p{Lu}[\p{L}]*)(?: of)? $/u); return !!m && !STOPWORDS.has(m[1].toLowerCase()); };
function clozeOf(sentence, key, toks) {
  const n = key.split(' ').length;
  const spans = [];
  for (let i = 0; i + n <= toks.length; i++) {
    const slice = toks.slice(i, i + n);
    if (slice.slice(1).some(t => t.brk)) continue;
    if (keyOf(slice) !== key) continue;
    const a = slice[0].start, b = slice[n - 1].end, rest = sentence.slice(b);
    if (/[\p{L}\p{N}\-–]/u.test(sentence[a - 1] || ' ') || /^[\-–]\p{L}/u.test(rest)) return null;
    if (/^\p{Lu}/u.test(sentence.slice(a)) && (/^ (?:of )?\p{Lu}\p{Ll}/u.test(rest) || capBefore(sentence.slice(Math.max(0, a - 30), a)))) return null;
    spans.push([a, b]);
  }
  if (!spans.length) return null;
  let out = '', at = 0;
  for (const [a, b] of spans) { if (a < at) continue; out += sentence.slice(at, a) + '{{c1::' + sentence.slice(a, b) + '}}'; at = b; }
  return out + sentence.slice(at);
}

// A plain word that reads as a verb where it stands: after "to", a modal or "not", or before "the", "that", "how"… ("reduces the", "measures how").
const BEFORE_VERB = new Set('to can could will would may might must should shall not also then often usually never always'.split(' '));
const AFTER_VERB = new Set('the a an that how whether to'.split(' '));
function looksLikeVerb(toks, p, subjects) {
  const i = toks.findIndex(t => t.start === p.start);
  if (i < 0) return false;
  if (i > 0 && BEFORE_VERB.has(toks[i - 1].w)) return true;
  if (i + 1 < toks.length && AFTER_VERB.has(toks[i + 1].w) && !toks[i + 1].brk) return true;
  // a noun usually comes after a little word ("the substances", "of ribosomes") or is what the text is about; a word right after another
  // plain word ("price increase reduces total") is more often a verb
  const prev = toks[i - 1];
  return !!prev && !prev.brk && !STOPWORDS.has(prev.w) && !subjects.has(p.key) && !/^\p{Lu}/u.test(prev.raw) && p.text.endsWith('s');
}

// A sentence worth a cloze: it says something, and has a key term to hide. → up to 3 choices [{ cloze, base, key, text }], best first.
// The key term is the phrase that best stands out in the text: counted words that come back (a few times, not everywhere), proper nouns,
// longer words and phrases, and terms the student's glossary or deck already has. A short plain word ("keep", "point") never is.
function sentenceCards(sentence, toks, phrases, { weights, counts, knownKeys, subjects }) {
  if (PRONOUNS.has(firstWord(sentence))) return [];
  if (/\b(?:I|I'm|I'll)\b/.test(sentence) || /\bwe will\b|\btoday\b|\bin this lecture\b/i.test(sentence)) return [];
  if (!/^["“(]?[\p{Lu}\p{N}]/u.test(sentence)) return [];
  if (isAdminLine(sentence) || CITATION.test(sentence) || new RegExp(LOCATOR.source, 'i').test(sentence)) return [];
  const cands = [];
  for (const p of phrases) {
    const e = counts.get(p.key), isKnown = knownKeys.has(p.key), tf = e?.tf || 0, df = e?.df || 0;
    if (wc(p.text) > 6 || NOT_TERMS.test(p.text) || isJunkTerm(p.text)) continue;
    if (p.start === toks[0].start && p.n === 1 && !isKnown) continue;                 // (a capital letter at the start of a sentence says nothing)
    if (p.n === 1) {
      if (GENERIC.has(p.key) || (!p.caps && !isKnown && looksLikeVerb(toks, p, subjects))) continue;
      if (!(p.caps || isKnown || /^\p{Lu}{2,}$/u.test(p.text) || (df >= 2 && p.text.length >= 7))) continue;
    } else if (!(p.caps || isKnown)) {
      const w = p.key.split(' ');
      if (p.n === 2 && /s$/.test(w[0]) && w[0].length > 3 && !/(?:ss|us|is|ics)$/.test(w[0]) && !/s$/.test(w[1])) continue;          // "plates move": a noun and its verb
      const last = toks[toks.findIndex(t => t.start === p.start) + p.n - 1];
      if (last && looksLikeVerb(toks, { start: last.start, key: stem(last.w), text: last.raw }, subjects) && !/s$/.test(last.w)) continue;
      // two words that really belong together: the rarer one is mostly found inside the phrase ("stem cells", not "cell needs")
      const parts = p.key.split(' ');
      if (df < 2 || tf / Math.min(...parts.filter(x => x !== 'of').map(x => counts.get(x)?.tf || 1)) < 0.6) continue;
    }
    let q = weights.get(p.key) || 0;
    if (isKnown) q += 0.3;
    if (p.caps && (p.n > 1 || df <= 3)) q += 0.2;                                    // (a name that is on every page, like a country in a history text, is the subject, not a term)
    if (df >= 2 && subjects.has(p.key)) q += 0.25;                                    // the text keeps coming back to it as the thing it is about
    q += (p.caps ? 0.25 : 0.1) * (p.n - 1);                                           // a whole name or a two-word term says more than a single word
    cands.push({ p, q });
  }
  cands.sort((a, b) => b.q - a.q || b.p.n - a.p.n || a.p.start - b.p.start);
  const out = [], taken = [];
  for (let best of cands) {
    // the whole name rather than a part of it: "Triple Entente", not "Triple"
    const longer = cands.filter(c => c.p.n > best.p.n && c.p.caps && c.p.start <= best.p.start && c.p.end >= best.p.end);
    if (longer.length) best = longer.sort((a, b) => b.p.n - a.p.n)[0];
    if (taken.some(t => t.start < best.p.end && best.p.start < t.end)) continue;
    const cloze = clozeOf(sentence, best.p.key, toks);
    if (!cloze) continue;
    taken.push(best.p);
    out.push({ cloze, base: 0.4 + 0.3 * Math.min(1.5, best.q) + (CUES.test(sentence) ? 0.1 : 0), key: best.p.key, text: best.p.text, caps: best.p.caps, n: best.p.n });
    if (out.length === 3) break;
  }
  return out;
}

// ---------- the generator ----------

export function* suggestSteps({ text = '', known = [], debug = null } = {}) {
  const stats = { words: 0, byKind: {}, total: 0, shown: 0, cut: false };
  yield { phase: 'Reading', progress: 0 };

  // ----- 0. prepare -----
  let src = normalize(text);
  if (src.length > MAX_CHARS) {
    const at = src.lastIndexOf('\n', MAX_CHARS);
    src = src.slice(0, at > MAX_CHARS * 0.8 ? at : MAX_CHARS);
    stats.cut = true;
  }
  stats.words = wc(src);
  const items = [];                     // { t, bullet, h, gap, where, slide }
  const pages = [];                     // the lines of each page, for finding running headers and footers
  let pageKeys = new Set(), where = '', gap = false;
  const boiler = t => t.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
  let tick = 0;
  for (const raw of src.split('\n')) {
    if (++tick % 2000 === 0) yield { phase: 'Reading', progress: 0.02 };
    const t = raw.trim();
    if (!t) { gap = true; continue; }
    const mark = t.match(/^(Page|Slide)\s+(\d+)\s*(?::\s*(.*))?$/);
    if (mark) {
      pages.push(pageKeys); pageKeys = new Set();
      where = `${mark[1]} ${mark[2]}`;
      items.push({ t: '', marker: true, where, gap: true });
      if (mark[3] && mark[3].trim()) items.push({ t: mark[3].trim(), h: true, slide: mark[1] === 'Slide', where, gap: false });
      gap = false;
      continue;
    }
    if (/^[-–—=_*\s]*(?:slide|page)\s*\d+[-–—=_*\s]*$/i.test(t) || /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t) || /^page \d+ of \d+$/i.test(t)) continue;
    pageKeys.add(boiler(t));
    const md = t.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (md) { if (md[1]) items.push({ t: md[1], h: true, where, gap }); gap = false; continue; }
    const stripped = stripMarker(t);
    items.push({ t: stripped, bullet: stripped !== t, gap, where });
    gap = false;
  }
  pages.push(pageKeys);
  // a running header or footer: the same line (digits aside) on at least 3 pages and 30% of them
  const seenOn = new Map();
  for (const keys of pages) for (const k of keys) seenOn.set(k, (seenOn.get(k) || 0) + 1);
  const nPages = pages.filter(p => p.size).length;
  const repeated = new Set([...seenOn].filter(([k, n]) => n >= 3 && n >= 0.3 * nPages && k.length > 3).map(([k]) => k));
  // (admin lines, a time, a link, an e-mail address, "midterm…", "TODO…", are not study material)
  const lines = items.filter(it => it.marker || it.h || (!repeated.has(boiler(it.t)) && (wc(it.t) > 15 || !isAdminLine(it.t))));
  // wrapped lines (a PDF breaks lines at the page width): join a line that stops mid-sentence with the next one that starts in lower case
  const lens = lines.filter(x => !x.h && !x.marker).map(x => x.t.length).sort((a, b) => a - b), wrapAt = 0.8 * (lens[Math.floor(lens.length * 0.9)] || 0);
  const joined = [];
  for (const it of lines) {
    if (++tick % 2000 === 0) yield { phase: 'Reading', progress: 0.04 };
    const prev = joined[joined.length - 1];
    if (prev && !prev.marker && !prev.h && !prev.bullet && !it.marker && !it.h && !it.bullet && !it.gap && wc(prev.t) >= 7 && prev.t.length >= wrapAt && !SEPS.some(x => prev.t.includes(x)) && !/[.!?:;]$/.test(prev.t) &&
      /^\p{Ll}/u.test(it.t) && prev.t.length < 3000 && !pairSplit(prev.t) && !pairSplit(it.t)) {
      prev.t += ' ' + it.t;
      continue;
    }
    joined.push({ ...it });
  }
  yield { phase: 'Reading', progress: 0.05 };

  // ----- 1. structure -----
  const isPairish = t => SEPS.some(s => t.includes(s)) || /^\*\*/.test(t);
  const sections = [];
  let sec = { heading: '', where: '', lines: [], slide: false, explicit: false };
  const flush = () => { if (sec.lines.length || sec.heading) sections.push(sec); };
  for (let i = 0; i < joined.length; i++) {
    if (++tick % 2000 === 0) yield { phase: 'Reading', progress: 0.08 };
    const it = joined[i];
    if (it.marker) { sec.where ||= it.where; continue; }
    let head = !!it.h;
    if (!head && !it.bullet && !(sec.heading && !sec.lines.length && !it.gap)) {          // (the line right under a heading is its text, not another heading)
      const ht = it.t.replace(/\s*\([^()]*(?:\be\.g\.|\bsuch as\b|,)[^()]*\)\s*$/, '');          // "Beta blockers (e.g. propranolol, atenolol)" is the heading "Beta blockers"
      const n = wc(ht), nx = joined[i + 1] && !joined[i + 1].marker ? joined[i + 1] : null;
      if (/^[\p{Lu}\p{N}\s&'’-]+$/u.test(it.t) && n >= 2 && n <= 8 && /\p{Lu}{2}/u.test(it.t) && !isAcronym(it.t)) head = true;
      else if (n <= 8 && !/[.,;:!?]$/.test(ht) && !/[()$]/.test(ht) && !isPairish(ht) && !isAdminLine(ht) && /^\p{L}/u.test(ht) &&
        nx && !nx.h && (nx.bullet || (wc(nx.t) >= 6 && wc(nx.t) >= n * 1.5))) { head = true; it.t = ht; }
    }
    if (head) {
      flush();
      sec = { heading: it.t.replace(/\*\*/g, '').replace(/:$/, '').trim(), where: it.where, lines: [], slide: !!it.slide, explicit: !!it.h };
    } else sec.lines.push(it);
  }
  flush();
  yield { phase: 'Reading', progress: 0.1 };

  // ----- 2. the sentences, and 3. counting the terms (pass 1) -----
  const counts = newCounts();
  const subjects = new Set();           // phrases that a sentence is about (it starts with them): "Ribosomes read the instructions…"
  let docN = 0, lineN = 0;
  const totalLines = sections.reduce((n, s) => n + s.lines.length, 0) || 1;
  for (const s of sections) {
    s.recs = [];
    for (const l of s.lines) {
      const pair = pairSplit(l.t);
      const sents = (pair ? [l.t] : splitSentences(l.t)).map(raw => {
        const plain = clean(raw), toks = words(plain), phrases = candidatePhrases(toks, { text: plain });
        addPhrases(counts, phrases, docN++);
        let at = 0;
        while (at < toks.length - 1 && SUBJECT_LEAD.has(toks[at].w)) at++;
        for (const p of phrases) if (p.start === toks[at]?.start) subjects.add(p.key);
        return { raw, plain, toks, phrases };
      });
      s.recs.push({ l, pair, sents });
      if (++lineN % 100 === 0) yield { phase: 'Counting words', progress: 0.1 + 0.3 * (lineN / totalLines) };
    }
  }
  const weights = termWeights(counts, Math.max(1, docN));
  const knownKeys = new Set();
  for (const k of known.slice(0, 5000)) { const ws = words(String(k)); if (ws.length && ws.length <= 6) knownKeys.add(keyOf(ws)); }
  const tfOf = key => counts.get(key)?.tf || 0;

  // ----- 4. the rules (pass 2) -----
  const cands = [];                     // every candidate suggestion, in document order
  let order = 0, unit = 0;
  const push = c => cands.push({ order: order++, ...c });
  const defined = new Set();            // keys of the terms some rule explains
  const bolds = [];                     // { key, text, sentence }
  const allSents = [];
  const ctx = { weights, counts, knownKeys, subjects };

  for (const s of sections) {
    const used = new Set();
    const secWhere = s.where || s.heading;
    const short = p => p && wc(p.term) <= 5 && wc(p.def) <= 5;
    const vocabN = s.recs.filter(r => short(r.pair)).length;
    if (vocabN >= 3 && vocabN / Math.max(1, s.recs.length) >= 0.6) {       // a list of word pairs: each pair is a card (both ways); nothing else in it is
      for (const r of s.recs) {
        if (!short(r.pair)) continue;
        push({ kind: 'vocab', type: 'basic', front: r.pair.term, back: r.pair.def, source: r.l.t, where: r.l.where || secWhere, base: 0.85, both: true, anchor: keyOf(words(r.pair.term)) || r.pair.term });
      }
      continue;
    }
    for (const r of s.recs) if (r.pair?.one) r.pair = null;          // a one-word meaning only counts in a list of word pairs

    // lists: a heading, or a line that ends in ":", followed by 2 to 8 bullets (under a slide title, short lines will do)
    for (let i = 0; i < s.recs.length; i++) {
      const l = s.recs[i].l;
      let front = '', start = -1;
      if (!l.bullet && /:$/.test(l.t) && s.recs[i + 1]?.l.bullet) { front = l.t.replace(/:$/, ''); start = i + 1; used.add(i); }
      else if (i === 0 && s.heading && (l.bullet || (s.slide && !l.gap))) { front = s.heading; start = 0; }
      if (start < 0) continue;
      const bulleted = !!s.recs[start].l.bullet, run = [];
      for (let j = start; j < s.recs.length; j++) {
        const x = s.recs[j].l;
        if (bulleted !== !!x.bullet || (x.gap && j > start)) break;
        run.push(j);
      }
      if (run.length < 2 || run.length > 8) continue;
      let items;
      if (run.some(j => s.recs[j].pair?.label)) continue;          // a list of "MOA, uses, SE…" is not a list to learn
      if (run.every(j => s.recs[j].pair)) items = run.map(j => s.recs[j].pair.term);          // "Prophase: …" lines: the terms are the list
      else if (run.every(j => wc(s.recs[j].l.t) <= 12)) items = run.map(j => chop(clean(s.recs[j].l.t)));
      else continue;
      if (items.some(x => !x || isAdminLine(x))) continue;
      run.forEach(j => used.add(j));
      const explicit = /:$/.test(l.t) || s.explicit;
      push({ kind: 'list', type: 'basic', front: cap(clean(front)), back: joinElements({ items }), source: [front, ...items].join('; '), where: l.where || secWhere, base: 0.7, boost: items.length >= 3 && explicit ? 0.1 : 0, anchor: keyOf(words(front)) || front });
    }

    for (let i = 0; i < s.recs.length; i++) {
      const { l, pair: p, sents } = s.recs[i], w = l.where || secWhere;
      if (p) {
        const ab = abbreviationPair(p.term, p.def);
        if (ab) {
          push({ kind: 'acronym', type: 'basic', front: ab.short, back: ab.long, source: sents[0].plain, where: w, base: 0.9, both: true, anchor: keyOf(words(ab.short)), acr: true });
          defined.add(keyOf(words(ab.long)));
          continue;
        }
        let full = fullHeading(p.term, s.heading) || p.term, base = 0.75;
        if (p.label) { if (s.heading) full = `${s.heading}: ${p.term}`; else base = 0.6; }          // a label needs its heading on the card; with none it is not ticked
        const key = keyOf(words(full));
        if (!p.label) defined.add(key);
        push({ kind: 'definition', type: 'basic', front: p.label ? full : cap(full), back: chop(wc(p.def) > 40 ? (splitSentences(p.def)[0] || p.def) : p.def), source: sents[0].plain, where: w, base, anchor: key, term: full, label: !!p.label });
        continue;
      }
      if (used.has(i)) continue;
      for (const u of sents) {
        if (++unit % 50 === 0) yield { phase: 'Finding cards', progress: 0.4 + 0.45 * (lineN ? Math.min(1, unit / Math.max(1, docN)) : 1) };
        Object.assign(u, { sec: s, where: w, bullet: !!l.bullet });
        allSents.push(u);
        for (const b of u.raw.matchAll(/\*\*(.+?)\*\*/g)) {
          const t = b[1].replace(/[:\s]+$/, '');
          if (t && wc(t) <= 5 && !isJunkTerm(t)) bolds.push({ key: keyOf(words(t)), text: t, sentence: u });
        }
        if (u.raw.trim().endsWith('?')) { u.skip = true; continue; }
        for (const ab of abbreviationsIn(u.plain)) {
          push({ kind: 'acronym', type: 'basic', front: ab.short, back: ab.long, source: u.plain, where: w, base: 0.9, both: true, anchor: keyOf(words(ab.short)), acr: true });
          defined.add(keyOf(words(ab.long)));
        }
        for (const c of calledIn(u.plain)) {
          const key = keyOf(words(c.term.replace(/\s*\(.*$/, '')));
          if (!defined.has(key)) { defined.add(key); u.defined = true; push({ kind: 'definition', type: 'basic', front: cap(c.term), back: c.back, source: u.plain, where: w, base: c.base, anchor: key, term: c.term, multi: true }); }
        }
        const d = definitionIn(u.plain) || appositiveIn(u.plain, u.toks);
        if (d) {
          const key = keyOf(words(d.term));
          defined.add(key);
          u.defined = true;
          push({ kind: 'definition', type: 'basic', front: cap(d.term), back: d.back, source: u.plain, where: w, base: d.base, anchor: key, term: d.term });
        }
        const n = wc(u.plain);
        if (hasAdminBits(u.plain) || (adminDate(u.plain) && !/\b\d{4}\b/.test(u.plain)) || letterCount(u.plain) < u.plain.replace(/\s/g, '').length * 0.7) continue;
        if (u.bullet && n < 6) continue;
        const f = n >= 6 && n <= 35 ? factIn(u.plain, u.phrases, weights, counts) : null;
        let named = n >= 8 && n <= 35 ? sentenceCards(u.plain, u.toks, u.phrases, ctx) : [];
        // one card per sentence: a whole name ("Treaty of Versailles") is the better thing to hide; without one, the number or date
        if (f && named.some(c => c.caps && c.n >= 2)) named = [named.find(c => c.caps && c.n >= 2)];
        else if (f) named = [];
        if (f && !named.length) push({ kind: 'fact', type: 'cloze', cloze: f.cloze, source: u.plain, where: w, base: f.base, cap: 0.72, anchor: 'fact|' + u.plain, fact: true });
        for (const c of named) push({ kind: 'sentence', type: 'cloze', cloze: c.cloze, source: u.plain, where: w, base: c.base, cap: 0.72, anchor: c.key, term: c.text });
      }
    }
  }

  // key terms (bold and headings) that no definition explains
  yield { phase: 'Finding cards', progress: 0.88 };
  const done = new Set();
  for (const b of bolds) {
    if (defined.has(b.key) || done.has(b.key) || b.sentence.defined) continue;
    done.add(b.key);
    const c = clozeOf(b.sentence.plain, b.key, b.sentence.toks);
    if (c) push({ kind: 'term', type: 'cloze', cloze: c, source: b.sentence.plain, where: b.sentence.where, base: 0.7, boost: 0.1, anchor: b.key, term: b.text });
  }
  for (const s of sections) {
    const h = s.heading;
    if (!h || wc(h) > 4 || isJunkTerm(h) || /\d/.test(h) || isAdminLine(h) || words(h).some(t => STOPWORDS.has(t.w) || FILLER.has(t.w))) continue;
    const key = keyOf(words(h));
    if (defined.has(key) || done.has(key)) continue;
    done.add(key);
    const inSec = allSents.filter(u => u.sec === s && !u.skip);
    const hit = inSec.find(u => wc(u.plain) >= 8 && wc(u.plain) <= 35 && !PRONOUNS.has(firstWord(u.plain)) && clozeOf(u.plain, key, u.toks));
    if (hit) { push({ kind: 'term', type: 'cloze', cloze: clozeOf(hit.plain, key, hit.toks), source: hit.plain, where: hit.where, base: 0.7, boost: s.slide ? 0.1 : 0, anchor: key, term: h }); continue; }
    const first = s.slide && inSec.find(u => wc(u.plain) >= 4 && wc(u.plain) <= 40 && /^\p{Lu}/u.test(u.plain) && !PRONOUNS.has(firstWord(u.plain)));
    if (first) push({ kind: 'term', type: 'basic', front: cap(h), back: chop(first.plain), source: first.plain, where: first.where, base: 0.55, boost: 0.1, anchor: key, term: h });
  }

  // ----- 5. scores, duplicates, ranking -----
  yield { phase: 'Choosing the best', progress: 0.95 };
  let step = 0;
  for (const c of cands) {
    if (++step % 300 === 0) yield { phase: 'Choosing the best', progress: 0.95 };
    if (c.type === 'cloze') { const cc = clozeCard(c.cloze, 1); c.front = cc.front; c.back = cc.back; }
    let score = c.base + (c.boost ?? 0);
    if (!c.boost && c.term && c.kind !== 'sentence' && tfOf(keyOf(words(c.term))) >= 3) score += 0.1;          // the term comes back elsewhere in the text
    if (wc(c.back) > 40) score -= 0.2;
    if (c.type === 'basic' && c.kind !== 'vocab' && PRONOUNS.has(firstWord(c.back))) score -= 0.3;
    c.raw = Math.max(0, Math.min(1.5, score));                 // (a key sentence or a fact never reaches "strong", but they still rank by this)
    c.score = c.cap ? Math.min(c.raw, c.cap) : Math.min(c.raw, 1);
  }
  const groups = groupNear(cands.map(c => c.anchor));
  const sorted = [...cands].sort((a, b) => b.score - a.score || (a.kind === 'sentence') - (b.kind === 'sentence') || b.raw - a.raw || a.order - b.order);
  if (debug) debug.push(...sorted);
  const usedSource = new Set(), usedAcr = new Set(), anchorBasic = new Set(), anchorCloze = new Set(), seen = new Set();
  const keep = [];
  let sentenceQuota = Math.max(1, Math.ceil(stats.words / 100));
  for (const c of sorted) {
    if (++step % 300 === 0) yield { phase: 'Choosing the best', progress: 0.97 };
    if (junky(c)) continue;
    const g = groups.get(c.anchor) || c.anchor;
    // one card per sentence (an abbreviation may share its sentence with a definition)
    const sourceSet = c.acr || c.multi ? usedAcr : usedSource;          // (an abbreviation, or a sentence that names two things, may give more than one card)
    const sourceId = c.acr || c.multi ? g : dupKey(c.source);
    if (sourceSet.has(sourceId)) continue;
    if (c.type === 'basic' ? anchorBasic.has(g) : anchorCloze.has(g)) continue;
    if ((c.kind === 'sentence' || c.kind === 'term') && defined.has(g) && c.score < 0.6) continue;       // a second card on a term that has a definition has to be good
    if (c.kind === 'sentence') { if (sentenceQuota <= 0) continue; sentenceQuota--; }
    const key = c.kind + '|' + dupKey(c.front) + '|' + dupKey(c.cloze || '');
    if (seen.has(key)) continue;
    seen.add(key);
    sourceSet.add(sourceId);
    (c.type === 'basic' ? anchorBasic : anchorCloze).add(g);
    c.key = key;
    keep.push(c);
  }
  stats.total = keep.length;
  const top = keep.slice(0, MAX_SUGGESTIONS).sort((a, b) => a.order - b.order);
  stats.shown = top.length;
  const suggestions = top.map(c => ({
    kind: c.kind, type: c.type, front: c.front, back: c.back, ...(c.cloze ? { cloze: c.cloze } : {}), source: c.source, where: c.where || '',
    score: Math.round(c.score * 100) / 100, strong: c.score >= STRONG, both: !!c.both, key: c.key, anchor: c.anchor
  }));
  for (const s of suggestions) stats.byKind[s.kind] = (stats.byKind[s.kind] || 0) + 1;
  yield { phase: 'Done', progress: 1 };
  return { suggestions, stats };
}

export function suggestCards(input) {
  const it = suggestSteps(input);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// ---------- junk ----------

export function junky(c) {
  if ([c.front, c.back].some(s => alnumCount(s) < 2)) return true;
  if (dupKey(c.front) === dupKey(c.back)) return true;
  if (c.front.length > 200 || c.back.length > 1000 || (c.cloze && c.cloze.length > 500)) return true;
  const all = c.front + ' ' + c.back + ' ' + (c.cloze || '');
  if (URL_RE.test(all) || EMAIL_RE.test(all) || TIME_RE.test(all)) return true;
  if (letterCount(all) < all.replace(/\s/g, '').length * 0.7) return true;
  if (c.type === 'basic' && c.kind !== 'acronym' && c.kind !== 'vocab' && isJunkTerm(c.front)) return true;
  if (c.type === 'cloze') {
    const ans = clozeBlanks(c.cloze).filter(b => b.num === '1').map(b => c.cloze.slice(b.index + 6, b.end - 2));
    if (!ans.length || ans.some(a => wc(a) > 6)) return true;
    if (c.kind !== 'fact' && ans.some(a => isJunkTerm(a))) return true;
    if (wc(c.front) < 6) return true;
  }
  return false;
}

// Does this text read like notes or an article rather than cards? `result` is what parseText made of it.
export function looksLikeProse(text, result) {
  const id = result?.format?.id;
  const proseFormat = id === 'none' || id === 'alternating' || id === 'blocks' ||
    (id === 'separator' && result.rows.length > 0 && result.rows.reduce((n, r) => n + String(r[1] ?? '').length, 0) / result.rows.length > 120);
  if (!proseFormat) return false;
  const t = String(text ?? '');
  return wc(t) >= 60 && splitSentences(t.replace(/\n+/g, ' ')).length >= 3;
}
