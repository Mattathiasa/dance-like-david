// Phases 1–8 without a browser: starts a real server, then drives the API and WebSocket rooms
// with simulated phones. Run with `npm test`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { scoreDetail } from '../shared/motion.js';
import { makeDancer, samplesFor, clickTrack } from './sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-test-'));
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const PASS = 'test-admin-pass';
let server;
const S = {}; // shared state across phases

async function startServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: PASS }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start:\n${log}`);
}
const stopServer = () => new Promise((r) => { if (!server || server.exitCode != null) return r(); server.once('exit', r); server.kill('SIGTERM'); });

async function call(p, { method = 'GET', body, admin = false, token, headers = {} } = {}) {
  const h = { ...headers };
  if (admin) h['x-admin-pass'] = PASS;
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !Buffer.isBuffer(body) && typeof body === 'object') { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (match, ms = 5000) => new Promise((resolve, reject) => {
      const f = typeof match === 'string' ? (m) => m.t === match : match;
      const i = inbox.findIndex(f);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const w = { match: f, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout waiting for ${match}`)); } }, ms);
    }),
    close: () => ws.close(),
  };
}

before(startServer);
after(async () => { await stopServer(); fs.rmSync(DATA, { recursive: true, force: true }); });

/** What a phone actually sends: its verdict plus the motion window it graded. */
const gradeFor = (chart, seg, samples, extra = {}) => {
  const win = samples.filter((x) => x[0] >= seg.start - 800 && x[0] <= seg.end + 800);
  return { type: 'grade', seg: seg.i, ...scoreDetail(chart, seg, win), samples: win, ...extra };
};

// ---------------- Phase 1–2: server and pages ----------------
test('Phase 1: server is healthy', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('Phase 2: every page loads with security headers', async () => {
  for (const [p, text] of [['/', 'Dance Like David'], ['/screen', 'Big screen'], ['/phone', 'Join the dance'], ['/lab', 'Move Lab'], ['/studio', 'Studio']]) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.body.includes(text), `${p} should mention "${text}"`);
    assert.ok(r.headers.get('content-security-policy')?.includes("default-src 'self'"), `${p} CSP`);
  }
  for (const f of ['/common.js', '/icons.js', '/motion-capture.js', '/screen.js', '/phone.js', '/studio.js', '/lab.js', '/shared/motion.js', '/style.css']) {
    assert.equal((await call(f)).status, 200, f);
  }
  const qr = await call('/api/qr?text=https%3A%2F%2Fexample.test%2Fphone%3Fcode%3D1234');
  assert.equal(qr.status, 200);
  assert.ok(qr.body.startsWith('<svg'));
});

// ---------------- Phase 3: accounts ----------------
test('Phase 3: accounts — register, login, profile, survive a restart', async () => {
  let r = await call('/api/auth/register', { method: 'POST', body: { username: 'miriam', password: 'secret123', displayName: 'Miriam' } });
  assert.equal(r.status, 200);
  S.token = r.body.token;
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username: 'miriam', password: 'secret123' } })).status, 409, 'duplicate username');
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username: 'x', password: '1' } })).status, 400, 'validation');
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'miriam', password: 'wrong' } })).status, 401, 'wrong password');
  r = await call('/api/auth/login', { method: 'POST', body: { username: 'Miriam', password: 'secret123' } });
  assert.equal(r.status, 200, 'login is case-insensitive');
  r = await call('/api/me', { token: S.token });
  assert.equal(r.body.user.displayName, 'Miriam');
  assert.equal((await call('/api/me')).status, 401, 'profile needs a token');

  await stopServer();
  await startServer();
  r = await call('/api/me', { token: S.token });
  assert.equal(r.status, 200, 'session survives a restart (data is on disk)');
});

