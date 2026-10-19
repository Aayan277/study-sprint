// The Import screen's pasted text, kept for this tab while you are away from the screen (Back, a swipe, another tab of the app).
// It holds the text together with how it is being read: { text, blocks, aiMade, noCloze, suggest, sug }.
//   blocks   "read as pages" (a PDF or slides read as pages)
//   aiMade   the text is an AI's answer (its cards get the ai-made tag)
//   noCloze  "Keep {{c1::…}} lines as plain cards" was pressed
//   suggest  "Suggest cards" is on (the text is read for definitions, lists and facts, not as cards)
//   sug      what was changed in the suggestions: { key: { pick, front, back, cloze } } for the ones unticked or edited
// It goes when the cards are saved, Clear is pressed, the device is wiped or you sign out.

const KEY = 'study-sprint-import-draft';

const plainObject = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : null);

export function keepDraft(draft) {
  try {
    if (draft && String(draft.text ?? '').trim()) {
      const suggest = !!draft.suggest, sug = suggest ? plainObject(draft.sug) : null;
      sessionStorage.setItem(KEY, JSON.stringify({ text: draft.text, blocks: !!draft.blocks, aiMade: !!draft.aiMade, noCloze: !!draft.noCloze, ...(suggest ? { suggest, ...(sug ? { sug } : {}) } : {}) }));
    } else sessionStorage.removeItem(KEY);
  } catch { try { sessionStorage.removeItem(KEY); } catch { /* blocked: fine */ } }      // too big or blocked: no old text left behind either
}
export const clearDraft = () => keepDraft(null);
// The kept draft, or null. (An older version kept just the text.)
export function takeDraft() {
  let raw;
  try { raw = sessionStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && typeof d.text === 'string') return d.text.trim() ? { text: d.text, blocks: !!d.blocks, aiMade: !!d.aiMade, noCloze: !!d.noCloze, suggest: !!d.suggest, sug: d.suggest ? plainObject(d.sug) : null } : null;
  } catch { /* plain text from an older version */ }
  return { text: raw, blocks: false, aiMade: false, noCloze: false, suggest: false, sug: null };
}
