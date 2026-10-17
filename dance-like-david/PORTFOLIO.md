# Portfolio Audit: Dance Like David

## 1. Title
Dance Like David

## 2. Short Description
A Just Dance-style multiplayer party game where your phone is the controller. Players hold their phone in their right hand and dance, with real-time motion-based scoring against a reference routine recorded by the admin. Everything runs in the browser with no app store download required.

## 3. Language/Tags
**Languages:** JavaScript (ES Modules), Node.js

**Tags:** `multiplayer`, `real-time`, `WebSocket`, `motion-sensing`, `DeviceMotion API`, `DTW`, `beat-detection`, `audio-analysis`, `party-game`, `game-development`, `vanilla-js`, `full-stack`, `Node.js`, `Express`

## 4. Full Tech Stack

**Backend:**
- [Node.js](https://nodejs.org/) (>=18) - Runtime environment
- [Express 4.21.2](https://expressjs.com/) - HTTP server, routing, and security middleware
- [ws 8.18.0](https://github.com/websockets/ws) - WebSocket server for real-time room state and score syncing
- [qrcode 1.5.4](https://github.com/soldair/node-qrcode) - QR code generation for easy phone joining

**Frontend (Vanilla JavaScript, ES Modules):**
- Pure vanilla JS with no framework dependencies
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) - Audio playback and synchronization
- [DeviceMotion API](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent) - Phone motion capture (accelerometer + gyroscope)
- [Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API) - Beat grid visualization in Studio/Record
- Custom WebSocket client with self-healing reconnection and NTP-style clock synchronization (`common.js`)
- Custom DOM utilities (`el()` helper pattern)

**Data & Storage:**
- File-based storage (JSON + append-only JSONL) with atomic writes
- Custom `fsjson.js` with per-file promise locks, temp-file + rename atomicity, and create-if-absent semantics
- In-memory indexes rebuilt from disk on startup (single-instance design)

**Security & Auth:**
- scrypt password hashing for player accounts (`lib/accounts.js`)
- Timing-safe password comparison (`timingSafeEqual`) for admin authentication
- Per-IP admin password attempt rate limiting (10 attempts/minute)
- Security headers (CSP with `connect-src 'self'`, HSTS when served over HTTPS, etc.)
- Bearer token session management

**Testing & Quality:**
- [Node.js Test Runner](https://nodejs.org/api/test.html) - Unit and integration tests (~8-12s)
- [ESLint 9.39.5](https://eslint.org/) - Code correctness linting (style rules managed separately per project conventions)
- [Playwright 1.56.0](https://playwright.dev/) - End-to-end browser tests with simulated motion (~5-6 minutes)
- Golden test vectors for deterministic scoring validation

**DevOps & Deployment:**
- [Docker](https://www.docker.com/) - Containerization (`Dockerfile` provided)
- [Render](https://render.com/) - Blueprint deployment (`render.yaml`); the architecture supports a persistent disk for real use, but the live demo link runs on Render's free tier for cost reasons, so it resets between visits
- HTTPS via local certs (`mkcert`) or tunneling (`cloudflared`) for DeviceMotion API access
- Zero build step - runs directly with Node.js

## 5. Long Description

Dance Like David is a browser-based party game that transforms smartphones into motion controllers for a Just Dance-style experience. The core innovation is that **the phone that plays the music can also record the reference dance**, eliminating network clock drift and making content creation accessible to anyone with a phone.

The project is split across five distinct interfaces that work together seamlessly. The **Big Screen** (`/screen`) runs on a TV or laptop and serves as the game host - displaying the lobby with QR codes, song library, live scores, upcoming moves, and final podium results. Up to 8 players join from their **Phones** (`/phone`) via a 4-digit room code, receiving live grades, streaks, and place rankings while the game runs. The scoring is remarkably resilient to real-world conditions - phones queue motion data during Wi-Fi drops and flush it on reconnection without losing accuracy.

Content creation happens through two complementary authoring paths. **Record** (`/record`) is the flagship phone-only workflow: an admin selects audio, the app automatically detects BPM and first downbeat using onset analysis (with a visual beat grid for confirmation), records a full take while playing the song on-device, and can even "patch" just a problematic section without re-recording the entire routine. **Studio** (`/studio`) runs on a laptop and adds webcam capture for reference videos, fine-grained move naming (with automatic grouping of repeated moves like choruses), and per-move strictness tuning. A third surface, **Move Lab** (`/lab`), lets admins capture and test individual moves in seconds with automatic alignment between takes.

At the heart of the system is `shared/motion.js` - a pure, framework-free module containing resampling, banded Dynamic Time Warping (DTW), medoid reference selection, tolerance derivation, move grouping, and grading logic. This module runs identically on both the server and client devices, ensuring perfect parity between phone-side preview scoring and authoritative server-side scoring. The server never trusts client verdicts - when a phone submits its graded motion, the server re-scores it against the same chart and uses its own result as the official tally.

The scoring pipeline is sophisticated: audio is analyzed to extract tempo and downbeats, segmented into moves on the beat grid, and each move's reference is chosen as the medoid of recorded takes with tolerance derived from inter-take variance. DTW with a configurable band allows for natural human timing variation (±600ms forgiveness) while still penalizing off-beat movement. Move grouping uses the grader's PERFECT threshold to determine when two segments are "the same dance", allowing names to propagate across repeats.

The entire system is designed as a single-instance Node.js app with no external database dependencies - relying on atomic filesystem operations and in-memory state rebuilt from append-only logs (`results.jsonl`, `lab.jsonl`). This keeps the stack minimal (only 3 runtime dependencies) while remaining highly testable and deployable anywhere that can run Node.js with persistent disk storage.
