// Dance Like David — server
// Static files, REST API (songs, takes, charts, covers, accounts, leaderboards) and WebSocket rooms.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { buildChart, validSamples, validChart } from './shared/motion.js';
import { readJson, writeJson, updateJson, createJson, httpError } from './lib/fsjson.js';
import { createAccounts } from './lib/accounts.js';
import { createResults } from './lib/results.js';
import { attachRooms } from './lib/rooms.js';
import { createLab } from './lib/lab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'david';
if (!process.env.ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD not set — using "david". Set it before deploying.');

export const GENRES = ['K-pop', 'Pop', 'Afrobeats', 'Worship', 'Kids', 'Other'];
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
export const ICONS = ['left', 'right', 'up', 'down', 'spin', 'wave', 'clap', 'punch'];

await fsp.mkdir(path.join(DATA, 'songs'), { recursive: true });
const accounts = await createAccounts(DATA);
const results = await createResults(DATA);

// ---------- song storage ----------
const songDir = (id) => path.join(DATA, 'songs', id);
const safeId = (id) => /^[a-z0-9-]{3,64}$/.test(id);
const metaPath = (id) => path.join(songDir(id), 'meta.json');
const getMeta = (id) => (safeId(id) ? readJson(metaPath(id)) : null);
const updateMeta = (id, fn) => updateJson(metaPath(id), {}, fn);

async function listTakes(id) {
  const files = await fsp.readdir(songDir(id)).catch(() => []);
  return files.map((f) => f.match(/^take-(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

async function songSummary(meta, { full = false } = {}) {
  const dir = songDir(meta.id);
  const chart = await readJson(path.join(dir, 'chart.json'));
  const stats = results.songStats(meta.id);
  const out = {
    ...meta,
    moves: undefined,
    hasChart: !!chart,
    scoredMoves: chart?.report.scoredMoves || 0,
    takesCount: (await listTakes(meta.id)).length,
    plays: stats.plays,
    best: results.songBest(meta.id),
  };
  if (full) {
    const takes = [];
    for (const n of await listTakes(meta.id)) {
      const t = await readJson(path.join(dir, `take-${n}.json`));
      takes.push({ n, hasVideo: !!t?.video, durationMs: t?.durationMs, samples: t?.samples?.length || 0, createdAt: t?.createdAt, device: t?.device });
    }
    out.takes = takes;
    out.moves = meta.moves || {};
    out.chart = chart ? {
      builtAt: chart.builtAt, report: chart.report,
      segments: chart.segments.map(({ ref, ...s }) => ({ ...s, miss: stats.seg[s.i] || [0, 0] })),
    } : null;
  }
  return out;
}

let songListCache = null;
let songListCacheAt = 0;
const SONG_CACHE_MS = 5000;
const chartCache = new Map();
function invalidateSongCache() { songListCache = null; chartCache.clear(); }
async function cachedSongList(force = false) {
  const now = Date.now();
  if (!force && songListCache && now - songListCacheAt < SONG_CACHE_MS) return songListCache;
  const ids = await fsp.readdir(path.join(DATA, 'songs')).catch(() => []);
  const out = [];
  for (const id of ids) { const m = await getMeta(id); if (m) out.push(await songSummary(m)); }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  songListCache = out;
  songListCacheAt = now;
  return out;
}

/**
 * The chart phones score against, with the admin's move names, pictograms and strictness merged in.
 * Cached and shared with the room tally, which scores grades itself — so both sides grade
 * against exactly the same reference. scoreDetail memoises _refArr on the segment, so the
 * HTTP route must strip it before serialising.
 */
async function loadChart(id) {
  if (chartCache.has(id)) return chartCache.get(id);
  const chart = await readJson(path.join(songDir(id), 'chart.json'));
  if (!chart) return null;
  const meta = await getMeta(id);
  const moves = meta?.moves || {};
  const out = {
    ...chart,
    segments: chart.segments.map((s) => ({
      ...s,
      name: moves[s.i]?.name || (s.rest ? 'Rest' : `Move ${s.i + 1}`),
      icon: moves[s.i]?.icon || null,
      strict: moves[s.i]?.strict || 1,
    })),
    bpm: meta?.bpm,
    beatsPerMove: meta?.beatsPerMove,
  };
  chartCache.set(id, out);
  return out;
}

async function rebuild(id) {
  const meta = await getMeta(id);
  const takes = [];
  for (const n of await listTakes(id)) {
    const t = await readJson(path.join(songDir(id), `take-${n}.json`));
    if (t) takes.push({ n, samples: t.samples });
  }
  const p = path.join(songDir(id), 'chart.json');
  if (!takes.length) { await fsp.rm(p, { force: true }); return null; }
  const chart = buildChart(meta, takes);
  await writeJson(p, chart);
  return chart;
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), accelerometer=(self), gyroscope=(self)',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

const json = express.json({ limit: '50mb' });
const raw = (limit) => express.raw({ type: () => true, limit });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isAdmin = (req) => {
  const a = Buffer.from(req.get('x-admin-pass') || ''), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const admin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Admin password required' }));
const withSong = wrap(async (req, res, next) => {
  const meta = await getMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Song not found' });
  req.meta = meta;
  next();
});
export const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
const user = (req, res, next) => {
  req.user = accounts.userForToken(bearer(req));
  if (!req.user) return res.status(401).json({ error: 'Sign in first' });
  next();
};

// tiny in-memory rate limiter (per IP) for auth endpoints
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = `${req.ip}|${req.path}`;
  const t = Date.now();
  const h = (hits.get(key) || []).filter((x) => x > t - windowMs);
  h.push(t);
  hits.set(key, h);
  if (h.length > max) return res.status(429).json({ error: 'Too many attempts — wait a minute' });
  next();
};
setInterval(() => { const t = Date.now() - 600000; for (const [k, v] of hits) if (!v.some((x) => x > t)) hits.delete(k); }, 600000).unref();

const extFor = (ct = '') =>
  ct.includes('mp4') ? 'mp4' : ct.includes('webm') ? 'webm' : ct.includes('mpeg') || ct.includes('mp3') ? 'mp3'
  : ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : ct.includes('aac') || ct.includes('m4a') ? 'm4a'
  : ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'bin';

const lab = await createLab({ dataDir: DATA, isAdmin, accounts, limit, bearer });
app.use(lab.router);

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/qr', wrap(async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#140C26', light: '#F6F1FF' } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
}));

// ----- admin -----
app.post('/api/login', json, (req, res, next) => { req.headers['x-admin-pass'] = req.body?.password || ''; next(); }, limit(10, 60000), admin,
  (req, res) => res.json({ ok: true }));

// ----- accounts -----
app.post('/api/auth/register', limit(10, 60000), json, wrap(async (req, res) => res.json(await accounts.register(req.body || {}))));
app.post('/api/auth/login', limit(10, 60000), json, wrap(async (req, res) => res.json(await accounts.login(req.body || {}))));
app.post('/api/auth/logout', wrap(async (req, res) => { await accounts.logout(bearer(req)); res.json({ ok: true }); }));
app.get('/api/me', user, (req, res) => res.json({ user: req.user, stats: results.userStats(req.user.id), lab: lab.userLabStats(req.user.id) }));
app.get('/api/leaderboard', (req, res) => {
  const songId = req.query.song && safeId(String(req.query.song)) ? String(req.query.song) : undefined;
  const period = req.query.period === 'week' ? 'week' : 'all';
  res.json({ rows: results.leaderboard({ songId, period }) });
});

// ----- songs -----
app.get('/api/songs', wrap(async (req, res) => {
  const out = await cachedSongList();
  res.json(isAdmin(req) ? out : out.filter((s) => s.published && s.hasChart && s.audio));
}));

app.get('/api/songs/:id', withSong, wrap(async (req, res) => {
  if (!req.meta.published && !isAdmin(req)) return res.status(404).json({ error: 'Song not found' });
  res.json(await songSummary(req.meta, { full: isAdmin(req) }));
}));

const cleanSongFields = (body, base = {}) => {
  const out = { ...base };
  if ('title' in body) out.title = String(body.title || '').trim().slice(0, 100);
  if ('artist' in body) out.artist = String(body.artist || '').trim().slice(0, 100);
  if ('bpm' in body) out.bpm = Number(body.bpm);
  if ('beatsPerMove' in body) out.beatsPerMove = [1, 2, 4, 8].includes(Number(body.beatsPerMove)) ? Number(body.beatsPerMove) : 4;
  if ('firstBeatMs' in body) out.firstBeatMs = Math.max(0, Number(body.firstBeatMs) || 0);
  if ('genre' in body) out.genre = GENRES.includes(body.genre) ? body.genre : 'Other';
  if ('difficulty' in body) out.difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'Medium';
  if ('familyFriendly' in body) out.familyFriendly = body.familyFriendly !== false;
  if ('featured' in body) out.featured = !!body.featured;
  if ('videoTake' in body) out.videoTake = body.videoTake == null ? null : Number(body.videoTake);
  if ('moves' in body && body.moves && typeof body.moves === 'object') {
    out.moves = {};
    for (const [i, mv] of Object.entries(body.moves)) {
      if (!/^\d{1,4}$/.test(i) || !mv) continue;
      out.moves[i] = {
        name: String(mv.name || '').trim().slice(0, 40),
        icon: ICONS.includes(mv.icon) ? mv.icon : null,
        strict: Math.min(1.8, Math.max(0.5, Number(mv.strict) || 1)),
      };
    }
  }
  return out;
};

app.post('/api/songs', admin, json, wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.title || !(body.bpm > 30 && body.bpm < 300)) return res.status(400).json({ error: 'Title and BPM (30–300) are required' });
  const slug = String(body.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
  const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  const meta = cleanSongFields({ genre: 'Other', difficulty: 'Medium', familyFriendly: true, beatsPerMove: 4, firstBeatMs: 0, ...body }, {
    id, durationMs: 0, audio: null, cover: null, videoTake: null, published: false, featured: false, moves: {}, createdAt: new Date().toISOString(),
  });
   await fsp.mkdir(songDir(id), { recursive: true });
  await writeJson(metaPath(id), meta);
  invalidateSongCache();
  res.json(meta);
}));

