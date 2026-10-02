// Studio (super admin): create songs, record reference takes (phone + webcam), name moves, publish.
import { $, $$, el, api, Link, SongPlayer, sleep, fmtTime, fmtNum, coverEl, toast, AUDIO_ACCEPT, audioTypeOf } from './common.js';
import { icon, MOVE_ICONS, MOVE_ICON_LABELS, defaultMoveIcon, dancerFigure } from './icons.js';
import { detectTempo, monoFromBuffer } from '/shared/beats.js';
import { drawBeatGrid } from './beat-grid.js';

let pass = '';
try { pass = sessionStorage.getItem('ddl.pass') || ''; } catch { /* ignore */ }
const link = new Link();
const player = new SongPlayer(link);
const A = {
  songs: [], filter: 'all', song: null, editing: null, phone: null, cam: null, recording: null,
  roomCode: null, roomSecret: null, selSeg: null, taps: [], coverFile: null, grid: null,
};
const pendingTakes = new Map();
const adm = (path, opts = {}) => api(path, { ...opts, pass, token: null });

// ---------------- sign in ----------------
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try { await signIn($('#pass').value); } catch (ex) { $('#loginErr').textContent = ex.message; }
});
async function signIn(p) {
  await api('/api/login', { method: 'POST', body: { password: p }, token: null });
  pass = p;
  try { sessionStorage.setItem('ddl.pass', p); } catch { /* ignore */ }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logo').prepend(icon('crown', { size: 26, stroke: 'var(--gold)' }));
  await link.connect();
  await hostStudio();
  await refreshSongs();
  renderForm();
}
async function hostStudio() {
  link.raw({ t: 'host', kind: 'studio', pass });
  const m = await link.waitFor('hosted');
  A.roomCode = m.code; A.roomSecret = m.secret;
  $('#roomCode').textContent = m.code;
  $('#joinUrl').textContent = `${location.host}/phone`;
  A.phone = null;
  renderPhone();
}
if (pass) signIn(pass).catch(() => { $('#login').hidden = false; });
$('#logout').addEventListener('click', () => { try { sessionStorage.removeItem('ddl.pass'); } catch { /* ignore */ } location.reload(); });

link.addEventListener('disconnected', () => { $('#phoneState').replaceChildren(icon('wifiOff', { size: 24, stroke: 'var(--coral)' }), el('span', {}, 'Server connection lost — reconnecting…')); });
link.addEventListener('reconnected', async () => {
  link.raw({ t: 'rehost', code: A.roomCode, secret: A.roomSecret });
  try { const m = await link.waitFor('rehosted'); if (!m.players.some((p) => p.connected)) A.phone = null; }
  catch { await hostStudio(); }
  renderPhone();
});
link.onMsg((m) => {
  if (m.t === 'playerJoined') A.phone = { id: m.id, name: m.name, ready: false, connected: true };
  else if (m.t === 'playerLeft') A.phone = null;
  else if (m.t === 'playerStatus' && A.phone?.id === m.id) A.phone.connected = m.connected;
  else if (m.t === 'msg') {
    if (m.msg.type === 'ready') A.phone = { ...A.phone, ready: true, hz: m.msg.hz };
    if (m.msg.type === 'take') pendingTakes.get(m.msg.takeId)?.(m.msg);
    if (m.msg.type === 'grade' && m.msg.test && A.test) { A.test.grades.set(m.msg.seg, m.msg); renderTest(); }
  }
  renderPhone();
});

