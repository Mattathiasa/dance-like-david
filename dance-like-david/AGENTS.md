# AGENTS.md — Dance Like David

## Quick start

```bash
npm install
ADMIN_PASSWORD=choose-something npm start      # http://localhost:3000
```

Phones need HTTPS for motion sensors. Use `cloudflared tunnel --url http://localhost:3000` or place `certs/key.pem` + `certs/cert.pem`.

## Testing

```bash
npm run lint        # eslint — correctness rules; the style rules below are on you
npm test            # ~8s: unit + integration (API, accounts, WebSocket game, scoring)
npm run test:e2e    # ~5min: Playwright browser tests (simulated phone motion)
```

`npm test` needs nothing extra. For `test:e2e`, once: `npx playwright install chromium`.
All three run in CI on every push.

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
- **Scoring** is computed on the phone for instant feedback, but the phone also sends the motion it graded (`samples`); the server re-scores that against the same chart and its verdict is the official one. Nothing is ever taken on a client's word — not the grade, not the points, not the score.
- **Charts cross a JSON boundary**, so `validChart` in `shared/motion.js` checks the shape before the phones use one. The stored `seg.ref` is already scaled; raw samples are not.
- **Test a new rule with a new phase** in `tests/api.test.js` (server behaviour) or `tests/scoring.test.js` (maths). They run in about eight seconds; the browser tests cost five minutes, so leave those for UI.
