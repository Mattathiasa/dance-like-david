// Finished games: personal bests, room records, leaderboards, per-move miss rates.
// Results are appended to DATA/results.jsonl (one line per dancer per game) and kept in memory.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson, withLock } from './fsjson.js';
import { starsFor } from '../shared/motion.js';

export async function createResults(dataDir) {
  const file = path.join(dataDir, 'results.jsonl');
  const statsFile = path.join(dataDir, 'songstats.json');
  // rows are kept in `at` order, and indexed so a song's best doesn't need a pass over everything
  const rows = [];
  const bySong = new Map(); // songId -> { rows, best }
  const byUser = new Map(); // userId -> rows
  const add = (r) => {
    rows.push(r);
    let s = bySong.get(r.songId);
    if (!s) bySong.set(r.songId, (s = { rows: [], best: 0 }));
    s.rows.push(r);
    if (r.points > s.best) s.best = r.points;
    if (r.userId) {
      const mine = byUser.get(r.userId);
      if (mine) mine.push(r); else byUser.set(r.userId, [r]);
    }
  };
  if (fs.existsSync(file)) {
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { add(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
  }
  const stats = await readJson(statsFile, {}); // songId -> { plays, seg: { i: [misses, total] } }

  // rows for one song are in `at` order, so everything before a timestamp is a prefix
  const bestFor = (songId, userId, before = Infinity) => {
    const list = bySong.get(songId)?.rows;
    let m = 0;
    for (let i = (list?.length || 0) - 1; i >= 0 && list[i].at < before; i--) {
      if (list[i].userId === userId && list[i].points > m) m = list[i].points;
    }
    return m;
  };
  const songBest = (songId) => bySong.get(songId)?.best || 0;

  return {
    songBest,
    songStats: (songId) => stats[songId] || { plays: 0, seg: {} },

    /**
     * entries: [{ playerId, userId|null, name, points, counts, maxStreak, team, segGrades: {i: grade} }]
     * Returns the entries enriched with rank, stars, personalBest, roomRecord.
     */
    async record({ songId, songTitle, mode, room, maxPoints, entries }) {
      const at = Date.now();
      const prevRoomBest = songBest(songId);
      const ranked = [...entries].sort((a, b) => b.points - a.points);
      const out = ranked.map((e, i) => {
        const prevBest = e.userId ? bestFor(songId, e.userId, at) : 0;
        return {
          ...e,
          rank: i + 1,
          of: ranked.length,
          stars: starsFor(e.points, maxPoints),
          personalBest: !!e.userId && e.points > prevBest,
          roomRecord: e.points > 0 && e.points > prevRoomBest && i === 0,
        };
      });
      const logged = out.map((e) => ({
        at, songId, songTitle, mode, room, userId: e.userId || null, name: e.name, points: e.points,
        maxPoints, counts: e.counts, maxStreak: e.maxStreak, rank: e.rank, of: e.of, stars: e.stars, accuracy: e.accuracy ?? null,
      }));
      for (const r of logged) add(r);
      await withLock(file, () => fsp.appendFile(file, logged.map((r) => JSON.stringify(r)).join('\n') + '\n'));

      // per-move miss rates for the studio
      const st = (stats[songId] ||= { plays: 0, seg: {} });
      st.plays++;
      for (const e of entries) {
        for (const [i, g] of Object.entries(e.segGrades || {})) {
          const cell = (st.seg[i] ||= [0, 0]);
          cell[1]++;
          if (g === 'MISS') cell[0]++;
        }
      }
      await withLock(statsFile, () => writeJson(statsFile, stats));
      return out;
    },

    /** Best score per signed-in player. songId omitted = all-time total of personal bests across songs. */
    leaderboard({ songId, period = 'all', limit = 50 }) {
      const since = period === 'week' ? Date.now() - 7 * 864e5 : 0;
      const best = new Map(); // key -> { userId, name, points }
      for (const r of songId ? bySong.get(songId)?.rows || [] : rows) {
        if (!r.userId || r.at < since) continue;
        const key = songId ? r.userId : `${r.userId}|${r.songId}`;
        const cur = best.get(key);
        if (!cur || r.points > cur.points) best.set(key, { userId: r.userId, name: r.name, points: r.points });
      }
      let list = [...best.values()];
      if (!songId) {
        const total = new Map();
        for (const b of list) {
          const t = total.get(b.userId) || { userId: b.userId, name: b.name, points: 0 };
          t.points += b.points;
          total.set(b.userId, t);
        }
        list = [...total.values()];
      }
      return list.sort((a, b) => b.points - a.points).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
    },

    userStats(userId) {
      const mine = byUser.get(userId) || [];
      return {
        songsDanced: new Set(mine.map((r) => r.songId)).size,
        games: mine.length,
        perfects: mine.reduce((s, r) => s + (r.counts?.PERFECT || 0), 0),
        bestStreak: mine.reduce((m, r) => Math.max(m, r.maxStreak || 0), 0),
        history: mine.slice(-12).reverse().map((r) => ({
          songId: r.songId, songTitle: r.songTitle, at: r.at, points: r.points, rank: r.rank, of: r.of, mode: r.mode, stars: r.stars, accuracy: r.accuracy ?? null,
        })),
      };
    },
  };
}
