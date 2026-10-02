// Draws a detected beat grid over the onset curve, so the admin checks the timing by eye
// instead of trusting a number. Used by the phone recorder and the laptop studio.
const cssVar = (name, fallback) => window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * onset/onsetHz come from detectTempo in shared/beats.js. Only the first few bars are drawn:
 * a whole song squeezed into one canvas hides exactly the detail being checked.
 */
export function drawBeatGrid(canvas, { onset, onsetHz, bpm, firstBeatMs = 0, beatsPerBar = 4 }) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = cssVar('--surface-2', '#2A1D4D');
  g.fillRect(0, 0, W, H);
  if (!onset?.length) return;
  // No tempo yet is exactly when seeing the music helps most, so the curve is drawn either way
  // and only the beat marks wait for a BPM.
  const beatMs = bpm > 0 ? 60000 / bpm : 0;
  const msPerFrame = 1000 / onsetHz;
  const from = beatMs ? Math.max(0, firstBeatMs - beatMs) : 0;
  const span = beatMs ? Math.min(12000, Math.max(4000, beatMs * beatsPerBar * 4)) : 8000;

  let peak = 0.001;
  for (let i = Math.floor(from / msPerFrame); i < (from + span) / msPerFrame && i < onset.length; i++) peak = Math.max(peak, onset[i]);
  g.fillStyle = cssVar('--muted', '#9A8FB8');
  for (let x = 0; x < W; x++) {
    const a = Math.floor((from + (x / W) * span) / msPerFrame);
    const b = Math.max(a + 1, Math.floor((from + ((x + 1) / W) * span) / msPerFrame));
    let m = 0;
    for (let i = a; i < b && i < onset.length; i++) m = Math.max(m, onset[i]);
    const h = (m / peak) * (H - 8);
    g.fillRect(x, H - h, 1, h);
  }
  if (!beatMs) return;
  const gold = cssVar('--gold', '#F2C14E');
  for (let k = 0; ; k++) {
    const t = firstBeatMs + k * beatMs;
    if (t >= from + span) break;
    if (t < from) continue;
    const down = k % beatsPerBar === 0;
    g.fillStyle = gold;
    g.globalAlpha = down ? 1 : 0.4;
    g.fillRect(((t - from) / span) * W, down ? 0 : H * 0.35, down ? 2 : 1, down ? H : H * 0.65);
    g.globalAlpha = 1;
  }
}