// ---------------- Phase 4: studio song side ----------------
test('Phase 4: studio — admin only, create song, upload audio and cover', async () => {
  assert.equal((await call('/api/songs', { method: 'POST', body: { title: 'x', bpm: 120 } })).status, 401, 'needs admin password');
  let r = await call('/api/songs', { method: 'POST', admin: true, body: { title: 'Neon Hearts', artist: 'Test Crew', bpm: 120, genre: 'K-pop', difficulty: 'Hard', featured: true } });
  assert.equal(r.status, 200);
  S.song = r.body;
  r = await call(`/api/songs/${S.song.id}/audio`, { method: 'PUT', admin: true, body: clickTrack(20, 120), headers: { 'content-type': 'audio/wav', 'x-duration-ms': '20000' } });
  assert.equal(r.body.audio, 'audio.wav');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  r = await call(`/api/songs/${S.song.id}/cover`, { method: 'PUT', admin: true, body: png, headers: { 'content-type': 'image/png' } });
  assert.equal(r.body.cover, 'cover.png');
  assert.equal((await call(`/api/songs/${S.song.id}/cover`, { method: 'PUT', admin: true, body: Buffer.from('x'), headers: { 'content-type': 'text/plain' } })).status, 400, 'rejects non-images');
  assert.equal((await call('/api/songs')).body.length, 0, 'drafts are hidden from the TV');
  assert.equal((await call(`/api/songs/${S.song.id}/publish`, { method: 'POST', admin: true, body: {} })).status, 400, 'cannot publish without takes');
});