app.patch('/api/songs/:id', admin, json, withSong, wrap(async (req, res) => {
  const body = req.body || {};
  if ('bpm' in body && !(body.bpm > 30 && body.bpm < 300)) return res.status(400).json({ error: 'BPM must be 30–300' });
  const timingChanged = ['bpm', 'beatsPerMove', 'firstBeatMs'].some((k) => k in body && body[k] !== req.meta[k]);
  if (body.featured) { // only one featured song
    const ids = await fsp.readdir(path.join(DATA, 'songs')).catch(() => []);
    for (const other of ids) if (other !== req.meta.id && (await getMeta(other))?.featured) await updateMeta(other, (m) => { m.featured = false; });
  }
   const meta = await updateMeta(req.meta.id, (m) => cleanSongFields(body, m));
  if (timingChanged) { await updateMeta(meta.id, (m) => { m.moves = {}; }); await rebuild(meta.id); }
  invalidateSongCache();
  res.json(await songSummary(await getMeta(meta.id), { full: true }));
}));

app.post('/api/songs/:id/publish', admin, json, withSong, wrap(async (req, res) => {
  const publish = req.body?.published !== false;
  if (publish) {
    const chart = await readJson(path.join(songDir(req.meta.id), 'chart.json'));
    if (!req.meta.audio) return res.status(400).json({ error: 'Upload the audio first' });
    if (!chart?.report.scoredMoves) return res.status(400).json({ error: 'Record at least one take with dancing in it' });
  }
  await updateMeta(req.meta.id, (m) => { m.published = publish; m.publishedAt = publish ? new Date().toISOString() : null; });
  invalidateSongCache();
  res.json(await songSummary(await getMeta(req.meta.id), { full: true }));
}));

