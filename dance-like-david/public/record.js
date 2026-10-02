// Record a song with nothing but a phone: it plays the audio and captures the motion on the
// same clock, so there is no laptop, no room code and nobody to hand the phone to.
// The laptop studio stays where it is for library work and the optional reference video.
import { $, $$, el, api, SongPlayer, sleep, fmtTime, toast, coverEl, AUDIO_ACCEPT, audioTypeOf } from './common.js';
import { icon } from './icons.js';
import { MotionCapture, keepAwake } from './motion-capture.js';
import { detectTempo, monoFromBuffer } from '/shared/beats.js';
import { drawBeatGrid } from './beat-grid.js';
import { scoreDetail, segmentsFor, validChart } from '/shared/motion.js';

const GENRES = ['K-pop', 'Pop', 'Afrobeats', 'Worship', 'Kids', 'Other'];
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const COUNT_IN = 4;
const LEAD_MS = 600;     // keep a little motion either side of the window being recorded
const CHUNK_MOVES = 4;   // a "section" to patch: four moves, about eight seconds at 120 BPM

const motion = new MotionCapture();
const player = new SongPlayer(); // no Link: this phone's own clock runs both the song and the capture
const R = { songs: [], song: null, chart: null, calibrated: false, enabled: false, busy: false };
let pass = '';
try { pass = sessionStorage.getItem('ddl.pass') || ''; } catch { /* ignore */ }
const adm = (path, opts = {}) => api(path, { ...opts, pass, token: null });
const isAdmin = () => !!pass;
const GRADE_VAR = { PERFECT: 'var(--gold)', GOOD: 'var(--teal)', OK: 'var(--blue)', MISS: 'var(--coral)' };

function show(view) {
  for (const s of $$('main > section')) s.hidden = s.id !== `v-${view}`;
  window.scrollTo(0, 0);
}
const back = (fn, label = 'Back') => el('button', { class: 'icon-btn', 'aria-label': label, onclick: fn }, icon('back', { size: 20 }));
const topbar = (onBack, title, right = null) => el('div', { class: 'topbar' },
  back(onBack), el('span', { class: 'muted', style: { fontWeight: 600, fontSize: '14px', flexGrow: 1, textAlign: 'center' } }, title),
  right || el('span', { style: { width: '44px' } }));

// ---------------- home ----------------
async function home() {
  show('home');
  $('#v-home').replaceChildren(
    el('div', { class: 'lab-head' },
      el('span', { class: 't' }, icon('crown', { size: 28, stroke: 'var(--gold)' }), 'Record a song'),
      isAdmin() ? el('button', { class: 'icon-btn', 'aria-label': 'Sign out', onclick: signOut }, icon('x', { size: 20 })) : null),
    el('p', { class: 'intro' }, 'Everything happens on this phone: it plays the song, counts you in and records the dance. Hold it in your right hand.'),
    el('div', { class: 'move-list', id: 'songList' }),
    el('div', { class: 'push' },
      isAdmin()
        ? el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => newSong() }, icon('upload', { size: 20, stroke: 'var(--bg)' }), 'New song')
        : el('button', { class: 'btn-block', onclick: unlock }, 'Admin: sign in to record'),
      el('a', { class: 'btn btn-block', href: '/lab' }, 'Move Lab (one move at a time)')));
  if (!isAdmin()) return $('#songList').replaceChildren(el('div', { class: 'tile muted' }, 'Sign in to see the songs you are working on.'));
  const list = $('#songList');
  list.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try { R.songs = await adm('/api/songs'); } catch (e) {
    if (e.status === 401) return signOut();
    return list.replaceChildren(el('p', { class: 'error' }, e.message));
  }
  list.replaceChildren();
  if (!R.songs.length) list.append(el('div', { class: 'tile muted' }, 'No songs yet — tap “New song”.'));
  for (const s of R.songs) {
    const tag = s.published ? ['Live', 'tone-teal'] : s.hasChart ? ['Draft', 'tone-gold'] : ['Needs a take', 'tone-coral'];
    list.append(el('button', { class: 'move-row', onclick: () => openSong(s.id) },
      coverEl(s, { size: 44 }),
      el('div', { class: 'grow' }, el('b', {}, s.title),
        el('span', {}, `${s.genre || 'Other'} · ${fmtTime(s.durationMs)} · ${s.takesCount || 0} take${s.takesCount === 1 ? '' : 's'}`)),
      el('span', { class: `chip ${tag[1]}` }, tag[0])));
  }
}

