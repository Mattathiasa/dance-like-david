// Move Lab: record an action on your phone, then try it and get a score. No song, TV or laptop needed.
import { $, $$, el, api, auth, store, sleep, fmtNum, avatar, toast } from './common.js';
import { icon, MOVE_ICONS, MOVE_ICON_LABELS } from './icons.js';
import { MotionCapture, keepAwake } from './motion-capture.js';
import { scoreDetail, intensityCurve, TIERS } from '/shared/motion.js';

const LEAD_MS = 600;
const motion = new MotionCapture();
const L = { moves: [], move: null, chart: null, enabled: false, calibrated: false, audio: null, busy: false };
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
const secs = (ms) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;

// ---------------- home ----------------
async function home() {
  show('home');
  const box = $('#v-home');
  const u = auth.user;
  box.replaceChildren(
    el('div', { class: 'lab-head' },
      el('span', { class: 't' }, icon('crown', { size: 28, stroke: 'var(--gold)' }), 'Move Lab'),
      u ? el('span', { class: 'row', style: { gap: '8px', fontSize: '14px' } }, avatar(u.displayName, 32), u.displayName)
        : el('a', { href: `/phone?signin=1&return=${encodeURIComponent('/lab')}`, style: { fontWeight: 600, fontSize: '14px' } }, 'Sign in')),
    el('p', { class: 'intro' }, 'Pick a move, dance it with your phone in your right hand, and see how close you got. No big screen needed.'),
    el('div', { class: 'move-list', id: 'moveList' }, el('p', { class: 'muted' }, 'Loading moves…')),
    el('div', { class: 'push' },
      isAdmin()
        ? el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => editMove(null) }, icon('camera', { size: 20, stroke: 'var(--bg)' }), 'Record a new move')
        : el('button', { class: 'btn-block', onclick: unlock }, 'Admin: record moves'),
      el('a', { class: 'btn btn-block', href: '/phone' }, 'Join a game on the big screen')));
  try {
    L.moves = isAdmin() ? await adm('/api/moves') : await api('/api/moves', { token: null });
  } catch (e) {
    if (e.status === 401 && isAdmin()) { pass = ''; try { sessionStorage.removeItem('ddl.pass'); } catch { /* ignore */ } return home(); }
    $('#moveList').replaceChildren(el('p', { class: 'error' }, e.message));
    return;
  }
  const list = $('#moveList');
  list.replaceChildren();
  if (!L.moves.length) list.append(el('div', { class: 'tile muted' }, isAdmin() ? 'No moves yet — record your first one below.' : 'No moves yet. Ask the admin to record some.'));
  for (const m of L.moves) {
    const status = !m.published ? el('span', { class: 'chip tone-gold' }, m.takes ? 'Draft' : 'Needs takes') : null;
    list.append(el('button', { class: 'move-row', onclick: () => openMove(m.id) },
      el('span', { class: 'pic' }, icon(m.icon || 'wave', { size: 28, width: 2.2 })),
      el('div', { class: 'grow' }, el('b', {}, m.name), el('span', {}, `${secs(m.durationMs)} · ${m.bpm} BPM${m.tries ? ` · ${m.tries} tries` : ''}`)),
      status || (m.best ? el('span', { class: 'best', 'aria-label': `Best score ${m.best}` }, String(m.best)) : icon('play', { size: 18, fill: 'var(--muted)', stroke: 'none' }))));
  }
}

// ---------------- admin unlock ----------------
function unlock() {
  show('unlock');
  const input = el('input', { type: 'password', autocomplete: 'current-password', id: 'apass' });
  const err = el('p', { class: 'error', role: 'alert' });
  $('#v-unlock').replaceChildren(
    el('div', { class: 'topbar' }, back(home), el('h1', { style: { fontSize: '24px' } }, 'Admin'), el('span', { style: { width: '44px' } })),
    el('form', { class: 'stack', style: { gap: '16px' }, onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('/api/login', { method: 'POST', body: { password: input.value }, token: null });
        pass = input.value;
        try { sessionStorage.setItem('ddl.pass', pass); } catch { /* ignore */ }
        home();
      } catch (ex) { err.textContent = ex.message; }
    } }, el('label', { class: 'field' }, 'Admin password', input), err, el('button', { class: 'btn-primary btn-lg' }, 'Unlock recording')));
  input.focus();
}

