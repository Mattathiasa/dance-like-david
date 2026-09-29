// Move Lab (phone only) + Studio test run + accuracy in a game.
import { chromium } from 'playwright';
import { makeDancer } from '../sim.js';
const BASE = process.env.BASE;
const OUT = process.env.OUT || '.';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];

const simScript = (kind, seed, labOffset = 2000) => `
(() => {
  ${makeDancer.toString()}
  let seed = ${seed}, dancer = makeDancer(${JSON.stringify(kind)}, seed);
  window.__clock = null;
  const WS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new WS(...args);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== 'msg') return;
      const x = m.msg;
      if (x.type === 'start' || x.type === 'recordTake' || x.type === 'testRun') { window.__clock = { startServer: x.startServer }; seed += 13; dancer = makeDancer(${JSON.stringify(kind)}, seed); }
    });
    return ws;
  };
  window.WebSocket.prototype = WS.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  let lastLab = null;
  setInterval(() => {
    let t = -1e9;
    if (window.__labClock) {
      if (window.__labClock !== lastLab) { lastLab = window.__labClock; seed += 7; dancer = makeDancer(${JSON.stringify(kind)}, seed); }
      t = performance.now() - window.__labClock.moveStart;
      t = t < -500 ? -1e9 : t + ${labOffset};
    } else if (window.__clock) t = Date.now() - window.__clock.startServer;
    const v = dancer(t);
    if (typeof DeviceMotionEvent !== 'undefined') window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: { x: v[0], y: v[1], z: v[2] },
      accelerationIncludingGravity: { x: v[0], y: v[1] + 9.81, z: v[2] },
      rotationRate: { alpha: v[3], beta: v[4], gamma: v[5] }, interval: 16,
    }));
  }, 16);
})();`;

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/TUNNEL|fonts\.g|DeviceMotionEvent/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
};
async function phonePage(kind, seed, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(simScript(kind, seed));
  const p = await ctx.newPage();
  watch(p, name);
  return p;
}
async function labTry(p, label) {
  await p.click('button:has-text("Try it")');
  if (await p.locator('#v-grip:not([hidden])').count() || await p.waitForSelector('#v-grip:not([hidden])', { timeout: 4000 }).catch(() => null)) {
    await p.click('#v-grip button.btn-primary');
  }
  await p.waitForSelector('#v-perform:not([hidden])');
  await p.waitForSelector('#v-result:not([hidden]) .ring', { timeout: 20000 });
  await p.waitForTimeout(1200);
  const txt = (await p.textContent('#v-result')).replace(/\s+/g, ' ');
  log(`${label}:`, txt.slice(0, 170));
  return txt;
}

// ================= MOVE LAB =================
const admin = await phonePage('good', 3, 'lab-admin');
await admin.goto(`${BASE}/lab`);
await admin.screenshot({ path: `${OUT}/L1-lab-home-empty.png` });
await admin.click('button:has-text("Admin: record moves")');
await admin.fill('#apass', process.env.PASS);
await admin.click('button:has-text("Unlock recording")');
await admin.click('button:has-text("Record a new move")');
await admin.fill('input[placeholder^="e.g."]', 'Arm sweep');
await admin.fill('input[placeholder^="One line"]', 'Sweep your right arm across your body, then roll the wrist.');
await admin.click('button[aria-label="Arrow left"]');
await admin.click('button:has-text("Create and record takes")');
await admin.waitForSelector('button:has-text("Record a take")');
for (let i = 1; i <= 3; i++) {
  await admin.click('button:has-text("Record a take")');
  if (i === 1) { await admin.waitForSelector('#v-grip:not([hidden])'); await admin.click('#v-grip button.btn-primary'); }
  await admin.waitForSelector('#v-perform:not([hidden])');
  if (i === 1) { await admin.waitForTimeout(1200); await admin.screenshot({ path: `${OUT}/L2-lab-countin.png` }); await admin.waitForTimeout(2200); await admin.screenshot({ path: `${OUT}/L3-lab-recording.png` }); }
  await admin.waitForSelector('#v-edit:not([hidden]) .take-row >> nth=' + (i - 1), { timeout: 20000 });
  log(`lab take ${i} saved`);
}
await admin.waitForTimeout(500);
log('takes:', (await admin.textContent('#v-edit')).replace(/\s+/g, ' ').match(/Takes.*?(?=Record a take)/)?.[0]);
await admin.screenshot({ path: `${OUT}/L4-lab-edit.png`, fullPage: true });
await admin.click('button:has-text("Publish to everyone")');
await admin.waitForSelector('button:has-text("Unpublish")');

const player = await phonePage('good', 41, 'lab-player');
await player.goto(`${BASE}/lab`);
await player.waitForSelector('.move-row');
await player.screenshot({ path: `${OUT}/L5-lab-home.png` });
await player.click('.move-row');
await player.waitForSelector('#v-move:not([hidden]) .curve');
await player.screenshot({ path: `${OUT}/L6-lab-move.png` });
const good = await labTry(player, 'good dancer');
await player.screenshot({ path: `${OUT}/L7-lab-result-good.png`, fullPage: true });

