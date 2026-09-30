// Phone controller: join, account, grip check, live scoring (offline-tolerant), results, practice, profile, leaderboard.
import { $, $$, el, api, auth, Link, store, sleep, fmtTime, fmtNum, ordinal, avatar, coverEl, toast } from './common.js';
import { icon, defaultMoveIcon } from './icons.js';
import { MotionCapture, keepAwake } from './motion-capture.js';
import { gradeSegment, extendsStreak } from '/shared/motion.js';

const link = new Link();
const motion = new MotionCapture();
const P = {
  view: 'join', back: 'join', code: null, id: null, secret: null, kind: null, seated: false,
  chart: null, song: null, session: null, outbox: [], place: null, of: null, final: null, practice: null, hostUp: true,
};
const GRADE_COLORS = { PERFECT: 'var(--gold)', GOOD: 'var(--teal)', OK: 'var(--blue)', MISS: 'var(--coral)' };

// ---------------- views ----------------
function show(view) {
  if (['join', 'wait'].includes(view)) P.back = view;
  P.view = view;
  for (const s of $$('main > section')) s.hidden = s.id !== `v-${view}`;
  window.scrollTo(0, 0);
  renderNet();
}
const backBtn = () => el('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => show(P.seated ? 'wait' : 'join') }, icon('back', { size: 20 }));
for (const b of $$('[data-back]')) { b.append(icon('back', { size: 20 })); b.addEventListener('click', () => show(P.seated ? 'wait' : 'join')); }
$('#logoIcon').append(icon('crown', { size: 56, stroke: 'var(--gold)', width: 1.8 }));

// ---------------- network status ----------------
function renderNet() {
  const offline = P.seated && !link.connected;
  const hostDown = P.seated && link.connected && !P.hostUp;
  const pending = P.outbox.length;
  const box = P.view === 'dance' ? $('#dAlert') : $('#netAlert');
  (P.view === 'dance' ? $('#netAlert') : $('#dAlert')).hidden = true;
  box.hidden = !(offline || hostDown);
  if (offline) {
    box.replaceChildren(icon('wifiOff', { size: 24, stroke: 'var(--gold)' }), el('div', {}, el('b', {}, 'Wi-Fi dropped, reconnecting…'),
      el('span', { style: { fontSize: '14px' } }, P.session ? `Keep dancing. Your phone is still scoring${pending ? ` — ${pending} move${pending > 1 ? 's' : ''} waiting to sync` : ''}.` : 'Hang on, trying again every few seconds.')));
  } else if (hostDown) {
    box.replaceChildren(icon('wifiOff', { size: 24, stroke: 'var(--gold)' }), el('div', {}, el('b', {}, 'The big screen dropped off'), el('span', { style: { fontSize: '14px' } }, 'Waiting for it to come back…')));
  }
  for (const pill of [$('#syncPill'), $('#dSync')]) {
    pill.replaceChildren(el('span', { class: `dot${link.connected ? '' : ' bad'}` }),
      el('span', {}, link.connected ? `Synced · ${Math.round(link.lastRtt ?? 0)} ms` : 'Offline'));
  }
}
link.addEventListener('sync', renderNet);
link.addEventListener('disconnected', renderNet);
link.addEventListener('retrying', renderNet);
link.addEventListener('reconnected', async () => {
  if (!P.seated) return renderNet();
  link.raw({ t: 'rejoin', code: P.code, id: P.id, secret: P.secret });
  try {
    const m = await link.waitFor('rejoined');
    P.hostUp = m.hostConnected;
    flush();
    toast('Back online');
  } catch {
    P.seated = false;
    stopSession();
    show('join');
    $('#joinErr').textContent = 'You were away too long and lost your spot. Join again.';
  }
  renderNet();
});

/** Send to the big screen, or queue while offline (grades are never lost). */
function toHost(msg) {
  if (P.seated && link.connected && link.raw({ t: 'toHost', msg })) return;
  if (msg.type === 'grade') P.outbox.push(msg);
  renderNet();
}
function flush() {
  const q = P.outbox.splice(0);
  for (const msg of q) link.raw({ t: 'toHost', msg });
}

async function ensureConnected() {
  if (link.connected) return;
  if (!link.started) { link.started = true; link.connect(); }
  const t0 = Date.now();
  while (!link.connected) {
    if (Date.now() - t0 > 8000) throw new Error('Can’t reach the server — check the Wi-Fi and try again.');
    await sleep(100);
  }
}

// ---------------- join ----------------
const digits = $('#digits');
for (let i = 0; i < 4; i++) {
  digits.append(el('input', { inputmode: 'numeric', maxlength: 1, pattern: '[0-9]', 'aria-label': `Room code digit ${i + 1}`, autocomplete: 'off' }));
}
const digitInputs = $$('input', digits);
digitInputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    const v = inp.value.replace(/\D/g, '');
    if (v.length > 1) { fillCode(v); return; } // paste
    inp.value = v;
    if (v && i < 3) digitInputs[i + 1].focus();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && i > 0) digitInputs[i - 1].focus(); });
  inp.addEventListener('paste', (e) => { e.preventDefault(); fillCode((e.clipboardData.getData('text') || '').replace(/\D/g, '')); });
});
function fillCode(v) { v.slice(0, 4).split('').forEach((d, i) => { digitInputs[i].value = d; }); digitInputs[Math.min(3, v.length)]?.focus(); }
const codeValue = () => digitInputs.map((x) => x.value).join('');
fillCode(new URLSearchParams(location.search).get('code') || '');

