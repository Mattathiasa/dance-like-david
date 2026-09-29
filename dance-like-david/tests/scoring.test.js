// Phase 6 (simulated): does the scoring engine tell good dancing from bad?
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChart, scoreDetail, alignTakes, accuracyFromRatio } from '../shared/motion.js';
import { makeDancer, samplesFor } from './sim.js';

const meta = { id: 'x', bpm: 120, beatsPerMove: 4, firstBeatMs: 0, durationMs: 16000 };
const chart = buildChart(meta, [1, 2, 3, 4].map((n) => ({ n, samples: samplesFor(makeDancer('good', n * 7), -800, 16800) })));
const moves = chart.segments.filter((s) => !s.rest);
const play = (kind, opts) => { const smp = samplesFor(makeDancer(kind, 303, opts), -1000, 17000); return moves.map((m) => scoreDetail(chart, m, smp)); };
const avg = (rs) => rs.reduce((a, r) => a + r.score, 0) / rs.length;

test('chart finds the moves and the rest', () => {
  assert.equal(chart.segments.length, 8);
  assert.equal(chart.segments.filter((s) => s.rest).length, 2);
  assert.equal(chart.report.takeScores.length, 4);
});
test('correct dancing scores PERFECT', () => { const r = play('good'); assert.ok(r.every((x) => x.name === 'PERFECT'), JSON.stringify(r.map((x) => x.name))); });
test('300 ms late still scores well and is detected', () => { const r = play('good', { lateMs: 300 }); assert.ok(avg(r) >= 70); assert.ok(Math.abs(r[0].lagMs - 300) <= 60); });
test('tiny moves: low score, "go bigger"', () => { const r = play('good', { scale: 0.3 }); assert.ok(avg(r) < 50); assert.ok(r.some((x) => x.reason === 'small')); });
test('mirrored moves: MISS, "wrong direction"', () => { const r = play('mirror'); assert.ok(r.every((x) => x.name === 'MISS')); assert.ok(r.some((x) => x.reason === 'mirrored')); });
test('shaking the phone: MISS', () => { assert.ok(play('shake').every((x) => x.name === 'MISS')); });
test('standing still: MISS, "still"', () => { assert.ok(play('still').every((x) => x.reason === 'still')); });
test('no motion data: no-data', () => { assert.ok(moves.every((m) => scoreDetail(chart, m, []).reason === 'no-data')); });
test('accuracy scale hits the tier edges', () => {
  assert.equal(accuracyFromRatio(1), 100); assert.equal(accuracyFromRatio(1.3), 90);
  assert.equal(accuracyFromRatio(2), 70); assert.equal(accuracyFromRatio(3), 40); assert.equal(accuracyFromRatio(5), 0);
});
test('Move Lab takes started at different times get aligned', () => {
  const move = (seed, off) => { const d = makeDancer('good', seed); return (t) => d(t - off + 2000); };
  const raw = [0, 280, -220].map((off, k) => ({ n: k + 1, samples: samplesFor(move(k * 5 + 1, off), -600, 4600) }));
  const a = alignTakes(raw, 4000);
  assert.ok(Math.abs(a[1].shiftMs - a[0].shiftMs - 280) <= 60);
  assert.ok(Math.abs(a[2].shiftMs - a[0].shiftMs + 220) <= 60);
  const labChart = buildChart({ id: 'lab', segments: [{ i: 0, start: 0, end: 4000 }] }, a);
  const r = scoreDetail(labChart, labChart.segments[0], samplesFor(move(99, 150), -800, 4800));
  assert.ok(r.score >= 70, `score ${r.score}`);
});