function signOut() {
  pass = '';
  try { sessionStorage.removeItem('ddl.pass'); } catch { /* ignore */ }
  home();
}

function unlock() {
  show('unlock');
  const input = el('input', { type: 'password', autocomplete: 'current-password' });
  const err = el('p', { class: 'error', role: 'alert' });
  $('#v-unlock').replaceChildren(
    topbar(home, 'Admin'),
    el('form', { class: 'stack', style: { gap: '16px' }, onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('/api/login', { method: 'POST', body: { password: input.value }, token: null });
        pass = input.value;
        try { sessionStorage.setItem('ddl.pass', pass); } catch { /* ignore */ }
        home();
      } catch (ex) { err.textContent = ex.message; }
    } }, el('label', { class: 'field' }, 'Admin password', input), err,
    el('button', { class: 'btn-primary btn-lg' }, 'Unlock recording')));
  input.focus();
}

// ---------------- new song: pick the audio, confirm the beat grid ----------------
function newSong() {
  if (!isAdmin()) return unlock();
  show('new');
  const title = el('input', { maxlength: 100, placeholder: 'e.g. Neon Hearts' });
  const artist = el('input', { maxlength: 100, placeholder: 'Artist (optional)' });
  const genre = el('select', {}, GENRES.map((g) => el('option', {}, g)));
  const difficulty = el('select', {}, DIFFICULTIES.map((d) => el('option', { selected: d === 'Medium' }, d)));
  const beatsPerMove = el('select', {}, [2, 4, 8].map((v) => el('option', { value: v, selected: v === 4 }, `${v} beats`)));
  const file = el('input', { type: 'file', accept: AUDIO_ACCEPT });
  const err = el('p', { class: 'error', role: 'alert' });
  const gridBox = el('div', { class: 'stack', style: { gap: '10px' } });
  const create = el('button', { class: 'btn-primary btn-lg btn-block', disabled: true });
  const audio = { file: null, durationMs: 0, bpm: null, firstBeatMs: 0, beatMs: null, onset: null, onsetHz: null, confidence: 0 };

  const setCreateLabel = () => {
    create.disabled = !audio.file || !audio.bpm;
    create.replaceChildren(audio.file ? 'Create and record' : 'Choose the song audio first');
  };

  function renderGrid() {
    gridBox.replaceChildren();
    if (!audio.bpm) return;
    const canvas = el('canvas', { class: 'grid-check', width: 640, height: 72, role: 'img', 'aria-label': 'Detected beats over the start of the song' });
    const draw = () => drawBeatGrid(canvas, { ...audio, beatsPerBar: 4 });
    const nudge = (ms) => { audio.firstBeatMs = Math.max(0, Math.round(audio.firstBeatMs + ms)); draw(); };
    const retempo = (f) => {
      const bpm = audio.bpm * f;
      if (bpm < 40 || bpm > 300) return;
      audio.bpm = +bpm.toFixed(2);
      audio.beatMs = 60000 / audio.bpm;
      renderGrid();
    };
    gridBox.append(
      el('div', { class: 'grid-row' },
        el('div', { class: 'detected grow' }, el('b', {}, `${Math.round(audio.bpm)} BPM`),
          el('span', {}, `first beat at ${(audio.firstBeatMs / 1000).toFixed(2)} s · ${audio.confidence >= 2 ? 'clear beat' : 'faint beat — check it'}`)),
        el('button', { onclick: () => retempo(0.5) }, '÷2'),
        el('button', { onclick: () => retempo(2) }, '×2')),
      canvas,
      el('div', { class: 'grid-row' },
        el('span', { class: 'muted grow', style: { fontSize: '13px' } }, 'Line the marks up with the beat'),
        el('button', { onclick: () => nudge(-audio.beatMs / 2) }, '−½'),
        el('button', { onclick: () => nudge(-20) }, '−20ms'),
        el('button', { onclick: () => nudge(20) }, '+20ms'),
        el('button', { onclick: () => nudge(audio.beatMs / 2) }, '+½')),
      el('button', { class: 'btn-block', onclick: () => previewBeats(audio) }, icon('play', { size: 18 }), 'Play the first bars with a click'));
    draw();
  }

  file.addEventListener('change', async () => {
    const f = file.files[0];
    err.textContent = '';
    if (!f) return;
    audio.file = f;
    create.replaceChildren('Reading the audio…');
    create.disabled = true;
    try {
      player.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      const buf = await player.ctx.decodeAudioData(await f.arrayBuffer());
      audio.durationMs = Math.round(buf.duration * 1000);
      const d = detectTempo(monoFromBuffer(buf), buf.sampleRate);
      Object.assign(audio, { bpm: d.bpm, beatMs: d.beatMs, firstBeatMs: d.firstDownbeatMs, onset: d.onset, onsetHz: d.onsetHz, confidence: d.confidence });
      if (!d.bpm) err.textContent = 'Could not hear a beat in that file — set the BPM in the Studio instead.';
      if (!title.value.trim()) title.value = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 100);
      renderGrid();
    } catch (ex) {
      err.textContent = `Could not read that audio: ${ex.message}`;
    } finally { setCreateLabel(); }
  });

  create.addEventListener('click', async () => {
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Give the song a title'; return; }
    create.disabled = true;
    const label = create.textContent;
    try {
      create.replaceChildren('Saving…');
      const body = {
        title: title.value, artist: artist.value, genre: genre.value, difficulty: difficulty.value,
        bpm: audio.bpm, beatsPerMove: Number(beatsPerMove.value), firstBeatMs: Math.round(audio.firstBeatMs),
      };
      const song = await adm('/api/songs', { method: 'POST', body });
      create.replaceChildren('Uploading the audio…');
      await adm(`/api/songs/${song.id}/audio`, { method: 'PUT', body: audio.file, headers: { 'content-type': audioTypeOf(audio.file), 'x-duration-ms': String(audio.durationMs) } });
      await openSong(song.id);
    } catch (ex) {
      err.textContent = ex.message;
      create.disabled = false;
      create.replaceChildren(label);
    }
  });

  $('#v-new').replaceChildren(
    topbar(home, 'New song'),
    el('label', { class: 'field' }, 'Title', title),
    el('label', { class: 'field' }, 'Artist', artist),
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      el('label', { class: 'field' }, 'Genre', genre), el('label', { class: 'field' }, 'Difficulty', difficulty)),
    el('label', { class: 'field' }, 'A move every', beatsPerMove),
    el('label', { class: 'field' }, 'Song audio', file),
    el('p', { class: 'muted', style: { fontSize: '13px', lineHeight: '1.45', marginTop: '-4px' } },
      'Pick a music file — mp3, m4a, wav, ogg or flac. Tracks inside Apple Music or Spotify are protected and cannot be used; the file has to be one you can see in Files.'),
    gridBox, err,
    el('div', { class: 'push' }, create));
  setCreateLabel();
}

