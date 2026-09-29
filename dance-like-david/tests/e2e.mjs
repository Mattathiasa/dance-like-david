// Browser tests: real Chrome, simulated phone motion. Clicks through Studio, TV, phones and Move Lab.
// Setup once:  npm i -D playwright && npx playwright install chromium
// Run:         npm run test:e2e        (screenshots land in tests/screenshots/)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickTrack } from './sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-e2e-'));
const PORT = 4400 + Math.floor(Math.random() * 400);
const OUT = path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const WAV = path.join(TMP, 'click.wav');
const COVER = path.join(TMP, 'cover.png');
fs.writeFileSync(WAV, clickTrack(20, 120, 22050));
fs.writeFileSync(COVER, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'));

try { await import('playwright'); } catch {
  console.error('Playwright is not installed. Run:  npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const env = { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'e2e-pass', PASS: 'e2e-pass', BASE: `http://localhost:${PORT}`, WAV, COVER, OUT };
const run = (cmd, args, extra = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: path.join(ROOT, 'tests', 'browser'), env: { ...env, ...extra }, stdio: 'inherit' });
  p.on('exit', (code) => resolve(code));
});

let failed = 0;
for (const script of ['lab-studio.mjs', 'game.mjs']) {
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${env.BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  console.log(`\n=== ${script} ===`);
  const code = await run(process.execPath, [script]);
  server.kill('SIGTERM');
  if (code !== 0) { failed++; console.log(`✖ ${script} failed (exit ${code})`); } else console.log(`✔ ${script} passed`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} browser test file(s) failed` : `\nAll browser tests passed — screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
