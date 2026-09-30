// Big screen: song library, lobby, solo/team gameplay, practice loops, results, leaderboard.
import { $, $$, el, api, Link, SongPlayer, store, fmtTime, fmtNum, ordinal, coverEl, avatar, toast, colorFor } from './common.js';
import { icon, dancerFigure, defaultMoveIcon } from './icons.js';

const GENRES = ['K-pop', 'Pop', 'Afrobeats', 'Worship', 'Kids', 'Other'];
const TEAMS = { A: { name: 'Team Crown', color: 'var(--gold)' }, B: { name: 'Team Teal', color: 'var(--teal)' } };
const GRADE_ORDER = ['PERFECT', 'GOOD', 'OK', 'MISS'];
const POINTS = { PERFECT: 100, GOOD: 70, OK: 40, MISS: 0 };

const link = new Link();
const player = new SongPlayer(link);
const video = $('#video');
const S = {
  songs: [], q: '', genre: '', family: store.get('ddl.familyOnly', false),
  song: null, chart: null, videoInfo: null, durationMs: 0, mode: 'solo',
  players: new Map(), // id -> { name, signedIn, connected, ready, loaded, team, score, counts, streak, maxStreak, lastGrade, segs }
  code: null, secret: null, running: false, raf: 0, popup: null, practice: null, lastResults: null, view: 'library',
};

// ---------------- views ----------------
function show(view) {
  S.view = view;
  const stage = view === 'play' || view === 'practice';
  $('#chrome').hidden = stage;
  for (const v of ['library', 'lobby', 'results', 'board', 'howto']) $(`#v-${v}`).hidden = v !== view;
  $('#v-play').hidden = view !== 'play';
  $('#v-practice').hidden = view !== 'practice';
  for (const b of $$('.tv-nav button')) b.setAttribute('aria-current', b.dataset.nav === view ? 'page' : 'false');
  if (view === 'board') renderBoard();
}
for (const b of $$('[data-nav]')) b.addEventListener('click', () => {
  if (b.dataset.nav === 'library' && S.view === 'lobby') { unloadSong(); }
  show(b.dataset.nav);
});
$('#brand').prepend(icon('crown', { size: 34, stroke: 'var(--gold)' }));
$('#searchIcon').append(icon('search', { size: 20, stroke: 'var(--muted)' }));
$('#lobbyBack').append(icon('back', { size: 18 }), 'All songs');

// ---------------- room ----------------
const toPlayers = (msg, to) => link.raw({ t: 'toPlayers', msg, to });
function netBanner(text) { const b = $('#netBanner'); b.hidden = !text; b.replaceChildren(text ? icon('wifiOff', { size: 20 }) : '', text || ''); }

