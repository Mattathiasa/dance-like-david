// Simulated dancers for tests. A "choreography" of 2-second moves; every 4th move is a rest.
export function makeDancer(kind, seed = 1, { lateMs = 0, scale = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return u - 3; };
  const jitter = (rnd() - 0.5) * 160;
  const amp = 0.9 + rnd() * 0.2;
  const segMs = 2000;
  return (t0) => {
    const t = t0 - lateMs;
    if (kind === 'shake' && t >= 0) return [0, 1, 2, 3, 4, 5].map((d) => (d < 3 ? 8 : 250) * Math.sin(2 * Math.PI * 6 * t / 1000 + d) + gauss() * (d < 3 ? 2 : 40));
    if (kind === 'still') return [0, 1, 2, 3, 4, 5].map(() => gauss() * 0.05);
    const tt = t - jitter;
    const k = Math.floor(tt / segMs), ph = (tt % segMs) / segMs;
    if (tt < 0 || k % 4 === 3) return [0, 1, 2, 3, 4, 5].map(() => gauss() * 0.1);
    const axis = k % 3, f = 1 + (k % 2), env = Math.sin(Math.PI * ph);
    const a = [0, 0, 0], r = [0, 0, 0];
    a[axis] = 5 * Math.sin(2 * Math.PI * f * ph) * env;
    a[(axis + 1) % 3] = 2 * Math.cos(2 * Math.PI * f * ph) * env;
    r[(axis + 2) % 3] = 150 * Math.sin(2 * Math.PI * f * ph + 0.5) * env;
    const m = kind === 'lazy' ? 0.15 : kind === 'mirror' ? -1 : amp * scale;
    return [...a, ...r].map((v, i) => v * m + gauss() * (i < 3 ? 0.4 : 12));
  };
}

export function samplesFor(fn, from, to, hz = 60) {
  const out = [];
  for (let t = from; t < to; t += 1000 / hz) out.push([+t.toFixed(1), ...fn(t).map((v) => +v.toFixed(3))]);
  return out;
}

/** A 16-bit mono WAV click track with accented downbeats (so tests don't need a real song file,
 *  and so beat detection has an unambiguous first beat to find). */
export function clickTrack(seconds = 20, bpm = 120, sr = 8000) {
  const n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const beat = (sr * 60) / bpm;
  for (let i = 0; i < n; i++) {
    const env = Math.exp(-(i % beat) / (sr * 0.03));
    const accent = Math.floor(i / beat) % 4 === 0 ? 1 : 0.45;
    buf.writeInt16LE(Math.round(0.5 * accent * env * Math.sin((2 * Math.PI * 880 * i) / sr) * 32767), 44 + i * 2);
  }
  return buf;
}