// ---------------- move page ----------------
async function openMove(id) {
  try {
    L.move = isAdmin() ? await adm(`/api/moves/${id}`) : await api(`/api/moves/${id}`, { token: null });
    L.chart = L.move.takes ? await (isAdmin() ? adm : (p) => api(p, { token: null }))(`/api/moves/${id}/chart`) : null;
  } catch (e) { toast(e.message); return; }
  const m = L.move;
  show('move');
  const seg = L.chart?.segments[0];
  const curveBox = seg ? drawCurve(intensityCurve(L.chart, seg, null)) : null;
  $('#v-move').replaceChildren(
    el('div', { class: 'topbar' }, back(home), el('span', { class: 'muted', style: { fontSize: '14px', fontWeight: 600 } }, 'Move Lab'),
      isAdmin() ? el('button', { class: 'icon-btn', 'aria-label': 'Edit move', onclick: () => editMove(m) }, icon('camera', { size: 20 })) : el('span', { style: { width: '44px' } })),
    el('div', { class: 'hero-move' },
      icon(m.icon || 'wave', { size: 88, width: 1.8 }),
      el('h1', { style: { fontSize: '34px' } }, m.name),
      m.description ? el('p', { class: 'muted' }, m.description) : null,
      el('span', { class: 'muted', style: { fontSize: '14px' } }, `${secs(m.durationMs)} · count-in at ${m.bpm} BPM${m.metronome ? ' · beat plays during the move' : ''}`)),
    curveBox ? el('div', { class: 'stack', style: { gap: '6px' } }, el('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 600 } }, 'The shape of the move (how hard it moves over time)'), curveBox) : el('div', { class: 'tile muted' }, 'This move has no recording yet.'),
    el('div', { class: 'push' },
      el('button', { class: 'btn-primary btn-lg btn-block', disabled: !m.ready, onclick: () => start('try') }, icon('play', { size: 20, fill: 'var(--bg)', stroke: 'none' }), 'Try it'),
      el('button', { class: 'btn-block', onclick: showBoard }, icon('star', { size: 18 }), 'Leaderboard')));
}

async function showBoard() {
  const m = L.move;
  const rows = el('div', { class: 'stack', style: { gap: '8px' } }, el('p', { class: 'muted' }, 'Loading…'));
  show('result');
  $('#v-result').replaceChildren(el('div', { class: 'topbar' }, back(() => openMove(m.id)), el('h1', { style: { fontSize: '24px', flexGrow: 1 } }, `${m.name} — top scores`)), rows);
  try {
    const { rows: list } = await api(`/api/moves/${m.id}/leaderboard`, { token: null });
    rows.replaceChildren(...(list.length ? list.map((r) => el('div', { class: `lb${r.userId === auth.user?.id ? ' me' : ''}${r.rank === 1 ? ' top' : ''}` },
      el('span', { class: 'rk' }, String(r.rank)), avatar(r.name, 36), el('span', { class: 'grow', style: { fontWeight: 600 } }, r.name), el('span', { class: 'pt' }, `${r.score}`)))
      : [el('div', { class: 'tile muted' }, 'No signed-in scores yet. Be the first!')]));
  } catch (e) { rows.replaceChildren(el('p', { class: 'error' }, e.message)); }
}

function drawCurve({ ref, you }) {
  const W = 300, H = 90, max = Math.max(0.01, ...ref, ...(you || []));
  const pts = (arr) => arr.map((v, i) => `${((i / (arr.length - 1)) * W).toFixed(1)},${(H - 4 - (v / max) * (H - 10)).toFixed(1)}`).join(' ');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'curve');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', you ? 'Your motion compared with the reference' : 'Motion intensity of the move over time');
  const fill = document.createElementNS(NS, 'polygon');
  fill.setAttribute('points', `0,${H} ${pts(ref)} ${W},${H}`);
  fill.setAttribute('class', 'ref-fill');
  const r = document.createElementNS(NS, 'polyline');
  r.setAttribute('points', pts(ref));
  r.setAttribute('class', 'ref');
  svg.append(fill, r);
  if (you) { const y = document.createElementNS(NS, 'polyline'); y.setAttribute('points', pts(you)); y.setAttribute('class', 'you'); svg.append(y); }
  const wrap = el('div', { class: 'tile', style: { padding: '12px' } }, svg);
  if (you) wrap.append(el('div', { class: 'legend2', style: { marginTop: '8px' } }, el('span', {}, el('i', { style: { background: 'var(--muted)' } }), 'Reference'), el('span', {}, el('i', { style: { background: 'var(--gold)' } }), 'You')));
  return wrap;
}

// ---------------- sensors, grip, count-in ----------------
function ensureAudio() {
  try {
    L.audio ||= new (window.AudioContext || window.webkitAudioContext)();
    L.audio.resume();
  } catch { L.audio = null; }
}
function click(at, accent) {
  const ctx = L.audio;
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1320 : 880;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.5, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.1);
}

