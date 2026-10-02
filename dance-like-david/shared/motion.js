// Dance Like David — shared motion maths.
// Used by the server (to build a chart from the admin's takes) and by the phone (to score live).
//
// A sample is [songMs, ax, ay, az, rAlpha, rBeta, rGamma]
//   a* = linear acceleration without gravity (m/s^2), device frame
//   r* = rotation rate (deg/s), device frame
// "songMs" is time on the song clock as HEARD in the room (0 = first audio sample).

export const HZ = 50;                 // everything is resampled to this grid
export const STEP = 1000 / HZ;
export const DIMS = 6;
export const BAND = 0.25;             // DTW timing slop: +-25% of the move length
export const REST_ENERGY = 0.3;       // below this the admin wasn't really moving -> not scored
export const MIN_TOL = 0.25;          // never be stricter than this
export const DEFAULT_TOL = 0.5;       // used when only one take exists
export const TIERS = [                // multiples of a move's tolerance
  { name: 'PERFECT', max: 1.3, points: 100 },
  { name: 'GOOD', max: 2.0, points: 70 },
  { name: 'OK', max: 3.0, points: 40 },
];
export const MISS = { name: 'MISS', points: 0 };

/** Linear-interpolate samples onto a fixed grid [t0, t1). Returns Float64Array(n*DIMS); NaN where uncovered. */
export function resample(samples, t0, t1) {
  const n = Math.max(0, Math.floor((t1 - t0) / STEP));
  const out = new Float64Array(n * DIMS).fill(NaN);
  if (!samples.length || !n) return out;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * STEP;
    if (t < samples[0][0] || t > samples[samples.length - 1][0]) continue;
    while (j < samples.length - 2 && samples[j + 1][0] < t) j++;
    const a = samples[j], b = samples[j + 1] || a;
    const span = b[0] - a[0];
    // don't bridge big gaps (tab was backgrounded, sensor hiccup)
    if (span > 250) continue;
    const f = span > 0 ? (t - a[0]) / span : 0;
    for (let d = 0; d < DIMS; d++) out[i * DIMS + d] = a[d + 1] + (b[d + 1] - a[d + 1]) * f;
  }
  return out;
}

export function coverage(grid) {
  let ok = 0;
  const n = grid.length / DIMS;
  for (let i = 0; i < n; i++) if (!Number.isNaN(grid[i * DIMS])) ok++;
  return n ? ok / n : 0;
}

/** Scale acc and gyro into comparable units. One scale per sensor, so direction between axes is preserved. */
export function scaleGrid(grid, accScale, gyrScale) {
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    const d = i % DIMS;
    out[i] = Number.isNaN(v) ? 0 : v / (d < 3 ? accScale : gyrScale);
  }
  return out;
}

export function energy(scaled) {
  const n = scaled.length / DIMS;
  let s = 0;
  for (let i = 0; i < n; i++) {
    let q = 0;
    for (let d = 0; d < DIMS; d++) q += scaled[i * DIMS + d] ** 2;
    s += Math.sqrt(q);
  }
  return n ? s / n : 0;
}