// ---------------- navigation ----------------
function show(view) {
  for (const v of ['songs', 'record', 'moves']) $(`#v-${v}`).hidden = v !== view;
  for (const b of $$('.snav [data-view]')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  if (view === 'moves') renderMoves();
  if (view === 'record') renderRecord();
}
for (const b of $$('.snav [data-view]')) b.addEventListener('click', () => show(b.dataset.view));
function setSong(song) {
  A.song = song;
  for (const b of $$('.snav [data-view]')) if (b.dataset.view !== 'songs') b.disabled = !song;
  $('#curSong').textContent = song ? `Working on: ${song.title}` : '';
}

// ---------------- songs ----------------
async function refreshSongs() {
  A.songs = await adm('/api/songs');
  renderSongs();
  if (A.song) await loadSong(A.song.id);
}
async function loadSong(id) {
  const s = await adm(`/api/songs/${id}`);
  setSong(s);
  return s;
}

function status(s) {
  if (s.published) return ['Published', 'tone-teal'];
  if (!s.hasChart) return ['Needs takes', 'tone-coral'];
  return ['Draft', 'tone-gold'];
}

function renderSongs() {
  $('#songFilters').replaceChildren(...[['all', 'All'], ['draft', 'Drafts'], ['published', 'Published']].map(([k, label]) =>
    el('button', { class: 'pill-btn', 'aria-pressed': String(A.filter === k), onclick: () => { A.filter = k; renderSongs(); } }, label)));
  const rows = $('#songRows');
  rows.replaceChildren();
  const list = A.songs.filter((s) => A.filter === 'all' || (A.filter === 'published' ? s.published : !s.published));
  if (!list.length) rows.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, A.songs.length ? 'Nothing here.' : 'No songs yet — create your first one on the right.')));
  for (const s of list) {
    const [st, tone] = status(s);
    rows.append(el('tr', { onclick: () => openRecord(s.id) },
      el('td', {}, el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, coverEl(s, { size: 44 }),
        el('div', { class: 'stack', style: { gap: '0' } }, el('b', {}, s.title), el('span', { class: 'muted', style: { fontSize: '13px' } }, `${s.genre || 'Other'} · ${fmtTime(s.durationMs)} · ${s.bpm} BPM${s.featured ? ' · Featured' : ''}`)))),
      el('td', {}, el('span', { class: `chip ${tone}` }, st)),
      el('td', {}, String(s.takesCount ?? '—')),
      el('td', {}, s.difficulty || 'Medium'),
      el('td', {}, s.plays ? fmtNum(s.plays) : '—'),
      el('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        el('button', { onclick: (e) => { e.stopPropagation(); editSong(s.id); }, style: { minHeight: '36px' } }, 'Edit'), ' ',
        el('button', { class: 'btn-primary', onclick: (e) => { e.stopPropagation(); openRecord(s.id); }, style: { minHeight: '36px' } }, 'Open'))));
  }
}

async function editSong(id) {
  A.editing = await loadSong(id);
  renderForm();
  show('songs');
}
$('#formNew').addEventListener('click', () => { A.editing = null; renderForm(); });

function renderForm() {
  const s = A.editing;
  A.coverFile = null;
  $('#formTitle').textContent = s ? `Edit “${s.title}”` : 'New song';
  $('#formNew').hidden = !s;
  $('#title').value = s?.title || '';
  $('#artist').value = s?.artist || '';
  $('#genre').value = s?.genre || 'K-pop';
  $('#difficulty').value = s?.difficulty || 'Medium';
  $('#bpm').value = s?.bpm || '';
  $('#bpmv').value = String(s?.beatsPerMove || 4);
  $('#first').value = s?.firstBeatMs || 0;
  $('#family').checked = s ? s.familyFriendly !== false : true;
  $('#featured').checked = !!s?.featured;
  $('#audio').value = '';
  A.grid = null;
  $('#gridCheck').hidden = true;
  $('#audioLabel').textContent = s?.audio ? `Audio uploaded (${fmtTime(s.durationMs)}) — choose a file to replace it` : 'Choose audio file (mp3, m4a, wav)';
  $('#cover').value = '';
  const drop = $('#coverDrop');
  $$('img, span', drop).forEach((n) => n.remove());
  drop.append(s?.cover ? el('img', { src: `/api/songs/${s.id}/cover?v=${s.coverVersion || 0}`, alt: 'Current cover' }) : el('span', {}, 'Cover', el('br'), 'image'));
  $('#formBtn').textContent = s ? 'Save changes' : 'Create and start recording';
  $('#formErr').textContent = '';
}

$('#cover').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  A.coverFile = f;
  const drop = $('#coverDrop');
  $$('img, span', drop).forEach((n) => n.remove());
  drop.append(el('img', { src: URL.createObjectURL(f), alt: 'New cover preview' }));
});
$('#audio').accept = AUDIO_ACCEPT; // set here so the list lives in one place
$('#audio').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  A.grid = null;
  drawGrid();
  if (!f) return;
  $('#audioLabel').textContent = `${f.name} — listening for the beat…`;
  $('#formBtn').disabled = true; // the BPM it is about to fill in is the whole point of waiting
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const d = detectTempo(monoFromBuffer(buf), buf.sampleRate);
    A.grid = { file: f, durationMs: Math.round(buf.duration * 1000), onset: d.onset, onsetHz: d.onsetHz, confidence: d.confidence };
    if (d.bpm) {
      $('#bpm').value = d.bpm.toFixed(1);
      $('#first').value = String(d.firstDownbeatMs);
      $('#tapBtn').textContent = `Tap tempo · ${Math.round(d.bpm)}`;
    }
    $('#audioLabel').textContent = d.bpm ? `${f.name} — ${Math.round(d.bpm)} BPM detected` : `${f.name} — no clear beat, set the BPM by hand`;
  } catch (ex) {
    $('#audioLabel').textContent = `${f.name} — could not read it (${ex.message})`;
  } finally {
    try { ctx.close(); } catch { /* already closed */ }
    $('#formBtn').disabled = false;
    drawGrid();
  }
});

