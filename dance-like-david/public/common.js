// Shared browser helpers: DOM, API with auth, a self-healing WebSocket link with clock sync, WebAudio song player.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmtTime = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
export const ordinal = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
export const PALETTE = ['#F2C14E', '#3DD9B5', '#FF7A6B', '#9B7BFF', '#7AB0FF'];
export const colorFor = (s = '') => PALETTE[[...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
export const initials = (t = '') => t.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

export function toast(msg, ms = 2600) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- auth (player accounts) ----------
export const auth = {
  get token() { return store.get('ddl.token'); },
  get user() { return store.get('ddl.user'); },
  set(token, user) { store.set('ddl.token', token); store.set('ddl.user', user); },
  clear() { store.del('ddl.token'); store.del('ddl.user'); },
};

/**
 * What the file pickers offer. Concrete types rather than `audio/*`: the wildcard makes iOS
 * offer the voice recorder and the photo library, when music lives in the Files browser.
 */
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac'];
export const AUDIO_ACCEPT = [...AUDIO_TYPES, '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'].join(',');

/** Pickers on some phones hand over a file with no type at all; the name still knows. */
export function audioTypeOf(file) {
  if (file.type && file.type.startsWith('audio')) return file.type;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac' }[ext] || 'audio/mpeg';
}

export async function api(path, { method = 'GET', body, headers = {}, pass, token = auth.token } = {}) {
  const h = { ...headers };
  if (pass) h['x-admin-pass'] = pass;
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body === 'object') {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, { method, headers: h, body: payload }); }
  catch { throw new Error('Can’t reach the server — check your connection'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

/** Song cover: the uploaded image, or a colour block with the title's initials. */
export function coverEl(song, { size = 44, radius = 10, glyph = 18, cls = '' } = {}) {
  const box = el('div', { class: `cover ${cls}`, style: { width: typeof size === 'number' ? `${size}px` : size, height: typeof size === 'number' ? `${size}px` : 'auto', borderRadius: `${radius}px`, background: colorFor(song.title) } },
    el('span', { class: 'glyph', style: { fontSize: `${glyph}px` } }, initials(song.title)));
  if (song.cover) box.append(el('img', { src: `/api/songs/${song.id}/cover?v=${song.coverVersion || 0}`, alt: '', loading: 'lazy' }));
  return box;
}

export function avatar(name, size = 40) {
  return el('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, background: colorFor(name), fontSize: `${Math.round(size * 0.42)}px` } }, (name || '?')[0].toUpperCase());
}

/**
 * WebSocket to the server with a synced clock that reconnects by itself.
 * Events: 'message' (detail = msg), 'sync' ({rtt}), 'disconnected', 'reconnected'.
 * link.serverNow() ≈ the server's clock in ms, accurate to about half the best round-trip.
 */
export class Link extends EventTarget {
  constructor({ reconnect = true } = {}) {
    super();
    this.offset = 0;
    this.bestRtt = Infinity;
    this.pending = new Map();
    this.reconnect = reconnect;
    this.connected = false;
    this.attempt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._first = { resolve, reject };
      this._open();
    });
  }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = async () => {
      this.connected = true;
      this.attempt = 0;
      await this.sync(10);
      clearInterval(this._syncTimer);
      this._syncTimer = setInterval(() => this.sync(5), 10000);
      if (this._first) { this._first.resolve(this); this._first = null; }
      else this.dispatchEvent(new CustomEvent('reconnected'));
    };
    ws.onerror = () => {
      if (this._first && !this.reconnect) { this._first.reject(new Error('Can’t reach the server')); this._first = null; }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this._syncTimer);
      for (const [c, cb] of this.pending) { this.pending.delete(c); cb(null); }
      if (was) this.dispatchEvent(new CustomEvent('disconnected'));
      if (this.reconnect && !this._closing) {
        this.attempt++;
        this.dispatchEvent(new CustomEvent('retrying', { detail: { attempt: this.attempt } }));
        setTimeout(() => this._open(), Math.min(5000, 800 * this.attempt));
      }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') {
        const cb = this.pending.get(m.c);
        if (cb) { this.pending.delete(m.c); cb({ c: m.c, s: m.s, r: performance.now() }); }
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: m }));
    };
  }

  close() { this._closing = true; this.ws?.close(); }

  ping() {
    return new Promise((resolve) => {
      const c = performance.now() + Math.random() * 1e-6;
      this.pending.set(c, resolve);
      this.raw({ t: 'ping', c });
      setTimeout(() => { if (this.pending.delete(c)) resolve(null); }, 2000);
    });
  }

  /** The lowest-latency ping of a batch has the most trustworthy midpoint. */
  async sync(n = 8) {
    let best = null;
    for (let i = 0; i < n && this.connected; i++) {
      const p = await this.ping();
      if (p) {
        const rtt = p.r - p.c;
        if (!best || rtt < best.rtt) best = { rtt, offset: p.s - (p.c + p.r) / 2 };
      }
      await sleep(40);
    }
    if (!best) return;
    if (best.rtt <= this.bestRtt * 1.5 || !Number.isFinite(this.bestRtt)) {
      this.offset = best.offset;
      this.bestRtt = Math.min(best.rtt, Number.isFinite(this.bestRtt) ? this.bestRtt * 1.2 : best.rtt);
    } else {
      this.bestRtt *= 1.1; // slowly forget an unusually good old sample
    }
    this.lastRtt = best.rtt;
    this.dispatchEvent(new CustomEvent('sync', { detail: { rtt: best.rtt } }));
  }

  serverNow() { return performance.now() + this.offset; }
  raw(obj) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  onMsg(fn) { this.addEventListener('message', (e) => fn(e.detail)); }

  waitFor(t, ms = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.removeEventListener('message', h); reject(new Error('The server didn’t answer')); }, ms);
      const h = (e) => {
        const m = e.detail;
        if (m.t === t) { clearTimeout(timer); this.removeEventListener('message', h); resolve(m); }
        else if (m.t === 'error') { clearTimeout(timer); this.removeEventListener('message', h); reject(new Error(m.error)); }
      };
      this.addEventListener('message', h);
    });
  }
}