/** mode: 'try' | 'take' | 'test' */
async function start(mode) {
  if (L.busy) return;
  ensureAudio(); // must happen inside the tap
  try {
    if (!L.enabled) { await motion.enable(); L.enabled = true; keepAwake(); }
  } catch (e) { toast(e.message, 5000); return; }
  if (!L.calibrated) return gripCheck(mode);
  perform(mode);
}

function gripCheck(mode) {
  show('grip');
  const msg = el('p', { style: { fontWeight: 700, minHeight: '1.4em', textAlign: 'center' } });
  const btn = el('button', { class: 'btn-primary btn-lg btn-block', onclick: async () => {
    btn.disabled = true;
    msg.style.color = 'var(--teal)';
    msg.textContent = 'Hold still… checking';
    const r = await motion.calibrate(1200).catch((e) => ({ ok: false, reason: e.message }));
    btn.disabled = false;
    if (!r.ok) { msg.style.color = 'var(--gold)'; msg.textContent = r.reason; return; }
    L.calibrated = true;
    perform(mode);
  } }, 'I’m holding it');
  $('#v-grip').replaceChildren(
    el('div', { class: 'topbar' }, back(() => (L.move?.id ? openMove(L.move.id) : home())), el('span', { class: 'muted', style: { fontWeight: 600, fontSize: '14px' } }, 'Grip check'), el('span', { style: { width: '44px' } })),
    el('h1', { style: { fontSize: '32px' } }, 'Hold it like a mic'),
    el('ol', { class: 'steps-list' },
      ['Right hand, like a microphone', 'Upright, screen facing you', 'Same grip for every try'].map((t, i) => el('li', {}, el('span', { class: 'n' }, String(i + 1)), t))),
    el('div', { class: 'push', style: { alignItems: 'stretch' } }, msg, btn));
}

async function perform(mode) {
  L.busy = true;
  const m = L.move;
  const beatMs = 60000 / m.bpm;
  const countIn = 4;
  show('perform');
  const num = el('span', { class: 'num' }, '');
  const label = el('span', { class: 'label' }, mode === 'take' ? 'Recording the reference' : `Get ready: ${m.name}`);
  const beats = el('div', { class: 'beats' }, [...Array(countIn)].map(() => el('span')));
  const bar = el('div', { class: 'recbar' }, el('span'));
  const cancel = el('button', { class: 'btn-block', onclick: () => { cancelled = true; } }, 'Cancel');
  let cancelled = false;
  $('#v-perform').replaceChildren(el('div', { class: 'stage-count' }, label, num, beats, bar), cancel);

  // schedule the count-in (and the metronome during the move) on the audio clock
  const ctx = L.audio;
  const outLat = ctx ? ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 : 0;
  const t0Audio = ctx ? ctx.currentTime + 0.6 : 0;
  const t0Perf = performance.now() + 600 + outLat; // when the first click is heard
  if (ctx) {
    for (let k = 0; k < countIn; k++) click(t0Audio + (k * beatMs) / 1000, k === 0);
    if (m.metronome) for (let t = 0, k = 0; t < m.durationMs - 1; t += beatMs, k++) click(t0Audio + (countIn * beatMs + t) / 1000, k % 4 === 0);
  }
  const moveStart = t0Perf + countIn * beatMs; // performance.now() when the move begins
  window.__labClock = { moveStart }; // lets automated tests drive simulated motion
  const samples = [];
  const off = motion.onSample((s) => {
    const t = s[0] - moveStart;
    if (t >= -LEAD_MS && t <= m.durationMs + LEAD_MS) samples.push([+t.toFixed(1), ...s.slice(1).map((v) => +v.toFixed(3))]);
  });
  let lastBeat = -1;
  while (!cancelled) {
    const now = performance.now();
    const t = now - moveStart;
    if (t < 0) {
      const b = Math.floor((now - t0Perf) / beatMs);
      if (b >= 0 && b !== lastBeat) {
        lastBeat = b;
        num.textContent = String(countIn - b);
        num.style.color = 'var(--text)';
        $$('span', beats).forEach((d, i) => d.classList.toggle('on', i <= b));
        if (navigator.vibrate) navigator.vibrate(b === 0 ? 60 : 30);
      }
    } else if (t <= m.durationMs) {
      if (num.textContent !== 'GO!') { num.textContent = 'GO!'; num.style.color = 'var(--gold)'; label.textContent = 'Dance!'; if (navigator.vibrate) navigator.vibrate(80); }
      bar.firstChild.style.width = `${(t / m.durationMs) * 100}%`;
    } else if (t > m.durationMs + LEAD_MS) break;
    else { num.textContent = '✓'; label.textContent = 'Hold on…'; }
    await sleep(30);
  }
  off();
  L.busy = false;
  if (cancelled) return mode === 'try' ? openMove(m.id) : editMove(m);
  if (samples.length < 20) { toast('Hardly any motion data arrived — keep the screen on and try again.', 5000); return mode === 'try' ? openMove(m.id) : editMove(m); }

  if (mode === 'take') return saveTake(samples);
  return showResult(samples, mode);
}