/** The detected grid over the first bars. Reads the fields, so typing or nudging redraws it. */
function drawGrid() {
  const box = $('#gridCheck');
  if (!A.grid?.onset?.length) { box.hidden = true; return; }
  box.hidden = false;
  const bpm = Number($('#bpm').value);
  const firstBeatMs = Math.max(0, Number($('#first').value) || 0);
  const beatsPerBar = Number($('#bpmv').value) || 4;
  $('#gridLabel').textContent = !(bpm > 0)
    ? 'No tempo yet — tap along to the song and the marks will appear'
    : A.grid.confidence >= 2
      ? 'Detected beat — check the marks land on it'
      : 'Faint beat: check this carefully, or tap the tempo instead';
  drawBeatGrid($('#gridCanvas'), { ...A.grid, bpm, firstBeatMs, beatsPerBar: Math.min(4, beatsPerBar) });
}
for (const id of ['bpm', 'first', 'bpmv']) $(`#${id}`).addEventListener('input', drawGrid);
for (const b of $$('#gridCheck [data-nudge]')) b.addEventListener('click', () => {
  const beatMs = 60000 / (Number($('#bpm').value) || 120);
  const by = b.dataset.nudge === 'half' ? beatMs / 2 : b.dataset.nudge === '-half' ? -beatMs / 2 : Number(b.dataset.nudge);
  $('#first').value = String(Math.max(0, Math.round((Number($('#first').value) || 0) + by)));
  drawGrid();
});

$('#tapBtn').addEventListener('click', () => {
  const t = performance.now();
  A.taps = A.taps.filter((x) => t - x < 3000).concat(t);
  if (A.taps.length >= 4) {
    const gaps = A.taps.slice(1).map((x, i) => x - A.taps[i]);
    const bpm = 60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
    $('#bpm').value = bpm.toFixed(1);
    $('#tapBtn').textContent = `Tap tempo · ${Math.round(bpm)}`;
  } else $('#tapBtn').textContent = `Tap tempo · ${A.taps.length}…`;
});