function renderAccount() {
  const u = auth.user;
  const name = $('#name');
  const box = $('#acct');
  if (u) {
    name.value = u.displayName;
    name.disabled = true;
    box.replaceChildren(avatar(u.displayName, 40), el('div', { class: 'grow' }, el('span', { style: { fontWeight: 600, fontSize: '15px' } }, `Signed in as ${u.displayName}`), el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Scores save to your profile')),
      el('a', { href: '#', style: { fontWeight: 600, fontSize: '14px' }, onclick: (e) => { e.preventDefault(); openProfile(); } }, 'Profile'));
  } else {
    name.disabled = false;
    name.value = store.get('ddl.name', '');
    box.replaceChildren(icon('user', { size: 26, stroke: 'var(--muted)' }), el('div', { class: 'grow' }, el('span', { style: { fontWeight: 600, fontSize: '15px' } }, 'Dancing as a guest'), el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Sign in to save scores and climb the leaderboard')),
      el('a', { href: '#', style: { fontWeight: 600, fontSize: '14px' }, onclick: (e) => { e.preventDefault(); openAuth(); } }, 'Sign in'));
  }
}

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#joinErr');
  err.textContent = '';
  const code = codeValue();
  if (!/^\d{4}$/.test(code)) { err.textContent = 'Enter the 4-digit code from the big screen.'; digitInputs[0].focus(); return; }
  const btn = $('#joinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    // iOS only allows the motion permission prompt inside this tap, so ask first.
    await motion.enable();
    await ensureConnected();
    const name = $('#name').value.trim() || 'Dancer';
    if (!auth.user) store.set('ddl.name', name);
    const seat = store.get('ddl.seat');
    let joined = null;
    if (seat && seat.code === code && Date.now() - seat.at < 110000) {
      link.raw({ t: 'rejoin', code, id: seat.id, secret: seat.secret });
      joined = await link.waitFor('rejoined').then((m) => ({ ...m, secret: seat.secret })).catch(() => null);
    }
    if (!joined) {
      link.raw({ t: 'join', code, name, token: auth.token, device: navigator.userAgent });
      joined = await link.waitFor('joined');
    }
    Object.assign(P, { code, id: joined.id, secret: joined.secret, kind: joined.kind, seated: true, hostUp: joined.hostConnected !== false });
    store.set('ddl.seat', { code, id: joined.id, secret: joined.secret, at: Date.now() });
    keepAwake();
    $('#gripRoom').textContent = `Room ${code}`;
    $('#waitRoom').textContent = `Room ${code}`;
    show('grip');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Join the dance';
  }
});
setInterval(() => { if (P.seated) store.set('ddl.seat', { code: P.code, id: P.id, secret: P.secret, at: Date.now() }); }, 20000);