async function hostRoom() {
  link.raw({ t: 'host', kind: 'game' });
  const m = await link.waitFor('hosted');
  S.code = m.code; S.secret = m.secret;
  S.players.clear();
  $('#roomCode').textContent = m.code;
  $('#bigCode').textContent = m.code;
  const url = `${location.origin}/phone?code=${m.code}`;
  $('#joinUrl').textContent = url.replace(/^https?:\/\//, '');
  $('#qr').replaceChildren(el('img', { src: `/api/qr?text=${encodeURIComponent(url)}`, alt: `QR code to join room ${m.code}` }));
  renderDancers();
}

link.addEventListener('disconnected', () => netBanner('Lost the server connection — reconnecting… Dancers keep scoring on their phones.'));
link.addEventListener('reconnected', async () => {
  link.raw({ t: 'rehost', code: S.code, secret: S.secret });
  try {
    const m = await link.waitFor('rehosted');
    const live = new Set(m.players.map((p) => p.id));
    for (const [id, p] of S.players) if (!live.has(id)) S.players.delete(id); else p.connected = m.players.find((x) => x.id === id).connected;
    netBanner('');
    toast('Reconnected');
  } catch {
    netBanner('');
    toast('The room expired — here is a new code. Dancers need to join again.', 5000);
    stopPlay(false);
    await hostRoom();
    show('library');
  }
  renderDancers();
});

link.onMsg((m) => {
  if (m.t === 'playerJoined') {
    S.players.set(m.id, { name: m.name, signedIn: m.signedIn, connected: true, ready: false, loaded: false, team: nextTeam(), score: 0, counts: {}, streak: 0, maxStreak: 0, lastGrade: null, segs: new Set() });
    renderDancers();
  } else if (m.t === 'playerStatus') {
    const p = S.players.get(m.id);
    if (p) { p.connected = m.connected; renderDancers(); renderScores(); }
  } else if (m.t === 'playerLeft') {
    S.players.delete(m.id); renderDancers(); renderScores();
  } else if (m.t === 'finished') {
    showResults(m);
  } else if (m.t === 'msg') {
    const p = S.players.get(m.from);
    if (!p) return;
    const msg = m.msg;
    if (msg.type === 'ready') { p.ready = true; if (S.song) toPlayers(loadMsg(), m.from); if (S.practice) toPlayers({ type: 'practiceStart', songId: S.song.id }, m.from); }
    else if (msg.type === 'loaded') p.loaded = !!msg.ok;
    else if (msg.type === 'grade') onGrade(m.from, p, msg);
    else if (msg.type === 'practiceCmd') onPracticeCmd(msg);
    renderDancers();
  }
});

function nextTeam() {
  const counts = { A: 0, B: 0 };
  for (const p of S.players.values()) if (p.team) counts[p.team]++;
  return counts.A <= counts.B ? 'A' : 'B';
}

// ---------------- library ----------------
async function loadSongs() {
  S.songs = await api('/api/songs', { token: null });
  renderLibrary();
  fillBoardSongs();
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.songs.filter((s) => (!S.genre || (s.genre || 'Other') === S.genre)
    && (!S.family || s.familyFriendly !== false)
    && (!q || `${s.title} ${s.artist}`.toLowerCase().includes(q)));
}

function renderLibrary() {
  // genre pills
  const g = $('#genres');
  g.replaceChildren(...['', ...GENRES].map((name) => el('button', {
    class: 'pill-btn', 'aria-pressed': String(S.genre === name),
    onclick: () => { S.genre = name; renderLibrary(); },
  }, name || 'All genres')));
  $('#familyOnly').checked = S.family;

  const list = filtered();
  const featuredSong = list.find((s) => s.featured) || list[0];
  renderFeatured(featuredSong);
  const grid = $('#songGrid');
  grid.replaceChildren();
  if (!S.songs.length) { grid.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'No songs yet. The admin publishes songs from the Studio.')); return; }
  if (!list.length) { grid.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'No songs match — try another genre or turn off Family-friendly.')); return; }
  for (const s of list) {
    const cover = coverEl(s, { size: '100%', radius: 0, glyph: 40 });
    cover.style.height = '118px';
    cover.prepend(el('span', { class: 'badge' }, s.genre || 'Other'));
    grid.append(el('button', { class: 'song-card', onclick: () => openLobby(s), 'aria-label': `${s.title} by ${s.artist || 'unknown artist'}` },
      cover,
      el('div', { class: 'info' }, el('b', {}, s.title),
        el('span', {}, `${s.difficulty || 'Medium'} · ${fmtTime(s.durationMs)} · ${s.best ? `Best ${fmtNum(s.best)}` : 'Not played'}`))));
  }
}

function renderFeatured(s) {
  const f = $('#featured');
  f.replaceChildren();
  if (!s) { f.append(el('div', { class: 'body' }, el('h2', {}, 'Nothing to play yet'), el('p', { class: 'muted' }, 'Songs appear here once the admin publishes them in the Studio.'))); return; }
  const cover = el('div', { class: `cover${s.cover ? ' has-img' : ''}`, style: { background: colorFor(s.title) } });
  if (s.cover) cover.append(el('img', { src: `/api/songs/${s.id}/cover?v=${s.coverVersion || 0}`, alt: '' }), el('div', { class: 'shade' }));
  else {
    const deco = icon('crown', { size: 220, stroke: 'rgba(20,12,38,.18)', width: 1.2 });
    Object.assign(deco.style, { position: 'absolute', right: '-20px', top: '-10px' });
    cover.append(deco);
  }
  cover.append(el('div', { class: 'over' },
    el('span', { class: 'eyebrow', style: { color: 'inherit' } }, `${s.featured ? 'Featured' : 'Newest'} · ${s.genre || 'Other'}`),
    el('span', { class: 't' }, s.title), el('span', { style: { fontSize: '17px', fontWeight: 600 } }, s.artist || '')));
  const preview = el('button', { class: 'btn-lg', onclick: () => togglePreview(s, preview) }, 'Preview');
  f.append(cover, el('div', { class: 'body' },
    el('div', { class: 'stats' },
      stat('Length', fmtTime(s.durationMs)), stat('Difficulty', s.difficulty || 'Medium'),
      stat('Moves', s.scoredMoves), stat('Room best', s.best ? fmtNum(s.best) : '—')),
    el('div', { class: 'row', style: { marginTop: 'auto' } },
      el('button', { class: 'btn-primary btn-lg grow', onclick: () => openLobby(s) }, icon('play', { fill: 'var(--bg)', stroke: 'none', size: 20 }), 'Play'),
      preview)));
}
const stat = (k, v) => el('div', {}, el('span', {}, k), el('b', {}, String(v)));

let previewAudio = null;
function togglePreview(s, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; btn.textContent = 'Preview'; return; }
  previewAudio = new Audio(`/api/songs/${s.id}/audio`);
  previewAudio.addEventListener('loadedmetadata', () => { previewAudio.currentTime = previewAudio.duration * 0.3; previewAudio.play().catch(() => {}); });
  btn.textContent = 'Stop preview';
  const a = previewAudio;
  setTimeout(() => { if (previewAudio === a) { a.pause(); previewAudio = null; btn.textContent = 'Preview'; } }, 15000);
}