app.delete('/api/songs/:id', admin, withSong, wrap(async (req, res) => {
  await fsp.rm(songDir(req.meta.id), { recursive: true, force: true });
  invalidateSongCache();
  res.json({ ok: true });
}));

app.put('/api/songs/:id/audio', admin, withSong, raw('200mb'), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'Empty upload' });
  const file = `audio.${extFor(req.get('content-type'))}`;
  if (req.meta.audio && req.meta.audio !== file) await fsp.rm(path.join(songDir(req.meta.id), req.meta.audio), { force: true });
  await fsp.writeFile(path.join(songDir(req.meta.id), file), req.body);
  const durationMs = Number(req.get('x-duration-ms')) || req.meta.durationMs;
  invalidateSongCache();
  res.json(await updateMeta(req.meta.id, (m) => { m.audio = file; m.durationMs = durationMs; }));
}));

app.put('/api/songs/:id/cover', admin, withSong, raw('8mb'), wrap(async (req, res) => {
  const ct = req.get('content-type') || '';
  if (!/^image\/(png|jpe?g|webp)$/.test(ct)) return res.status(400).json({ error: 'Cover must be PNG, JPG or WebP' });
  const file = `cover.${extFor(ct)}`;
  if (req.meta.cover && req.meta.cover !== file) await fsp.rm(path.join(songDir(req.meta.id), req.meta.cover), { force: true });
  await fsp.writeFile(path.join(songDir(req.meta.id), file), req.body);
  invalidateSongCache();
  res.json(await updateMeta(req.meta.id, (m) => { m.cover = file; m.coverVersion = Date.now(); }));
}));

const publicOrAdmin = (req, res, next) => (req.meta.published || isAdmin(req) ? next() : res.status(404).end());
app.get('/api/songs/:id/cover', withSong, (req, res) => {
  if (!req.meta.cover) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=300').sendFile(path.join(songDir(req.meta.id), req.meta.cover));
});
app.get('/api/songs/:id/audio', withSong, publicOrAdmin, (req, res) => {
  if (!req.meta.audio) return res.status(404).end();
  res.sendFile(path.join(songDir(req.meta.id), req.meta.audio));
});