/** Banded dynamic time warping, normalised by path length. Lower = more similar. */
export function dtw(a, b, band = BAND) {
  const n = a.length / DIMS, m = b.length / DIMS;
  if (!n || !m) return Infinity;
  const w = Math.max(Math.floor(band * Math.max(n, m)), Math.abs(n - m) + 1);
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const lo = Math.max(1, i - w), hi = Math.min(m, i + w);
    for (let j = lo; j <= hi; j++) {
      let q = 0;
      for (let d = 0; d < DIMS; d++) {
        const x = a[(i - 1) * DIMS + d] - b[(j - 1) * DIMS + d];
        q += x * x;
      }
      cur[j] = Math.sqrt(q) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

export function segmentsFor(meta) {
  const segMs = (meta.beatsPerMove * 60000) / meta.bpm;
  const out = [];
  for (let s = meta.firstBeatMs || 0, i = 0; s + segMs <= meta.durationMs; s += segMs, i++) {
    out.push({ i, start: Math.round(s), end: Math.round(s + segMs) });
  }
  return out;
}

function rms(values) {
  let s = 0, n = 0;
  for (const v of values) if (!Number.isNaN(v)) { s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** One scale per sensor across all takes (keeps direction between axes intact). */
export function scalesFor(takes) {
  const acc = [], gyr = [];
  for (const t of takes) for (const s of t.samples) { acc.push(s[1], s[2], s[3]); gyr.push(s[4], s[5], s[6]); }
  return { accScale: Math.max(rms(acc), 0.5), gyrScale: Math.max(rms(gyr), 20) };
}

/**
 * Build a chart from the admin's takes.
 * takes: [{ n, samples }]
 * Returns { hz, accScale, gyrScale, segments:[{i,start,end,rest,tol,ref,takes,loo}], report }
 */
export function buildChart(meta, takes) {
  if (!takes.length) throw new Error('No takes recorded yet');
  // 1. global scales from all takes
  const { accScale, gyrScale } = scalesFor(takes);

  const segments = [];
  const perTake = new Map(takes.map((t) => [t.n, { sum: 0, count: 0 }])); // distance of each take to the reference
  for (const seg of meta.segments || segmentsFor(meta)) {
    const grids = takes
      .map((t) => ({ n: t.n, g: resample(t.samples, seg.start, seg.end) }))
      .filter((x) => coverage(x.g) >= 0.9)
      .map((x) => ({ n: x.n, g: scaleGrid(x.g, accScale, gyrScale) }));
    if (!grids.length) continue; // no take covered this part of the song

    // medoid: the take closest to all the others
    let medoid = 0, loo = [];
    if (grids.length > 1) {
      const D = grids.map((a) => grids.map((b) => (a === b ? 0 : dtw(a.g, b.g))));
      const sums = D.map((row) => row.reduce((x, y) => x + y, 0));
      medoid = sums.indexOf(Math.min(...sums));
      loo = D[medoid].filter((_, k) => k !== medoid);
      grids.forEach((g, k) => { if (k !== medoid) { const pt = perTake.get(g.n); pt.sum += D[k][medoid]; pt.count++; } });
    }
    const ref = grids[medoid].g;
    const e = energy(ref);
    const tol = grids.length > 1 ? Math.max(median(loo), MIN_TOL) : DEFAULT_TOL;
    segments.push({
      ...seg,
      rest: e < REST_ENERGY,
      energy: +e.toFixed(3),
      tol: +tol.toFixed(3),
      loo: loo.map((x) => +x.toFixed(3)),
      takes: grids.map((x) => x.n),
      refTake: grids[medoid].n,
      ref: Array.from(ref, (v) => Math.round(v * 1000) / 1000),
    });
  }
  const scored = segments.filter((s) => !s.rest);
  // How well each take agrees with the others (an "odd one" should be deleted or re-recorded)
  const means = takes.map((t) => { const pt = perTake.get(t.n); return pt.count ? pt.sum / pt.count : 0; });
  const nonZero = means.filter((m) => m > 0);
  const typical = nonZero.length ? median(nonZero) : 0;
  const takeScores = takes.map((t, i) => {
    const ratio = typical ? means[i] / typical : 1;
    return {
      n: t.n, meanDist: +means[i].toFixed(3), ratio: +ratio.toFixed(2),
      agreement: Math.max(5, Math.min(100, Math.round(100 - Math.max(0, ratio - 0.8) * 70))),
      odd: takes.length >= 3 && ratio > 1.6,
    };
  });
  return {
    songId: meta.id,
    hz: HZ,
    accScale: +accScale.toFixed(4),
    gyrScale: +gyrScale.toFixed(4),
    builtAt: new Date().toISOString(),
    segments,
    report: {
      takes: takes.length,
      segments: segments.length,
      scoredMoves: scored.length,
      restMoves: segments.length - scored.length,
      medianTol: scored.length ? +median(scored.map((s) => s.tol)).toFixed(3) : null,
      singleTake: takes.length < 2,
      takeScores,
    },
  };
}

/**
 * Mark segments that are the same dance as each other, so the admin names a chorus once
 * instead of twelve times. Sets `group` on every scored segment and returns the chart.
 *
 * Two segments group when the distance between their references is small enough that
 * dancing one where the other was expected would still grade PERFECT — the same threshold
 * the grader uses, so "the same move" means the same thing here as it does when scoring.
 * Envelope correlation prunes the pairs first: a full DTW on every pair of a 90-move song
 * is work we don't need to do to know that a rest and a spin are different.
 */
export function groupSegments(chart) {
  const segs = (chart.segments || []).filter((s) => !s.rest && Array.isArray(s.ref) && s.ref.length);
  for (const s of chart.segments || []) delete s.group;
  if (segs.length < 2) {
    if (segs.length) segs[0].group = 0;
    if (chart.report) chart.report.moveGroups = segs.length;
    return chart;
  }
  const refs = segs.map((s) => Float64Array.from(s.ref));
  const envs = refs.map((r) => envelope(r));
  const parent = segs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (find(i) === find(j)) continue;
      const n = Math.min(envs[i].length, envs[j].length);
      if (!n || pearson(envs[i], envs[j], 0, n) < 0.8) continue;
      if (dtw(refs[i], refs[j]) <= Math.min(segs[i].tol, segs[j].tol) * TIERS[0].max) union(i, j);
    }
  }
  const ids = new Map();
  for (let i = 0; i < segs.length; i++) {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    segs[i].group = ids.get(root);
  }
  if (chart.report) chart.report.moveGroups = ids.size;
  return chart;
}

/** Grade one move. Kept for callers that only need the tier; see scoreDetail for the full picture. */
export function gradeSegment(chart, seg, samples, opts = {}) {
  return scoreDetail(chart, seg, samples, opts);
}

/** Stars (0–5) from the share of the maximum possible points. */
export function starsFor(points, maxPoints) {
  if (!maxPoints) return 0;
  const r = points / maxPoints;
  return r >= 0.9 ? 5 : r >= 0.75 ? 4 : r >= 0.6 ? 3 : r >= 0.4 ? 2 : r >= 0.2 ? 1 : 0;
}

/** Streak rule: PERFECT and GOOD extend it, OK and MISS reset it. */
export const extendsStreak = (grade) => grade === 'PERFECT' || grade === 'GOOD';

// ---------------------------------------------------------------------------
// Scoring v2: timing alignment, 0–100 accuracy and "why" feedback
// ---------------------------------------------------------------------------

/** Motion intensity per sample of a scaled grid (acceleration counts double: it's what a watcher sees). */
export function envelope(scaled) {
  const n = scaled.length / DIMS;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0, g = 0;
    for (let d = 0; d < 3; d++) a += scaled[i * DIMS + d] ** 2;
    for (let d = 3; d < 6; d++) g += scaled[i * DIMS + d] ** 2;
    out[i] = Math.sqrt(a) + 0.5 * Math.sqrt(g);
  }
  return out;
}

function pearson(a, b, bOff, n) {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[bOff + i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[bOff + i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Map a distance ratio (distance / move tolerance) to a 0–100 accuracy. Tier edges land on 90 / 70 / 40. */
export function accuracyFromRatio(ratio) {
  const pts = [[0, 100], [1, 100], [1.3, 90], [2, 70], [3, 40], [4, 0]];
  if (ratio >= 4) return 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    if (ratio <= x2) return Math.round(y1 + ((ratio - x1) / (x2 - x1)) * (y2 - y1));
  }
  return 0;
}

const TIPS = {
  'no-data': 'No motion reached the game — keep this page open and the screen on.',
  still: 'We barely felt any movement — dance with your whole arm!',
  small: (p) => `Go bigger — that was about ${p}% of the move's size.`,
  big: 'Too wild — keep it controlled and match the shape.',
  shaky: 'Smoother! Shaking the phone doesn’t count.',
  mirrored: 'Wrong direction — right hand, screen facing you.',
  late: (s) => `A little late (${s} s) — start with the beat.`,
  early: (s) => `A little early (${s} s) — wait for the beat.`,
  shape: 'Close — match the shape of the move more closely.',
  perfect: 'Nailed it!',
  good: 'Nice — almost perfect.',
};

/**
 * Full scoring for one move.
 * Returns { name, points, score (0–100), ratio, dist, lagMs, size, tip, reason }.
 *  - lagMs  > 0: the dancer was late; we shift their motion (up to maxLagMs) before comparing, so a
 *           consistent delay (reaction time, Bluetooth speakers) doesn't wreck the score.
 *  - size   player motion ÷ reference motion (1 = same size).
 * opts.speed    practice playback speed (slow dancing is gentler, so we scale it back up)
 * opts.maxLagMs how far to search for the best alignment (default 30% of the move, max 600 ms)
 */
export function scoreDetail(chart, seg, samples, opts = {}) {
  const speed = opts.speed || 1;
  const input = speed === 1 ? samples
    : samples.map((s) => [s[0], s[1] / speed ** 2, s[2] / speed ** 2, s[3] / speed ** 2, s[4] / speed, s[5] / speed, s[6] / speed]);
  const ref = seg._refArr || (seg._refArr = Float64Array.from(seg.ref));
  const n = ref.length / DIMS;
  const maxLagMs = opts.maxLagMs ?? Math.min(600, (seg.end - seg.start) * 0.3);
  const L = Math.round(maxLagMs / STEP);
  const raw = resample(input, seg.start - L * STEP, seg.start - L * STEP + (n + 2 * L) * STEP + STEP / 2);
  const ext = scaleGrid(raw, chart.accScale, chart.gyrScale);
  const total = ext.length / DIMS;
  const miss = (reason, extra = {}) => ({ ...MISS, score: 0, dist: null, ratio: null, lagMs: 0, size: 0, reason, tip: typeof TIPS[reason] === 'string' ? TIPS[reason] : TIPS.shape, ...extra });
  if (total < n) return miss('no-data');

  // coverage of the un-shifted window
  let covered = 0;
  for (let i = L; i < L + n && i < total; i++) if (!Number.isNaN(raw[i * DIMS])) covered++;
  if (covered / n < 0.6) return miss('no-data');

  // 1) timing: slide the player's intensity curve against the reference's
  const envR = envelope(ref), envP = envelope(ext);
  let bestK = 0, bestC = -Infinity;
  for (let k = -L; k <= L; k++) {
    const off = L + k;
    if (off < 0 || off + n > total) continue;
    const c = pearson(envR, envP, off, n) - Math.abs(k) * 0.002; // tiny bias toward "on time"
    if (c > bestC) { bestC = c; bestK = k; }
  }
  const off = (L + bestK) * DIMS;
  const player = ext.subarray(off, off + n * DIMS);
  const lagMs = Math.round(bestK * STEP * speed);

  // 2) size, shakiness, direction
  const eR = energy(ref), eP = energy(player);
  const size = eR > 0 ? eP / eR : 0;
  const jitter = (g) => { let s = 0; for (let i = 1; i < g.length / DIMS; i++) for (let d = 0; d < 3; d++) s += Math.abs(g[i * DIMS + d] - g[(i - 1) * DIMS + d]); return s / Math.max(1, g.length / DIMS); };
  const shake = jitter(player) / Math.max(0.05, jitter(ref));
  let dot = 0, nr = 0, np = 0;
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) { const a = ref[i * DIMS + d], b = player[i * DIMS + d]; dot += a * b; nr += a * a; np += b * b; }
  const direction = nr && np ? dot / Math.sqrt(nr * np) : 0;

  // 3) shape distance, with a gentle penalty for being far off the beat
  const dist = dtw(player, ref);
  const lagPenalty = 1 + Math.max(0, Math.abs(lagMs) - 200) / 1500;
  const ratio = (dist / (seg.tol * (seg.strict || 1))) * lagPenalty;
  const tier = TIERS.find((t) => ratio <= t.max) || MISS;
  const score = accuracyFromRatio(ratio);

  // 4) the single most useful tip
  let reason;
  if (eP < 0.08) reason = 'still';
  else if (size < 0.45) reason = 'small';
  else if (shake > 2.5 && size > 1.3) reason = 'shaky';
  else if (direction < -0.25) reason = 'mirrored';
  else if (size > 2.2) reason = 'big';
  else if (tier.name === 'PERFECT') reason = 'perfect';
  else if (Math.abs(lagMs) > 250) reason = lagMs > 0 ? 'late' : 'early';
  else reason = tier.name === 'GOOD' ? 'good' : 'shape';
  const t = TIPS[reason];
  const tip = typeof t === 'function' ? t(reason === 'small' ? Math.round(size * 100) : (Math.abs(lagMs) / 1000).toFixed(1)) : t;
  const timingNote = reason === 'perfect' && Math.abs(lagMs) > 250 ? ` (a touch ${lagMs > 0 ? 'late' : 'early'}: ${(Math.abs(lagMs) / 1000).toFixed(1)} s)` : '';

  return {
    name: tier.name, points: tier.points, score,
    dist: +dist.toFixed(3), ratio: +ratio.toFixed(2), lagMs,
    size: +size.toFixed(2), shake: +shake.toFixed(2), direction: +direction.toFixed(2), reason, tip: tip + timingNote, cov: covered / n,
  };
}

/**
 * Line up free-form takes (Move Lab: no music to sync to) by their intensity curves,
 * so a take started 200 ms late doesn't blur the reference. Shifts sample times in place (returns new takes).
 */
export function alignTakes(takes, windowMs, maxLagMs = 600) {
  if (takes.length < 2) return takes;
  const { accScale, gyrScale } = scalesFor(takes);
  const L = Math.round(maxLagMs / STEP);
  const n = Math.floor(windowMs / STEP);
  const envOf = (t, t0) => envelope(scaleGrid(resample(t.samples, t0, t0 + (n + 2 * L) * STEP + STEP / 2), accScale, gyrScale));
  // anchor: the take with the most motion (most likely a complete, confident take)
  const energies = takes.map((t) => energy(scaleGrid(resample(t.samples, 0, windowMs), accScale, gyrScale)));
  const anchor = takes[energies.indexOf(Math.max(...energies))];
  const anchorEnv = envelope(scaleGrid(resample(anchor.samples, 0, windowMs), accScale, gyrScale));
  return takes.map((t) => {
    if (t === anchor) return { ...t, shiftMs: 0 };
    const env = envOf(t, -L * STEP);
    let bestK = 0, bestC = -Infinity;
    for (let k = -L; k <= L; k++) {
      const c = pearson(anchorEnv, env, L + k, Math.min(n, anchorEnv.length)) - Math.abs(k) * 0.001;
      if (c > bestC) { bestC = c; bestK = k; }
    }
    const shift = bestK * STEP;
    return { ...t, shiftMs: shift, samples: t.samples.map((s) => [s[0] - shift, ...s.slice(1)]) };
  });
}

/** Each sample must be [songMs, ax, ay, az, rAlpha, rBeta, rGamma] with finite numbers. */
export function validSamples(s, { min = 20, max = 60000 } = {}) {
  return Array.isArray(s) && s.length >= min && s.length <= max
    && s.every((r) => Array.isArray(r) && r.length === DIMS + 1 && r.every((v) => Number.isFinite(v)));
}

/**
 * A chart crosses a JSON boundary and is fed straight into DTW, where a NaN tolerance or a
 * truncated reference would quietly score every move as zero. Phones check it before dancing.
 */
export function validChart(c) {
  return !!c && typeof c === 'object'
    && Number.isFinite(c.accScale) && c.accScale > 0
    && Number.isFinite(c.gyrScale) && c.gyrScale > 0
    && Array.isArray(c.segments) && c.segments.length > 0
    && c.segments.every((s) => Number.isInteger(s.i) && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
      && Number.isFinite(s.tol) && s.tol > 0
      && Array.isArray(s.ref) && s.ref.length > 0 && s.ref.length % DIMS === 0
      && s.ref.every((v) => Number.isFinite(v)));
}

/** Down-sampled intensity curve for drawing (e.g. "reference vs you" on the phone). */
export function intensityCurve(chart, seg, samples, points = 60) {
  const envR = envelope(Float64Array.from(seg.ref)); // the stored reference is already scaled
  let envP = null;
  if (samples) envP = envelope(scaleGrid(resample(samples, seg.start, seg.end), chart.accScale, chart.gyrScale));
  const pick = (env) => Array.from({ length: points }, (_, i) => {
    const a = Math.floor((i / points) * env.length), b = Math.max(a + 1, Math.floor(((i + 1) / points) * env.length));
    let m = 0; for (let j = a; j < b && j < env.length; j++) m = Math.max(m, env[j]); return +m.toFixed(3);
  });
  return { ref: pick(envR), you: envP ? pick(envP) : null };
}
