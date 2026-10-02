# Dance Like David

A Just Dance–style party game where **your phone is the controller**. Hold it in your right hand and dance: the phone's motion sensors score every move against a reference the admin recorded — on a phone, with no laptop in the room. K-pop, pop, Afrobeats, worship, kids — every style is welcome.

## What's in it
| Screen | Where | What it does |
|---|---|---|
| **Big screen** | `/screen` on a TV or laptop | Song library (search, genre filter, family-friendly switch, featured song), lobby with QR code, **Solo**, **Teams** (averaged, so team size doesn't matter) and **Practice** modes, live scoreboard, reference video, upcoming-move cards, podium results, leaderboard |
| **Phone** | `/phone` | Join by code or QR, optional account, grip check, live grades/streak/place, keeps scoring through Wi-Fi drops, results with stars and personal bests, practice missed moves, profile, leaderboards |
| **Record** | `/record` on a phone (admin password) | The whole of authoring on one device: pick the audio and the **beat grid is detected for you**, grip check, record a take while the phone plays the song, **fix just one section** instead of redoing the song, test run, publish |
| **Studio** | `/studio` on a laptop (admin password) | The library: song details and cover, the detected beat grid drawn over the music to nudge by eye, recording with a phone **plus a webcam** for the reference video, **Test run**, naming moves (name a chorus once and every repeat takes the name), per-move strictness, publish checklist |
| **Move Lab** | `/lab` on a phone — nothing else needed | Admin records a single move (2–8 s) three times after a 4-beat count-in; anyone tries it and gets a **0–100 score**, a tip (too small, shaky, wrong direction, late/early) and a "reference vs you" motion chart; per-move leaderboard |

## How scoring works
- The admin dances the routine, once or several times. Each take is phone motion (acceleration + rotation) on the song's clock.
- The beat grid is **found in the audio**: an onset curve, autocorrelated for the tempo, then combed for the beat and bar phase. The admin confirms it against a drawing of the music rather than tapping it out.
- The song is cut into moves on that grid (BPM × beats per move). For each move the most typical take becomes the reference; how much the takes disagree sets how strict that move is. With a single take the strictness is a sane default instead.
- A take only has to cover **part** of the song — any move a take doesn't reach simply ignores it, which is what makes re-recording one section possible.
- Moves that are the same dance are **grouped**: two moves belong together when dancing one where the other was expected would still grade PERFECT. That is what lets a chorus be named once.
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

### First song, phone only
1. On your phone open `/record` (over HTTPS), sign in with the admin password.
2. **New song** → title → choose the audio file. The BPM and the first downbeat are read off the
   music and drawn over it; nudge the marks if they look off, or tap *÷2* / *×2* if it guessed the
   wrong octave. **Create and record**.
3. Grip check, then **Record the whole song** — the phone counts you in four beats, plays the song
   and records the dance against it. That's it: one take is enough to publish and play.
4. **Test it** to dance it back and see every move's score. Flubbed one part? **Fix a section**
   re-records just those moves and leaves the rest of the chart alone.
5. **Publish to the big screen**, then open `/screen` on the TV, join from phones, **Start dancing**.

Two more takes make each move's strictness come from how much your own takes differ instead of a
default — worth it for a song you'll play often, not needed to get going.

### Naming the moves, and the reference video
Players see pictograms and names, and a video of the dance if there is one. Both live in `/studio`
on a laptop: open the song, go to **Moves**, and name what's worth naming — repeated moves are
detected, so naming the chorus once names all twelve instances. For a reference video, record a
take there with the webcam on.

## Testing
    npm test            # ~12 s: server, pages, accounts, studio, Move Lab, a full game over WebSockets, scoring engine, beat detection
    npm run test:e2e    # ~6 min: real Chrome clicks through the phone recorder, Studio, TV, phones, Move Lab (simulated motion)

`npm test` needs nothing extra. For `test:e2e`, once: `npx playwright install chromium`. Screenshots land in `tests/screenshots/`.

What the tests can't prove: how scoring feels on real bodies and real phones, or whether a detected
beat grid sits where a musician would put it. After tests pass, do the phone checks: record a move in
`/lab`, try it right (expect 80+) and wrong (expect < 40); and in `/record`, check the drawn beats
against what you hear before recording a take.

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
