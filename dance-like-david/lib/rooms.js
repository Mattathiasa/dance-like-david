// WebSocket rooms.
// A room has one host (TV screen or studio laptop) and up to 8 players (phones).
// The server relays messages, provides a shared clock, keeps the official score tally,
// and holds a seat for 2 minutes when a phone or the TV drops off Wi-Fi.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { extendsStreak, scoreDetail, validSamples } from '../shared/motion.js';

const GRACE_MS = 120_000;
const MAX_PLAYERS = 8;
const MAX_GRADE_SAMPLES = 3000;
const MAX_BAD_JOINS = 10; // per socket, before we stop guessing codes for it
const MAX_ROOMS = 200; // a host that never disconnects would otherwise keep its room forever

export function attachRooms(server, { adminPassword, accounts, results, getSong, getChart }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });
  const rooms = new Map(); // code -> room
  const now = () => performance.timeOrigin + performance.now();
  const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const secret = () => crypto.randomBytes(12).toString('hex');
  const newCode = () => {
    let c;
    do c = String(crypto.randomInt(1000, 10000)); while (rooms.has(c));
    return c;
  };
  const playerList = (room) => [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name, connected: !!p.ws, signedIn: !!p.userId, ready: p.ready, device: p.device,
  }));

  function closeRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    for (const p of room.players.values()) { clearTimeout(p.timer); send(p.ws, { t: 'hostLeft' }); }
    clearTimeout(room.hostTimer);
    rooms.delete(code);
  }

  /**
   * The phone sends the motion it captured for the move; the server grades it against the same
   * chart the phone used, so a client can't claim PERFECT without a dance behind it. Returns the
   * verified grade for the TV to show, or null when the grade isn't part of the official tally.
   */
  async function tallyGrade(room, id, msg) {
    const g = room.game;
    if (!g || g.finished || g.mode === 'practice' || msg.practice || msg.test) return null;
    const p = room.players.get(id);
    let t = g.tally.get(id);
    if (!t) g.tally.set(id, (t = { name: p?.name || 'Dancer', userId: p?.userId || null, points: 0, counts: {}, streak: 0, maxStreak: 0, segGrades: {}, scoreSum: 0, pending: new Set() }));
    if (msg.seg in t.segGrades || t.pending.has(msg.seg)) return null; // duplicate, or a rejoin flush racing its own original
    if (g.scored ? !g.scored.has(msg.seg) : g.totalSegs && !(msg.seg >= 0 && msg.seg < g.totalSegs)) return null;
    t.pending.add(msg.seg);
    try {
      const chart = await getChart(g.songId);
      const seg = chart?.segments.find((s) => s.i === msg.seg);
      if (!seg) return null;
      const r = validSamples(msg.samples, { min: 5, max: MAX_GRADE_SAMPLES })
        ? scoreDetail(chart, seg, msg.samples)
        : { name: 'MISS', points: 0, score: 0, reason: 'no-data', tip: 'No motion reached the game' };
      t.segGrades[msg.seg] = r.name;
      t.points += r.points;
      t.scoreSum += Math.max(0, Math.min(100, r.score));
      t.counts[r.name] = (t.counts[r.name] || 0) + 1;
      t.streak = extendsStreak(r.name) ? t.streak + 1 : 0;
      t.maxStreak = Math.max(t.maxStreak, t.streak);
      return { ...msg, ...r, samples: undefined };
    } finally {
      t.pending.delete(msg.seg);
    }
  }

  async function finishGame(room) {
    const g = room.game;
    if (!g || g.finished) return null;
    g.finished = true;
    if (g.mode === 'practice') return { mode: 'practice', entries: [] };
    const song = await getSong(g.songId);
    for (const [id, p] of room.players) {
      if (!g.tally.has(id)) g.tally.set(id, { name: p.name, userId: p.userId || null, points: 0, counts: {}, streak: 0, maxStreak: 0, segGrades: {}, scoreSum: 0 });
    }
    const entries = [...g.tally.entries()].map(([playerId, t]) => ({
      playerId, userId: t.userId, name: t.name, points: t.points, counts: t.counts, maxStreak: t.maxStreak,
      accuracy: g.maxPoints ? Math.max(0, Math.min(100, Math.round((t.scoreSum || 0) / (g.maxPoints / 100)))) : 0,
      team: g.teams?.[playerId] || null, segGrades: t.segGrades,
    }));
    const recorded = await results.record({
      songId: g.songId, songTitle: song?.title || '', mode: g.mode, room: room.code, maxPoints: g.maxPoints, entries,
    });
    let teams = null;
    if (g.mode === 'teams' && g.teams) {
      teams = {};
      for (const e of recorded) {
        if (!e.team) continue;
        const tm = (teams[e.team] ||= { total: 0, members: 0 });
        tm.total += e.points;
        tm.members++;
      }
      for (const tm of Object.values(teams)) tm.average = Math.round(tm.total / tm.members);
      const order = Object.entries(teams).sort((a, b) => b[1].average - a[1].average);
      if (order.length) order[0][1].won = order.length < 2 || order[0][1].average > order[1][1].average;
    }
    return {
      mode: g.mode,
      songId: g.songId,
      maxPoints: g.maxPoints,
      teams,
      entries: recorded.map(({ segGrades, ...e }) => ({ ...e, missed: Object.entries(segGrades || {}).filter(([, v]) => v === 'MISS').map(([k]) => Number(k)) })),
    };
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.badJoins = 0;
    ws.on('pong', () => (ws.isAlive = true));
    ws.ctx = {};

    ws.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const ctx = ws.ctx;
      const room = ctx.code ? rooms.get(ctx.code) : null;

      switch (m.t) {
        case 'ping':
          return send(ws, { t: 'pong', c: m.c, s: now() });

        case 'host': {
          if (m.kind === 'studio' && m.pass !== adminPassword) return send(ws, { t: 'error', error: 'bad admin password' });
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', error: 'The server is hosting too many rooms — try again shortly' });
          const code = newCode();
          const r = { code, kind: m.kind === 'studio' ? 'studio' : 'game', host: ws, hostSecret: secret(), players: new Map(), game: null };
          rooms.set(code, r);
          Object.assign(ctx, { code, role: 'host' });
          return send(ws, { t: 'hosted', code, kind: r.kind, secret: r.hostSecret });
        }

        case 'rehost': {
          const r = rooms.get(String(m.code));
          if (!r || m.secret !== r.hostSecret) return send(ws, { t: 'error', error: 'room-gone' });
          clearTimeout(r.hostTimer);
          if (r.host && r.host !== ws) try { r.host.close(); } catch { /* ignore */ }
          r.host = ws;
          Object.assign(ctx, { code: r.code, role: 'host' });
          for (const p of r.players.values()) send(p.ws, { t: 'hostStatus', connected: true });
          return send(ws, { t: 'rehosted', code: r.code, kind: r.kind, players: playerList(r) });
        }

        case 'join': {
          const r = rooms.get(String(m.code || '').trim());
          if (!r) {
            // a 4-digit code is guessable; make guessing it a cost rather than a scan
            if (++ws.badJoins > MAX_BAD_JOINS) return send(ws, { t: 'error', error: 'Too many wrong codes — start a new join' });
            return send(ws, { t: 'error', error: 'No room with that code' });
          }
          ws.badJoins = 0;
          if (r.kind === 'studio' && [...r.players.values()].some((p) => p.ws)) return send(ws, { t: 'error', error: 'Studio already has a recorder phone' });
          if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', error: 'Room is full (8 dancers)' });
          const user = accounts.userForToken(m.token);
          const id = crypto.randomBytes(4).toString('hex');
          const name = (user?.displayName || String(m.name || 'Dancer')).trim().slice(0, 20) || 'Dancer';
          const p = { ws, name, userId: user?.id || null, secret: secret(), ready: false, device: String(m.device || '').slice(0, 200) };
          r.players.set(id, p);
          Object.assign(ctx, { code: r.code, role: 'player', id });
          send(ws, { t: 'joined', code: r.code, kind: r.kind, id, secret: p.secret, name, signedIn: !!user, hostConnected: !!r.host });
          return send(r.host, { t: 'playerJoined', id, name, signedIn: !!user, device: p.device });
        }

        case 'rejoin': {
          const r = rooms.get(String(m.code));
          const p = r?.players.get(m.id);
          if (!p || p.secret !== m.secret) return send(ws, { t: 'error', error: 'seat-gone' });
          clearTimeout(p.timer);
          if (p.ws && p.ws !== ws) try { p.ws.close(); } catch { /* ignore */ }
          p.ws = ws;
          Object.assign(ctx, { code: r.code, role: 'player', id: m.id });
          send(ws, { t: 'rejoined', code: r.code, kind: r.kind, id: m.id, hostConnected: !!r.host });
          return send(r.host, { t: 'playerStatus', id: m.id, connected: true });
        }

        case 'toPlayers': { // host -> all players (or one)
          if (!room || room.host !== ws) return;
          const msg = m.msg || {};
          if (msg.type === 'start') {
            const teams = msg.teams || null;
            const scored = Array.isArray(msg.scoredIdx) ? msg.scoredIdx.map(Number).filter(Number.isInteger) : null;
            room.game = { songId: msg.songId, mode: msg.mode || 'solo', teams, scored: scored && new Set(scored), totalSegs: Number(msg.totalSegs) || 0, maxPoints: Number(msg.maxPoints) || 0, startServer: msg.startServer, tally: new Map(), finished: false };
          }
          if (msg.type === 'practiceStart') room.game = { songId: msg.songId, mode: 'practice', tally: new Map(), finished: false };
          for (const [id, p] of room.players) if (!m.to || m.to === id) send(p.ws, { t: 'msg', msg });
          return;
        }

        case 'toHost': { // player -> host
          if (!room || ctx.role !== 'player') return;
          const msg = m.msg || {};
          const p = room.players.get(ctx.id);
          if (msg.type === 'ready' && p) p.ready = true;
          if (msg.type === 'grade') {
            const verified = await tallyGrade(room, ctx.id, msg);
            if (verified) return send(room.host, { t: 'msg', from: ctx.id, name: p?.name, msg: verified });
          }
          return send(room.host, { t: 'msg', from: ctx.id, name: p?.name, msg });
        }

        case 'finish': { // host: song over -> official results
          if (!room || room.host !== ws) return;
          const res = await finishGame(room);
          if (!res) return;
          send(ws, { t: 'finished', ...res });
          for (const e of res.entries) {
            const p = room.players.get(e.playerId);
            send(p?.ws, { t: 'msg', msg: { type: 'final', ...e, mode: res.mode, teams: res.teams, maxPoints: res.maxPoints } });
          }
          return;
        }

        case 'kick': {
          if (!room || room.host !== ws) return;
          const p = room.players.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          send(p.ws, { t: 'kicked' });
          room.players.delete(m.id);
          return send(ws, { t: 'playerLeft', id: m.id });
        }
      }
    });

    ws.on('close', () => {
      const { code, role, id } = ws.ctx;
      const room = rooms.get(code);
      if (!room) return;
      if (role === 'host' && room.host === ws) {
        room.host = null;
        for (const p of room.players.values()) send(p.ws, { t: 'hostStatus', connected: false });
        room.hostTimer = setTimeout(() => closeRoom(code), GRACE_MS);
      } else if (role === 'player') {
        const p = room.players.get(id);
        if (!p || p.ws !== ws) return;
        p.ws = null;
        send(room.host, { t: 'playerStatus', id, connected: false });
        p.timer = setTimeout(() => {
          room.players.delete(id);
          send(room.host, { t: 'playerLeft', id });
        }, GRACE_MS);
      }
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  wss.on('close', () => clearInterval(hb));

  return { rooms, wss };
}