/** Play the first bars with a click on every beat, so the grid can be heard as well as seen. */
async function previewBeats(audio) {
  const ctx = player.ctx;
  if (!ctx) return;
  await ctx.resume();
  const src = ctx.createBufferSource();
  try {
    const buf = await ctx.decodeAudioData(await audio.file.arrayBuffer());
    src.buffer = buf;
  } catch { return; }
  const from = Math.max(0, audio.firstBeatMs - audio.beatMs) / 1000;
  const at = ctx.currentTime + 0.15;
  src.connect(ctx.destination);
  src.start(at, from, 6);
  for (let k = 0; ; k++) {
    const t = (audio.firstBeatMs + k * audio.beatMs) / 1000 - from;
    if (t > 6) break;
    if (t >= 0) click(ctx, at + t, k % 4 === 0);
  }
}

// ---------------- one song: takes, patches, test, publish ----------------
async function openSong(id) {
  try {
    R.song = await adm(`/api/songs/${id}`);
    const c = R.song.hasChart ? await adm(`/api/songs/${id}/chart`) : null;
    R.chart = validChart(c) ? c : null;
  } catch (e) { toast(e.message, 4000); return home(); }
  renderSong();
}

/** Where each take actually reached, read off the chart rather than guessed. */
function takeRange(n) {
  const segs = (R.chart?.segments || []).filter((s) => (s.takes || []).includes(n));
  if (!segs.length) return null;
  return { from: Math.min(...segs.map((s) => s.start)), to: Math.max(...segs.map((s) => s.end)) };
}