$('#q').addEventListener('input', (e) => { S.q = e.target.value; renderLibrary(); });
$('#familyOnly').addEventListener('change', (e) => { S.family = e.target.checked; store.set('ddl.familyOnly', S.family); renderLibrary(); });

// ---------------- lobby ----------------
const loadMsg = () => S.song && { type: 'load', songId: S.song.id, title: S.song.title, artist: S.song.artist, genre: S.song.genre };

async function openLobby(song) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  S.song = song; S.chart = null; S.videoInfo = null;
  for (const p of S.players.values()) { p.loaded = false; }
  show('lobby');
  renderLobby();
  toPlayers(loadMsg());
  try {
    const [dur, chart, vi] = await Promise.all([
      player.load(`/api/songs/${song.id}/audio`),
      api(`/api/songs/${song.id}/chart`, { token: null }),
      api(`/api/songs/${song.id}/video-info`, { token: null }),
    ]);
    if (S.song !== song) return;
    S.durationMs = dur; S.chart = chart; S.videoInfo = vi;
    if (vi) { video.src = `/api/songs/${song.id}/video`; video.load(); }
    else video.removeAttribute('src');
  } catch (e) {
    toast(e.message);
  }
  renderLobby();
}

function unloadSong() {
  S.song = null; S.chart = null;
  toPlayers({ type: 'unload' });
}

function renderLobby() {
  const s = S.song;
  if (!s) return;
  const meta = el('span', { class: 'muted', style: { fontSize: '18px' } }, [s.artist, s.genre, fmtTime(s.durationMs), s.difficulty, `${s.scoredMoves} moves`].filter(Boolean).join(' · '));
  const info = el('div', { class: 'stack', style: { gap: '6px' } }, el('h1', {}, s.title), meta);
  if (s.familyFriendly !== false) info.append(el('span', { class: 'chip tone-teal', style: { alignSelf: 'flex-start', marginTop: '4px' } }, icon('shield', { size: 16, width: 2.4 }), 'Family-friendly'));
  $('#lobbyHero').replaceChildren(coverEl(s, { size: 132, radius: 22, glyph: 48 }), info);

  const modes = [
    ['solo', 'user', 'Solo', 'Everyone for themselves. Top score takes the crown.'],
    ['teams', 'users', 'Teams', 'Split the room in two. Team scores are averaged, so team size doesn’t matter.'],
    ['practice', 'loop', 'Practice', 'Loop one move at a time, slowed down, until it clicks.'],
  ];
  $('#modes').replaceChildren(...modes.map(([id, ic, name, desc]) => el('button', {
    class: 'mode', 'aria-pressed': String(S.mode === id), onclick: () => { S.mode = id; renderLobby(); renderDancers(); },
  }, icon(ic, { size: 30 }), el('b', {}, name), el('span', {}, desc))));
  renderDancers();
}

function renderDancers() {
  const n = S.players.size;
  $('#dancerCount').textContent = n ? `${n} dancer${n > 1 ? 's' : ''} connected` : 'No dancers yet';
  $('#dancerSlots').textContent = `${n} / 8`;
  const box = $('#dancers');
  box.replaceChildren();
  if (!n) box.append(el('p', { class: 'muted' }, 'Waiting for dancers… open the link or scan the code on a phone.'));
  for (const p of S.players.values()) {
    let state, tone;
    if (!p.connected) { state = 'Reconnecting'; tone = 'tone-coral'; }
    else if (!p.ready) { state = 'Grip check'; tone = 'tone-gold'; }
    else if (S.song && !p.loaded) { state = 'Loading'; tone = 'tone-blue'; }
    else { state = 'Ready'; tone = 'tone-teal'; }
    const row = el('div', { class: 'dancer' }, avatar(p.name, 40), el('span', { class: 'name' }, p.name));
    if (S.mode === 'teams') {
      row.append(el('button', {
        class: 'team-tag', style: { background: p.team === 'A' ? 'var(--gold)' : 'var(--teal)', color: 'var(--bg)' },
        title: 'Switch team', onclick: () => { p.team = p.team === 'A' ? 'B' : 'A'; renderDancers(); },
      }, TEAMS[p.team].name));
    }
    row.append(el('span', { class: `chip ${tone}` }, state));
    box.append(row);
  }
  $('#shuffleBtn').hidden = S.mode !== 'teams' || n < 2;

  const ready = [...S.players.values()].filter((p) => p.connected && p.ready && p.loaded).length;
  const btn = $('#startBtn');
  const canStart = !!S.chart && player.buffer && ready > 0 && !S.running;
  btn.disabled = !canStart;
  btn.replaceChildren(icon(S.mode === 'practice' ? 'loop' : 'play', { size: 22, fill: S.mode === 'practice' ? 'none' : 'var(--bg)', stroke: S.mode === 'practice' ? 'var(--bg)' : 'none' }),
    S.mode === 'practice' ? 'Start practice' : 'Start dancing');
  const note = $('#startNote');
  if (!S.chart) note.textContent = 'Loading the song…';
  else if (!n) note.textContent = 'Waiting for at least one dancer.';
  else if (S.mode === 'teams' && n < 2) note.textContent = 'Teams needs at least 2 dancers.';
  else if (ready < n) note.textContent = `${ready} of ${n} dancers ready. Starting now skips anyone still getting set up.`;
  else note.textContent = `Everyone’s ready.`;
  if (S.mode === 'teams' && n < 2) btn.disabled = true;
}
$('#shuffleBtn').addEventListener('click', () => {
  const ids = [...S.players.keys()].sort(() => Math.random() - 0.5);
  ids.forEach((id, i) => { S.players.get(id).team = i % 2 ? 'B' : 'A'; });
  renderDancers();
});
$('#startBtn').addEventListener('click', () => (S.mode === 'practice' ? startPractice() : startGame()));

