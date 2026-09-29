// Phone motion capture via the DeviceMotion API.
// Produces samples [performanceNowMs, ax, ay, az, rAlpha, rBeta, rGamma].

export class MotionCapture {
  constructor() {
    this.listeners = new Set();
    this.accSign = 1;
    this.gravity = [0, 0, 0];
    this.last = null;
    this.count = 0;
    this._handler = (e) => this._onMotion(e);
  }

  static supported() { return 'DeviceMotionEvent' in window; }
  static needsPermission() { return typeof DeviceMotionEvent?.requestPermission === 'function'; }

  /** Must be called from a user tap (iOS requires it). */
  async enable() {
    if (!window.isSecureContext) throw new Error('Motion sensors need HTTPS. Open this page through the https:// link.');
    if (!MotionCapture.supported()) throw new Error('This browser has no motion sensor support.');
    if (MotionCapture.needsPermission()) {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission was denied. Reload and tap Allow.');
    }
    window.addEventListener('devicemotion', this._handler);
    // Verify data actually arrives (desktop browsers fire nothing or all-null events).
    const start = this.count;
    await new Promise((r) => setTimeout(r, 1200));
    if (this.count - start < 5) throw new Error('No motion data is arriving. Use a phone with Chrome or Safari.');
    return this.rateHz();
  }

  rateHz() {
    return this._interval ? Math.round(1000 / this._interval) : null;
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    const a = e.acceleration;
    const r = e.rotationRate;
    if (!g || g.x == null) return;
    const now = performance.now();
    this._interval = e.interval > 1 ? e.interval : e.interval * 1000 || this._interval; // spec says ms; some old builds used s
    // low-pass gravity estimate (fallback if the browser has no gravity-free acceleration)
    const k = 0.9;
    this.gravity = [0, 1, 2].map((i) => k * this.gravity[i] + (1 - k) * [g.x, g.y, g.z][i]);
    let lin;
    if (a && a.x != null) lin = [a.x, a.y, a.z];
    else lin = [g.x - this.gravity[0], g.y - this.gravity[1], g.z - this.gravity[2]];
    const s = this.accSign;
    const sample = [now, s * lin[0], s * lin[1], s * lin[2], r?.alpha || 0, r?.beta || 0, r?.gamma || 0];
    this.last = { sample, gravity: [g.x, g.y, g.z] };
    this.count++;
    for (const fn of this.listeners) fn(sample);
  }

  onSample(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /**
   * Grip check: phone upright (portrait), screen facing you, held still.
   * Spec: that pose gives accelerationIncludingGravity.y ≈ +9.8. Some platforms report the opposite sign,
   * so we detect and normalise it — otherwise an iPhone reference would never match an Android player.
   */
  async calibrate(ms = 1500) {
    const reads = [];
    const off = this.onSample(() => reads.push(this.last.gravity));
    await new Promise((r) => setTimeout(r, ms));
    off();
    if (reads.length < 10) throw new Error('Not enough sensor data — try again.');
    const avg = [0, 1, 2].map((i) => reads.reduce((s, v) => s + v[i], 0) / reads.length);
    const mag = Math.hypot(...avg);
    const spread = Math.max(...reads.map((v) => Math.hypot(v[0] - avg[0], v[1] - avg[1], v[2] - avg[2])));
    if (spread > 2.5) return { ok: false, reason: 'Hold still for a moment.' };
    if (Math.abs(avg[1]) < 0.75 * mag) return { ok: false, reason: 'Hold the phone upright (portrait), screen facing you.' };
    this.accSign = avg[1] > 0 ? 1 : -1;
    return { ok: true, accSign: this.accSign, gravity: avg.map((v) => +v.toFixed(2)) };
  }
}

/** Keep the screen awake while dancing (the tab dies if the phone locks). */
export async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') { try { await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } }
    });
    return !!lock;
  } catch { return false; }
}