// ---------------- account ----------------
let authMode = 'login';
function openAuth() { show('auth'); $('#username').focus(); }
for (const b of $$('[data-auth]')) b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  for (const x of $$('[data-auth]')) x.setAttribute('aria-selected', String(x === b));
  $('#dnField').hidden = authMode !== 'register';
  $('#password').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
  $('#authBtn').textContent = authMode === 'register' ? 'Create account' : 'Sign in';
});
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  try {
    const body = { username: $('#username').value, password: $('#password').value, displayName: $('#displayName').value || $('#username').value };
    const r = await api(`/api/auth/${authMode}`, { method: 'POST', body, token: null });
    auth.set(r.token, r.user);
    $('#password').value = '';
    const ret = new URLSearchParams(location.search).get('return');
    if (ret && ret.startsWith('/') && !ret.startsWith('//')) { location.href = ret; return; }
    renderAccount();
    toast(`Welcome, ${r.user.displayName}`);
    show(P.seated ? 'wait' : 'join');
  } catch (ex) { $('#authErr').textContent = ex.message; }
});

// ---------------- grip check ----------------
function gripArt(progress = 0) {
  const wrap = $('#gripArt');
  wrap.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const phone = mk('svg', { width: 170, height: 250, viewBox: '0 0 90 140', 'aria-hidden': 'true' });
  phone.append(mk('rect', { x: 24, y: 6, width: 42, height: 80, rx: 8, fill: '#2A1D4D', stroke: '#F2C14E', 'stroke-width': 3 }),
    mk('rect', { x: 30, y: 14, width: 30, height: 62, rx: 3, fill: '#3B2C66' }),
    mk('path', { d: 'M20 66c-5 26 6 50 14 66h36c8-24 8-44 2-58l-6-6V56l-7 2v-6l-7 2v-4l-7 2v-8l-8 2z', fill: '#D9A77E' }));
  const ring = mk('svg', { width: 220, height: 220, viewBox: '0 0 100 100', class: 'ring', 'aria-hidden': 'true' });
  ring.append(mk('circle', { cx: 50, cy: 50, r: 46, fill: 'none', stroke: '#2A1D4D', 'stroke-width': 4 }),
    mk('circle', { class: 'prog', cx: 50, cy: 50, r: 46, fill: 'none', stroke: '#3DD9B5', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': 289, 'stroke-dashoffset': 289 * (1 - progress), transform: 'rotate(-90 50 50)' }));
  wrap.append(phone, ring);
}
gripArt(0);
$('#gripBtn').addEventListener('click', async () => {
  const msg = $('#gripMsg');
  const btn = $('#gripBtn');
  btn.disabled = true;
  msg.style.color = 'var(--teal)';
  msg.textContent = 'Hold still… checking';
  const t0 = performance.now();
  const anim = setInterval(() => { const c = $('.ring .prog'); if (c) c.setAttribute('stroke-dashoffset', 289 * (1 - Math.min(1, (performance.now() - t0) / 1500))); }, 50);
  try {
    const r = await motion.calibrate(1500);
    clearInterval(anim);
    if (!r.ok) { msg.style.color = 'var(--gold)'; msg.textContent = r.reason; gripArt(0); return; }
    toHost({ type: 'ready', accSign: r.accSign, hz: motion.rateHz() });
    showWait();
  } catch (ex) {
    clearInterval(anim);
    msg.style.color = 'var(--coral)';
    msg.textContent = ex.message;
  } finally { btn.disabled = false; }
});

// ---------------- waiting ----------------
function showWait(note) {
  const big = $('#waitBig');
  if (P.kind === 'studio') {
    big.replaceChildren(icon('phone', { size: 64, stroke: 'var(--teal)', width: 1.6 }), el('span', { class: 'display', style: { fontSize: '44px' } }, 'Recorder ready'), note ? el('p', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--gold)' } }, note) : null, el('p', { class: 'muted' }, 'Start a take or a test run from the Studio.'));
  } else {
    big.replaceChildren(icon('crown', { size: 64, stroke: 'var(--gold)', width: 1.6 }), el('span', { class: 'display', style: { fontSize: '52px' } }, 'Ready!'),
      el('p', { class: 'muted', style: { fontSize: '17px' } }, note || (P.song ? `${P.song.title}${P.song.artist ? ` · ${P.song.artist}` : ''}` : 'Pick a song on the big screen.')),
      el('p', { class: 'muted', style: { fontSize: '14px' } }, 'Watch the big screen. Keep this page open.'));
  }
  $('#waitLinks').replaceChildren(...[
    el('button', { onclick: openProfile }, icon('user', { size: 18 }), auth.user ? 'Profile' : 'Sign in'),
    el('button', { onclick: () => openBoard(P.song?.id) }, icon('star', { size: 18 }), 'Leaderboard'),
    P.kind === 'studio' ? null : el('a', { class: 'btn', href: '/lab', target: '_blank', rel: 'noopener' }, icon('loop', { size: 18 }), 'Move Lab')].filter(Boolean));
  show('wait');
}

// ---------------- host messages ----------------
link.onMsg(async (m) => {
  if (m.t === 'hostStatus') { P.hostUp = m.connected; renderNet(); return; }
  if (m.t === 'hostLeft' || m.t === 'kicked') {
    P.seated = false; stopSession(); store.del('ddl.seat');
    show('join');
    $('#joinErr').textContent = m.t === 'kicked' ? 'The screen removed you from the room.' : 'The big screen closed the room. Join the new code.';
    return;
  }
  if (m.t !== 'msg') return;
  const msg = m.msg;
  switch (msg.type) {
    case 'load':
      P.song = { id: msg.songId, title: msg.title, artist: msg.artist, genre: msg.genre };
      P.chart = null;
      try { P.chart = await api(`/api/songs/${msg.songId}/chart`, { token: null }); } catch { /* reported below */ }
      toHost({ type: 'loaded', ok: !!P.chart });
      if (['wait', 'results', 'practice'].includes(P.view) || P.view === 'grip') { if (P.view !== 'grip') showWait(); }
      break;
    case 'unload': P.song = null; P.chart = null; if (P.view === 'wait' || P.view === 'results') showWait(); break;
    case 'start': startDance(msg); break;
    case 'testRun': P.chart = msg.chart; P.song = { id: msg.chart.songId, title: `Test run · ${msg.title || ''}` }; startDance({ startServer: msg.startServer, songId: msg.chart.songId, test: true }); break;
    case 'standings': P.place = msg.ranks?.[P.id] || null; P.of = msg.of; renderPlace(); break;
    case 'stop': stopSession(); showWait('The screen stopped the song.'); break;
    case 'final': stopSession(); showResults(msg); break;
    case 'practiceStart': startPracticeView(); break;
    case 'practiceLoop': practiceLoop(msg); break;
    case 'practiceEnd': stopSession(); P.practice = null; showWait(); break;
    case 'recordTake': startTake(msg); break;
    case 'cancelTake': stopSession(); showWait(); break;
  }
});

function stopSession() {
  if (!P.session) return;
  P.session.off?.();
  clearInterval(P.session.timer);
  clearTimeout(P.session.gradeTimer);
  P.session = null;
}

// sample time (performance.now) -> song time, using the synced clock
const songMsOf = (sample, startServer, fromMs = 0, speed = 1) => fromMs + (sample[0] + link.offset - startServer) * speed;

// ---------------- dancing ----------------
function startDance({ startServer, songId, test = false }) {
  stopSession();
  if (!P.chart || P.chart.songId !== songId) { showWait('Still loading this song — you’ll join the next one.'); return; }
  const segs = P.chart.segments.filter((s) => !s.rest);
  const buf = [];
  const S = { off: null, timer: 0, next: 0, score: 0, streak: 0, counts: {}, accSum: 0, done: false };
  S.off = motion.onSample((s) => {
    const t = songMsOf(s, startServer);
    if (t > -1000) buf.push([t, s[1], s[2], s[3], s[4], s[5], s[6]]);
  });
  const lastEnd = P.chart.segments.at(-1)?.end || 0;
  $('#dSong').textContent = P.song?.title || '';
  $('#dScore').textContent = '0';
  $('#dStreak').textContent = '';
  $('#dTip').textContent = test ? 'Test run — your moves are compared with the takes so far' : '';
  $('#dAcc').textContent = '–';
  P.place = null;
  renderPlace();
  S.timer = setInterval(() => {
    const now = link.serverNow() - startServer;
    const g = $('#dGrade');
    if (now < 0) { g.className = 'grade'; g.style.color = 'var(--text)'; g.textContent = String(Math.ceil(-now / 1000)); }
    else if (now < 700 && !S.next) { g.textContent = 'DANCE!'; g.style.color = 'var(--gold)'; }
    $('#dTime').textContent = `${fmtTime(now)} / ${fmtTime(lastEnd)}`;
    $('#dProg').style.width = `${Math.max(0, Math.min(100, (now / lastEnd) * 100))}%`;
    while (S.next < segs.length && now > segs[S.next].end + 250) {
      const seg = segs[S.next++];
      const window = buf.filter((x) => x[0] >= seg.start - 800 && x[0] <= seg.end + 800);
      const r = gradeSegment(P.chart, seg, window);
      S.score += r.points;
      S.counts[r.name] = (S.counts[r.name] || 0) + 1;
      S.streak = extendsStreak(r.name) ? S.streak + 1 : 0;
      S.accSum += r.score;
      // the window travels with the grade: the server re-scores it, so a phone can't claim a
      // grade it didn't earn. It rides along in the outbox too, so offline moves stay verifiable.
      toHost({ type: 'grade', seg: seg.i, name: r.name, points: r.points, score: r.score, tip: r.tip, reason: r.reason, lagMs: r.lagMs, size: r.size, dist: r.dist, ratio: r.ratio, test, samples: window });
      $('#dTip').textContent = r.tip;
      $('#dAcc').textContent = `${Math.round(S.accSum / S.next)}%`;
      g.textContent = r.name;
      g.className = `grade ${r.name} pop`;
      g.style.color = GRADE_COLORS[r.name];
      $('#dStreak').textContent = S.streak >= 2 ? `${S.streak} in a row` : r.name === 'MISS' ? 'Keep going!' : '';
      $('#dScore').textContent = fmtNum(S.score);
      if (navigator.vibrate) navigator.vibrate(r.name === 'PERFECT' ? [30, 40, 30] : r.name === 'MISS' ? 0 : 30);
      const keepFrom = (segs[S.next]?.start ?? Infinity) - 1500;
      while (buf.length && buf[0][0] < keepFrom) buf.shift();
    }
    if (test && !S.done && S.next >= segs.length) {
      S.done = true;
      const acc = segs.length ? Math.round(S.accSum / segs.length) : 0;
      setTimeout(() => { stopSession(); showWait(`Test run: ${acc}% accuracy · ${S.counts.PERFECT || 0} perfect of ${segs.length} moves`); }, 1500);
    }
    const upcoming = segs[S.next];
    $('#dNext').replaceChildren(icon(upcoming ? upcoming.icon || defaultMoveIcon(upcoming.i) : 'check', { size: 34, width: 2.2 }),
      el('div', { class: 'stack', style: { gap: '0' } }, el('span', { class: 'muted', style: { fontSize: '13px' } }, upcoming ? (now < upcoming.start ? 'Next move' : 'Now') : 'Last move done'),
        el('b', { style: { fontSize: '17px' } }, upcoming ? upcoming.name : 'Waiting for results…')));
  }, 50);
  P.session = S;
  show('dance');
}
function renderPlace() {
  $('#dPlace').replaceChildren(P.place ? ordinal(P.place) : '–', P.of ? el('span', { style: { fontSize: '16px', color: 'var(--muted)', fontWeight: 500 } }, ` of ${P.of}`) : '');
}

// ---------------- results ----------------
function showResults(r) {
  P.final = r;
  const box = $('#v-results');
  const teamLine = r.mode === 'teams' && r.teams && r.team
    ? el('p', { class: 'muted', style: { textAlign: 'center' } }, r.teams[r.team]?.won ? 'Your team won!' : 'Your team fought hard.') : null;
  const note = auth.user
    ? el('div', { class: 'ok-note' }, icon('check', { size: 22, stroke: 'var(--teal)', width: 2.4 }), el('span', {}, r.personalBest ? 'New personal best, saved to your profile' : 'Saved to your profile'))
    : el('div', { class: 'acct' }, icon('user', { size: 22, stroke: 'var(--muted)' }), el('span', { class: 'grow', style: { fontSize: '14px' } }, 'Sign in next time to keep this score.'),
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); openAuth(); }, style: { fontWeight: 600 } }, 'Sign in'));
  const missed = r.missed || [];
  box.replaceChildren(...[
    el('div', { class: 'stack', style: { alignItems: 'center', gap: '6px', textAlign: 'center' } },
      r.rank === 1 ? icon('crownFill', { size: 48, fill: 'var(--gold)', stroke: 'var(--gold)', width: 1.5 }) : null,
      el('span', { class: 'muted' }, 'You placed'),
      el('span', { class: 'display', style: { fontSize: '72px', lineHeight: 1 } }, ordinal(r.rank || 1)),
      el('span', { class: 'display', style: { fontSize: '26px', color: 'var(--gold)', fontWeight: 700 } }, `${fmtNum(r.points)} pts`),
      r.accuracy != null ? el('span', { class: 'muted' }, `${r.accuracy}% accuracy`) : null,
      el('div', { class: 'row', style: { gap: '4px' }, role: 'img', 'aria-label': `${r.stars || 0} of 5 stars` },
        [1, 2, 3, 4, 5].map((i) => icon('star', { size: 26, fill: i <= (r.stars || 0) ? 'var(--gold)' : 'var(--line)', stroke: 'none' })))),
    teamLine,
    el('div', { class: 'counts' }, ['PERFECT', 'GOOD', 'OK', 'MISS'].map((g) => el('div', {}, el('b', {}, String(r.counts?.[g] || 0)), el('span', { class: `g-${g}` }, g)))),
    note,
    el('div', { class: 'push' },
      missed.length ? el('button', { class: 'btn-lg btn-block', onclick: () => { toHost({ type: 'practiceCmd', cmd: 'start', segs: missed }); toast('Asked the big screen to start practice'); } },
        `Practice my ${missed.length} missed move${missed.length > 1 ? 's' : ''}`) : null,
      el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => openBoard(P.song?.id) }, 'See the leaderboard'),
      el('button', { class: 'btn-block', onclick: () => showWait() }, 'Done'))].filter(Boolean));
  show('results');
}