$('#songForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#formErr');
  err.textContent = '';
  const btn = $('#formBtn');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const audio = $('#audio').files[0];
    if (!$('#title').value.trim()) throw new Error('Give the song a title');
    if (!(Number($('#bpm').value) > 30)) throw new Error('Set the BPM (tap along to the song if you don’t know it)');
    if (!A.editing && !audio) throw new Error('Choose the audio file');
    let durationMs = null;
    if (audio && A.grid?.file === audio) durationMs = A.grid.durationMs;
    else if (audio) {
      btn.textContent = 'Reading audio…';
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      durationMs = Math.round((await ctx.decodeAudioData(await audio.arrayBuffer())).duration * 1000);
      ctx.close();
    }
    const body = {
      title: $('#title').value, artist: $('#artist').value, genre: $('#genre').value, difficulty: $('#difficulty').value,
      bpm: Number($('#bpm').value), beatsPerMove: Number($('#bpmv').value), firstBeatMs: Number($('#first').value) || 0,
      familyFriendly: $('#family').checked, featured: $('#featured').checked,
    };
    btn.textContent = 'Saving…';
    let id = A.editing?.id;
    if (A.editing) {
      const timing = ['bpm', 'beatsPerMove', 'firstBeatMs'].some((k) => body[k] !== A.editing[k]);
      if (timing && A.editing.hasChart && !confirm('Changing BPM, beats per move or first beat re-cuts the moves. Names follow their moment in the song, so they are kept. Continue?')) throw new Error('Not saved');
      await adm(`/api/songs/${id}`, { method: 'PATCH', body });
    } else {
      id = (await adm('/api/songs', { method: 'POST', body })).id;
    }
    if (audio) {
      btn.textContent = 'Uploading audio…';
      await adm(`/api/songs/${id}/audio`, { method: 'PUT', body: audio, headers: { 'content-type': audioTypeOf(audio), 'x-duration-ms': String(durationMs) } });
    }
    if (A.coverFile) {
      btn.textContent = 'Uploading cover…';
      await adm(`/api/songs/${id}/cover`, { method: 'PUT', body: A.coverFile, headers: { 'content-type': A.coverFile.type } });
    }
    const wasNew = !A.editing;
    A.editing = null;
    await refreshSongs();
    renderForm();
    if (wasNew) openRecord(id); else toast('Saved');
  } catch (ex) {
    if (ex.message !== 'Not saved') err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// ---------------- record ----------------
async function openRecord(id) {
  await loadSong(id);
  show('record');
}

function renderRecord() {
  const s = A.song;
  if (!s) return;
  $('#recTitle').textContent = s.title;
  const segMs = (s.beatsPerMove * 60000) / s.bpm;
  $('#recMeta').textContent = `${s.genre || 'Other'} · ${fmtTime(s.durationMs)} · ${s.bpm} BPM · a move every ${s.beatsPerMove} beats (${(segMs / 1000).toFixed(2)} s)`;
  $('#camBtn').replaceChildren(icon('camera', { size: 18 }), A.cam ? 'Camera off' : 'Camera on');
  $('#camFallback').replaceChildren(...(A.cam ? [] : [dancerFigure(180), el('span', {}, 'Camera off — takes will have no video')]));
  renderTakes();
  renderPhone();
}

function renderTakes() {
  const s = A.song;
  const box = $('#takes');
  box.replaceChildren();
  const scores = new Map((s.chart?.report.takeScores || []).map((t) => [t.n, t]));
  if (!s.takes?.length && !A.recording) {
    box.append(el('p', { class: 'muted', style: { fontSize: '14px' } },
      'No takes yet. One take is enough to publish and play — dancing the routine the same way three times is what measures how strict each move should be, instead of using a default. ',
      el('a', { href: `/record?song=${s.id}`, style: { fontWeight: 600 } }, 'Record it from your phone instead'),
      ' if you would rather not run this from a laptop.'));
  }
  for (const t of s.takes || []) {
    const sc = scores.get(t.n);
    const agreement = sc ? sc.agreement : null;
    const odd = sc?.odd;
    const tag = odd ? ['Odd one', 'tone-coral'] : s.videoTake === t.n ? ['Video', 'tone-teal'] : agreement != null && (s.takes.length > 1) ? ['Good', 'tone-teal'] : ['Saved', 'tone-muted'];
    const useVideo = t.hasVideo ? el('label', { class: 'check', style: { fontSize: '12px', color: 'var(--muted)', whiteSpace: 'nowrap' } },
      el('input', { type: 'radio', name: 'vt', checked: s.videoTake === t.n, onchange: async () => { await adm(`/api/songs/${s.id}`, { method: 'PATCH', body: { videoTake: t.n } }); await loadSong(s.id); renderTakes(); } }), 'Use video') : null;
    box.append(el('div', { class: 'take' },
      el('span', { class: 'n' }, String(t.n)),
      el('div', { class: 'grow stack', style: { gap: '6px' } },
        el('div', { class: 'spread', style: { fontSize: '14px', flexWrap: 'nowrap' } }, el('span', {}, fmtTime(t.durationMs)), useVideo),
        el('div', { class: 'bar' }, el('span', { style: { width: `${agreement ?? 100}%`, background: odd ? 'var(--coral)' : agreement == null ? 'var(--line)' : 'var(--teal)' } }))),
      el('span', { class: `chip ${tag[1]}` }, tag[0]),
      el('button', { class: 'icon-btn', 'aria-label': `Delete take ${t.n}`, style: { background: 'transparent' }, onclick: async () => {
        if (!confirm(`Delete take ${t.n}?`)) return;
        await adm(`/api/songs/${s.id}/takes/${t.n}`, { method: 'DELETE' });
        await loadSong(s.id); renderTakes(); renderSongsSoon();
      } }, icon('trash', { size: 18, stroke: 'var(--muted)' }))));
  }
  if (A.recording) box.append(el('div', { class: 'take' }, el('span', { class: 'n' }, String((s.takes?.length || 0) + 1)), el('div', { class: 'grow' }, 'Recording now…'), el('span', { class: 'chip tone-coral' }, 'REC')));
  const oddOnes = [...scores.values()].filter((t) => t.odd);
  const note = $('#takeNote');
  note.hidden = !oddOnes.length && !(s.takes?.length === 1 || s.takes?.length === 2);
  if (oddOnes.length) note.textContent = `Take ${oddOnes.map((t) => t.n).join(' and ')} disagrees with the others. Delete it or record one more so scoring stays fair.`;
  else if (s.takes?.length && s.takes.length < 3) note.textContent = `${s.takes.length} take${s.takes.length > 1 ? 's' : ''} — playable right now. ${3 - s.takes.length} more and each move's strictness comes from your own takes rather than a default.`;
}
let songsTimer;
const renderSongsSoon = () => { clearTimeout(songsTimer); songsTimer = setTimeout(() => refreshSongs().catch(() => {}), 300); };

function renderPhone() {
  const box = $('#phoneState');
  const p = A.phone;
  if (!p) {
    box.className = 'phone-state tile';
    box.replaceChildren(icon('phone', { size: 26, stroke: 'var(--muted)' }), el('div', { class: 'stack', style: { gap: '0' } }, el('b', {}, 'No phone connected'), el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Join from your phone with the code below')));
  } else {
    const ok = p.ready && p.connected !== false;
    box.className = 'phone-state';
    box.style.background = ok ? 'var(--teal-bg)' : 'var(--gold-bg)';
    box.replaceChildren(icon('phone', { size: 26, stroke: ok ? 'var(--teal)' : 'var(--gold)' }),
      el('div', { class: 'stack', style: { gap: '0' } }, el('b', {}, `${p.name}’s phone`),
        el('span', { style: { fontSize: '13px', color: ok ? 'var(--teal)' : 'var(--gold)' } }, p.connected === false ? 'Reconnecting…' : p.ready ? `Ready · ${p.hz || '?'} Hz · grip OK` : 'Doing the grip check…')));
  }
  $('#recBtn').disabled = !(p?.ready && p.connected !== false && A.song?.audio && !A.recording);
  $('#testBtn').disabled = !(p?.ready && p.connected !== false && A.song?.audio && A.song?.hasChart && !A.recording);
  $('#recBtn').replaceChildren(el('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: 'var(--bg)' } }), 'Record take');
}

$('#camBtn').addEventListener('click', async () => {
  $('#recErr').textContent = '';
  if (A.cam) {
    A.cam.getTracks().forEach((t) => t.stop());
    A.cam = null;
    $('#cam video')?.remove();
  } else {
    try {
      A.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = el('video', { muted: true, playsinline: true, autoplay: true });
      v.srcObject = A.cam;
      $('#cam').prepend(v);
    } catch (ex) { $('#recErr').textContent = `Camera: ${ex.message}`; }
  }
  renderRecord();
});

$('#recBtn').addEventListener('click', recordTake);
$('#testBtn').addEventListener('click', testRun);
$('#cancelBtn').addEventListener('click', () => A.recording?.cancel());
$('#toMoves').addEventListener('click', () => show('moves'));

async function recordTake() {
  $('#recErr').textContent = '';
  const s = A.song;
  const durationMs = $('#recLen').value === 'full' ? s.durationMs : Math.min(Number($('#recLen').value), s.durationMs);
  const takeId = Math.random().toString(36).slice(2);
  let cancelled = false;
  A.recording = { cancel: () => { cancelled = true; } };
  $('#cancelBtn').hidden = false;
  renderPhone();
  renderTakes();
  const overlay = $('#overlay');
  try {
    await player.load(`/api/songs/${s.id}/audio`, { 'x-admin-pass': pass });
    let recorder = null, recStartServer = null;
    const chunks = [];
    if (A.cam) {
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(A.cam, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
      recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      const started = new Promise((r) => { recorder.onstart = () => { recStartServer = link.serverNow(); r(); }; });
      recorder.start(1000);
      await started;
    }
    const startServer = link.serverNow() + 4000;
    const takeArrived = new Promise((resolve, reject) => {
      pendingTakes.set(takeId, resolve);
      setTimeout(() => reject(new Error('The phone never sent its take. Is it still connected and awake?')), durationMs + 4000 + 25000);
    });
    takeArrived.catch(() => {});
    link.raw({ t: 'toPlayers', msg: { type: 'recordTake', startServer, durationMs, takeId } });
    await player.startAt(startServer);
    const chip = $('#recChip');
    while (!cancelled) {
      const t = player.songMs();
      overlay.textContent = t < 0 ? String(Math.ceil(-t / 1000)) : t < 700 ? 'DANCE!' : '';
      chip.replaceChildren(t >= 0 ? el('span', { class: 'chip tone-coral' }, el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: 'var(--coral)' } }), `REC ${fmtTime(t)}`) : '');
      $('#recProg').style.width = `${Math.min(100, Math.max(0, (t / durationMs) * 100))}%`;
      if (t > durationMs + 600) break;
      await sleep(50);
    }
    player.stop();
    chip.replaceChildren();
    overlay.textContent = '';
    let videoBlob = null;
    if (recorder) {
      const stopped = new Promise((r) => { recorder.onstop = r; });
      recorder.stop();
      await stopped;
      videoBlob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    }
    if (cancelled) { link.raw({ t: 'toPlayers', msg: { type: 'cancelTake' } }); return; }
    overlay.textContent = 'Saving…';
    const take = await takeArrived;
    const { n } = await adm(`/api/songs/${s.id}/takes`, { method: 'POST', body: {
      samples: take.samples, durationMs, device: take.device, videoOffsetSec: recStartServer ? (recStartServer - startServer) / 1000 : 0,
    } });
    if (videoBlob?.size) await adm(`/api/songs/${s.id}/takes/${n}/video`, { method: 'PUT', body: videoBlob, headers: { 'content-type': videoBlob.type } });
    overlay.textContent = 'Saved';
    setTimeout(() => { overlay.textContent = ''; }, 1500);
    await loadSong(s.id);
    renderSongsSoon();
  } catch (ex) {
    $('#recErr').textContent = ex.message;
    overlay.textContent = '';
  } finally {
    pendingTakes.delete(takeId);
    player.stop();
    A.recording = null;
    $('#cancelBtn').hidden = true;
    $('#recProg').style.width = '0';
    renderTakes();
    renderPhone();
  }
}

// ---------------- moves & publish ----------------
const strictToSlider = (f) => Math.round(((1.8 - f) / 1.3) * 100);
const sliderToStrict = (v) => +(1.8 - (v / 100) * 1.3).toFixed(2);

function segInfo() {
  const segs = A.song?.chart?.segments || [];
  const scored = segs.filter((x) => !x.rest).map((x) => x.tol).sort((a, b) => a - b);
  const med = scored.length ? scored[Math.floor(scored.length / 2)] : 0;
  return { segs, loose: (x) => !x.rest && med && x.tol > med * 2 };
}

/** Every move that is the same dance as move i — a chorus is named once, not twelve times. */
function groupOf(i) {
  if (i == null) return [];
  const segs = A.song?.chart?.segments || [];
  const sel = segs.find((x) => x.i === i);
  if (!sel || sel.rest || sel.group == null) return sel ? [i] : [];
  return segs.filter((x) => x.group === sel.group).map((x) => x.i);
}

function renderMoves() {
  const s = A.song;
  if (!s) return;
  const { segs, loose } = segInfo();
  const groups = s.chart?.report.moveGroups;
  $('#movesSub').textContent = s.chart
    ? `${s.title} · built from ${s.chart.report.takes} take${s.chart.report.takes > 1 ? 's' : ''} · ${s.chart.report.scoredMoves} scored moves${groups ? `, ${groups} of them different` : ''}`
    : `${s.title} · no takes yet`;
  const tl = $('#timeline');
  tl.replaceChildren();
  if (!segs.length) tl.append(el('div', { class: 'empty', style: { flexGrow: 1, padding: '18px' } }, 'Record a take first — moves appear here.'));
  if (A.selSeg == null || !segs.some((x) => x.i === A.selSeg)) A.selSeg = segs.find((x) => !x.rest)?.i ?? null;
  const repeats = new Set(groupOf(A.selSeg));
  for (const x of segs) {
    const repeat = x.i !== A.selSeg && repeats.has(x.i);
    tl.append(el('button', {
      'aria-label': `Move ${x.i + 1}${x.rest ? ' (rest)' : repeat ? ' (same dance as the selected move)' : ''}`,
      'aria-pressed': String(x.i === A.selSeg),
      style: { background: x.rest ? 'var(--surface-2)' : repeat ? 'var(--violet)' : loose(x) ? 'var(--gold)' : 'var(--teal)' },
      onclick: () => { A.selSeg = x.i; renderMoves(); },
    }));
  }
  const end = segs.at(-1)?.end || s.durationMs;
  $('#timeTicks').replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map((f) => el('span', {}, fmtTime(end * f))));
  const rows = $('#moveRows');
  rows.replaceChildren();
  const moves = s.moves || {};
  for (const x of segs) {
    const kind = x.rest ? ['Rest', 'tone-muted'] : loose(x) ? ['Loose', 'tone-gold'] : ['Tight', 'tone-teal'];
    const [miss, total] = x.miss || [0, 0];
    rows.append(el('tr', { class: x.i === A.selSeg ? 'sel' : '', onclick: () => { A.selSeg = x.i; renderMoves(); } },
      el('td', {}, String(x.i + 1)),
      el('td', { style: { fontWeight: 600 } }, x.rest ? 'Rest' : moves[x.i]?.name || `Move ${x.i + 1}`,
        x.rest || groupOf(x.i).length < 2 ? null : el('span', { class: 'muted', style: { fontWeight: 400, fontSize: '12px' } }, ` ×${groupOf(x.i).length}`)),
      el('td', { class: 'muted' }, `${(x.start / 1000).toFixed(1)} s`),
      el('td', {}, el('span', { class: `chip ${kind[1]}` }, kind[0])),
      el('td', {}, x.rest ? '—' : total ? `${Math.round((miss / total) * 100)}%` : 'no plays yet')));
  }
  renderMoveEditor();
  renderChecklist();
}

function renderMoveEditor() {
  const s = A.song;
  const x = s.chart?.segments.find((q) => q.i === A.selSeg);
  const disabled = !x || x.rest;
  for (const id of ['mvName', 'mvStrict', 'mvAuto', 'mvCopyPrev']) $(`#${id}`).disabled = disabled;
  if (!x) { $('#mvHead').textContent = 'No move selected'; $('#mvIcons').replaceChildren(); $('#mvRepeats').hidden = true; return; }
  const others = groupOf(x.i).filter((i) => i !== x.i);
  const rp = $('#mvRepeats');
  rp.hidden = disabled || !others.length;
  if (!rp.hidden) {
    const at = others.map((i) => fmtTime(s.chart.segments.find((q) => q.i === i).start));
    rp.textContent = `The same dance happens ${others.length} more time${others.length > 1 ? 's' : ''} (${at.slice(0, 4).join(', ')}${others.length > 4 ? ', …' : ''}). Naming it here names every one of them.`;
  }
  const mv = s.moves?.[x.i] || {};
  $('#mvHead').textContent = `Move ${x.i + 1} · ${(x.start / 1000).toFixed(1)} – ${(x.end / 1000).toFixed(1)} s${x.rest ? ' · rest (not scored)' : ''}`;
  $('#mvName').value = mv.name || '';
  $('#mvName').placeholder = `Move ${x.i + 1}`;
  const cur = mv.icon || defaultMoveIcon(x.i);
  $('#mvIcons').replaceChildren(...MOVE_ICONS.map((k) => el('button', {
    'aria-label': MOVE_ICON_LABELS[k], 'aria-pressed': String(cur === k), disabled,
    onclick: () => saveMove({ icon: k }),
  }, icon(k, { size: 24, width: 2.2 }))));
  const strict = mv.strict || 1;
  $('#mvStrict').value = strictToSlider(strict);
  $('#mvStrictLabel').textContent = strict === 1 ? 'Auto (from your takes)' : strict < 1 ? 'Stricter than auto' : 'More forgiving than auto';
}

let saveTimer;
/** A patch lands on every repeat of the selected move. `live` is for typing: redrawing the
 *  table mid-keystroke would fight the caret, so the redraw waits for the save. */
function saveMove(patch, { live = false } = {}) {
  const s = A.song;
  const idx = groupOf(A.selSeg);
  if (!idx.length) return;
  const moves = { ...(s.moves || {}) };
  for (const i of idx) moves[i] = { name: '', icon: null, strict: 1, ...moves[i], ...patch };
  s.moves = moves;
  if (!live) renderMoves();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await adm(`/api/songs/${s.id}`, { method: 'PATCH', body: { moves } });
      if (live) renderMoves();
    } catch (e) { toast(`Not saved: ${e.message}`); }
  }, live ? 600 : 400);
}
$('#mvName').addEventListener('input', (e) => saveMove({ name: e.target.value }, { live: true }));
$('#mvStrict').addEventListener('change', (e) => saveMove({ strict: sliderToStrict(Number(e.target.value)) }));
$('#mvAuto').addEventListener('click', () => saveMove({ strict: 1 }));
$('#mvCopyPrev').addEventListener('click', () => {
  const prev = (A.song?.chart?.segments || []).filter((x) => !x.rest && x.i < A.selSeg).reverse().find((x) => A.song.moves?.[x.i]?.name);
  if (!prev) return toast('No earlier move has a name yet');
  const mv = A.song.moves[prev.i];
  saveMove({ name: mv.name, icon: mv.icon });
});

