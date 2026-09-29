# AGENTS.md — Dance Like David

## Quick start

```bash
npm install
ADMIN_PASSWORD=choose-something npm start      # http://localhost:3000
```

Phones need HTTPS for motion sensors. Use `cloudflared tunnel --url http://localhost:3000` or place `certs/key.pem` + `certs/cert.pem`.

## Testing

```bash
npm test              # ~6s: unit + integration (API, accounts, WebSocket game, scoring)
npm run test:e2e      # ~5min: Playwright browser tests (simulated phone motion)
```

`npm test` needs nothing extra. For `test:e2e`, once: `npx playwright install chromium`.

## Project layout

| File | Responsibility |
|---|---|
| `server.js` | HTTP API, static files, security headers, HTTPS/certs |
| `lib/rooms.js` | WebSocket rooms: clock sync, score tally, 2-min reconnect grace |
| `lib/accounts.js` | scrypt-hashed passwords, bearer-token sessions |
| `lib/results.js` | scores, personal bests, leaderboards, per-move miss rates |
| `lib/fsjson.js` | atomic JSON writes with per-file locks |
| `lib/lab.js` | Move Lab API: moves, takes (auto-aligned), attempts, leaderboards |
| `shared/motion.js` | resampling, DTW, chart building, grading (server + phones) |
| `public/common.js` | DOM helpers, API client, self-healing WebSocket + clock sync, WebAudio player |
| `public/motion-capture.js` | DeviceMotion capture, iOS permission, grip calibration |
| `public/phone.js` | phone controller: join, grip check, live offline-tolerant scoring, results, practice, profile |
| `public/screen.js` | big screen: library, lobby, solo/teams/practice, results, leaderboard |
| `public/studio.js` | admin studio: create songs, record takes, name moves, publish |
| `public/lab.js` | Move Lab phone app |

## Code style

- **No comments** in code unless the concept is non-obvious (this is a deliberate rule for this repo).
- Prefer the `el(tag, attrs, ...kids)` helper from `common.js` for DOM construction.
- Server-side uses `(req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)` wrapped in `wrap()` for async route handlers.
- Client-side uses ES modules (`import ... from './common.js'`).
- Indentation: 2 spaces. No semicolons (the existing code style).

## Key conventions

- **Admin auth** uses `x-admin-pass` header, compared with `timingSafeEqual`. The `bearer(req)` helper extracts player tokens from the `Authorization: Bearer` header.
- **Security headers** are set in the first middleware in `server.js`. HSTS is added when `req.secure` is true.
- **Single-instance design**: WebSocket rooms, in-memory results, and lab attempts are not shared across processes. Deploy as one instance.
- **Scoring** happens on the phone (client-side `scoreDetail`), the server only tallies grades and recomputes points from the grade name (never trusts client-supplied `points`).