// ---------------- practice (the big screen loops one move) ----------------
function startPracticeView() {
  stopSession();
  P.practice = { seg: null, speed: 0.75, tries: [] };
  renderPractice();
  show('practice');
}
function renderPractice() {
  const pr = P.practice;
  const box = $('#v-practice');
  const segs = P.chart?.segments.filter((s) => !s.rest) || [];
  const seg = P.chart?.segments.find((s) => s.i === pr.seg);
  const pos = seg ? segs.findIndex((s) => s.i === seg.i) + 1 : 0;
  const mine = pr.tries.filter((t) => t.seg === pr.seg).slice(-4);
  const missed = P.final?.missed || [];
  const nextMissed = missed.find((i) => i > (pr.seg ?? -1)) ?? missed[0];
  const cmd = (c) => toHost({ type: 'practiceCmd', ...c });
  box.replaceChildren(
    el('div', { class: 'topbar' }, el('span', { style: { width: '44px' } }), el('span', { class: 'muted', style: { fontSize: '14px', fontWeight: 600 } }, seg ? `Practice · Move ${pos} of ${segs.length}` : 'Practice'), el('span', { style: { width: '44px' } })),
    el('div', { class: 'move-card' },
      icon(seg ? seg.icon || defaultMoveIcon(seg.i) : 'loop', { size: 96, width: 1.8 }),
      el('span', { class: 'display', style: { fontSize: '32px' } }, seg ? seg.name : 'Get ready'),
      el('span', { class: 'muted' }, seg ? `${P.chart.beatsPerMove || 4} beats${missed.includes(seg.i) ? ' · you missed this one' : ''}` : 'Watch the big screen')),
    el('div', { class: 'stack', style: { gap: '8px' } }, el('span', { class: 'muted', style: { fontSize: '14px', fontWeight: 600 } }, 'Speed'),
      el('div', { class: 'speed' }, [0.5, 0.75, 1].map((v) => el('button', { 'aria-pressed': String(pr.speed === v), onclick: () => cmd({ cmd: 'speed', value: v }) }, `${v}×`)))),
    el('div', { class: 'stack', style: { gap: '8px' } }, el('span', { class: 'muted', style: { fontSize: '14px', fontWeight: 600 } }, 'Last attempts'),
      el('div', { class: 'tries' }, mine.length ? mine.map((t) => el('span', { class: `gb-${t.name}` }, t.name)) : el('span', { class: 'muted', style: { fontSize: '14px', textAlign: 'left', padding: 0 } }, 'Dance along — each loop gets a grade'))),
    el('div', { class: 'push' },
      el('button', { class: 'btn-primary btn-lg btn-block', onclick: () => cmd({ cmd: 'goto', seg: pr.seg }) }, icon('loop', { size: 22, stroke: 'var(--bg)', width: 2.4 }), 'Loop this move again'),
      el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        el('button', { class: 'grow', onclick: () => cmd({ cmd: 'prev' }) }, 'Previous'),
        el('button', { class: 'grow', onclick: () => (missed.length ? cmd({ cmd: 'goto', seg: nextMissed }) : cmd({ cmd: 'next' })) }, missed.length ? 'Next missed' : 'Next move'))));
}
function practiceLoop({ seg: segIndex, startServer, fromMs, speed }) {
  if (!P.practice) startPracticeView();
  stopSession();
  const pr = P.practice;
  pr.seg = segIndex; pr.speed = speed;
  renderPractice();
  if (P.view !== 'practice') show('practice');
  const seg = P.chart?.segments.find((s) => s.i === segIndex);
  if (!seg) return;
  const buf = [];
  const off = motion.onSample((s) => buf.push([songMsOf(s, startServer, fromMs, speed), s[1], s[2], s[3], s[4], s[5], s[6]]));
  const gradeAt = startServer + (seg.end - fromMs) / speed + 250;
  const gradeTimer = setTimeout(() => {
    off();
    const r = gradeSegment(P.chart, seg, buf, { speed });
    pr.tries.push({ seg: seg.i, name: r.name });
    toHost({ type: 'grade', practice: true, seg: seg.i, name: r.name, points: r.points });
    if (navigator.vibrate) navigator.vibrate(r.name === 'PERFECT' ? [30, 40, 30] : 30);
    renderPractice();
  }, Math.max(0, gradeAt - link.serverNow()));
  P.session = { off, gradeTimer };
}

