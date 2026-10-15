// Dance Like David — beat grid detection.
// Finds the tempo and where the first downbeat lands, so the admin confirms a grid
// instead of tapping a tempo and typing a millisecond offset by hand.
//
// Pure and dependency-free: the studio runs this on a decoded AudioBuffer in the browser,
// the tests run it on a synthesised click track in Node.

export const TARGET_RATE = 11025; // onsets don't need the full bandwidth
export const HOP = 128;           // ~11.6 ms per frame at TARGET_RATE: fine enough for beat phase

/** Average every f-th sample together: a crude low-pass and a decimation in one pass. */
function decimate(x, sampleRate, targetRate) {
  const f = Math.max(1, Math.round(sampleRate / targetRate));
  if (f === 1) return { y: x, rate: sampleRate };
  const n = Math.floor(x.length / f);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += x[i * f + j];
    y[i] = s / f;
  }
  return { y, rate: sampleRate / f };
}

/**
 * Onset strength per frame: the rise in log energy. Log compression is what keeps a quiet
 * verse and a loud chorus contributing comparably.
 */
export function onsetEnvelope(mono, sampleRate) {
  const { y, rate } = decimate(mono, sampleRate, TARGET_RATE);
  const win = HOP * 2;
  const n = Math.max(0, Math.floor((y.length - win) / HOP) + 1);
  const loud = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = i * HOP;
    for (let j = 0; j < win; j++) { const v = y[a + j]; s += v * v; }
    loud[i] = Math.log1p((s / win) * 1000);
  }
  const env = new Float64Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, loud[i] - loud[i - 1]);
  return { env, onsetHz: rate / HOP };
}

/** Autocorrelation of a zero-mean signal over a lag range, normalised by overlap length. */
function acf(z, minLag, maxLag) {
  const out = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const n = z.length - lag;
    if (n <= 0) continue;
    let s = 0;
    for (let i = 0; i < n; i++) s += z[i] * z[i + lag];
    out[lag] = s / n;
  }
  return out;
}

/**
 * Mean onset strength on a beat grid of period `period` frames starting at `offset`.
 * Taking the mean rather than the sum is what stops a half-period grid (twice as many
 * chances to hit something) from always winning.
 */
function combScore(env, period, offset) {
  let s = 0, k = 0;
  for (let t = offset; t < env.length; t += period) { s += env[Math.round(t)]; k++; }
  return k ? s / k : 0;
}

/** Best phase for a period, searched over one whole beat at frame resolution. */
function bestPhase(env, period) {
  let bestOff = 0, best = -Infinity;
  for (let off = 0; off < period; off++) {
    const s = combScore(env, period, off);
    if (s > best) { best = s; bestOff = off; }
  }
  return { offset: bestOff, score: best };
}

// Listeners hear a tempo near 120 as "the" tempo, so a candidate there beats an equally
// well-fitting half or double. Log-normal prior, same idea as a tempo resonance curve.
const tempoPrior = (bpm) => Math.exp(-0.5 * (Math.log(bpm / 120) / 0.35) ** 2);

/**
 * Tempo and beat grid from mono PCM.
 * Returns { bpm, beatMs, firstBeatMs, firstDownbeatMs, confidence, onset, onsetHz }.
 *  - firstBeatMs      the first beat of the grid
 *  - firstDownbeatMs  the first beat of a bar, assuming `beatsPerBar` — this is what the
 *                     song's `firstBeatMs` wants, since moves are cut in bars
 *  - confidence       how much stronger a beat frame is than an average frame; above ~2 is a
 *                     confident read, below that the UI should ask the admin to check it
 */
export function detectTempo(mono, sampleRate, { minBpm = 60, maxBpm = 190, beatsPerBar = 4 } = {}) {
  const { env, onsetHz } = onsetEnvelope(mono, sampleRate);
  const msPerFrame = 1000 / onsetHz;
  const empty = { bpm: null, beatMs: null, firstBeatMs: 0, firstDownbeatMs: 0, confidence: 0, onset: env, onsetHz };
  const minLag = Math.max(2, Math.floor((onsetHz * 60) / maxBpm));
  const maxLag = Math.ceil((onsetHz * 60) / minBpm);
  if (env.length < maxLag * 4) return empty;

  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  if (!(mean > 0)) return empty;
  const z = Float64Array.from(env, (v) => v - mean);

  const ac = acf(z, minLag, maxLag);
  let peak = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > ac[peak]) peak = lag;
  if (!(ac[peak] > 0)) return empty;

  // sub-frame peak: an integer lag is only ~3 BPM apart at 120, which would drift seconds
  // over a three-minute song
  const y0 = ac[peak - 1] ?? ac[peak], y1 = ac[peak], y2 = ac[peak + 1] ?? ac[peak];
  const denom = y0 - 2 * y1 + y2;
  const coarse = peak + (denom ? (0.5 * (y0 - y2)) / denom : 0);

  // the ACF peak can land on a half or double of what a listener would count
  const inRange = (p) => {
    const bpm = (onsetHz * 60) / p;
    return bpm >= minBpm && bpm <= maxBpm;
  };
  let best = null;
  for (const cand of [coarse / 2, coarse, coarse * 2].filter(inRange)) {
    // refine tempo and phase together against the whole song, so the grid can't drift
    for (let p = cand - 0.6; p <= cand + 0.6; p += 0.01) {
      if (!inRange(p)) continue;
      const { offset, score } = bestPhase(env, p);
      const weighted = score * tempoPrior((onsetHz * 60) / p);
      if (!best || weighted > best.weighted) best = { period: p, offset, score, weighted };
    }
  }
  if (!best) return empty;

  // which beat of the bar carries the most weight is the downbeat
  let bar = 0, barBest = -Infinity;
  for (let b = 0; b < beatsPerBar; b++) {
    let s = 0, k = 0;
    for (let t = best.offset + b * best.period; t < env.length; t += best.period * beatsPerBar) {
      s += env[Math.round(t)];
      k++;
    }
    const m = k ? s / k : 0;
    if (m > barBest) { barBest = m; bar = b; }
  }

  const bpm = (onsetHz * 60) / best.period;
  // A frame's energy is measured over a window starting at the frame and one hop wide either
  // side of its centre, so the sound that frame f reacts to happened around (f + 1) hops in.
  const timeOf = (frames) => Math.max(0, Math.round((frames + 1) * msPerFrame));
  return {
    bpm: +bpm.toFixed(2),
    beatMs: +(best.period * msPerFrame).toFixed(2),
    firstBeatMs: timeOf(best.offset),
    firstDownbeatMs: timeOf(best.offset + bar * best.period),
    confidence: +(best.score / mean).toFixed(2),
    onset: env,
    onsetHz,
  };
}

/** Downmix a decoded AudioBuffer to one channel. Browser-side helper. */
export function monoFromBuffer(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}