// ---------------- results ----------------
async function showResult(samples, mode) {
  const m = L.move;
  if (mode === 'test') L.chart = await adm(`/api/moves/${m.id}/chart`);
  const chart = L.chart;
  const seg = chart.segments[0];
  const r = scoreDetail(chart, seg, samples);
  const shifted = samples.map((s) => [s[0] - r.lagMs, ...s.slice(1)]);
  const curve = drawCurve(intensityCurve(chart, seg, shifted));
  let save = null;
  if (mode === 'try') {
    save = await api(`/api/moves/${m.id}/attempts`, { method: 'POST', body: { score: r.score, grade: r.name, reason: r.reason, name: store.get('ddl.name', 'Guest') } }).catch(() => null);
  }
  show('result');
  const C = 2 * Math.PI * 88;
  const NS = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(NS, 'svg');
  ring.setAttribute('viewBox', '0 0 200 200');
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = `<circle cx="100" cy="100" r="88" fill="none" stroke="#2A1D4D" stroke-width="14"/><circle cx="100" cy="100" r="88" fill="none" stroke-width="14" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1);stroke:${GRADE_VAR[r.name]}"/>`;
  requestAnimationFrame(() => requestAnimationFrame(() => ring.lastChild.setAttribute('stroke-dashoffset', String(C * (1 - r.score / 100)))));
  const timing = ['no-data', 'still', 'shaky'].includes(r.reason) ? '—' : Math.abs(r.lagMs) < 120 ? 'On time' : `${(Math.abs(r.lagMs) / 1000).toFixed(1)} s ${r.lagMs > 0 ? 'late' : 'early'}`;
  const size = r.size && r.reason !== 'no-data' ? `${Math.round(r.size * 100)}%` : '—';
  const note = mode === 'test' ? el('div', { class: 'tile muted', style: { fontSize: '14px' } }, 'Test run — not saved to the leaderboard.')
    : save?.personalBest ? el('div', { class: 'ok-note' }, icon('check', { size: 22, stroke: 'var(--teal)', width: 2.4 }), el('span', {}, `New personal best${save.rank ? ` — #${save.rank} on the leaderboard` : ''}`))
    : save && !save.signedIn ? el('div', { class: 'acct' }, el('span', { class: 'grow', style: { fontSize: '14px' } }, 'Sign in to save your best score.'), el('a', { href: `/phone?signin=1&return=${encodeURIComponent('/lab')}`, style: { fontWeight: 600 } }, 'Sign in'))
    : save ? el('div', { class: 'tile muted', style: { fontSize: '14px' } }, `Your best: ${save.best}`) : null;
  $('#v-result').replaceChildren(...[
    el('div', { class: 'topbar' }, back(() => (mode === 'test' ? editMove(m) : openMove(m.id))), el('span', { class: 'muted', style: { fontWeight: 600, fontSize: '14px' } }, m.name), el('span', { style: { width: '44px' } })),
    el('div', { class: 'ring', role: 'img', 'aria-label': `Score ${r.score} out of 100, ${r.name}` }, ring,
      el('div', { class: 'val' }, el('b', {}, String(r.score)), el('span', { style: { color: GRADE_VAR[r.name] } }, r.name))),
    el('div', { class: 'tip' }, icon(r.name === 'PERFECT' ? 'star' : r.name === 'MISS' ? 'warn' : 'check', { size: 22, stroke: GRADE_VAR[r.name], width: 2.4 }), el('span', {}, r.tip)),
    el('div', { class: 'facts' }, el('div', {}, el('b', {}, timing), el('span', {}, 'Timing')), el('div', {}, el('b', {}, size), el('span', {}, 'Size vs reference')), el('div', {}, el('b', {}, r.ratio == null ? '—' : r.ratio.toFixed(2)), el('span', {}, 'Distance (lower is better)'))),
    curve,
    note,
    el('div', { class: 'push' },
      el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => start(mode === 'test' ? 'test' : 'try') }, icon('loop', { size: 20, stroke: 'var(--bg)', width: 2.4 }), 'Try again'),
      mode === 'test' ? el('button', { class: 'btn-block', onclick: () => editMove(m) }, 'Back to editing') : el('button', { class: 'btn-block', onclick: showBoard }, 'Leaderboard')),
  ].filter(Boolean));
}