// ---------------- studio recorder ----------------
function startTake({ startServer, durationMs, takeId }) {
  stopSession();
  const samples = [];
  const off = motion.onSample((s) => {
    const t = songMsOf(s, startServer);
    if (t >= -500 && t <= durationMs + 500) samples.push([+t.toFixed(1), ...s.slice(1).map((v) => +v.toFixed(3))]);
  });
  const big = $('#waitBig');
  const timer = setInterval(async () => {
    const now = link.serverNow() - startServer;
    if (now < 0) big.replaceChildren(el('span', { class: 'display', style: { fontSize: '96px' } }, String(Math.ceil(-now / 1000))));
    else if (now <= durationMs) big.replaceChildren(el('span', { class: 'chip tone-coral', style: { fontSize: '20px', padding: '10px 18px' } }, 'REC'), el('span', { class: 'display', style: { fontSize: '44px' } }, 'Dance!'), el('span', { class: 'muted' }, fmtTime(now)));
    else {
      stopSession();
      big.replaceChildren(el('span', { class: 'display', style: { fontSize: '36px' } }, 'Sending take…'));
      const ok = link.raw({ t: 'toHost', msg: { type: 'take', takeId, samples, hz: motion.rateHz(), accSign: motion.accSign, device: navigator.userAgent } });
      await sleep(300);
      big.replaceChildren(icon('check', { size: 64, stroke: ok ? 'var(--teal)' : 'var(--coral)', width: 2.4 }),
        el('span', { class: 'display', style: { fontSize: '36px' } }, ok ? 'Take sent' : 'Couldn’t send — Wi-Fi dropped'), el('span', { class: 'muted' }, `${samples.length} samples`));
    }
  }, 100);
  P.session = { off, timer };
  show('wait');
}