/**
 * The song in patchable chunks. Built from the whole beat grid rather than from the chart, so a
 * stretch no take reached shows up as a gap to fill instead of silently not existing.
 */
function sections() {
  const built = new Map((R.chart?.segments || []).map((x) => [x.i, x]));
  const grid = segmentsFor(R.song).map((x) => ({ ...x, ...built.get(x.i), built: built.has(x.i) }));
  const tols = grid.filter((x) => x.built && !x.rest).map((x) => x.tol).sort((a, b) => a - b);
  const med = tols.length ? tols[Math.floor(tols.length / 2)] : 0;
  const out = [];
  for (let i = 0; i < grid.length; i += CHUNK_MOVES) {
    const part = grid.slice(i, i + CHUNK_MOVES);
    out.push({
      from: part[0].start,
      to: part.at(-1).end,
      moves: `${part[0].i + 1}–${part.at(-1).i + 1}`,
      loose: med ? part.filter((x) => x.built && !x.rest && x.tol > med * 2).length : 0,
      missing: part.filter((x) => !x.built).length,
    });
  }
  return out;
}

function renderSong() {
  const s = R.song;
  const rep = R.chart?.report;
  show('song');
  const scored = R.chart?.segments.filter((x) => !x.rest).length || 0;
  const takes = s.takes || [];
  const bar = el('div', { class: 'seg-bar', role: 'img', 'aria-label': `${scored} scored moves` },
    (R.chart?.segments || []).map((x) => el('span', { style: { background: x.rest ? 'var(--surface-2)' : 'var(--teal)' } })));
  $('#v-song').replaceChildren(
    topbar(home, 'Record', el('button', { class: 'icon-btn', 'aria-label': 'Delete song', onclick: deleteSong }, icon('trash', { size: 20 }))),
    el('div', { class: 'hero-move', style: { gap: '6px' } },
      el('h1', { style: { fontSize: '30px' } }, s.title),
      el('span', { class: 'muted', style: { fontSize: '14px' } },
        `${fmtTime(s.durationMs)} · ${Math.round(s.bpm)} BPM · a move every ${s.beatsPerMove} beats`),
      el('span', { class: `chip ${s.published ? 'tone-teal' : R.chart ? 'tone-gold' : 'tone-coral'}` },
        s.published ? 'Live on the big screen' : R.chart ? `Draft · ${scored} moves ready` : 'No takes yet')),
    R.chart ? bar : null,
    R.chart ? el('p', { class: 'muted', style: { fontSize: '13px' } },
      `Built from ${rep.takes} take${rep.takes === 1 ? '' : 's'}.${rep.singleTake ? ' One take is enough to play — a second and third make the strictness fair rather than a guess.' : ''}`) : null,
    el('div', { class: 'stack', style: { gap: '8px' } },
      el('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 600 } }, 'Takes'),
      ...(takes.length ? takes.map((t) => takeRow(t)) : [el('div', { class: 'tile muted', style: { fontSize: '14px' } }, 'None yet. Tap “Record the whole song”, listen to the four beats and dance from “GO!”.')])),
    el('div', { class: 'push' },
      el('button', { class: 'btn-rec btn-lg btn-block', onclick: () => start('take', null) }, 'Record the whole song'),
      el('button', { class: 'btn-block', disabled: !R.chart, onclick: pickSection }, 'Fix a section'),
      el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        el('button', { class: 'grow', disabled: !R.chart, onclick: () => start('test', null) }, 'Test it'),
        el('button', { class: 'grow', onclick: () => openSong(s.id) }, 'Refresh')),
      el('button', { class: s.published ? 'btn-danger btn-block' : 'btn-primary btn-block', disabled: !s.published && !scored, onclick: publish },
        s.published ? 'Unpublish' : 'Publish to the big screen')));
}