// ---------------- gameplay ----------------
function beatMs() { return 60000 / (S.chart?.bpm || S.song?.bpm || 120); }
const scoredSegs = () => S.chart.segments.filter((s) => !s.rest);

async function startGame() {
  if (!S.chart) return;
  const view = $('#v-play');
  view.classList.toggle('teams', S.mode === 'teams');
  view.classList.toggle('solo', S.mode !== 'teams');
  const participants = [...S.players.entries()].filter(([, p]) => p.connected && p.ready && p.loaded);
  for (const p of S.players.values()) Object.assign(p, { score: 0, counts: {}, streak: 0, maxStreak: 0, lastGrade: null, segs: new Set(), accSum: 0, accN: 0 });
  const teams = S.mode === 'teams' ? Object.fromEntries(participants.map(([id, p]) => [id, p.team])) : null;
  clearTimeout(S.finishTimer);
  S.gameId = (S.gameId || 0) + 1;
  const startServer = link.serverNow() + 4000;
  toPlayers({ type: 'start', songId: S.song.id, mode: S.mode, teams, scoredIdx: scoredSegs().map((s) => s.i), totalSegs: S.chart.segments.length, maxPoints: scoredSegs().length * 100, startServer });
  await player.startAt(startServer);
  S.running = true;
  S.popup = null;
  $('#songChip').replaceChildren(icon('crown', { size: 24, stroke: 'var(--gold)' }), el('b', {}, S.song.title), el('span', { class: 'muted clock' }, ''));
  $('#noVideoHint').hidden = !!S.videoInfo;
  video.hidden = !S.videoInfo;
  const stage = $('#stage');
  $$('svg', stage).forEach((n) => n.remove());
  if (!S.videoInfo) stage.prepend(dancerFigure(300));
  else stage.prepend(video);
  video.pause();
  video.playbackRate = 1;
  if (S.videoInfo) video.currentTime = 0;
  show('play');
  renderScores();
  S.stripSeg = null;
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(tick);
}

function tick() {
  if (!S.running) return;
  const t = player.songMs();
  const cd = $('#countdown');
  cd.textContent = t < 0 ? String(Math.ceil(-t / 1000)) : t < 700 ? 'DANCE!' : '';
  syncVideo(t, 1);
  $('#progress').style.width = `${Math.min(100, Math.max(0, (t / S.durationMs) * 100))}%`;
  for (const c of $$('.clock')) c.textContent = `${fmtTime(t)} / ${fmtTime(S.durationMs)}`;
  renderStrip(t);
  if (S.popup && performance.now() > S.popup.until) { $('#popup').textContent = ''; S.popup = null; }
  if (t > S.durationMs + 2500) { finishGame(); return; }
  S.raf = requestAnimationFrame(tick);
}

function syncVideo(t, speed) {
  if (!S.videoInfo || video.readyState < 2) return;
  const target = t / 1000 - S.videoInfo.offsetSec;
  if (target < 0 || target > video.duration) { if (!video.paused) video.pause(); return; }
  if (video.playbackRate !== speed) video.playbackRate = speed;
  if (video.paused) video.play().catch(() => {});
  if (Math.abs(video.currentTime - target) > 0.15) video.currentTime = target;
}