// ---------------- profile ----------------
async function openProfile() {
  if (!auth.user) return openAuth();
  const box = $('#v-profile');
  box.replaceChildren(el('div', { class: 'topbar' }, backBtn(), el('span'), el('span', { style: { width: '44px' } })), el('p', { class: 'muted' }, 'Loading…'));
  show('profile');
  try {
    const { user, stats } = await api('/api/me');
    auth.set(auth.token, user);
    box.replaceChildren(
      el('div', { class: 'topbar' }, backBtn(), el('span'), el('span', { style: { width: '44px' } })),
      el('div', { class: 'row', style: { gap: '16px', flexWrap: 'nowrap' } }, avatar(user.displayName, 72),
        el('div', { class: 'stack', style: { gap: '2px' } }, el('span', { class: 'display', style: { fontSize: '28px' } }, user.displayName),
          el('span', { class: 'muted', style: { fontSize: '14px' } }, `@${user.username} · dancing since ${new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`))),
      el('div', { class: 'stat3' }, [[stats.songsDanced, 'Songs danced'], [stats.perfects, 'Perfects'], [stats.bestStreak, 'Best streak']].map(([v, l]) => el('div', {}, el('b', {}, fmtNum(v)), el('span', {}, l)))),
      el('div', { class: 'spread' }, el('h2', { style: { fontSize: '20px', fontWeight: 700 } }, 'Recent dances'), el('a', { href: '#', onclick: (e) => { e.preventDefault(); openBoard(); }, style: { fontSize: '14px', fontWeight: 600 } }, 'Leaderboards')),
      el('div', { class: 'stack', style: { gap: '10px' } },
        stats.history.length ? stats.history.map((h) => el('div', { class: 'hist' }, coverEl({ id: h.songId, title: h.songTitle || '?' }, { size: 44 }),
          el('div', { class: 'grow' }, el('b', { style: { fontSize: '15px' } }, h.songTitle || 'Song'), el('span', { class: 'muted', style: { fontSize: '13px' } }, `${h.mode === 'teams' ? 'Teams · ' : ''}${new Date(h.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)),
          el('div', { class: 'stack', style: { gap: '0', alignItems: 'flex-end' } }, el('b', {}, fmtNum(h.points)), el('span', { class: 'muted', style: { fontSize: '12px' } }, h.of > 1 ? `${ordinal(h.rank)} of ${h.of}` : 'Solo'))))
          : el('div', { class: 'tile muted' }, 'No dances yet. Your games show up here.')),
      el('button', { class: 'btn-block', style: { marginTop: 'auto' }, onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); auth.clear(); renderAccount(); show(P.seated ? 'wait' : 'join'); } }, 'Sign out'));
  } catch (e) {
    if (e.status === 401) { auth.clear(); renderAccount(); return openAuth(); }
    box.append(el('p', { class: 'error' }, e.message));
  }
}

// ---------------- leaderboard ----------------
let lbTab = 'song';
let lbSong = null;
async function openBoard(songId) {
  if (songId !== undefined) lbSong = songId || lbSong;
  const box = $('#v-board');
  show('board');
  let songs = [];
  try { songs = await api('/api/songs', { token: null }); } catch { /* shown below */ }
  if (!lbSong && songs.length) lbSong = songs[0].id;
  if (!songs.length) lbTab = 'all';
  const tabs = [['song', 'This song'], ['week', 'This week'], ['all', 'All time']];
  const select = el('select', { 'aria-label': 'Song', onchange: (e) => { lbSong = e.target.value; openBoard(); } }, songs.map((s) => el('option', { value: s.id }, s.title)));
  select.value = lbSong || '';
  const rows = el('div', { class: 'stack', style: { gap: '8px' } }, el('p', { class: 'muted' }, 'Loading…'));
  box.replaceChildren(
    el('div', { class: 'topbar' }, backBtn(), el('h1', { style: { fontSize: '28px', flexGrow: 1 } }, 'Leaderboard')),
    el('div', { class: 'tabs3', role: 'tablist' }, tabs.map(([k, label]) => el('button', { role: 'tab', 'aria-selected': String(lbTab === k), onclick: () => { lbTab = k; openBoard(); } }, label))),
    lbTab !== 'all' ? select : el('p', { class: 'muted', style: { fontSize: '14px' } }, 'Total of everyone’s personal bests across all songs.'),
    rows);
  try {
    const q = lbTab === 'all' ? '?period=all' : `?song=${encodeURIComponent(lbSong || '')}&period=${lbTab === 'week' ? 'week' : 'all'}`;
    const { rows: list } = await api(`/api/leaderboard${q}`, { token: null });
    rows.replaceChildren();
    if (!list.length) rows.append(el('div', { class: 'tile muted' }, 'No scores yet. Signed-in dancers show up here after a song.'));
    const me = auth.user?.id;
    for (const r of list) {
      rows.append(el('div', { class: `lb${r.userId === me ? ' me' : ''}${r.rank === 1 ? ' top' : ''}` }, el('span', { class: 'rk' }, String(r.rank)), avatar(r.name, 36),
        el('span', { class: 'grow', style: { fontWeight: 600 } }, r.userId === me ? `${r.name} (you)` : r.name), el('span', { class: 'pt' }, fmtNum(r.points))));
    }
  } catch (e) { rows.replaceChildren(el('p', { class: 'error' }, e.message)); }
}

// ---------------- boot ----------------
renderAccount();
show('join');
if (new URLSearchParams(location.search).get('signin')) openAuth();
if (auth.token) api('/api/me').then(({ user }) => { auth.set(auth.token, user); renderAccount(); }).catch((e) => { if (e.status === 401) { auth.clear(); renderAccount(); } });
if (!codeValue()) digitInputs[0].focus();
window.__ddl = { link, P }; // handy for debugging from the console
