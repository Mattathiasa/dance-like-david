// Move Lab: short stand-alone moves (2–8 s) recorded and tried on a phone alone — no song, TV or laptop needed.
// The admin records a move 2–5 times; anyone can try it and gets a 0–100 score with a tip.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildChart, alignTakes, validSamples } from '../shared/motion.js';
import { readJson, writeJson, updateJson, withLock } from './fsjson.js';

const ICONS = ['left', 'right', 'up', 'down', 'spin', 'wave', 'clap', 'punch'];
const LEAD_MS = 600; // takes and attempts are recorded from -LEAD_MS to duration + LEAD_MS

export async function createLab({ dataDir, isAdmin, accounts, limit, bearer }) {
  const root = path.join(dataDir, 'moves');
  await fsp.mkdir(root, { recursive: true });
  const attemptsFile = path.join(dataDir, 'lab.jsonl');
  const attempts = [];
  if (fs.existsSync(attemptsFile)) {
    for (const l of (await fsp.readFile(attemptsFile, 'utf8')).split('\n')) { if (l.trim()) try { attempts.push(JSON.parse(l)); } catch { /* torn line */ } }
  }

  const dir = (id) => path.join(root, id);
  const safeId = (id) => /^[a-z0-9-]{3,64}$/.test(id);
  const getMeta = (id) => (safeId(id) ? readJson(path.join(dir(id), 'meta.json')) : null);
  const takeNums = async (id) => (await fsp.readdir(dir(id)).catch(() => []))
    .map((f) => f.match(/^take-(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);

  const bestOf = (moveId, userId) => attempts.filter((a) => a.moveId === moveId && a.userId === userId).reduce((m, a) => Math.max(m, a.score), 0);
  const leaderboard = (moveId) => {
    const best = new Map();
    for (const a of attempts) {
      if (a.moveId !== moveId || !a.userId) continue;
      const cur = best.get(a.userId);
      if (!cur || a.score > cur.score) best.set(a.userId, { userId: a.userId, name: a.name, score: a.score, at: a.at });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, 20).map((r, i) => ({ rank: i + 1, ...r }));
  };

  async function summary(meta, full = false) {
    const chart = await readJson(path.join(dir(meta.id), 'chart.json'));
    const mine = attempts.filter((a) => a.moveId === meta.id);
    const out = {
      ...meta,
      takes: (await takeNums(meta.id)).length,
      ready: !!chart && !chart.segments[0]?.rest,
      best: mine.reduce((m, a) => Math.max(m, a.score), 0),
      tries: mine.length,
    };
    if (full && chart) out.report = { ...chart.report, tol: chart.segments[0]?.tol, rest: chart.segments[0]?.rest, energy: chart.segments[0]?.energy, shifts: chart.shifts };
    return out;
  }

  async function rebuild(id) {
    const meta = await getMeta(id);
    const takes = [];
    for (const n of await takeNums(id)) { const t = await readJson(path.join(dir(id), `take-${n}.json`)); if (t) takes.push({ n, samples: t.samples }); }
    const p = path.join(dir(id), 'chart.json');
    if (!takes.length) { await fsp.rm(p, { force: true }); return null; }
    const aligned = alignTakes(takes, meta.durationMs);
    const chart = buildChart({ id, segments: [{ i: 0, start: 0, end: meta.durationMs }] }, aligned);
    chart.shifts = aligned.map((t) => ({ n: t.n, shiftMs: t.shiftMs || 0 }));
    chart.kind = 'move';
    await writeJson(p, chart);
    return chart;
  }

  const clean = (b, base = {}) => {
    const out = { ...base };
    if ('name' in b) out.name = String(b.name || '').trim().slice(0, 40);
    if ('description' in b) out.description = String(b.description || '').trim().slice(0, 200);
    if ('icon' in b) out.icon = ICONS.includes(b.icon) ? b.icon : 'wave';
    if ('durationMs' in b) out.durationMs = Math.min(8000, Math.max(2000, Math.round(Number(b.durationMs) / 500) * 500 || 4000));
    if ('bpm' in b) out.bpm = Math.min(160, Math.max(60, Number(b.bpm) || 100));
    if ('metronome' in b) out.metronome = b.metronome !== false;
    if ('published' in b) out.published = !!b.published;
    return out;
  };
  const r = express.Router();
  const json = express.json({ limit: '5mb' });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const admin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Admin password required' }));
  const withMove = wrap(async (req, res, next) => {
    const m = await getMeta(req.params.id);
    if (!m || (!m.published && !isAdmin(req))) return res.status(404).json({ error: 'Move not found' });
    req.move = m;
    next();
  });

  r.get('/api/moves', wrap(async (req, res) => {
    const out = [];
    for (const id of await fsp.readdir(root).catch(() => [])) {
      const m = await getMeta(id);
      if (m && (m.published || isAdmin(req))) out.push(await summary(m, isAdmin(req)));
    }
    out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json(out);
  }));
  r.get('/api/moves/:id', withMove, wrap(async (req, res) => res.json(await summary(req.move, isAdmin(req)))));

  r.post('/api/moves', admin, json, wrap(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Give the move a name' });
    const slug = String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'move';
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    const meta = clean({ icon: 'wave', durationMs: 4000, bpm: 100, metronome: true, published: false, description: '', ...b }, { id, createdAt: new Date().toISOString() });
    await fsp.mkdir(dir(id), { recursive: true });
    await writeJson(path.join(dir(id), 'meta.json'), meta);
    res.json(await summary(meta, true));
  }));

  r.patch('/api/moves/:id', admin, json, withMove, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.published && !(await readJson(path.join(dir(req.move.id), 'chart.json')))) return res.status(400).json({ error: 'Record at least one take first' });
    const meta = await updateJson(path.join(dir(req.move.id), 'meta.json'), {}, (m) => clean(b, m));
    if ('durationMs' in b && b.durationMs !== req.move.durationMs) await rebuild(meta.id);
    res.json(await summary(meta, true));
  }));

  r.delete('/api/moves/:id', admin, withMove, wrap(async (req, res) => {
    await fsp.rm(dir(req.move.id), { recursive: true, force: true });
    res.json({ ok: true });
  }));

  r.post('/api/moves/:id/takes', admin, json, withMove, wrap(async (req, res) => {
    const { samples } = req.body || {};
    if (!validSamples(samples)) return res.status(400).json({ error: 'That take has no usable motion data' });
    const n = ((await takeNums(req.move.id)).at(-1) || 0) + 1;
    await writeJson(path.join(dir(req.move.id), `take-${n}.json`), { n, samples, createdAt: new Date().toISOString() });
    await rebuild(req.move.id);
    res.json({ n, move: await summary(await getMeta(req.move.id), true) });
  }));

  r.delete('/api/moves/:id/takes/:n', admin, withMove, wrap(async (req, res) => {
    await fsp.rm(path.join(dir(req.move.id), `take-${Number(req.params.n)}.json`), { force: true });
    await rebuild(req.move.id);
    res.json(await summary(await getMeta(req.move.id), true));
  }));

  r.get('/api/moves/:id/takes', admin, withMove, wrap(async (req, res) => {
    const chart = await readJson(path.join(dir(req.move.id), 'chart.json'));
    const scores = new Map((chart?.report.takeScores || []).map((t) => [t.n, t]));
    const out = [];
    for (const n of await takeNums(req.move.id)) {
      const t = await readJson(path.join(dir(req.move.id), `take-${n}.json`));
      out.push({ n, createdAt: t?.createdAt, samples: t?.samples.length || 0, ...(scores.get(n) || {}), shiftMs: chart?.shifts?.find((s) => s.n === n)?.shiftMs || 0 });
    }
    res.json(out);
  }));

  r.get('/api/moves/:id/chart', withMove, wrap(async (req, res) => {
    const chart = await readJson(path.join(dir(req.move.id), 'chart.json'));
    if (!chart) return res.status(404).json({ error: 'This move has no recording yet' });
    chart.segments = chart.segments.map((s) => ({ ...s, name: req.move.name, icon: req.move.icon, strict: 1 }));
    chart.leadMs = LEAD_MS;
    res.json(chart);
  }));

  r.post('/api/moves/:id/attempts', limit(40, 60000), json, withMove, wrap(async (req, res) => {
    const b = req.body || {};
    const score = Math.round(Number(b.score));
    if (!(score >= 0 && score <= 100)) return res.status(400).json({ error: 'Bad score' });
    const user = accounts.userForToken(bearer(req));
    const prev = user ? bestOf(req.move.id, user.id) : 0;
    const row = {
      at: Date.now(), moveId: req.move.id, userId: user?.id || null, name: user?.displayName || String(b.name || 'Guest').slice(0, 20),
      score, grade: ['PERFECT', 'GOOD', 'OK', 'MISS'].includes(b.grade) ? b.grade : 'MISS', reason: String(b.reason || '').slice(0, 20),
    };
    attempts.push(row);
    await withLock(attemptsFile, () => fsp.appendFile(attemptsFile, JSON.stringify(row) + '\n'));
    const board = leaderboard(req.move.id);
    res.json({ personalBest: !!user && score > prev, best: Math.max(prev, score), rank: user ? board.find((x) => x.userId === user.id)?.rank || null : null, signedIn: !!user });
  }));

  r.get('/api/moves/:id/leaderboard', withMove, (req, res) => res.json({ rows: leaderboard(req.move.id) }));

  return { router: r, userLabStats: (userId) => {
    const mine = attempts.filter((a) => a.userId === userId);
    return { tries: mine.length, movesTried: new Set(mine.map((a) => a.moveId)).size, bestScore: mine.reduce((m, a) => Math.max(m, a.score), 0) };
  } };
}