function renderStrip(t) {
  const segs = S.chart.segments;
  const cur = segs.find((s) => t >= s.start && t < s.end);
  const key = `${cur?.i ?? 'x'}|${Math.floor(t / beatMs())}`;
  if (key === S.stripSeg) return;
  S.stripSeg = key;
  const upcoming = segs.filter((s) => !s.rest && s.start >= (cur ? cur.end : t)).slice(0, cur ? 4 : 5);
  const cards = [];
  if (cur) cards.push(moveCard(cur, cur.rest ? 'rest' : 'now', cur.rest ? 'Rest' : 'NOW'));
  for (const s of upcoming) cards.push(moveCard(s, '', `in ${Math.max(1, Math.round((s.start - t) / beatMs()))} beats`));
  $('#strip').replaceChildren(...cards);
}
function moveCard(s, kind, when) {
  const big = kind === 'now';
  return el('div', { class: `mv ${kind}` },
    icon(s.rest ? 'rest' : s.icon || defaultMoveIcon(s.i), { size: big ? 52 : 34, width: 2.2 }),
    el('b', {}, s.rest ? 'Rest' : s.name), el('span', {}, when));
}

function onGrade(id, p, msg) {
  if (S.practice && msg.practice) return onPracticeGrade(id, p, msg);
  if (!S.running || p.segs.has(msg.seg)) return;
  p.segs.add(msg.seg);
  p.score += POINTS[msg.name] || 0;
  p.counts[msg.name] = (p.counts[msg.name] || 0) + 1;
  p.streak = msg.name === 'PERFECT' || msg.name === 'GOOD' ? p.streak + 1 : 0;
  p.maxStreak = Math.max(p.maxStreak, p.streak);
  p.lastGrade = msg.name;
  p.accSum = (p.accSum || 0) + (Number(msg.score) || 0);
  p.accN = (p.accN || 0) + 1;
  // center popup: best grade the room got on this move
  const now = performance.now();
  if (!S.popup || S.popup.seg !== msg.seg || GRADE_ORDER.indexOf(msg.name) < GRADE_ORDER.indexOf(S.popup.grade)) {
    const fresh = !S.popup || S.popup.seg !== msg.seg;
    S.popup = { seg: msg.seg, grade: msg.name, until: now + 900 };
    const pop = $('#popup');
    pop.textContent = msg.name;
    pop.className = `popup g-${msg.name}${fresh ? ' pop' : ''}`;
  }
  renderScores(id);
  broadcastStandings();
}

let standingsTimer = 0;
function broadcastStandings() {
  if (standingsTimer) return;
  standingsTimer = setTimeout(() => {
    standingsTimer = 0;
    const ranked = [...S.players.entries()].sort((a, b) => b[1].score - a[1].score);
    const ranks = Object.fromEntries(ranked.map(([id], i) => [id, i + 1]));
    toPlayers({ type: 'standings', ranks, of: ranked.length });
  }, 300);
}