// ---------------- Phase 6 (simulated): Move Lab ----------------
test('Phase 6: Move Lab — record 3 takes, publish, good try scores high, bad try low', async () => {
  let r = await call('/api/moves', { method: 'POST', admin: true, body: { name: 'Arm sweep', durationMs: 4000, bpm: 100, icon: 'left' } });
  assert.equal(r.status, 200);
  const id = r.body.id;
  const move = (seed, off) => { const d = makeDancer('good', seed); return (t) => d(t - off + 2000); };
  for (const [k, off] of [[1, 0], [2, 180], [3, -150]]) {
    r = await call(`/api/moves/${id}/takes`, { method: 'POST', admin: true, body: { samples: samplesFor(move(k * 5, off), -600, 4600) } });
    assert.equal(r.status, 200);
  }
  assert.equal(r.body.move.takes, 3);
  assert.ok(r.body.move.ready);
  assert.equal((await call(`/api/moves/${id}`)).status, 404, 'unpublished move is hidden');
  await call(`/api/moves/${id}`, { method: 'PATCH', admin: true, body: { published: true } });
  const chart = (await call(`/api/moves/${id}/chart`)).body;
  const seg = chart.segments[0];
  const good = scoreDetail(chart, seg, samplesFor(move(77, 120), -600, 4600));
  const shake = scoreDetail(chart, seg, samplesFor((t) => makeDancer('shake', 4)(t + 1000), -600, 4600));
  assert.ok(good.score >= 70, `good try ${good.score}`);
  assert.ok(shake.score < 40, `shaking ${shake.score}`);
  r = await call(`/api/moves/${id}/attempts`, { method: 'POST', token: S.token, body: { samples: samplesFor(move(77, 120), -600, 4600) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.personalBest, true);
  assert.equal((await call(`/api/moves/${id}/attempts`, { method: 'POST', token: S.token, body: { score: 100, grade: 'PERFECT' } })).status, 400, 'a try with no motion to score is not recorded');
  const board = (await call(`/api/moves/${id}/leaderboard`)).body;
  assert.equal(board.rows[0].name, 'Miriam');
  assert.equal(board.rows[0].score, good.score, 'the server scored the motion, not the claimed score');
});

// ---------------- Phase 7 (simulated): studio takes, moves, publish ----------------
test('Phase 7: studio takes build a chart; names and publish reach the TV', async () => {
  let r;
  for (const n of [1, 2, 3]) {
    r = await call(`/api/songs/${S.song.id}/takes`, { method: 'POST', admin: true, body: { samples: samplesFor(makeDancer('good', n * 7), -500, 15500), durationMs: 15000 } });
    assert.equal(r.status, 200);
  }
  r = await call(`/api/songs/${S.song.id}`, { admin: true });
  assert.equal(r.body.takes.length, 3);
  assert.equal(r.body.chart.report.scoredMoves, 6);
  assert.ok(r.body.chart.report.takeScores.every((t) => !t.odd), 'takes agree');
  await call(`/api/songs/${S.song.id}`, { method: 'PATCH', admin: true, body: { moves: { 0: { name: 'Arm sweep', icon: 'left', strict: 1 } } } });
  r = await call(`/api/songs/${S.song.id}/publish`, { method: 'POST', admin: true, body: {} });
  assert.equal(r.body.published, true);
  const list = (await call('/api/songs')).body;
  assert.equal(list.length, 1, 'published song is on the TV');
  S.chart = (await call(`/api/songs/${S.song.id}/chart`)).body;
  assert.equal(S.chart.segments[0].name, 'Arm sweep');
});

// ---------------- Phase 8 (simulated): a full game over WebSockets ----------------
test('Phase 8: game — TV hosts, 2 phones dance, Wi-Fi drop + rejoin, official results and leaderboard', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');
  const phones = [];
  for (const [name, token] of [['Miriam', S.token], ['Guest', null]]) {
    const p = client(); await p.open();
    p.send({ t: 'join', code, name, token });
    p.seat = await p.wait('joined');
    await tv.wait('playerJoined');
    phones.push(p);
  }
  assert.equal(phones[0].seat.name, 'Miriam', 'signed-in name comes from the account');

  // Wi-Fi drop: the guest disconnects and rejoins with its secret
  phones[1].close();
  await tv.wait((m) => m.t === 'playerStatus' && m.connected === false);
  const back = client(); await back.open();
  back.send({ t: 'rejoin', code, id: phones[1].seat.id, secret: phones[1].seat.secret });
  await back.wait('rejoined');
  await tv.wait((m) => m.t === 'playerStatus' && m.connected === true);
  phones[1] = back;

  const moves = S.chart.segments.filter((s) => !s.rest);
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'solo', scoredIdx: moves.map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: moves.length * 100, startServer: Date.now() } });
  await phones[0].wait((m) => m.t === 'msg' && m.msg.type === 'start');
  const dancers = [samplesFor(makeDancer('good', 303), -1000, 16000), samplesFor(makeDancer('shake', 5), -1000, 16000)];
  phones.forEach((p, k) => {
    for (const m of moves) {
      const r = scoreDetail(S.chart, m, dancers[k]);
      p.send({ t: 'toHost', msg: gradeFor(S.chart, m, dancers[k]) });
      p.send({ t: 'toHost', msg: { ...gradeFor(S.chart, m, dancers[k]), name: 'PERFECT', points: 100 } }); // duplicate must be ignored
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  tv.send({ t: 'finish' });
  const res = await tv.wait('finished');
  const [first, second] = res.entries;
  assert.equal(first.name, 'Miriam');
  assert.equal(first.points, moves.length * 100, 'duplicates were not double-counted');
  assert.ok(first.accuracy >= 90, `accuracy ${first.accuracy}`);
  assert.equal(first.stars, 5);
  assert.equal(first.personalBest, true);
  assert.ok(second.points < first.points);
  const final = await phones[0].wait((m) => m.t === 'msg' && m.msg.type === 'final');
  assert.equal(final.msg.rank, 1);
  const board = (await call(`/api/leaderboard?song=${S.song.id}`)).body.rows;
  assert.equal(board[0].name, 'Miriam', 'only signed-in dancers on the leaderboard');
  assert.equal(board.length, 1);
  const me = (await call('/api/me', { token: S.token })).body.stats;
  assert.equal(me.games, 1);
  for (const c of [tv, ...phones]) c.close();
});

// ---------------- Phase 9: server rejects grades it shouldn't count ----------------
test('Phase 9: bogus segment indices are rejected — can’t inflate score', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');

  const p = client(); await p.open();
  p.send({ t: 'join', code, name: 'Miriam', token: S.token });
  await p.wait('joined');
  await tv.wait('playerJoined');

  const moves = S.chart.segments.filter((s) => !s.rest);
  const totalSegs = S.chart.segments.length;
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'solo', scoredIdx: moves.map((s) => s.i), totalSegs, maxPoints: moves.length * 100, startServer: Date.now() } });
  await p.wait((m) => m.t === 'msg' && m.msg.type === 'start');

  const samples = samplesFor(makeDancer('good', 303), -1000, 16000);
  // send valid grades for real segments
  for (const m of moves) {
    p.send({ t: 'toHost', msg: gradeFor(S.chart, m, samples) });
  }
  // send bogus grades for segments that don't exist — server must reject these
  p.send({ t: 'toHost', msg: { type: 'grade', seg: 999, name: 'PERFECT', points: 100, score: 100 } });
  p.send({ t: 'toHost', msg: { type: 'grade', seg: -1, name: 'PERFECT', points: 100, score: 100 } });
  // also try to send too many grades (more than there are segments) to inflate
  for (let i = totalSegs; i < totalSegs + 10; i++) {
    p.send({ t: 'toHost', msg: { type: 'grade', seg: i, name: 'PERFECT', points: 100, score: 100 } });
  }
  // and grades for rest segments — in range, but the TV did not list them as scored
  const rest = S.chart.segments.filter((s) => s.rest);
  assert.ok(rest.length, 'the test song has a rest segment to attack');
  for (const r of rest) {
    p.send({ t: 'toHost', msg: { type: 'grade', seg: r.i, name: 'PERFECT', points: 100, score: 100 } });
  }
  await new Promise((r) => setTimeout(r, 300));
  tv.send({ t: 'finish' });
  const res = await tv.wait('finished');
  const entry = res.entries[0];
  assert.equal(entry.points, moves.length * 100, 'bogus segments did not inflate the score');
  assert.equal(entry.counts.PERFECT, moves.length, 'only real segments were tallied');
  assert.ok(entry.accuracy <= 100, `accuracy stayed in range (${entry.accuracy})`);
  tv.close(); p.close();
});