function renderChecklist() {
  const s = A.song;
  const { segs, loose } = segInfo();
  const takes = s.takes?.length || 0;
  const looseCount = segs.filter(loose).length;
  const odd = (s.chart?.report.takeScores || []).filter((t) => t.odd).length;
  const items = [
    [!!s.audio, s.audio ? 'Audio uploaded' : 'Upload the audio'],
    [takes >= 3, takes >= 3 ? `${takes} takes — strictness measured from them` : takes ? `${takes} take${takes > 1 ? 's' : ''} — playable, strictness is a default` : 'No takes yet', takes > 0],
    [!!s.videoTake, s.videoTake ? 'Reference video chosen' : 'No reference video (players see move cards)', true],
    [!!s.cover, s.cover ? 'Cover image set' : 'No cover image (a colour block is used)', true],
    [!odd, odd ? `${odd} take${odd > 1 ? 's' : ''} disagree with the others` : 'Takes agree with each other', true],
    [!looseCount, looseCount ? `${looseCount} move${looseCount > 1 ? 's are' : ' is'} loose` : 'All moves consistent', true],
  ];
  $('#checklist').replaceChildren(el('b', {}, s.published ? 'Published — live on the TV' : 'Ready to publish?'),
    ...items.map(([ok, text, soft]) => el('span', { class: 'check', style: { color: ok ? 'var(--teal)' : soft ? 'var(--gold)' : 'var(--coral)' } },
      icon(ok ? 'check' : soft ? 'warn' : 'x', { size: 16, width: 3 }), text)));
  const btn = $('#publishBtn');
  btn.textContent = s.published ? 'Unpublish' : 'Publish to library';
  btn.className = s.published ? 'btn-lg btn-danger' : 'btn-primary btn-lg';
  btn.disabled = !s.published && !(s.audio && s.chart?.report.scoredMoves);
}
$('#publishBtn').addEventListener('click', async () => {
  $('#pubErr').textContent = '';
  try {
    await adm(`/api/songs/${A.song.id}/publish`, { method: 'POST', body: { published: !A.song.published } });
    await loadSong(A.song.id);
    renderMoves();
    renderSongsSoon();
    toast(A.song.published ? 'Published — it’s on the big screen now' : 'Unpublished');
  } catch (e) { $('#pubErr').textContent = e.message; }
});