function renderScores(flashId) {
  if (S.view !== 'play') return;
  const ranked = [...S.players.entries()].sort((a, b) => b[1].score - a[1].score);
  if (S.mode === 'teams') return renderTeams(ranked, flashId);
  const side = $('#side');
  side.replaceChildren(el('div', { class: 'spread' }, el('h2', { style: { fontSize: '22px', fontWeight: 700 } }, 'Live scores'), el('span', { class: 'muted', style: { fontSize: '14px' } }, `Room ${S.code}`)));
  ranked.forEach(([id, p], i) => {
    const grade = p.lastGrade ? el('span', { class: `grade-chip gb-${p.lastGrade}${id === flashId ? ' pop' : ''}` }, p.lastGrade) : el('span', { class: 'muted', style: { fontSize: '14px' } }, p.connected ? 'Get ready' : 'Reconnecting…');
    const streak = p.streak >= 2 ? `${p.streak} in a row` : p.lastGrade && p.lastGrade !== 'PERFECT' && p.lastGrade !== 'GOOD' && p.maxStreak >= 3 ? 'streak lost' : p.accN ? `${Math.round(p.accSum / p.accN)}% accurate` : '';
    side.append(el('div', { class: `score-card${i === 0 && p.score > 0 ? ' lead' : ''}${p.connected ? '' : ' off'}` },
      el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, el('span', { class: 'rank' }, String(i + 1)), avatar(p.name, 36),
        el('b', { class: 'grow', style: { fontSize: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name), el('span', { class: 'pts' }, fmtNum(p.score))),
      el('div', { class: 'spread' }, grade, el('span', { class: 'muted', style: { fontSize: '14px' } }, streak))));
  });
}

function teamTotals() {
  const t = { A: { sum: 0, n: 0, names: [] }, B: { sum: 0, n: 0, names: [] } };
  for (const p of S.players.values()) { const x = t[p.team]; if (!x) continue; x.sum += p.score; x.n++; x.names.push(p.name); }
  for (const x of Object.values(t)) x.avg = x.n ? Math.round(x.sum / x.n) : 0;
  return t;
}
function renderTeams(ranked, flashId) {
  const t = teamTotals();
  const maxSoFar = Math.max(1, ...ranked.map(([, p]) => p.segs.size)) * 100;
  const side = (k, align) => el('div', { class: 'stack', style: { gap: '10px' } },
    el('div', { class: 'spread', style: { flexDirection: align === 'right' ? 'row-reverse' : 'row' } },
      el('span', { class: 'tname', style: { color: TEAMS[k].color } }, TEAMS[k].name), el('span', { class: 'tscore' }, fmtNum(t[k].avg))),
    el('div', { class: 'bar', style: { display: 'flex', justifyContent: align === 'right' ? 'flex-end' : 'flex-start' } },
      el('span', { style: { width: `${Math.min(100, (t[k].avg / maxSoFar) * 100)}%`, background: TEAMS[k].color } })),
    el('span', { class: 'muted', style: { fontSize: '14px', textAlign: align } }, `${t[k].names.join(' · ') || 'No dancers'} — average per dancer`));
  $('#teamHead').hidden = false;
  $('#teamFoot').hidden = false;
  $('#side').hidden = true;
  $('#teamHead').replaceChildren(side('A', 'left'),
    el('div', { class: 'stack', style: { alignItems: 'center', gap: '2px' } }, el('span', { class: 'display', style: { fontSize: '34px' } }, 'VS'), el('span', { class: 'muted clock', style: { fontSize: '14px' } }, '')),
    side('B', 'right'));
  $('#teamFoot').replaceChildren(...ranked.map(([id, p]) => el('div', { class: 'team-card', style: { borderBottomColor: TEAMS[p.team].color } },
    el('span', { class: 'avatar', style: { width: '44px', height: '44px', background: TEAMS[p.team].color } }, p.name[0].toUpperCase()),
    el('div', { class: 'stack', style: { gap: '4px' } }, el('b', {}, p.name),
      el('span', { class: `g-${p.lastGrade || 'x'}${id === flashId ? ' pop' : ''}`, style: { fontSize: '14px', fontWeight: 800, letterSpacing: '.04em' } }, p.lastGrade || (p.connected ? 'Ready' : 'Reconnecting…'))))));
}

function stopPlay(tellPlayers = true) {
  S.running = false;
  cancelAnimationFrame(S.raf);
  player.stop();
  video.pause();
  $('#countdown').textContent = '';
  $('#popup').textContent = '';
  $('#side').hidden = false;
  $('#teamHead').hidden = true;
  $('#teamFoot').hidden = true;
  if (tellPlayers) toPlayers({ type: 'stop' });
}
$('#stopBtn').addEventListener('click', () => { stopPlay(); show('lobby'); renderLobby(); });

async function finishGame() {
  stopPlay(false);
  $('#countdown').textContent = '';
  link.raw({ t: 'finish' });
  // results arrive as a 'finished' message; fall back to local scores if the server is unreachable
  clearTimeout(S.finishTimer);
  const game = S.gameId;
  S.finishTimer = setTimeout(() => { if (S.gameId === game && S.view === 'play') showResults(localResults()); }, 6000);
}
function localResults() {
  const entries = [...S.players.entries()].sort((a, b) => b[1].score - a[1].score).map(([playerId, p], i) => ({
    playerId, name: p.name, points: p.score, counts: p.counts, maxStreak: p.maxStreak, rank: i + 1, of: S.players.size, stars: 0, team: p.team,
    accuracy: S.chart ? Math.round((p.accSum || 0) / Math.max(1, scoredSegs().length)) : null,
  }));
  return { mode: S.mode, entries, teams: null, offline: true };
}

// ---------------- results ----------------
function showResults(res) {
  clearTimeout(S.finishTimer);
  if (S.running) return; // a stale result must never interrupt a game in progress
  S.lastResults = res;
  $('#side').hidden = false; $('#teamHead').hidden = true; $('#teamFoot').hidden = true;
  const e = res.entries;
  const winner = e[0];
  $('#resSub').textContent = `${S.song?.title || ''} · ${res.mode === 'teams' ? 'Teams' : 'Solo'}${res.offline ? ' · scores not saved (server offline)' : ''}`;
  if (res.mode === 'teams' && res.teams) {
    const best = Object.entries(res.teams).sort((a, b) => b[1].average - a[1].average)[0];
    const tie = Object.values(res.teams).length > 1 && Object.values(res.teams).every((x) => x.average === best[1].average);
    $('#resTitle').textContent = tie ? 'It’s a tie!' : `${TEAMS[best[0]].name} wins`;
  } else {
    $('#resTitle').textContent = winner ? `${winner.name} takes the crown` : 'Nobody danced this time';
  }
  const podium = $('#podium');
  podium.replaceChildren();
  const order = [e[1], e[0], e[2]];
  const heights = [150, 210, 110];
  order.forEach((x, k) => {
    if (!x) return;
    const first = x.rank === 1;
    podium.append(el('div', { class: `place${first ? ' first' : ''}` },
      first ? icon('crownFill', { size: 54, fill: 'var(--gold)', stroke: 'var(--gold)', width: 1.5 }) : null,
      avatar(x.name, 72), el('b', { style: { fontSize: '22px' } }, x.name), el('span', { class: 'pts' }, fmtNum(x.points)),
      x.accuracy != null ? el('span', { class: 'muted', style: { fontSize: '14px' } }, `${x.accuracy}% accuracy`) : null,
      starRow(x.stars, 22),
      el('div', { class: 'block', style: { height: `${heights[k]}px` } }, String(x.rank))));
  });
  $('#resRest').replaceChildren(...e.slice(3).map((x) => el('span', { class: 'chip tone-muted' }, `${ordinal(x.rank)} ${x.name} · ${fmtNum(x.points)}`)));

  const badge = $('#recordBadge');
  badge.hidden = !winner?.roomRecord;
  badge.replaceChildren(icon('star', { size: 20 }), 'New room record for this song');
  $('#resMovesTitle').textContent = winner ? `${winner.name}’s moves${winner.accuracy != null ? ` · ${winner.accuracy}% accuracy` : ''}` : '';
  const total = winner ? Object.values(winner.counts || {}).reduce((a, b) => a + b, 0) || 1 : 1;
  $('#breakdown').replaceChildren(...GRADE_ORDER.map((g) => {
    const c = winner?.counts?.[g] || 0;
    return el('div', { class: 'line' }, el('span', { class: `g-${g}`, style: { fontWeight: 800, fontSize: '14px', letterSpacing: '.04em' } }, g),
      el('div', { class: 'bar' }, el('span', { style: { width: `${(c / total) * 100}%`, background: `var(--${{ PERFECT: 'gold', GOOD: 'teal', OK: 'blue', MISS: 'coral' }[g]})` } })),
      el('b', { style: { textAlign: 'right' } }, String(c)));
  }));
  $('#resStreak').textContent = winner ? `${winner.maxStreak || 0} moves` : '—';
  show('results');
  loadSongs().catch(() => {}); // refresh "room best"
}
function starRow(n, size) {
  return el('div', { class: 'stars', role: 'img', 'aria-label': `${n} of 5 stars` },
    [1, 2, 3, 4, 5].map((i) => icon('star', { size, fill: i <= n ? 'var(--gold)' : 'var(--line)', stroke: 'none' })));
}
$('#againBtn').addEventListener('click', () => { show('lobby'); renderLobby(); });
$('#otherBtn').addEventListener('click', () => { unloadSong(); show('library'); });

// ---------------- practice ----------------
async function startPractice(segList) {
  if (!S.chart) return;
  const all = scoredSegs().map((s) => s.i);
  const list = segList?.length ? segList.filter((i) => all.includes(i)) : all;
  S.practice = { list: list.length ? list : all, idx: 0, speed: 0.75, tries: new Map(), loop: 0, timer: 0 };
  toPlayers({ type: 'practiceStart', songId: S.song.id });
  const stage = $('#pStage');
  stage.replaceChildren();
  if (S.videoInfo) stage.append(video); else stage.append(dancerFigure(260));
  video.hidden = !S.videoInfo;
  show('practice');
  renderPractice();
  S.running = false;
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(practiceTick);
  loopMove(1500);
}

function currentPracticeSeg() { return S.chart.segments.find((s) => s.i === S.practice.list[S.practice.idx]); }

function loopMove(delay = 700) {
  const P = S.practice;
  if (!P) return;
  clearTimeout(P.timer);
  const seg = currentPracticeSeg();
  const lead = beatMs() * 2;
  const fromMs = Math.max(0, seg.start - lead);
  const toMs = seg.end + 200;
  const startServer = link.serverNow() + delay;
  P.loop++;
  P.window = { startServer, fromMs, toMs };
  toPlayers({ type: 'practiceLoop', seg: seg.i, startServer, fromMs, speed: P.speed, loop: P.loop });
  player.startAt(startServer, { fromMs, toMs, speed: P.speed });
  const lengthMs = (toMs - fromMs) / P.speed;
  P.timer = setTimeout(() => loopMove(900), delay + lengthMs);
}

function practiceTick() {
  const P = S.practice;
  if (!P) return;
  const t = player.songMs();
  const w = P.window;
  const countdown = w ? w.startServer - link.serverNow() : 0;
  $('#pCountdown').textContent = countdown > 0 && P.loop === 1 ? String(Math.ceil(countdown / 1000)) : '';
  if (w && t >= w.fromMs) syncVideo(t, P.speed); else if (!video.paused) video.pause();
  S.raf = requestAnimationFrame(practiceTick);
}

function renderPractice() {
  const P = S.practice;
  const seg = currentPracticeSeg();
  $('#pCount').textContent = `Move ${P.idx + 1} of ${P.list.length}`;
  $('#pMove').replaceChildren(icon(seg.icon || defaultMoveIcon(seg.i), { size: 96, width: 1.8 }), el('h2', {}, seg.name),
    el('span', { class: 'muted' }, `${S.chart.beatsPerMove || 4} beats · ${fmtTime(seg.start)} in the song`));
  $('#pSpeeds').replaceChildren(...[0.5, 0.75, 1].map((v) => el('button', {
    role: 'tab', 'aria-selected': String(P.speed === v), onclick: () => onPracticeCmd({ cmd: 'speed', value: v }),
  }, `${v}×`)));
  const box = $('#pTries');
  box.replaceChildren(el('span', { class: 'muted', style: { fontWeight: 600, fontSize: '14px' } }, 'Last attempts'));
  if (!S.players.size) box.append(el('p', { class: 'muted' }, 'No dancers connected.'));
  for (const [id, p] of S.players) {
    const tries = (P.tries.get(id) || []).filter((x) => x.seg === seg.i).slice(-5);
    box.append(el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, avatar(p.name, 32), el('b', { class: 'grow' }, p.name),
      el('div', { class: 'tries' }, tries.length ? tries.map((x) => el('span', { class: `grade-chip gb-${x.name}` }, x.name)) : el('span', { class: 'muted', style: { fontSize: '13px' } }, 'waiting'))));
  }
}