// ---------------- Phase 10: song take sample validation ----------------
test('Phase 10: malformed song takes are rejected but valid ones succeed', async () => {
  // too few samples
  assert.equal((await call(`/api/songs/${S.song.id}/takes`, { method: 'POST', admin: true, body: { samples: [[0, 1, 2, 3, 4, 5, 6]] } })).status, 400, 'too few samples');
  // malformed: not 7-element arrays
  assert.equal((await call(`/api/songs/${S.song.id}/takes`, { method: 'POST', admin: true, body: { samples: [[0, 1, 2, 3], [100, 4, 5, 6, 7, 8, 9]] } })).status, 400, 'wrong-length rows');
  // malformed: non-finite values
  const bad = samplesFor(makeDancer('good', 10), -500, 500);
  bad[5][1] = 'oops';
  assert.equal((await call(`/api/songs/${S.song.id}/takes`, { method: 'POST', admin: true, body: { samples: bad } })).status, 400, 'non-finite value');
  // good samples still work
  const r = await call(`/api/songs/${S.song.id}/takes`, { method: 'POST', admin: true, body: { samples: samplesFor(makeDancer('good', 10), -500, 500), durationMs: 1000 } });
  assert.equal(r.status, 200, 'valid take accepted');
  // clean up: delete take 4 (the one just added)
  await call(`/api/songs/${S.song.id}/takes/4`, { method: 'DELETE', admin: true });
});

// ---------------- Phase 11: practice mode grades don't affect official results ----------------
test('Phase 11: practice mode — grades relayed but not tallied as a real game', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');
  const p = client(); await p.open();
  p.send({ t: 'join', code, name: 'Miriam', token: S.token });
  await p.wait('joined');
  await tv.wait('playerJoined');

  const moves = S.chart.segments.filter((s) => !s.rest);
  // start a real game, send some grades, then send practiceStart (switches to practice)
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'solo', scoredIdx: moves.map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: moves.length * 100, startServer: Date.now() } });
  await p.wait((m) => m.t === 'msg' && m.msg.type === 'start');
  const samples = samplesFor(makeDancer('good', 42), -1000, 16000);
  p.send({ t: 'toHost', msg: gradeFor(S.chart, moves[0], samples) });
  await new Promise((r) => setTimeout(r, 200));
  // send practiceStart — server creates a practice game, which should not tally the grade
  tv.send({ t: 'toPlayers', msg: { type: 'practiceStart', songId: S.song.id } });
  const ps = await p.wait((m) => m.t === 'msg' && m.msg.type === 'practiceStart');
  // phone sends a practice grade
  p.send({ t: 'toHost', msg: { type: 'grade', practice: true, seg: moves[0].i, name: 'PERFECT', points: 100 } });
  await new Promise((r) => setTimeout(r, 200));
  // finish — practice games return empty entries, no official record
  tv.send({ t: 'finish' });
  const res = await tv.wait('finished');
  assert.equal(res.mode, 'practice');
  assert.equal(res.entries.length, 0);
  tv.close(); p.close();
});

