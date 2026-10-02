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
| `shared/motion.js` | resampling, DTW, chart building, move grouping, grading (server + phones) |
| `shared/beats.js` | tempo and first-downbeat detection from decoded audio (studio + recorder) |
| `public/common.js` | DOM helpers, API client, self-healing WebSocket + clock sync, WebAudio player |
| `public/motion-capture.js` | DeviceMotion capture, iOS permission, grip calibration |
| `public/phone.js` | phone controller: join, grip check, live offline-tolerant scoring, results, practice, profile |
| `public/screen.js` | big screen: library, lobby, solo/teams/practice, results, leaderboard |
| `public/studio.js` | admin studio (laptop): create songs, record takes with video, name moves, publish |
| `public/record.js` | admin recorder (phone only): create a song, record takes and patches, test, publish |
| `public/beat-grid.js` | canvas drawing of a detected beat grid over the onset curve |
| `public/lab.js` | Move Lab phone app |

## Code style

- **No comments** in code unless the concept is non-obvious (this is a deliberate rule for this repo).
- Prefer the `el(tag, attrs, ...kids)` helper from `common.js` for DOM construction.
- Server-side uses `(req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)` wrapped in `wrap()` for async route handlers.
- Client-side uses ES modules (`import ... from './common.js'`).
- Indentation: 2 spaces. No semicolons (the existing code style).

## Key conventions

- **Admin auth** uses the `x-admin-pass` header, compared with `timingSafeEqual`. A wrong password is
  counted per IP by the `admin` middleware in `server.js` and refused with 429 past ten a minute —
  the same gate is passed into `createLab`, and `lib/rooms.js` applies the same rule to the
  WebSocket `host kind:'studio'` path. The `bearer(req)` helper extracts player tokens from the
  `Authorization: Bearer` header.
- **Security headers** are set in the first middleware in `server.js`. HSTS is added when `req.secure` is true.
- **Single-instance design**: WebSocket rooms, in-memory results, and lab attempts are not shared across processes. Deploy as one instance.
- **Authoring happens twice over, on purpose.** `/record` is the phone-only path: the phone plays
  the song and captures the motion on its own clock, so `SongPlayer` is constructed without a
  `Link`. `/studio` stays the laptop path for the library, move naming and the webcam reference
  video. Both post takes to the same unchanged routes.
- **A take may cover only part of a song.** `buildChart` drops any take below 90% coverage of a
  segment, so a patch take recorded over 2:20–2:40 contributes to those moves and nothing else.
  Nothing server-side needs to know a take was a patch.
- **Move names live on the beat grid, not on an index.** `remapMoves` in `server.js` carries them
  across a BPM, beats-per-move or first-beat change by the moment they happened.
- **Scoring** is computed on the phone for instant feedback, but the phone also sends the motion it graded (`samples`); the server re-scores that against the same chart and its verdict is the official one. Nothing is ever taken on a client's word — not the grade, not the points, not the score.
- **Charts cross a JSON boundary**, so `validChart` in `shared/motion.js` checks the shape before the phones use one. The stored `seg.ref` is already scaled; raw samples are not.
- **Test a new rule with a new phase** in `tests/api.test.js` (server behaviour), `tests/scoring.test.js` (maths) or `tests/beats.test.js` (beat detection). They run in about eight seconds; the browser tests cost five minutes, so leave those for UI.
