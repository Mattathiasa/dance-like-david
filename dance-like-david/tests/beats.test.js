// Beat grid detection: a synthesised click track has a tempo and an offset we know,
// so the detector can be held to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTempo, onsetEnvelope } from '../shared/beats.js';

/** A click track with accented downbeats over a noise floor. Deterministic. */
function clickTrack({ bpm, offsetMs = 0, seconds = 40, sampleRate = 44100, noise = 0.02, beatsPerBar = 4 }) {
  const n = Math.floor(seconds * sampleRate);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i < n; i++) x[i] = noise * rnd();
  const beat = (sampleRate * 60) / bpm;
  const len = Math.floor(sampleRate * 0.04);
  for (let k = 0; ; k++) {
    const t = Math.floor((offsetMs / 1000) * sampleRate + k * beat);
    if (t >= n) break;
    const amp = k % beatsPerBar === 0 ? 1 : 0.55;
    for (let j = 0; j < len && t + j < n; j++) {
      x[t + j] += amp * Math.exp(-j / (sampleRate * 0.008)) * Math.sin((2 * Math.PI * 1000 * j) / sampleRate);
    }
  }
  return x;
}

test('onset envelope fires on the clicks, not between them', () => {
  const { env, onsetHz } = onsetEnvelope(clickTrack({ bpm: 120, seconds: 10 }), 44100);
  assert.ok(env.length > 500, `got ${env.length} frames`);
  const period = onsetHz / 2; // 120 BPM = 2 beats a second
  let on = 0, off = 0;
  for (let k = 1; k * period < env.length - 2; k++) {
    on += env[Math.round(k * period)];
    off += env[Math.round((k + 0.5) * period)];
  }
  assert.ok(on > off * 5, `on-beat ${on.toFixed(2)} should dwarf off-beat ${off.toFixed(2)}`);
});

for (const bpm of [96, 120, 128, 140]) {
  test(`finds ${bpm} BPM and the downbeat`, () => {
    const offsetMs = 437;
    const r = detectTempo(clickTrack({ bpm, offsetMs }), 44100);
    assert.ok(Math.abs(r.bpm - bpm) / bpm < 0.02, `bpm ${r.bpm} vs ${bpm}`);
    assert.ok(Math.abs(r.firstDownbeatMs - offsetMs) <= 25, `downbeat ${r.firstDownbeatMs} vs ${offsetMs}`);
    assert.ok(r.confidence > 2, `confidence ${r.confidence}`);
  });
}

test('the grid still lines up at the end of a long song, not just the start', () => {
  const bpm = 124, offsetMs = 200, seconds = 200;
  const r = detectTempo(clickTrack({ bpm, offsetMs, seconds }), 44100);
  const trueBeat = 60000 / bpm;
  const lastBeat = Math.floor((seconds * 1000 - offsetMs) / trueBeat);
  const drift = Math.abs((offsetMs + lastBeat * r.beatMs) - (offsetMs + lastBeat * trueBeat));
  assert.ok(drift < 120, `drifted ${drift.toFixed(0)} ms by the end of the song`);
});

test('a half-tempo click track is not read as double time', () => {
  const r = detectTempo(clickTrack({ bpm: 75, offsetMs: 0 }), 44100);
  assert.ok(Math.abs(r.bpm - 75) / 75 < 0.02 || Math.abs(r.bpm - 150) / 150 < 0.02, `bpm ${r.bpm}`);
});

test('silence and noise report no tempo instead of a made-up one', () => {
  assert.equal(detectTempo(new Float32Array(44100 * 5), 44100).bpm, null);
  assert.equal(detectTempo(new Float32Array(100), 44100).bpm, null);
});

// The browser tests play this exact WAV and expect the grid to land on its bars. Pinning it
// here means the fast suite catches a drift in detection before the five-minute one does.
test('the WAV click track the browser tests use is read to the millisecond', async () => {
  const { clickTrack } = await import('./sim.js');
  const buf = clickTrack(20, 120, 22050);
  const n = (buf.length - 44) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(44 + i * 2) / 32768;
  const d = detectTempo(x, 22050);
  assert.ok(Math.abs(d.bpm - 120) < 0.5, `bpm ${d.bpm}`);
  // the very first click has no quiet frame before it to rise from, so the grid starts at the
  // second bar — which is still a true downbeat, and where the moves should begin
  assert.ok(Math.abs(d.firstDownbeatMs - 2000) <= 15, `downbeat ${d.firstDownbeatMs}`);
});