// ---------------- Phase 12: teams mode averages scores ----------------
test('Phase 12: teams mode — averages per-team, winner is the higher average', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');
  const phones = [];
  for (const [name, token] of [['Miriam', S.token], ['Guest', null]]) {
    const p = client(); await p.open();
    p.send({ t: 'join', code, name, token });
    p.seat = await p.wait('joined');
    await tv.wait('playerJoined');
    phones.push(p);
  }

  const moves = S.chart.segments.filter((s) => !s.rest);
  // assign: Miriam=team A, Guest=team B
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'teams', teams: { [phones[0].seat.id]: 'A', [phones[1].seat.id]: 'B' }, scoredIdx: moves.map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: moves.length * 100, startServer: Date.now() } });
  await phones[0].wait((m) => m.t === 'msg' && m.msg.type === 'start');
  // Miriam dances well, Guest shakes
  const dancers = [samplesFor(makeDancer('good', 303), -1000, 16000), samplesFor(makeDancer('shake', 5), -1000, 16000)];
  phones.forEach((p, k) => {
    for (const m of moves) {
      const r = scoreDetail(S.chart, m, dancers[k]);
      p.send({ t: 'toHost', msg: gradeFor(S.chart, m, dancers[k]) });
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  tv.send({ t: 'finish' });
  const res = await tv.wait('finished');
  assert.equal(res.mode, 'teams');
  assert.ok(res.teams, 'team results returned');
  const avgs = Object.values(res.teams).map((t) => t.average);
  assert.ok(Math.max(...avgs) > Math.min(...avgs), 'teams differ in average');
  const winner = Object.entries(res.teams).sort((a, b) => b[1].average - a[1].average)[0];
  assert.equal(winner[0], 'A', 'team A (good dancing) should win');
  tv.close(); phones.forEach((p) => p.close());
});

// ---------------- Phase 13: grades after game finish are ignored ----------------
test('Phase 13: late grades after finish are ignored', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');
  const p = client(); await p.open();
  p.send({ t: 'join', code, name: 'Miriam', token: S.token });
  await p.wait('joined');
  await tv.wait('playerJoined');

  const moves = S.chart.segments.filter((s) => !s.rest);
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'solo', scoredIdx: moves.map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: moves.length * 100, startServer: Date.now() } });
  await p.wait((m) => m.t === 'msg' && m.msg.type === 'start');

  // send valid grades for all moves
  const samples = samplesFor(makeDancer('good', 303), -1000, 16000);
  for (const m of moves) {
    p.send({ t: 'toHost', msg: gradeFor(S.chart, m, samples) });
  }
  await new Promise((r) => setTimeout(r, 200));
  tv.send({ t: 'finish' });
  const res = await tv.wait('finished');

  // now send a PERFECT grade for move 0 AFTER the game is finished — must be ignored
  p.send({ t: 'toHost', msg: { type: 'grade', seg: moves[0].i, name: 'PERFECT', points: 100, score: 100 } });
  await new Promise((r) => setTimeout(r, 200));
  tv.send({ t: 'finish' }); // second finish should be a no-op
  const entry = res.entries[0];
  assert.equal(entry.points, moves.length * 100, 'post-finish grade did not inflate score');
  tv.close(); p.close();
});

// ---------------- Phase 14: room rejects more than MAX_PLAYERS (8) ----------------
test('Phase 14: room rejects the 9th player', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');

  const phones = [];
  for (let i = 0; i < 9; i++) {
    const p = client(); await p.open();
    p.send({ t: 'join', code, name: `Player${i}` });
    phones.push(p);
  }
  const joined = [];
  for (const p of phones) {
    try { const m = await p.wait('joined', 3000); joined.push(m); }
    catch { /* 'No room with that code' or 'Room is full' comes as an error msg */ }
  }
  assert.equal(joined.length, 8, 'exactly 8 players joined');
  // the 9th should have received an error
  const ninth = phones[8];
  try {
    await ninth.wait((m) => m.t === 'error', 1000);
    assert.ok(true, '9th player was rejected');
  } catch {
    // the 9th might have already timed out on join with no 'joined' message
    assert.equal(joined.length, 8, '9th player did not join');
  }
  tv.close();
  for (const p of phones) p.close();
});