function takeRow(t) {
  const sc = (R.chart?.report.takeScores || []).find((x) => x.n === t.n);
  const range = takeRange(t.n);
  const whole = range && range.to - range.from >= (R.song.durationMs || 0) * 0.8;
  return el('div', { class: 'take-row' },
    el('span', { class: 'n' }, String(t.n)),
    el('div', { class: 'grow stack', style: { gap: '6px' } },
      el('span', { style: { fontSize: '13px', color: 'var(--muted)' } },
        range ? (whole ? 'Whole song' : `${fmtTime(range.from)}–${fmtTime(range.to)}`) : 'Covered nothing — too little motion'),
      el('div', { class: 'bar' }, el('span', { style: { width: `${sc?.agreement ?? 100}%`, background: sc?.odd ? 'var(--coral)' : (R.chart?.report.takes || 0) > 1 ? 'var(--teal)' : 'var(--line)' } }))),
    sc?.odd ? el('span', { class: 'chip tone-coral' }, 'Odd one') : null,
    el('button', { class: 'icon-btn', 'aria-label': `Delete take ${t.n}`, style: { background: 'transparent' }, onclick: async () => {
      if (!confirm(`Delete take ${t.n}?`)) return;
      try { await adm(`/api/songs/${R.song.id}/takes/${t.n}`, { method: 'DELETE' }); } catch (e) { return toast(e.message); }
      openSong(R.song.id);
    } }, icon('trash', { size: 18, stroke: 'var(--muted)' })));
}

function pickSection() {
  const list = el('div', { class: 'range-list' }, sections().map((x) => el('button', {
    onclick: () => start('take', x),
  },
    el('span', { class: 't' }, `${fmtTime(x.from)}–${fmtTime(x.to)}`),
    el('span', { class: 'grow' }, `Moves ${x.moves}`),
    x.missing ? el('span', { class: 'chip tone-coral' }, 'No take') : x.loose ? el('span', { class: 'chip tone-gold' }, 'Shaky') : el('span', { class: 'chip tone-teal' }, 'Good'))));
  $('#v-song').replaceChildren(
    topbar(renderSong, 'Fix a section'),
    el('p', { class: 'intro' }, 'Pick the part to dance again. The song plays from there and only those moves are rebuilt — the rest of the chart is left alone.'),
    list);
  window.scrollTo(0, 0);
}

async function publish() {
  try {
    const r = await adm(`/api/songs/${R.song.id}/publish`, { method: 'POST', body: { published: !R.song.published } });
    R.song = r;
    toast(r.published ? 'Published — it’s on the big screen now' : 'Unpublished');
    openSong(r.id);
  } catch (e) { toast(e.message, 4000); }
}

async function deleteSong() {
  if (!confirm(`Delete “${R.song.title}” and all its takes?`)) return;
  try { await adm(`/api/songs/${R.song.id}`, { method: 'DELETE' }); } catch (e) { return toast(e.message); }
  home();
}

// ---------------- sensors, grip check, count-in ----------------
function click(ctx, at, accent) {
  if (!ctx || at < ctx.currentTime) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1320 : 880;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.5, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.1);
}

async function start(mode, range) {
  if (R.busy) return;
  try {
    player.ctx ||= new (window.AudioContext || window.webkitAudioContext)(); // must be created inside the tap
    await player.ctx.resume();
  } catch { /* the song load will report it */ }
  try {
    if (!R.enabled) { await motion.enable(); R.enabled = true; keepAwake(); }
  } catch (e) { return toast(e.message, 5000); }
  if (!R.calibrated) return gripCheck(mode, range);
  perform(mode, range);
}