/**
 * Song playback through WebAudio, so we know when sound leaves the speakers.
 * Song time 0 = the moment the first sample is HEARD in the room (output latency included).
 * startAt(startServer, { fromMs, toMs, speed }) plays a section, optionally slowed down (practice).
 */
export class SongPlayer {
  // Without a Link there is no room and no shared clock to keep: the phone that plays the
  // song is the one that records against it, so its own clock is the only one that matters.
  constructor(link = { serverNow: () => performance.now() }) { this.link = link; this.ctx = null; this.buffer = null; this.src = null; this.startServer = null; this.fromMs = 0; this.speed = 1; }
  async load(url, headers = {}) {
    this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('Could not load the song audio');
    this.buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.url = url;
    return this.buffer.duration * 1000;
  }
  get manualLatency() { return Number(store.get('ddl.latencyMs', 0)) || 0; }
  outputLatencyMs() {
    const c = this.ctx;
    return ((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000 + this.manualLatency;
  }
  async startAt(startServer, { fromMs = 0, toMs = null, speed = 1 } = {}) {
    await this.ctx.resume();
    this.stop();
    Object.assign(this, { startServer, fromMs, speed });
    const delayMs = startServer - this.link.serverNow() - this.outputLatencyMs();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = speed;
    src.connect(this.ctx.destination);
    const late = Math.max(0, -delayMs) / 1000 * speed;
    const offset = fromMs / 1000 + late;
    const dur = toMs != null ? Math.max(0.05, (toMs - fromMs) / 1000 - late) : undefined;
    src.start(this.ctx.currentTime + Math.max(0, delayMs) / 1000, offset, dur);
    this.src = src;
  }
  songMs() { return this.startServer == null ? -Infinity : this.fromMs + (this.link.serverNow() - this.startServer) * this.speed; }
  stop() { try { this.src?.stop(); } catch { /* already stopped */ } this.src = null; }
}
