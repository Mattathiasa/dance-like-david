// Full end-to-end: studio -> publish -> accounts -> solo game with a Wi-Fi drop -> teams -> practice -> leaderboard.
import { chromium } from 'playwright';
import { makeDancer } from '../sim.js';
const BASE = process.env.BASE;
const OUT = process.env.OUT || '.';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];
const results = {};

const simScript = (kind, seed) => `
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
      if (x.type === 'start' || x.type === 'recordTake') { window.__clock = { startServer: x.startServer, fromMs: 0, speed: 1 }; seed += 13; dancer = makeDancer(${JSON.stringify(kind)}, seed); }
      if (x.type === 'practiceLoop') window.__clock = { startServer: x.startServer, fromMs: x.fromMs, speed: x.speed };
    });
    return ws;
  };
  window.WebSocket.prototype = WS.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  setInterval(() => {
    const c = window.__clock;
    const sp = c ? c.speed : 1;
    const t = c ? c.fromMs + (Date.now() - c.startServer) * sp : -1e9;
    const v = dancer(t);
    // dancing slower means gentler motion: acceleration ~ speed^2, rotation ~ speed
    const a = v.slice(0, 3).map((q) => q * sp * sp), r = v.slice(3).map((q) => q * sp);
    if (typeof DeviceMotionEvent !== 'undefined') window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: { x: a[0], y: a[1], z: a[2] },
      accelerationIncludingGravity: { x: a[0], y: a[1] + 9.81, z: a[2] },
      rotationRate: { alpha: r[0], beta: r[1], gamma: r[2] }, interval: 16,
    }));
  }, 16);
})();`;

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('TUNNEL') && !m.text().includes('fonts.g') && errors.push(`${name} console: ${m.text()}`));
};
async function phone(kind, seed, code, name, { register } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(simScript(kind, seed));
  const p = await ctx.newPage();
  watch(p, name);
  await p.goto(`${BASE}/phone?code=${code}`);
  if (register) {
    await p.click('#acct a');
    await p.click('[data-auth="register"]');
    await p.fill('#displayName', name);
    await p.fill('#username', register);
    await p.fill('#password', 'secret123');
    await p.click('#authBtn');
    await p.waitForSelector('#v-join:not([hidden])');
  } else {
    await p.fill('#name', name);
  }
  await p.click('#joinBtn');
  await p.waitForSelector('#v-grip:not([hidden])', { timeout: 10000 });
  await p.click('#gripBtn');
  await p.waitForSelector('#v-wait:not([hidden])', { timeout: 10000 });
  return p;
}

// ================= STUDIO =================
const sctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 1440, height: 900 } });
const studio = await sctx.newPage();
watch(studio, 'studio');
await studio.goto(`${BASE}/studio`);
await studio.fill('#pass', process.env.PASS);
await studio.click('#login button');
await studio.waitForSelector('#app:not([hidden])');
await studio.screenshot({ path: `${OUT}/01-studio-empty.png` });
await studio.fill('#title', 'Neon Hearts');
await studio.fill('#artist', 'Test Crew');
await studio.selectOption('#genre', 'K-pop');
await studio.selectOption('#difficulty', 'Hard');
await studio.fill('#bpm', '120');
await studio.check('#featured');
await studio.setInputFiles('#cover', process.env.COVER);
await studio.setInputFiles('#audio', process.env.WAV);
await studio.click('#formBtn');
await studio.waitForSelector('#v-record:not([hidden])', { timeout: 20000 });
await studio.waitForFunction(() => /^\d{4}$/.test(document.querySelector('#roomCode').textContent));
const scode = (await studio.textContent('#roomCode')).trim();
log('studio room', scode, '|', await studio.textContent('#recMeta'));
const rec = await phone('good', 5, scode, 'Matty');
await studio.waitForFunction(() => document.querySelector('#phoneState').textContent.includes('Ready'));
await studio.click('#camBtn');
await studio.waitForTimeout(600);
await studio.selectOption('#recLen', '15000');
for (let i = 1; i <= 3; i++) {
  await studio.waitForSelector('#recBtn:not([disabled])', { timeout: 30000 });
  await studio.click('#recBtn');
  if (i === 1) { await studio.waitForTimeout(8000); await studio.screenshot({ path: `${OUT}/02-studio-recording.png` }); await rec.screenshot({ path: `${OUT}/03-phone-recorder.png` }); }
  await studio.waitForFunction((n) => document.querySelectorAll('#takes .take').length >= n && !document.querySelector('#takes').textContent.includes('Recording now'), i, { timeout: 60000 });
  log(`take ${i}`, (await studio.textContent('#recErr')) || 'ok');
}
log('takes:', (await studio.textContent('#takes')).replace(/\s+/g, ' '));
await studio.screenshot({ path: `${OUT}/04-studio-takes.png` });
await studio.click('#toMoves');
await studio.waitForSelector('#v-moves:not([hidden])');
await studio.fill('#mvName', 'Arm sweep');
await studio.click('#mvIcons button[aria-label="Arrow left"]');
await studio.waitForTimeout(900);
log('checklist:', (await studio.textContent('#checklist')).replace(/\s+/g, ' '));
await studio.click('#publishBtn');
await studio.waitForFunction(() => document.querySelector('#publishBtn').textContent.includes('Unpublish'));
await studio.screenshot({ path: `${OUT}/05-studio-moves.png` });
await rec.close();