function gripCheck(mode, range) {
  show('grip');
  const msg = el('p', { style: { fontWeight: 700, minHeight: '1.4em', textAlign: 'center' } });
  const btn = el('button', { class: 'btn-primary btn-lg btn-block', onclick: async () => {
    btn.disabled = true;
    msg.style.color = 'var(--teal)';
    msg.textContent = 'Hold still… checking';
    const r = await motion.calibrate(1200).catch((e) => ({ ok: false, reason: e.message }));
    btn.disabled = false;
    if (!r.ok) { msg.style.color = 'var(--gold)'; msg.textContent = r.reason; return; }
    R.calibrated = true;
    perform(mode, range);
  } }, 'I’m holding it');
  $('#v-grip').replaceChildren(
    topbar(renderSong, 'Grip check'),
    el('h1', { style: { fontSize: '32px' } }, 'Hold it like a mic'),
    el('ol', { class: 'steps-list' },
      ['Right hand, like a microphone', 'Upright, screen facing you', 'Same grip for every take'].map((t, i) => el('li', {}, el('span', { class: 'n' }, String(i + 1)), t))),
    el('div', { class: 'push', style: { alignItems: 'stretch' } }, msg, btn));
}

/** mode: 'take' (save it as a reference) | 'test' (dance it and see the scores) */
async function perform(mode, range) {
  R.busy = true;
  const s = R.song;
  const fromMs = range ? range.from : 0;
  const toMs = range ? range.to : (R.chart?.segments.at(-1)?.end || s.durationMs);
  const beatMs = 60000 / s.bpm;
  show('perform');
  const num = el('span', { class: 'num' }, '');
  const label = el('span', { class: 'label' }, mode === 'take' ? (range ? `Recording moves ${range.moves}` : 'Recording the reference') : 'Test run');
  const beats = el('div', { class: 'beats' }, [...Array(COUNT_IN)].map(() => el('span')));
  const bar = el('div', { class: 'recbar' }, el('span'));
  let cancelled = false;
  const cancel = el('button', { class: 'btn-block', onclick: () => { cancelled = true; } }, 'Cancel');
  const err = el('p', { class: 'error', role: 'alert' });
  $('#v-perform').replaceChildren(el('div', { class: 'stage-count' }, label, num, beats, bar), err, cancel);

  const samples = [];
  let off = () => {};
  try {
    num.textContent = '…';
    await player.load(`/api/songs/${s.id}/audio`, { 'x-admin-pass': pass });
    const ctx = player.ctx;
    const outLat = player.outputLatencyMs();
    const nowPerf = performance.now(), nowCtx = ctx.currentTime;
    const atCtx = (perfMs) => nowCtx + (perfMs - nowPerf - outLat) / 1000;
    const t0Perf = performance.now() + 700;           // when the first count-in beat is heard
    const startAt = t0Perf + COUNT_IN * beatMs;       // when song time `fromMs` is heard
    for (let k = 0; k < COUNT_IN; k++) click(ctx, atCtx(t0Perf + k * beatMs), k === 0);
    window.__recClock = { startAt, fromMs, toMs }; // lets automated tests drive simulated motion
    off = motion.onSample((x) => {
      const t = fromMs + (x[0] - startAt);
      if (t >= fromMs - LEAD_MS && t <= toMs + LEAD_MS) samples.push([+t.toFixed(1), ...x.slice(1).map((v) => +v.toFixed(3))]);
    });
    await player.startAt(startAt, { fromMs, toMs: toMs + 400 });
    let lastBeat = -1;
    while (!cancelled) {
      const now = performance.now();
      if (now < startAt) {
        const b = Math.floor((now - t0Perf) / beatMs);
        if (b >= 0 && b !== lastBeat) {
          lastBeat = b;
          num.textContent = String(COUNT_IN - b);
          num.style.color = 'var(--text)';
          $$('span', beats).forEach((d, i) => d.classList.toggle('on', i <= b));
          if (navigator.vibrate) navigator.vibrate(b === 0 ? 60 : 30);
        }
      } else {
        const t = player.songMs();
        if (num.textContent !== 'GO!') { num.textContent = 'GO!'; num.style.color = 'var(--gold)'; label.textContent = 'Dance!'; if (navigator.vibrate) navigator.vibrate(80); }
        bar.firstChild.style.width = `${Math.min(100, Math.max(0, ((t - fromMs) / (toMs - fromMs)) * 100))}%`;
        if (t > toMs + LEAD_MS) break;
      }
      await sleep(30);
    }
  } catch (e) {
    err.textContent = e.message;
    off();
    player.stop();
    R.busy = false;
    cancel.textContent = 'Back';
    cancel.onclick = renderSong;
    return;
  }
  off();
  player.stop();
  R.busy = false;
  if (cancelled) return renderSong();
  if (samples.length < 20) { toast('Hardly any motion arrived — keep the screen on and try again.', 5000); return renderSong(); }
  if (mode === 'take') return saveTake(samples, fromMs, toMs);
  return showResult(samples);
}