function onPracticeGrade(id, p, msg) {
  const P = S.practice;
  const list = P.tries.get(id) || [];
  list.push({ seg: msg.seg, name: msg.name });
  P.tries.set(id, list.slice(-40));
  renderPractice();
}

function onPracticeCmd(msg) {
  if (msg.cmd === 'start') {
    if (!S.song || !S.chart) return;
    if (S.running) return; // don't interrupt a real game
    if (!S.practice) return startPractice(msg.segs);
  }
  const P = S.practice;
  if (!P) return;
  if (msg.cmd === 'speed' && [0.5, 0.75, 1].includes(msg.value)) P.speed = msg.value;
  if (msg.cmd === 'next') P.idx = (P.idx + 1) % P.list.length;
  if (msg.cmd === 'prev') P.idx = (P.idx - 1 + P.list.length) % P.list.length;
  if (msg.cmd === 'goto' && P.list.includes(msg.seg)) P.idx = P.list.indexOf(msg.seg);
  renderPractice();
  player.stop();
  loopMove(800);
}
$('#pNext').addEventListener('click', () => onPracticeCmd({ cmd: 'next' }));
$('#pPrev').addEventListener('click', () => onPracticeCmd({ cmd: 'prev' }));
$('#pExit').addEventListener('click', () => {
  clearTimeout(S.practice?.timer);
  S.practice = null;
  cancelAnimationFrame(S.raf);
  player.stop();
  video.pause();
  toPlayers({ type: 'practiceEnd' });
  show('lobby');
  renderLobby();
});

