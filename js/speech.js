// Reading cards aloud, with the device's built-in voices (free, and they work offline).
// Each deck can choose a language (deck.ttsLang, '' = work it out from the text) and whether Review
// reads cards out by itself (deck.ttsAuto). detectLang is a pure function, tested by tests/speech.test.js.

import { plainText } from './format.js';

// Languages offered in Edit deck. The code tells the device which voice to use.
export const SPEECH_LANGS = [
  ['', 'Work it out from the text'],
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'],
  ['it-IT', 'Italian'], ['pt-BR', 'Portuguese'], ['nl-NL', 'Dutch'], ['ru-RU', 'Russian'], ['ar-SA', 'Arabic'],
  ['hi-IN', 'Hindi'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)']
];

// Guess the language from the writing system. Latin-script languages can't be told apart this way,
// so they use the device's own language (pick one in Edit deck to be sure).
export function detectLang(text, fallback = 'en-US') {
  const s = String(text ?? '');
  if (/[぀-ヿ]/.test(s)) return 'ja-JP';                 // hiragana / katakana
  if (/[가-힯]/.test(s)) return 'ko-KR';                 // hangul
  if (/[一-鿿]/.test(s)) return 'zh-CN';                 // Chinese characters (no kana)
  if (/[Ѐ-ӿ]/.test(s)) return 'ru-RU';                 // Cyrillic
  if (/[؀-ۿ]/.test(s)) return 'ar-SA';                 // Arabic
  if (/[ऀ-ॿ]/.test(s)) return 'hi-IN';                 // Devanagari
  if (/[Ͱ-Ͽ]/.test(s)) return 'el-GR';                 // Greek
  if (/[֐-׿]/.test(s)) return 'he-IL';                 // Hebrew
  if (/[฀-๿]/.test(s)) return 'th-TH';                 // Thai
  return fallback;
}

// What to say: the card's text without formatting marks or bullet dots.
export const speakableText = text => plainText(text).replace(/^• /gm, '').replace(/\s+/g, ' ').trim();

export const canSpeak = () => typeof speechSynthesis !== 'undefined';

// Read some text aloud (stopping anything already being read). lang: a code from SPEECH_LANGS, or ''.
export function speak(text, lang = '') {
  if (!canSpeak()) return false;
  const say = speakableText(text);
  speechSynthesis.cancel();
  if (!say) return false;
  const u = new SpeechSynthesisUtterance(say);
  u.lang = lang || detectLang(say, navigator.language || 'en-US');
  const voice = speechSynthesis.getVoices().find(v => v.lang === u.lang) || speechSynthesis.getVoices().find(v => v.lang.startsWith(u.lang.slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return true;
}
export const stopSpeaking = () => { if (canSpeak()) speechSynthesis.cancel(); };