// ---------------- test run: dance the song and see every move's score ----------------
async function testRun() {
  $('#recErr').textContent = '';
  const s = A.song;
  let cancelled = false;
  A.recording = { cancel: () => { cancelled = true; } };
  $('#cancelBtn').hidden = false;
  renderPhone();
  const overlay = $('#overlay');
  try {
    const chart = await adm(`/api/songs/${s.id}/chart`);
    const scored = chart.segments.filter((x) => !x.rest);
    const endMs = Math.min(s.durationMs, (chart.segments.at(-1)?.end || 0) + 800);
    await player.load(`/api/songs/${s.id}/audio`, { 'x-admin-pass': pass });
    A.test = { chart, scored, grades: new Map(), running: true };
    renderTest();
    const startServer = link.serverNow() + 4000;
    link.raw({ t: 'toPlayers', msg: { type: 'testRun', startServer, chart, title: s.title } });
    await player.startAt(startServer, { toMs: endMs });
    while (!cancelled) {
      const t = player.songMs();
      overlay.textContent = t < 0 ? String(Math.ceil(-t / 1000)) : t < 700 ? 'DANCE!' : '';
      $('#recProg').style.width = `${Math.min(100, Math.max(0, (t / endMs) * 100))}%`;
      if (t > endMs + 1200) break;
      await sleep(50);
    }
    if (cancelled) link.raw({ t: 'toPlayers', msg: { type: 'cancelTake' } });
  } catch (e) {
    $('#recErr').textContent = e.message;
  } finally {
    player.stop();
    overlay.textContent = '';
    $('#recProg').style.width = '0';
    if (A.test) A.test.running = false;
    A.recording = null;
    $('#cancelBtn').hidden = true;
    renderTest();
    renderPhone();
  }
}

