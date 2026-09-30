# Dance Like David — state of the code

A Node.js + Express + WebSocket party game where phones are the controllers: a TV
hosts a room, up to 8 phones join with a 4-digit code and dance along, and the
phones score themselves in real time against a chart the server rebuilt from the
admin's own takes.

~4,000 lines across 19 source files, 3 runtime dependencies, no build step.
`npm run lint` and `npm test` both pass; `npm run test:e2e` drives the real
pages in Chromium with simulated motion.

## What holds up well

- **`shared/motion.js` is the centre of the design.** Resampling, banded DTW,
  medoid reference selection, tolerance derivation and grading are one pure
  module with no dependencies, used identically by the server and by the phone.
  It is the reason the app is testable at all.
- **The scoring maths is pinned.** `tests/scoring.test.js` asserts on behaviour
  ("300 ms late still scores well and is detected") and a golden table pins the
  exact grade, reason and score for seven kinds of dancer, so a refactor of the
  maths cannot quietly change what dancers are told.
- **The server is the authority on scores.** A phone sends the motion it graded,
  not a verdict. The server re-scores it against the same chart, so a modified
  phone client gains nothing. Song results and Move Lab tries both work this way.
- **The offline story is deliberate.** Phones keep dancing through a Wi-Fi drop
  and queue the motion with each grade; the queue rides through the reconnect
  flush, so a move danced offline is still scored on what actually happened.
- **`lib/fsjson.js`** — atomic writes via temp file plus rename, per-file
  promise locks, and an atomic create-if-absent used to claim take numbers.

## Known limits, on purpose

- **Single instance.** WebSocket rooms live in memory, and results, song stats
  and lab attempts are in-memory indexes rebuilt from `.jsonl` at startup.
  Horizontal scaling would need a shared store.
- **The logs grow without bound.** `results.jsonl` and `lab.jsonl` are append-only
  and are read into memory at boot. Fine for a party game; a public deployment
  wants rotation and a TTL.
- **The room code is the credential.** Four digits, generated with
  `crypto.randomInt`, with ten wrong guesses per socket before the room stops
  answering. Enough for a living room, not for a stranger-proof public service.
- **The chart is trusted to be well-formed.** Phones check it with `validChart`
  and the route answers 409 rather than serving a broken one, but the grading
  still trusts that the reference in `chart.json` is the honest one.
- **Practice, test runs and live standings** are relayed from phones to the TV
  without server re-scoring. They are not recorded, so nothing is at stake.

## Decisions worth knowing about

| Decision | Why |
|---|---|
| Points recomputed from the grade name, never taken from the client | A client cannot pick its own score |
| Grades deduped per segment, with a pending set for the async re-score | A reconnect flush can't double-count a move |
| The TV sends `scoredIdx`, and rest segments are never tallied | Rest segments are in range but worth nothing |
| Accuracy clamped to 0–100 | Defence in depth behind the segment checks |
| `connect-src 'self'` in the CSP | The pages only ever talk to their own origin, and mixed-content blocking already stops a downgrade |
| Lint covers correctness only | The formatting rules live in `AGENTS.md`; a style linter would fight the house style |

## Testing

```bash
npm run lint     # eslint, correctness rules
npm test         # ~8s: scoring engine + API/accounts/rooms/leaderboards
npm run test:e2e # ~5min: Chromium, simulated phone motion
```

`npm test` needs nothing extra. For `npm run test:e2e`, once:
`npx playwright install chromium`. CI runs all three.
