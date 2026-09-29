# Audit: Dance Like David

A Node.js + Express + WebSocket party game where phones are controllers. ~3,800 lines across 19 source files + tests. Tests pass (17/17). `npm audit` reports **0 vulnerabilities**.

## Summary

| Area | Status |
|---|---|
| Tests | 17/17 pass; covers API, accounts, scoring engine, WebSocket game with reconnect |
| Dependency vulnerabilities | 0 (npm audit clean) |
| Security headers (CSP, nosniff, frame-ancestors, Permissions-Policy) | Well-configured |
| Password hashing | scrypt + timing-safe compare |
| Auth model (custom-header, no cookies) | CSRF-resistant |
| Session tokens | 24-byte random hex, 90-day expiry |

## Security findings

### High: server does not send HSTS
`server.js:92-108` sets CSP, nosniff, referrer-policy, and Permissions-Policy but **not** `Strict-Transport-Security`. Phones require HTTPS for DeviceMotion — a MITM could downgrade to HTTP and silently break sensor access. Add `Strict-Transport-Security: max-age=31536000` when serving over HTTPS.

### Medium: server does not validate WebSocket grade segment indices
`lib/rooms.js:168-171` — `tallyGrade` deduplicates by `msg.seg` (via `in t.segGrades`) but **never checks that `msg.seg` is a real segment** for the current song. A phone can send `seg: 999, name: 'PERFECT'` and inflate its server-side score. The `msg.points` field is correctly ignored by the server (points are recomputed from the validated grade name), but the **number** of valid segments is not enforced. Fix: store the game's valid segment indices in room state and reject grades for unknown segments.

### Medium: server does not validate song-take sample structure
`server.js:290-298` — `/api/songs/:id/takes` only checks `Array.isArray(samples) && samples.length < 20`. The Move Lab path (`lib/lab.js:79-80`) validates each sample is a 7-element array of finite numbers (`validSamples`), but the **song take** path does not. Bad data passes through to `buildChart` / `scoreDetail` and could produce NaN segments or corrupted charts. This is admin-only, but a buggy studio client could corrupt a song.

### Low: rate limiter only covers auth endpoints
`server.js:136-146` — the in-memory rate limiter (`limit`) protects `/api/auth/register`, `/api/auth/login`, and `/api/moves/:id/attempts`. It does **not** protect `/api/songs/:id/takes` (large payload: 50 mb), `/api/songs/:id/audio` (200 mb), or `/api/songs/:id/takes/:n/video` (500 mb). These are admin-only, so the risk is a compromised admin client flooding uploads and exhausting disk. Consider size-based throttling or disk quotas.

### Low: admin password stored in browser sessionStorage and sent as a custom header on every request
This is by design (the Studio and Move Lab are browser apps that can't hold a server-side session for admin auth). It works, but the password is visible in the DOM password field with `autocomplete="current-password"`, and the Studio saves it in `sessionStorage` for the session lifetime. If XSS were possible (currently mitigated by strict CSP + no `innerHTML` of untrusted data), the password would leak. This is acceptable for a self-hosted party game.

## Code quality & architecture

**Strengths:**
- **`lib/fsjson.js`** — atomic JSON writes via temp-file + `rename`, per-file promise-based locks. Clean.
- **`shared/motion.js`** — DTW, resampling, grading logic is shared between server and phones. Well-structured and heavily commented.
- **`lib/rooms.js`** — 2-minute reconnect grace period, per-player secrets, ping/pong heartbeat. Robust for a party game on flaky Wi-Fi.
- **`public/phone.js`** — grades are queued offline and flushed on reconnect (`P.outbox`, `flush()`). Good offline-tolerance design.
- **Security headers** — CSP is strict (`script-src 'self'`, no `unsafe-inline` for scripts), `frame-ancestors 'none'`, microphone blocked in Permissions-Policy.

**Scaling limitations (documented single-instance design):**
- WebSocket rooms, results (`lib/results.js:12`), and lab attempts (`lib/lab.js:18`) are **in-memory**. Multiple server instances would lose room state, split leaderboards, and lose scores on restart. The README correctly states "One web service" for Render. Not a bug, but worth a note in `AGENTS.md` if you plan horizontal scaling.
- `results.jsonl` and `lab/attempts.jsonl` are loaded fully into memory at startup. For a high-traffic public deployment these files grow unbounded. No archival or TTL on attempt/result rows.

**Minor issues:**
- `lib/lab.js:166` duplicates the bearer-token extraction (`(req.get('authorization') || '').replace(/^Bearer\s+/i, '')`) instead of reusing `server.js:128`'s `bearer` helper. Not exported, so this was necessary — but the logic is duplicated.
- `server.js:68` correctly strips `ref` arrays from the full chart summary, but the non-full `songSummary` path (line 184) calls `songSummary(m)` without `full:true`, which reads `chart.json` from disk per song on every `/api/songs` list call. For 50 songs this is 50 disk reads per request. Acceptable at this scale, but caching would help.
- `render.yaml:7` uses `plan: starter` with the comment "persistent disks need a paid plan." This is correct for Render.
- `Dockerfile` healthcheck uses `wget` — `node:20-alpine` includes busybox `wget` which supports `-qO-`, so this works. Not a bug.

## Test coverage

**Well-tested:**
- Scoring engine (`tests/scoring.test.js`) — 8 tests covering correct dancing, late timing, small moves, mirrored moves, shaking, standing still, no data, accuracy scale edges, and Move Lab take alignment.
- API + game flow (`tests/api.test.js`) — 8 phases covering health, page loads, security headers, accounts (including restart persistence), studio song creation, Move Lab, chart building, and a full WebSocket game with a simulated Wi-Fi drop + rejoin.

**Not covered (by tests):**
- `/api/moves/:id/attempts` leaderboard and `personalBest` logic — tested indirectly (Phase 6 checks the leaderboard top entry).
- Practice mode (loop, speed control, missed-move practice).
- Teams mode scoring and averaging.
- The `accSign` normalization path (grip check with wrong sign).
- `alignTakes` with very different take timings (>600 ms).
- Edge case: song with zero non-rest segments (`scoredMoves: 0`).

## No issues found (working as designed)

- **Score inflation via `msg.points`** — the server recomputes points from the grade name in `tallyGrade` (`lib/rooms.js:42-43`), ignoring any client-supplied points.
- **Duplicate grades after reconnect** — deduplicated by `msg.seg in t.segGrades` (`lib/rooms.js:41`).
- **Clock sync accuracy** — `common.js:154-167` uses multiple pings and picks the best RTT, then applies the midpoint offset. Sound NTP-style approach.
- **DTW implementation** — banded, O(n·m), swaps `prev`/`cur` arrays efficiently.

## Recommendations

1. **Add HSTS** (`Strict-Transport-Security`) when HTTPS is active (`server.js:92`).
2. **Validate `msg.seg` against known segments** in `tallyGrade` (`lib/rooms.js:168`).
3. **Add `validSamples`-style validation** to song takes (`/api/songs/:id/takes` in `server.js:290`) to match the Move Lab's strictness.
4. **Export the `bearer` helper** from `server.js` and reuse it in `lib/lab.js:166` to eliminate duplication.
5. **Create an `AGENTS.md`** to codify testing/lint commands and project conventions for contributors.
