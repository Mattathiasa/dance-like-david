# Dance Like David

A Just Dance–style party game where **your phone is the controller**. Hold it in your right hand and dance: the phone's motion sensors score every move against a reference the admin recorded. K-pop, pop, Afrobeats, worship, kids — every style is welcome.

## What's in it
| Screen | Where | What it does |
|---|---|---|
| **Big screen** | `/screen` on a TV or laptop | Song library (search, genre filter, family-friendly switch, featured song), lobby with QR code, **Solo**, **Teams** (averaged, so team size doesn't matter) and **Practice** modes, live scoreboard, reference video, upcoming-move cards, podium results, leaderboard |
| **Phone** | `/phone` | Join by code or QR, optional account, grip check, live grades/streak/place, keeps scoring through Wi-Fi drops, results with stars and personal bests, practice missed moves, profile, leaderboards |
| **Studio** | `/studio` (admin password) | Create songs (cover, genre, difficulty, tap tempo), record 3–5 reference takes with phone + webcam, per-take agreement check, **Test run** (dance it yourself, see every move's score), name moves and pick pictograms, per-move strictness, publish checklist |
| **Move Lab** | `/lab` on a phone — nothing else needed | Admin records a single move (2–8 s) three times after a 4-beat count-in; anyone tries it and gets a **0–100 score**, a tip (too small, shaky, wrong direction, late/early) and a "reference vs you" motion chart; per-move leaderboard |

## How scoring works
- The admin dances the routine several times. Each take is phone motion (acceleration + rotation) on the song's clock.
- The song is cut into moves on the beat grid (BPM × beats per move). For each move the most typical take becomes the reference; how much the takes disagree sets how strict that move is.
- During a game each phone compares its own motion to the reference with dynamic time warping (forgives being a little early or late) and sends only the grade. The server keeps the official tally.
- Shaking the phone randomly or doing tiny wrist flicks scores MISS — direction and size both matter.
- **Timing forgiveness:** before comparing, each move is slid up to ±600 ms to line up with the reference (reaction time, Bluetooth speakers). Being more than 0.2 s off costs a little; the tip tells the dancer.
- **Accuracy 0–100** per move (Perfect ≥ 90, Good ≥ 70, OK ≥ 40) and a **tip** explaining the biggest problem.
- Move Lab takes are also auto-aligned to each other, so a take started a bit late doesn't blur the reference.

### Try scoring in 2 minutes (phone only)
1. Open `/lab` on your phone (over HTTPS), tap **Admin: record moves**, enter the admin password.
2. **Record a new move** → name it → **Create and record takes** → **Record a take** three times (listen to the 4 beats, dance on GO!).
3. **Test it**, then **Publish to everyone**. Hand the phone to a friend: **Try it**.

## Run it
    npm install
    ADMIN_PASSWORD=choose-something npm start      # http://localhost:3000

### Phones need HTTPS
Browsers only give motion sensors to secure pages, so `http://192.168.x.x:3000` won't work on a phone. Pick one:
1. **Tunnel (easiest):** `brew install cloudflared`, then `cloudflared tunnel --url http://localhost:3000` and open the `https://…trycloudflare.com` link on every device.
2. **Local certs:** put `certs/key.pem` and `certs/cert.pem` in the project (e.g. `mkcert <your-lan-ip>`) and restart — the server switches to HTTPS.
3. **Deploy** (below).

### First song in 5 minutes
1. Open `/studio`, sign in, fill in **New song** (title, genre, BPM — use *Tap tempo* — and the audio file).
2. On your phone open `/phone`, enter the studio's code, do the grip check.
3. Choose *First 15 s (quick test)*, turn the camera on, **Record take** three times — same dance each time.
4. **Review moves** → name a few moves → **Publish to library**.
5. Open `/screen` on the TV, pick the song, join from phones, **Start dancing**.

## Testing
    npm test            # ~10 s: server, pages, accounts, studio, Move Lab, a full game over WebSockets, scoring engine
    npm run test:e2e    # ~5 min: real Chrome clicks through Studio, TV, phones, Move Lab (simulated motion)

`npm test` needs nothing extra. For `test:e2e`, once: `npx playwright install chromium`. Screenshots land in `tests/screenshots/`.

What the tests can't prove: how scoring feels on real bodies and real phones. After tests pass, do the phone checks: record a move in `/lab`, try it right (expect 80+) and wrong (expect < 40).

## Deploy
- **Docker:** `docker build -t ddl . && docker run -p 3000:3000 -e ADMIN_PASSWORD=… -v ddl-data:/data ddl`
- **Render:** `render.yaml` is a ready blueprint (web service + persistent disk). Set `ADMIN_PASSWORD` in the dashboard.
- Any host works if it supports WebSockets and gives you a persistent disk for `DATA_DIR`.

| Env var | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `ADMIN_PASSWORD` | `david` | **change it** |
| `DATA_DIR` | `./data` | songs, takes, videos, covers, accounts, scores |

## Music rights
Using audio you own in a private room is fine. Before the server is public, commercial tracks (K-pop, pop) need a license — otherwise use royalty-free music or tracks you have the artist's permission for.

## Project layout
    server.js               HTTP API, static files, security headers
    lib/rooms.js            WebSocket rooms: clock sync, official score tally, 2-minute reconnect grace
    lib/accounts.js         player accounts (scrypt-hashed passwords, token sessions)
    lib/results.js          scores, personal bests, room records, leaderboards, per-move miss rates
    lib/fsjson.js           atomic JSON writes with per-file locks
    lib/lab.js              Move Lab API: moves, takes (auto-aligned), attempts, leaderboards
    public/lab.*            Move Lab phone app
    shared/motion.js        resampling, DTW, chart building, grading (runs on server AND phones)
    public/screen.*         big screen
    public/phone.*          phone controller
    public/studio.*         admin studio
    public/common.js        API client, self-reconnecting WebSocket with clock sync, WebAudio player
    public/motion-capture.js  DeviceMotion capture, iOS permission, grip calibration

## Scoring knobs (`shared/motion.js`)
`TIERS` (Perfect ≤ 1.3×, Good ≤ 2×, OK ≤ 3× of a move's tolerance), `BAND` (timing slack), `REST_ENERGY`, `MIN_TOL`. Tuned on simulated dancers — adjust after testing with real people. Per-move strictness can also be set in the Studio.
