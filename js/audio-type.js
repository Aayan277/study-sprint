// Which kind of sound a file is. Pure functions (no page, no files), tested by tests/audio-type.test.js.
//   soundType(type, name)    the type to keep for a file from its declared type or its ending, or null
//   sniffAudioType(bytes)    the type its first bytes say it is, or null (a file's own header is more honest than its name)
//   soundExt(type)           the ending used when a sound goes into an Anki deck
//   storedType(type, bytes)  a type from a download or a file, tidied: no ";charset", aliases folded in, sniffed when it is vague
//                            (the sound types the app keeps are the ones in ALLOWED_SOUND_TYPES of db.js)

const BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', wav: 'audio/wav', flac: 'audio/flac' };
const ALIASES = { 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/mp4': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/aac': 'audio/aac', 'audio/ogg': 'audio/ogg', 'application/ogg': 'audio/ogg',
  'audio/webm': 'audio/webm', 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/flac': 'audio/flac', 'audio/x-flac': 'audio/flac' };

const bare = type => String(type || '').toLowerCase().split(';')[0].trim();
export function soundType(type, name = '') {
  return ALIASES[bare(type)] || BY_EXT[String(name).split('.').pop().toLowerCase()] || null;
}
export const soundExt = type => ({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/flac': 'flac' })[type] || 'mp3';

// The first bytes of a file (an ArrayBuffer or a typed array).
export function sniffAudioType(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (b.length < 4) return null;
  const at = (i, text) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 'ID3')) return 'audio/mpeg';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (b.length >= 12 && at(4, 'ftyp')) return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0xf6) === 0xf0 ? 'audio/aac' : 'audio/mpeg';     // a frame header: AAC (ADTS) has layer bits 00, MP3 does not
  return null;
}

// The type to store for a file's bytes: its tidied declared type when it is one we keep, else what its bytes say; pictures keep their image type.
export function storedType(type, bytes, fallback = 'image/jpeg') {
  const t = bare(type);
  if (t.startsWith('image/')) return t;
  return soundType(t) || sniffAudioType(bytes) || fallback;
}