async function saveTake(samples, fromMs, toMs) {
  show('perform');
  $('#v-perform').replaceChildren(el('div', { class: 'stage-count' }, el('span', { class: 'label' }, 'Saving the take…'), el('span', { class: 'num' }, '✓')));
  try {
    const { n } = await adm(`/api/songs/${R.song.id}/takes`, { method: 'POST', body: { samples, durationMs: Math.round(toMs - fromMs), device: navigator.userAgent } });
    toast(`Take ${n} saved`);
  } catch (e) { toast(e.message, 5000); }
  await openSong(R.song.id);
}

// ---------------- test run result ----------------
async function showResult(samples) {
  const chart = R.chart;
  const scored = chart.segments.filter((x) => !x.rest);
  const rows = scored.map((seg) => ({ seg, r: scoreDetail(chart, seg, samples) }));
  const acc = rows.length ? Math.round(rows.reduce((a, x) => a + x.r.score, 0) / rows.length) : 0;
  const count = (n) => rows.filter((x) => x.r.name === n).length;
  const weak = rows.filter((x) => x.r.name === 'MISS' || x.r.name === 'OK');
  show('result');
  $('#v-result').replaceChildren(
    topbar(renderSong, R.song.title),
    el('div', { class: 'hero-move', style: { gap: '4px' } },
      el('span', { class: 'display', style: { fontSize: '56px', color: 'var(--gold)' } }, `${acc}%`),
      el('span', { class: 'muted' }, `${count('PERFECT')} perfect · ${count('GOOD')} good · ${count('OK')} OK · ${count('MISS')} missed`)),
    el('div', { class: 'tile muted', style: { fontSize: '14px' } },
      weak.length
        ? `If you danced those right, the chart is the problem, not you — record another take, or fix just that section.`
        : 'The chart matches the way you dance. Publish it.'),
    el('div', { style: { overflow: 'auto', maxHeight: '46vh' } },
      el('table', { class: 'scores' },
        el('thead', {}, el('tr', {}, ['#', 'At', 'Score', 'Tip'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows.map(({ seg, r }) => el('tr', {},
          el('td', {}, String(seg.i + 1)),
          el('td', { class: 'muted' }, `${(seg.start / 1000).toFixed(1)}s`),
          el('td', { style: { color: GRADE_VAR[r.name], fontWeight: 700 } }, String(r.score)),
          el('td', { class: 'muted', style: { fontSize: '13px' } }, r.tip)))))),
    el('div', { class: 'push' },
      el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => start('test', null) }, icon('loop', { size: 20, stroke: 'var(--bg)', width: 2.4 }), 'Test again'),
      weak.length ? el('button', { class: 'btn-block', onclick: pickSection }, 'Fix a section') : null,
      el('button', { class: 'btn-block', onclick: renderSong }, 'Back to the song')));
}

// ---------------- boot ----------------
const deep = new URLSearchParams(location.search).get('song');
if (deep && isAdmin()) openSong(deep).catch(home); else home();
window.__record = { R, motion, player };