// ---------------- leaderboard ----------------
let lbPeriod = 'all';
function fillBoardSongs() {
  const sel = $('#lbSong');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'All songs (total of personal bests)'), ...S.songs.map((s) => el('option', { value: s.id }, s.title)));
  sel.value = cur;
}
async function renderBoard() {
  const song = $('#lbSong').value;
  const box = $('#lbRows');
  box.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const { rows } = await api(`/api/leaderboard?period=${lbPeriod}${song ? `&song=${song}` : ''}`, { token: null });
    box.replaceChildren();
    if (!rows.length) box.append(el('div', { class: 'empty' }, 'No scores yet. Only signed-in dancers appear here.'));
    for (const r of rows) box.append(el('div', { class: `lb-row${r.rank === 1 ? ' top' : ''}` }, el('span', { class: 'rk' }, String(r.rank)), avatar(r.name, 36), el('span', { class: 'nm' }, r.name), el('span', { class: 'pt' }, fmtNum(r.points))));
  } catch (e) { box.replaceChildren(el('p', { class: 'error' }, e.message)); }
}
$('#lbSong').addEventListener('change', renderBoard);
for (const b of $$('#lbTabs button')) b.addEventListener('click', () => {
  lbPeriod = b.dataset.period;
  for (const x of $$('#lbTabs button')) x.setAttribute('aria-selected', String(x === b));
  renderBoard();
});

// ---------------- settings ----------------
$('#latency').value = store.get('ddl.latencyMs', 0);
$('#latency').addEventListener('change', (e) => store.set('ddl.latencyMs', Math.max(0, Number(e.target.value) || 0)));
$('#fullBtn').addEventListener('click', () => document.documentElement.requestFullscreen?.().catch(() => {}));

// ---------------- boot ----------------
show('library');
try {
  await link.connect();
  await hostRoom();
} catch (e) {
  netBanner(`Can’t reach the server: ${e.message}`);
}
loadSongs().catch((e) => $('#songGrid').replaceChildren(el('p', { class: 'error' }, e.message)));
window.__ddl = S; // handy for debugging from the console
