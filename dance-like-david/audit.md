# Dance Like David — state of the code

A Node.js + Express + WebSocket party game where phones are the controllers: a TV hosts a room,
up to 8 phones join with a 4-digit code and dance along, and the server grades every move against
a chart rebuilt from the admin's own takes.

~6,400 lines across 23 source files, 3 runtime dependencies, no build step. `npm run lint` and
`npm test` both pass; `npm run test:e2e` drives the real pages in Chromium with simulated motion.

## What holds up well

- **`shared/motion.js` is the centre of the design.** Resampling, banded DTW, medoid reference
  selection, tolerance derivation, move grouping and grading are one pure module with no
  dependencies, used identically by the server and by the phone. It is the reason the app is
  testable at all.
- **The scoring maths is pinned.** `tests/scoring.test.js` asserts on behaviour ("300 ms late
  still scores well and is detected") and a golden table pins the exact grade, reason and score
  for seven kinds of dancer, so a refactor of the maths cannot quietly change what dancers are
  told.
- **The server is the authority on scores.** A phone sends the motion it graded, not a verdict.
  The server re-scores it against the same chart, so a modified phone client gains nothing. Song
  results and Move Lab tries both work this way.
- **The offline story is deliberate.** Phones keep dancing through a Wi-Fi drop and queue the
  motion with each grade; the queue rides through the reconnect flush, so a move danced offline is
  still scored on what actually happened.
- **`lib/fsjson.js`** — atomic writes via temp file plus rename, per-file promise locks, and an
  atomic create-if-absent used to claim take numbers.
- **Authoring is no longer a two-person job.** `/record` does the whole of it on one phone, which
  also makes the timing *better* than the old path: the device that plays the song is the device
  that records against it, so there is no network clock error to absorb.

## Known limits, on purpose

- **Single instance.** WebSocket rooms live in memory, and results, song stats and lab attempts
  are in-memory indexes rebuilt from `.jsonl` at startup. Horizontal scaling would need a shared
  store.
- **The logs grow without bound.** `results.jsonl` and `lab.jsonl` are append-only and are read
  into memory at boot. Fine for a party game; a public deployment wants rotation and a TTL.
- **The room code is the credential.** Four digits, generated with `crypto.randomInt`, with ten
  wrong guesses per socket before the room stops answering. Enough for a living room, not for a
  stranger-proof public service.
- **The chart is trusted to be well-formed.** Phones check it with `validChart` and the route
  answers 409 rather than serving a broken one, but the grading still trusts that the reference in
  `chart.json` is the honest one.
- **Practice, test runs and live standings** are relayed from phones to the TV without server
  re-scoring. They are not recorded, so nothing is at stake.
- **Beat detection can land on the wrong octave.** A log-normal prior around 120 BPM picks between
  a candidate and its half or double, which is a preference and not a proof. The admin confirms
  against a drawing of the music and can halve or double it in one tap — that check is the design,
  not a workaround.

## Still worth fixing

Small, real, and not addressed yet:

- `GET /api/songs/:id/cover` has no `publicOrAdmin` guard, so an unpublished song's cover is
  readable by anyone who knows the id — unlike `/audio`, which is guarded.
- `express.json({ limit: '50mb' })` is mounted on `/api/login`, so an unauthenticated request can
  make the server buffer 50 MB. Rate limiting caps the rate, not the size.
- `db.sessions` in `lib/accounts.js` is pruned only at startup, so a long-lived process accumulates
  expired sessions.
- The motion shim in `tests/browser/` is now written three times (`record.mjs`, `lab-studio.mjs`,
  `game.mjs`). The three have genuinely diverged — song clock, lab clock, practice loop — so
  merging them is a real refactor rather than a tidy-up, but it is duplication.

## Decisions worth knowing about

| Decision | Why |
|---|---|
| Points recomputed from the grade name, never taken from the client | A client cannot pick its own score |
| Grades deduped per segment, with a pending set for the async re-score | A reconnect flush can't double-count a move |
| The TV sends `scoredIdx`, and rest segments are never tallied | Rest segments are in range but worth nothing |
| Accuracy clamped to 0–100 | Defence in depth behind the segment checks |
| `connect-src 'self'` in the CSP | The pages only ever talk to their own origin, and mixed-content blocking already stops a downgrade |
| Lint covers correctness only | The formatting rules live in `AGENTS.md`; a style linter would fight the house style |
| A wrong admin password costs the same on every route | Rate limiting only `/api/login` left the header check on every other admin route free to grind, and the WebSocket studio path compared the password with `!==` |
| Move names are remapped by timestamp, never wiped | Changing the BPM used to delete every name, which is the most tedious work in the app |
| Moves are grouped at the grader's own PERFECT threshold | "The same move" then means the same thing when naming as it does when scoring |
| Two authoring surfaces, not one | A phone cannot film the dancer holding it, so the laptop keeps the webcam pass; everything else moved to the phone |

## Testing

```bash
npm run lint     # eslint, correctness rules
npm test         # ~12s: scoring engine + beat detection + API/accounts/rooms/leaderboards
npm run test:e2e # ~6min: Chromium, simulated phone motion
```

`npm test` needs nothing extra. For `npm run test:e2e`, once:
`npx playwright install chromium`. CI runs all three.

What the tests cannot prove: how scoring feels on real bodies and real phones, and whether a
detected beat grid sits where a musician would put it. Those are phone checks, listed at the end
of the README.
