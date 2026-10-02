// /record — the phone-only song recorder. Proves one device can take a song from an audio file
// to published: beat grid detected, takes recorded, a section patched, a test run scored.
import { chromium } from 'playwright';
import { makeDancer } from '../sim.js';
const BASE = process.env.BASE;
const OUT = process.env.OUT || '.';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];

// The recorder has no WebSocket, so the song clock is published on window.__recClock.
const simScript = (kind, seed) => `
(() => {
  ${makeDancer.toString()}
  let seed = ${seed}, dancer = makeDancer(${JSON.stringify(kind)}, seed), last = null;
  setInterval(() => {
    let t = -1e9;
    const c = window.__recClock;
    if (c) {
      if (c !== last) { last = c; seed += 11; dancer = makeDancer(${JSON.stringify(kind)}, seed); }
      t = c.fromMs + (performance.now() - c.startAt);
      if (t < -700) t = -1e9;
    }
    const v = dancer(t);
    if (typeof DeviceMotionEvent !== 'undefined') window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: { x: v[0], y: v[1], z: v[2] },
      accelerationIncludingGravity: { x: v[0], y: v[1] + 9.81, z: v[2] },
      rotationRate: { alpha: v[3], beta: v[4], gamma: v[5] }, interval: 16,
    }));
  }, 16);
})();`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(simScript('good', 5));
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(`record: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/TUNNEL|fonts\.g|DeviceMotionEvent/.test(m.text()) && errors.push(`record console: ${m.text()}`));

const fail = (msg) => { errors.push(msg); log('✖', msg); };

await p.goto(`${BASE}/record`);
await p.click('button:has-text("Admin: sign in to record")');
await p.fill('#v-unlock input[type=password]', process.env.PASS);
await p.click('button:has-text("Unlock recording")');
await p.waitForSelector('button:has-text("New song")');
await p.screenshot({ path: `${OUT}/R1-record-home.png` });

// ---- new song: the audio file volunteers its tempo ----
await p.click('button:has-text("New song")');
await p.fill('#v-new input[placeholder^="e.g."]', 'Neon Hearts');
await p.setInputFiles('#v-new input[type=file]', process.env.WAV);
await p.waitForSelector('#v-new canvas', { timeout: 20000 });
const detected = (await p.textContent('#v-new .detected')).replace(/\s+/g, ' ');
log('detected:', detected);
if (!/\b12[01] BPM/.test(detected)) fail(`tempo should be read as 120 BPM, got "${detected}"`);
if (!/clear beat/.test(detected)) fail(`a click track should read as a clear beat, got "${detected}"`);
if (!/first beat at 1\.9\d s/.test(detected)) fail(`the first downbeat of this click track is at 2.0 s, got "${detected}"`);
await p.screenshot({ path: `${OUT}/R2-record-beatgrid.png`, fullPage: true });

await p.click('button:has-text("Create and record")');
await p.waitForSelector('#v-song:not([hidden])', { timeout: 20000 });
if (!/No takes yet/.test(await p.textContent('#v-song'))) fail('a new song should say it has no takes');
await p.screenshot({ path: `${OUT}/R3-record-song-empty.png`, fullPage: true });

// ---- takes: the phone plays the song and records against it ----
async function record(button, n, shots = false) {
  await p.click(button);
  if (n === 1) { await p.waitForSelector('#v-grip:not([hidden])'); await p.click('#v-grip button.btn-primary'); }
  await p.waitForSelector('#v-perform:not([hidden])');
  if (shots) { await p.waitForTimeout(900); await p.screenshot({ path: `${OUT}/R4-record-countin.png` }); await p.waitForTimeout(2500); await p.screenshot({ path: `${OUT}/R5-record-recording.png` }); }
  await p.waitForFunction((k) => document.querySelectorAll('#v-song .take-row').length >= k, n, { timeout: 90000 });
  log(`take ${n} saved`);
}
await record('button:has-text("Record the whole song")', 1, true);
if (!/One take is enough to play/.test(await p.textContent('#v-song'))) fail('one take should be presented as playable');
await record('button:has-text("Record the whole song")', 2);
await p.screenshot({ path: `${OUT}/R6-record-two-takes.png`, fullPage: true });

// ---- patch a section: only those moves should use the new take ----
await p.click('button:has-text("Fix a section")');
await p.waitForSelector('.range-list button');
const section = (await p.textContent('.range-list button')).replace(/\s+/g, ' ');
log('patching section:', section);
await p.click('.range-list button');
await p.waitForSelector('#v-perform:not([hidden])');
await p.waitForFunction(() => document.querySelectorAll('#v-song .take-row').length >= 3, null, { timeout: 90000 });
const rows = await p.$$eval('#v-song .take-row', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ')));
log('takes:', rows.join(' | '));
if (rows.filter((r) => /Whole song/.test(r)).length !== 2) fail(`two full takes expected, got: ${rows.join(' | ')}`);
const patch = rows.find((r) => !/Whole song/.test(r));
if (!patch || !/\d:\d\d–\d:\d\d/.test(patch)) fail(`the patch take should show the range it covered, got: ${rows.join(' | ')}`);
await p.screenshot({ path: `${OUT}/R7-record-patched.png`, fullPage: true });

// ---- test run: the dancer who recorded it should score well against it ----
await p.click('button:has-text("Test it")');
await p.waitForSelector('#v-perform:not([hidden])');
await p.waitForSelector('#v-result:not([hidden]) .scores', { timeout: 90000 });
const result = (await p.textContent('#v-result')).replace(/\s+/g, ' ');
const acc = Number(result.match(/(\d+)%/)?.[1]);
log('test run:', result.slice(0, 160));
if (!(acc >= 70)) fail(`the dancer who recorded the reference should score well, got ${acc}%`);
await p.screenshot({ path: `${OUT}/R8-record-testrun.png`, fullPage: true });

// ---- publish ----
await p.click('button:has-text("Back to the song")');
await p.click('button:has-text("Publish to the big screen")');
await p.waitForSelector('button:has-text("Unpublish")', { timeout: 20000 });
const live = await fetch(`${BASE}/api/songs`).then((r) => r.json());
if (live.length !== 1 || live[0].title !== 'Neon Hearts') fail(`the published song should reach the TV, got ${JSON.stringify(live.map((x) => x.title))}`);
log('published and visible to the TV');
await p.screenshot({ path: `${OUT}/R9-record-published.png`, fullPage: true });

await browser.close();
if (errors.length) { console.error('\nFAILURES:\n' + errors.join('\n')); process.exit(1); }
log('record: all checks passed');