const shaker = await phonePage('shake', 9, 'lab-shaker');
await shaker.goto(`${BASE}/lab`);
await shaker.click('.move-row');
const bad = await labTry(shaker, 'shaker');
await shaker.screenshot({ path: `${OUT}/L8-lab-result-shaker.png`, fullPage: true });

const lazy = await phonePage('lazy', 9, 'lab-lazy');
await lazy.goto(`${BASE}/lab`);
await lazy.click('.move-row');
const small = await labTry(lazy, 'tiny moves');
const scoreOf = (t) => Number(t.match(/(\d+)\s?(PERFECT|GOOD|OK|MISS)/)?.[1]);
log('LAB SCORES good/shaker/tiny:', scoreOf(good), scoreOf(bad), scoreOf(small));

// ================= STUDIO TEST RUN =================
const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const studio = await sctx.newPage();
watch(studio, 'studio');
await studio.goto(`${BASE}/studio`);
await studio.fill('#pass', process.env.PASS);
await studio.click('#login button');
await studio.waitForSelector('#app:not([hidden])');
await studio.fill('#title', 'Neon Hearts');
await studio.fill('#bpm', '120');
await studio.setInputFiles('#audio', process.env.WAV);
await studio.click('#formBtn');
await studio.waitForSelector('#v-record:not([hidden])', { timeout: 20000 });
await studio.waitForFunction(() => /^\d{4}$/.test(document.querySelector('#roomCode').textContent));
const scode = (await studio.textContent('#roomCode')).trim();
const rec = await phonePage('good', 5, 'recorder');
await rec.goto(`${BASE}/phone?code=${scode}`);
await rec.fill('#name', 'Matty');
await rec.click('#joinBtn');
await rec.waitForSelector('#v-grip:not([hidden])');
await rec.click('#gripBtn');
await rec.waitForSelector('#v-wait:not([hidden])');
await studio.selectOption('#recLen', '15000');
for (let i = 1; i <= 3; i++) {
  await studio.waitForSelector('#recBtn:not([disabled])', { timeout: 30000 });
  await studio.click('#recBtn');
  await studio.waitForFunction((n) => document.querySelectorAll('#takes .take').length >= n && !document.querySelector('#takes').textContent.includes('Recording now'), i, { timeout: 60000 });
}
log('studio takes recorded');
await studio.waitForSelector('#testBtn:not([disabled])');
await studio.click('#testBtn');
await studio.waitForTimeout(12000);
await rec.screenshot({ path: `${OUT}/S1-phone-testrun.png` });
await studio.waitForFunction(() => document.querySelector('#testPanel h2')?.textContent.includes('result'), null, { timeout: 40000 });
log('test run:', (await studio.textContent('#testPanel')).replace(/\s+/g, ' ').slice(0, 200));
await studio.screenshot({ path: `${OUT}/S2-studio-testrun.png`, fullPage: true });
await rec.waitForTimeout(2000);
log('phone after test run:', (await rec.textContent('#waitBig')).replace(/\s+/g, ' '));
await studio.click('[data-view="moves"]');
await studio.click('#publishBtn');
await studio.waitForFunction(() => document.querySelector('#publishBtn').textContent.includes('Unpublish'));
await rec.close();

// ================= GAME ACCURACY =================
const tv = await (await browser.newContext({ viewport: { width: 1440, height: 810 } })).newPage();
watch(tv, 'tv');
await tv.goto(`${BASE}/screen`);
await tv.waitForFunction(() => /^\d{4}$/.test(document.querySelector('#roomCode').textContent));
const code = (await tv.textContent('#roomCode')).trim();
await tv.waitForSelector('.song-card');
await tv.click('.song-card');
const ps = [];
for (const [kind, seed, name] of [['good', 11, 'Miriam'], ['lazy', 7, 'Couch']]) {
  const p = await phonePage(kind, seed, name);
  await p.goto(`${BASE}/phone?code=${code}`);
  await p.fill('#name', name);
  await p.click('#joinBtn');
  await p.waitForSelector('#v-grip:not([hidden])');
  await p.click('#gripBtn');
  await p.waitForSelector('#v-wait:not([hidden])');
  ps.push(p);
}
await tv.waitForFunction(() => (document.querySelector('#dancers').textContent.match(/Ready/g) || []).length === 2, null, { timeout: 15000 });
await tv.click('#startBtn');
await tv.waitForTimeout(10000);
await ps[1].screenshot({ path: `${OUT}/G1-phone-tip.png` });
await tv.screenshot({ path: `${OUT}/G2-tv-live.png` });
await tv.waitForSelector('#v-results:not([hidden])', { timeout: 45000 });
log('game results:', (await tv.textContent('#podium')).replace(/\s+/g, ' '), '|', await tv.textContent('#resMovesTitle'));
await tv.screenshot({ path: `${OUT}/G3-tv-results.png` });
await ps[0].waitForSelector('#v-results:not([hidden])');
log('phone result:', (await ps[0].textContent('#v-results')).replace(/\s+/g, ' ').slice(0, 120));
log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