app.post('/api/songs/:id/takes', admin, json, withSong, wrap(async (req, res) => {
  const { samples, durationMs, videoOffsetSec = 0, device = '' } = req.body || {};
  if (!validSamples(samples, { max: 60000 })) return res.status(400).json({ error: 'Take has too few or malformed samples' });
  const dir = songDir(req.meta.id);
  let n = 0;
  for (let i = 1; i <= 9999 && !n; i++) {
    const claimed = await createJson(path.join(dir, `take-${i}.json`), {
      n: i, samples, durationMs, videoOffsetSec, device: String(device).slice(0, 200), video: null, createdAt: new Date().toISOString(),
    });
    if (claimed) n = i;
  }
  if (!n) return res.status(400).json({ error: 'This song has too many takes already' });
  await rebuild(req.meta.id); // keeps consistency feedback live after every take
  invalidateSongCache();
  res.json({ n });
}));

app.put('/api/songs/:id/takes/:n/video', admin, withSong, raw('500mb'), wrap(async (req, res) => {
  const n = Number(req.params.n);
  const tp = path.join(songDir(req.meta.id), `take-${n}.json`);
  const take = await readJson(tp);
  if (!take) return res.status(404).json({ error: 'Take not found' });
  const file = `take-${n}.${extFor(req.get('content-type'))}`;
  await fsp.writeFile(path.join(songDir(req.meta.id), file), req.body);
  take.video = file;
  await writeJson(tp, take);
  if (!req.meta.videoTake) await updateMeta(req.meta.id, (m) => { m.videoTake = n; });
  res.json({ ok: true, file });
}));

app.delete('/api/songs/:id/takes/:n', admin, withSong, wrap(async (req, res) => {
  const n = Number(req.params.n);
  const dir = songDir(req.meta.id);
  const take = await readJson(path.join(dir, `take-${n}.json`));
  await fsp.rm(path.join(dir, `take-${n}.json`), { force: true });
  if (take?.video) await fsp.rm(path.join(dir, take.video), { force: true });
  if (req.meta.videoTake === n) await updateMeta(req.meta.id, (m) => { m.videoTake = null; });
  await rebuild(req.meta.id);
  invalidateSongCache();
  res.json({ ok: true });
}));

app.post('/api/songs/:id/build', admin, withSong, wrap(async (req, res) => {
  const chart = await rebuild(req.meta.id);
  if (!chart) return res.status(400).json({ error: 'No takes recorded yet' });
  invalidateSongCache();
  res.json(await songSummary(await getMeta(req.meta.id), { full: true }));
}));

/** The chart phones score against, with the admin's move names, pictograms and strictness merged in. */
app.get('/api/songs/:id/chart', withSong, publicOrAdmin, wrap(async (req, res) => {
  const chart = await loadChart(req.meta.id);
  if (!chart) return res.status(404).json({ error: 'No moves yet — record takes in the Studio' });
  if (!validChart(chart)) return res.status(409).json({ error: 'This song’s chart is broken — rebuild it in the Studio' });
  res.json({ ...chart, segments: chart.segments.map(({ _refArr, ...s }) => s) });
}));

app.get('/api/songs/:id/video', withSong, publicOrAdmin, wrap(async (req, res) => {
  const n = req.meta.videoTake;
  const take = n ? await readJson(path.join(songDir(req.meta.id), `take-${n}.json`)) : null;
  if (!take?.video) return res.status(404).end();
  res.sendFile(path.join(songDir(req.meta.id), take.video));
}));
app.get('/api/songs/:id/video-info', withSong, publicOrAdmin, wrap(async (req, res) => {
  const n = req.meta.videoTake;
  const take = n ? await readJson(path.join(songDir(req.meta.id), `take-${n}.json`)) : null;
  res.json(take?.video ? { take: n, offsetSec: take.videoOffsetSec || 0 } : null);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

// ---------- server (HTTPS if certs present — phones need a secure origin for motion sensors) ----------
const certDir = path.join(__dirname, 'certs');
const hasCerts = fs.existsSync(path.join(certDir, 'key.pem')) && fs.existsSync(path.join(certDir, 'cert.pem'));
const server = hasCerts
  ? https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, app)
  : http.createServer(app);

attachRooms(server, { adminPassword: ADMIN_PASSWORD, accounts, results, getSong: getMeta, getChart: loadChart });

server.listen(PORT, () => {
  console.log(`Dance Like David on ${hasCerts ? 'https' : 'http'}://localhost:${PORT}`);
  console.log('  TV: /screen   Phone: /phone   Studio: /studio');
  if (!hasCerts) console.log('  Phones need HTTPS for motion sensors — see README (tunnel or certs/).');
});

const shutdown = () => { console.log('Shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