function renderTest() {
  const T = A.test;
  const box = $('#testPanel');
  if (!T) { box.hidden = true; return; }
  box.hidden = false;
  const got = [...T.grades.values()];
  const acc = got.length ? Math.round(got.reduce((a, g) => a + (g.score || 0), 0) / T.scored.length) : 0;
  const count = (n) => got.filter((g) => g.name === n).length;
  const names = A.song.moves || {};
  box.replaceChildren(
    el('div', { class: 'spread' }, el('h2', { style: { fontSize: '22px', fontWeight: 700 } }, T.running ? 'Test run — dance!' : 'Test run result'),
      el('span', { class: 'display', style: { fontSize: '28px', color: 'var(--gold)' } }, got.length ? `${acc}%` : '—')),
    el('p', { class: 'muted', style: { fontSize: '14px' } },
      T.running ? `${got.length} of ${T.scored.length} moves scored so far.`
        : `${count('PERFECT')} perfect · ${count('GOOD')} good · ${count('OK')} OK · ${count('MISS')} missed. If you danced it right and a move still misses, record another take or make that move more forgiving in Moves & publish.`),
    el('div', { style: { overflow: 'auto', maxHeight: '320px' } }, el('table', {},
      el('thead', {}, el('tr', {}, ['#', 'Move', 'Score', 'Grade', 'Tip'].map((h) => el('th', {}, h)))),
      el('tbody', {}, T.scored.map((seg) => {
        const g = T.grades.get(seg.i);
        return el('tr', {},
          el('td', {}, String(seg.i + 1)),
          el('td', { style: { fontWeight: 600 } }, names[seg.i]?.name || seg.name || `Move ${seg.i + 1}`),
          el('td', {}, g ? `${g.score}` : '…'),
          el('td', {}, g ? el('span', { class: `grade-chip gb-${g.name}` }, g.name) : ''),
          el('td', { class: 'muted', style: { fontSize: '13px' } }, g?.tip || ''));
      })))));
}