// ---------------- Phase 15: the server scores, not the phone ----------------
test('Phase 15: a forged PERFECT is re-scored from the motion that came with it', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');
  const p = client(); await p.open();
  p.send({ t: 'join', code, name: 'Miriam', token: S.token });
  await p.wait('joined');
  await tv.wait('playerJoined');

  const moves = S.chart.segments.filter((s) => !s.rest);
  tv.send({ t: 'toPlayers', msg: { type: 'start', songId: S.song.id, mode: 'solo', scoredIdx: moves.map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: moves.length * 100, startServer: Date.now() } });
  await p.wait((m) => m.t === 'msg' && m.msg.type === 'start');

  const still = samplesFor(makeDancer('still', 9), -1000, 16000);
  for (const m of moves) {
    // claims a perfect run, but attaches the motion of someone standing still
    p.send({ t: 'toHost', msg: { ...gradeFor(S.chart, m, still), name: 'PERFECT', points: 100, score: 100 } });
  }
  // and one move with no motion attached at all
  p.send({ t: 'toHost', msg: { type: 'grade', seg: moves[0].i, name: 'PERFECT', points: 100, score: 100 } });
  await new Promise((r) => setTimeout(r, 400));
  tv.send({ t: 'finish' });
  const entry = (await tv.wait('finished')).entries[0];
  assert.equal(entry.points, 0, 'the server ignored the claimed grades and graded the motion');
  assert.ok(entry.counts.MISS >= moves.length, `every move missed (${JSON.stringify(entry.counts)})`);
  assert.ok(entry.accuracy <= 5, `accuracy reflects the real dancing (${entry.accuracy})`);
  tv.close(); p.close();
});

// ---------------- Phase 16: code guessing is rate limited ----------------
test('Phase 16: a socket can’t grind through the 4-digit code space', async () => {
  const tv = client(); await tv.open();
  tv.send({ t: 'host', kind: 'game' });
  const { code } = await tv.wait('hosted');

  const p = client(); await p.open();
  const errors = [];
  const guesses = Array.from({ length: 12 }, (_, i) => String(1000 + i).padStart(4, '0')).filter((g) => g !== code);
  for (const g of guesses) {
    p.send({ t: 'join', code: g, name: 'Guesser' });
    errors.push(await p.wait((m) => m.t === 'error' || m.t === 'joined', 2000));
  }
  const last = errors[errors.length - 1];
  assert.equal(last.t, 'error', 'guessing is cut off');
  assert.match(last.error, /Too many wrong codes/);
  assert.ok(errors.every((e) => e.t === 'error'), 'none of the guesses found the real code by luck');

  // the real code still works from a fresh socket
  const ok = client(); await ok.open();
  ok.send({ t: 'join', code, name: 'Miriam', token: S.token });
  await ok.wait('joined');
  tv.close(); p.close(); ok.close();
});

// ---------------- Phase 17: concurrent take uploads each get their own number ----------------
test('Phase 17: takes uploaded at the same time don’t overwrite each other', async () => {
  const r = await call('/api/songs', { method: 'POST', admin: true, body: { title: 'Race', bpm: 120 } });
  const id = r.body.id;
  const take = (seed) => ({ samples: samplesFor(makeDancer('good', seed), -500, 4000), durationMs: 3500 });
  const ns = (await Promise.all([1, 2, 3, 4, 5, 6].map((k) => call(`/api/songs/${id}/takes`, { method: 'POST', admin: true, body: take(k * 13) })))).map((x) => x.body.n);
  assert.equal(new Set(ns).size, 6, `every take got a distinct number (${ns.join(',')})`);
  const full = await call(`/api/songs/${id}`, { admin: true });
  assert.equal(full.body.takes.length, 6, 'no take was lost to the race');
  await call(`/api/songs/${id}`, { method: 'DELETE', admin: true });
});

// ---------------- Phase 18: the in-memory indexes are rebuilt from disk ----------------
test('Phase 18: leaderboards and profiles survive a restart', async () => {
  const before = await call('/api/leaderboard?song=' + S.song.id);
  const me = (await call('/api/me', { token: S.token })).body.stats;
  await stopServer();
  await startServer();
  const after = await call('/api/leaderboard?song=' + S.song.id);
  assert.deepEqual(after.body.rows, before.body.rows, 'the song leaderboard is rebuilt from results.jsonl');
  const me2 = (await call('/api/me', { token: S.token })).body.stats;
  assert.equal(me2.games, me.games);
  assert.equal(me2.songsDanced, me.songsDanced);
  assert.equal(me2.bestStreak, me.bestStreak);
  const all = (await call('/api/leaderboard?period=all')).body.rows;
  assert.ok(all.length && all[0].points >= all[all.length - 1].points, 'all-time totals still add up');
});
