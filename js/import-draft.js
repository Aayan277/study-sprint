// The Import screen's pasted text, kept for this tab while you are away from the screen (Back, a swipe, another tab of the app).
// It holds the text together with how it is being read: { text, blocks, aiMade, noCloze }.
//   blocks   "read as pages" (a PDF or slides read as pages)
//   aiMade   the text is an AI's answer (its cards get the ai-made tag)
//   noCloze  "Keep {{c1::…}} lines as plain cards" was pressed
// It goes when the cards are saved, Clear is pressed, the device is wiped or you sign out.

const KEY = 'study-sprint-import-draft';

export function keepDraft(draft) {
  try {
    if (draft && String(draft.text ?? '').trim()) sessionStorage.setItem(KEY, JSON.stringify({ text: draft.text, blocks: !!draft.blocks, aiMade: !!draft.aiMade, noCloze: !!draft.noCloze }));
    else sessionStorage.removeItem(KEY);
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
    if (d && typeof d === 'object' && typeof d.text === 'string') return d.text.trim() ? { text: d.text, blocks: !!d.blocks, aiMade: !!d.aiMade, noCloze: !!d.noCloze } : null;
  } catch { /* plain text from an older version */ }
  return { text: raw, blocks: false, aiMade: false, noCloze: false };
}
