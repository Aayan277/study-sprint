// RWKV lab: scoring predictions against what happened. Pure.
const EPS = 1e-6;
const clip = p => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);

// Mean binary cross-entropy. p: chances of remembering; y: 1 remembered, 0 forgot.
export function logLoss(p, y) {
  if (!p.length) return null;
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = clip(p[i]); s -= y[i] ? Math.log(q) : Math.log(1 - q); }
  return s / p.length;
}

// Area under the ROC curve by ranks (ties share their average rank). null when every answer was the same.
export function auc(p, y) {
  const n = p.length;
  let pos = 0;
  for (let i = 0; i < n; i++) if (y[i]) pos++;
  const neg = n - pos;
  if (!pos || !neg) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  let rankSum = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && p[order[j + 1]] === p[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[order[k]]) rankSum += avg;
    i = j + 1;
  }
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

// The 20 equal-width bins of predicted chance: sqrt of the count-weighted mean of (mean predicted - observed share)^2.
export function rmseBins(p, y, bins = 20) {
  const n = p.length;
  if (!n) return null;
  const cnt = new Array(bins).fill(0), sp = new Array(bins).fill(0), sy = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p[i] * bins)));
    cnt[b]++; sp[b] += p[i]; sy[b] += y[i] ? 1 : 0;
  }
  let s = 0;
  for (let b = 0; b < bins; b++) if (cnt[b]) { const d = sp[b] / cnt[b] - sy[b] / cnt[b]; s += cnt[b] * d * d; }
  return Math.sqrt(s / n);
}

export const MODELS = [
  { key: 'fsrsMine', name: 'FSRS-6 (your settings)' },
  { key: 'fsrsDefault', name: 'FSRS-6 (default)' },
  { key: 'rwkvCurve', name: 'RWKV curve' },
  { key: 'rwkvImm', name: 'RWKV instant' }
];

// preds: records from the lab database. since: only reviews at or after this time (ms), or null.
// Every row covers the same reviews: those a day or more after the card's last answer that all four models predicted.
export function compare(preds, { since = null } = {}) {
  const ok = preds.filter(r => r.elapsedDays >= 1 && (since === null || r.t >= since)
    && MODELS.every(m => Number.isFinite(r[m.key])));
  const y = ok.map(r => r.y);
  return MODELS.map(m => {
    const p = ok.map(r => r[m.key]);
    return { key: m.key, name: m.name, n: ok.length, logLoss: logLoss(p, y), auc: auc(p, y), rmse: rmseBins(p, y) };
  });
}