// ================= TV + SOLO =================
const tctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
const tv = await tctx.newPage();
watch(tv, 'tv');
await tv.goto(`${BASE}/screen`);
await tv.waitForFunction(() => /^\d{4}$/.test(document.querySelector('#roomCode').textContent));
await tv.waitForSelector('.song-card');
await tv.screenshot({ path: `${OUT}/06-tv-library.png` });
const code = (await tv.textContent('#roomCode')).trim();
await tv.click('.song-card');
await tv.waitForSelector('#v-lobby:not([hidden])');
const miriam = await phone('good', 11, code, 'Miriam', { register: 'miriam' });
const shaker = await phone('shake', 99, code, 'Shaker');
const couch = await phone('lazy', 7, code, 'Couch');
await tv.waitForFunction(() => (document.querySelector('#dancers').textContent.match(/Ready/g) || []).length === 3, null, { timeout: 15000 });
await tv.screenshot({ path: `${OUT}/07-tv-lobby.png` });
await miriam.screenshot({ path: `${OUT}/08-phone-wait.png` });
await tv.click('#startBtn');
await tv.waitForTimeout(9000);
// Wi-Fi drop on Miriam's phone for ~4 s mid-song: grades must queue and sync later
await miriam.evaluate(() => { const L = window.__ddl.link; L.reconnect = false; L.ws.close(); });
await miriam.waitForTimeout(1500);
await miriam.screenshot({ path: `${OUT}/09-phone-offline.png` });
await tv.screenshot({ path: `${OUT}/10-tv-play.png` });
await miriam.waitForTimeout(2500);
const queued = await miriam.evaluate(() => window.__ddl.P.outbox.length);
await miriam.evaluate(() => { const L = window.__ddl.link; L.reconnect = true; L._open(); });
log('queued while offline:', queued);
await shaker.screenshot({ path: `${OUT}/11-phone-dance.png` });
await tv.waitForSelector('#v-results:not([hidden])', { timeout: 45000 });
results.solo = (await tv.textContent('#podium')).replace(/\s+/g, ' ');
log('solo podium:', results.solo, '| title:', await tv.textContent('#resTitle'));
await tv.screenshot({ path: `${OUT}/12-tv-results.png` });
await miriam.waitForSelector('#v-results:not([hidden])');
log('miriam result:', (await miriam.textContent('#v-results')).replace(/\s+/g, ' ').slice(0, 160));
await miriam.screenshot({ path: `${OUT}/13-phone-results.png` });

// ================= TEAMS =================
await tv.click('#againBtn');
await tv.click('#modes button:nth-child(2)');
await tv.waitForTimeout(300);
await tv.click('#startBtn');
await tv.waitForTimeout(12000);
await tv.screenshot({ path: `${OUT}/14-tv-teams.png` });
await tv.waitForSelector('#v-results:not([hidden])', { timeout: 45000 });
log('teams:', await tv.textContent('#resTitle'), '|', await tv.textContent('#resSub'));
await tv.screenshot({ path: `${OUT}/14b-tv-teams-results.png` });

// ================= PRACTICE (shaker asks to practice missed moves) =================
await shaker.waitForSelector('#v-results:not([hidden])');
const practiceBtn = shaker.locator('#v-results button', { hasText: 'Practice my' });
log('shaker practice button:', await practiceBtn.count());
await practiceBtn.click();
await tv.waitForSelector('#v-practice:not([hidden])', { timeout: 10000 });
await tv.waitForTimeout(9000);
log('practice tries:', (await tv.textContent('#pTries')).replace(/\s+/g, ' '));
await tv.screenshot({ path: `${OUT}/15-tv-practice.png` });
await shaker.screenshot({ path: `${OUT}/16-phone-practice.png` });
await tv.click('#pExit');

// ================= PROFILE + LEADERBOARD =================
await miriam.waitForSelector('#v-wait:not([hidden])');
await miriam.click('#waitLinks button:nth-child(2)');
await miriam.waitForSelector('#v-board .lb', { timeout: 10000 });
log('leaderboard:', (await miriam.textContent('#v-board')).replace(/\s+/g, ' ').slice(0, 140));
await miriam.screenshot({ path: `${OUT}/17-phone-leaderboard.png` });
await miriam.evaluate(() => document.querySelector('#v-board .icon-btn').click());
await miriam.click('#waitLinks button:first-child');
await miriam.waitForSelector('#v-profile .stat3', { timeout: 10000 });
log('profile:', (await miriam.textContent('#v-profile')).replace(/\s+/g, ' ').slice(0, 160));
await miriam.screenshot({ path: `${OUT}/18-phone-profile.png` });
const join = await browser.newPage({ viewport: { width: 390, height: 844 } });
await join.goto(`${BASE}/phone?code=${code}`);
await join.screenshot({ path: `${OUT}/19-phone-join.png` });
const home = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await home.goto(`${BASE}/`);
await home.screenshot({ path: `${OUT}/20-home.png` });
log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