// ---------------- admin: create / edit a move ----------------
async function editMove(m) {
  if (!isAdmin()) return unlock();
  show('edit');
  const box = $('#v-edit');
  const draft = m ? { ...m } : { name: '', description: '', icon: 'wave', durationMs: 4000, bpm: 100, metronome: true };
  const name = el('input', { maxlength: 40, value: draft.name, placeholder: 'e.g. Arm sweep left' });
  const desc = el('input', { maxlength: 200, value: draft.description || '', placeholder: 'One line: how the move goes' });
  const dur = el('select', {}, [2000, 3000, 4000, 5000, 6000, 8000].map((v) => el('option', { value: v, selected: v === draft.durationMs }, secs(v))));
  const bpm = el('input', { type: 'number', min: 60, max: 160, value: draft.bpm });
  const metro = el('input', { type: 'checkbox', checked: draft.metronome !== false });
  let chosen = draft.icon;
  const icons = el('div', { class: 'icon-pick' }, MOVE_ICONS.map((k) => el('button', {
    type: 'button', 'aria-label': MOVE_ICON_LABELS[k], 'aria-pressed': String(k === chosen),
    onclick: (e) => { chosen = k; for (const b of $$('button', icons)) b.setAttribute('aria-pressed', String(b === e.currentTarget)); },
  }, icon(k, { size: 24, width: 2.2 }))));
  const err = el('p', { class: 'error', role: 'alert' });
  const body = () => ({ name: name.value, description: desc.value, icon: chosen, durationMs: Number(dur.value), bpm: Number(bpm.value), metronome: metro.checked });
  async function save() {
    err.textContent = '';
    try {
      if (m) {
        if (Number(dur.value) !== m.durationMs && m.takes && !confirm('Changing the length re-cuts the existing takes. Re-record them for best results. Continue?')) return null;
        L.move = await adm(`/api/moves/${m.id}`, { method: 'PATCH', body: body() });
      } else L.move = await adm('/api/moves', { method: 'POST', body: body() });
      return L.move;
    } catch (e) { err.textContent = e.message; return null; }
  }
  const takesBox = el('div', { class: 'stack', style: { gap: '8px' } });
  box.replaceChildren(
    el('div', { class: 'topbar' }, back(() => (m ? openMove(m.id) : home())), el('h1', { style: { fontSize: '24px' } }, m ? 'Edit move' : 'New move'), el('span', { style: { width: '44px' } })),
    el('label', { class: 'field' }, 'Name', name),
    el('label', { class: 'field' }, 'Description', desc),
    el('div', { class: 'stack', style: { gap: '8px' } }, el('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 600 } }, 'Pictogram'), icons),
    el('div', { class: 'two', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, el('label', { class: 'field' }, 'Length', dur), el('label', { class: 'field' }, 'Count-in tempo (BPM)', bpm)),
    el('label', { class: 'check', style: { color: 'var(--text)' } }, metro, 'Play the beat during the move (helps everyone keep time)'),
    err,
    m ? takesBox : null,
    el('div', { class: 'push' }, ...(m ? [
      el('button', { class: 'btn-rec btn-lg btn-block', onclick: async () => { if (await save()) start('take'); } }, 'Record a take'),
      el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        el('button', { class: 'grow', disabled: !m.takes, onclick: async () => { if (await save()) start('test'); } }, 'Test it'),
        el('button', { class: 'grow', onclick: async () => { if (await save()) toast('Saved'); } }, 'Save')),
      el('button', { class: m.published ? 'btn-danger btn-block' : 'btn-primary btn-block', disabled: !m.published && !m.ready, onclick: async () => {
        const s = await save(); if (!s) return;
        try { L.move = await adm(`/api/moves/${m.id}`, { method: 'PATCH', body: { published: !m.published } }); toast(L.move.published ? 'Published — everyone can try it now' : 'Unpublished'); editMove(L.move); } catch (e) { err.textContent = e.message; }
      } }, m.published ? 'Unpublish' : 'Publish to everyone'),
      el('button', { class: 'btn-danger btn-block', style: { background: 'transparent' }, onclick: async () => {
        if (!confirm(`Delete “${m.name}” and all its takes?`)) return;
        await adm(`/api/moves/${m.id}`, { method: 'DELETE' }); home();
      } }, 'Delete move'),
    ] : [
      el('button', { class: 'btn-primary btn-lg btn-block', onclick: async () => { if (!name.value.trim()) { err.textContent = 'Give the move a name'; return; } const s = await save(); if (s) editMove(s); } }, 'Create and record takes'),
    ])));
  if (m) renderTakes(takesBox, m);
}

async function renderTakes(box, m) {
  box.replaceChildren(el('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 600 } }, 'Takes — record the same move 3 times'));
  let takes = [];
  try { takes = await adm(`/api/moves/${m.id}/takes`); } catch (e) { box.append(el('p', { class: 'error' }, e.message)); return; }
  if (!takes.length) box.append(el('div', { class: 'tile muted', style: { fontSize: '14px' } }, 'No takes yet. Tap “Record a take”, listen to the 4-beat count-in, then dance on “GO!”.'));
  for (const t of takes) {
    const odd = t.odd;
    box.append(el('div', { class: 'take-row' }, el('span', { class: 'n' }, String(t.n)),
      el('div', { class: 'grow stack', style: { gap: '6px' } },
        el('span', { style: { fontSize: '13px', color: 'var(--muted)' } }, t.agreement != null && takes.length > 1 ? `${t.agreement}% agreement${t.shiftMs ? ` · aligned ${t.shiftMs > 0 ? '+' : ''}${t.shiftMs} ms` : ''}` : 'Recorded'),
        el('div', { class: 'bar' }, el('span', { style: { width: `${t.agreement ?? 100}%`, background: odd ? 'var(--coral)' : takes.length > 1 ? 'var(--teal)' : 'var(--line)' } }))),
      odd ? el('span', { class: 'chip tone-coral' }, 'Odd one') : null,
      el('button', { class: 'icon-btn', 'aria-label': `Delete take ${t.n}`, style: { background: 'transparent' }, onclick: async () => {
        L.move = await adm(`/api/moves/${m.id}/takes/${t.n}`, { method: 'DELETE' }); renderTakes(box, L.move);
      } }, icon('trash', { size: 18, stroke: 'var(--muted)' }))));
  }
  const rep = L.move?.report;
  if (rep?.rest) box.append(el('div', { class: 'tile', style: { background: 'var(--gold-bg)', fontSize: '14px' } }, 'The takes barely move — dance bigger so there’s something to score.'));
  else if (takes.length && takes.length < 3) box.append(el('p', { class: 'muted', style: { fontSize: '13px' } }, `Record ${3 - takes.length} more — with fewer than 3, how strict scoring is becomes a guess.`));
}

async function saveTake(samples) {
  const m = L.move;
  try {
    const r = await adm(`/api/moves/${m.id}/takes`, { method: 'POST', body: { samples } });
    L.move = r.move;
    toast(`Take ${r.n} saved`);
  } catch (e) { toast(e.message, 5000); }
  editMove(L.move);
}

// ---------------- boot ----------------
if (auth.token) api('/api/me').then(({ user }) => auth.set(auth.token, user)).catch((e) => { if (e.status === 401) auth.clear(); });
const deep = new URLSearchParams(location.search).get('move');
if (deep) openMove(deep); else home();
window.__lab = { L, motion };
