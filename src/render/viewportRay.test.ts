import { describe, expect, it } from 'vitest';
import { adaptBatchPolls, initialRows, rowsForSample } from './viewportRay';

// 2026-07-20 pacing pass — the fenced batch adapter is a pure function so the
// heuristic is testable without a GL context. WebGL submission is async (wall
// clock around accumulate() measures nothing), so the pacer sizes batches by how
// many rAF fence-polls the LAST batch took on the GPU: 1 poll = fits inside a
// frame → grow; 3+ polls = spans multiple frames → halve.
describe('adaptBatchPolls (fenced GPU batch adapter)', () => {
  const MAX = 16;

  it('DOUBLES when the fence signaled by the very next poll', () => {
    expect(adaptBatchPolls(1, 1, MAX)).toBe(2);
    expect(adaptBatchPolls(4, 1, MAX)).toBe(8);
    expect(adaptBatchPolls(4, 0, MAX)).toBe(8); // completed before any poll
  });

  it('HOLDS at two polls (batch roughly frame-sized)', () => {
    expect(adaptBatchPolls(4, 2, MAX)).toBe(4);
  });

  it('HALVES at three or more polls (batch spans multiple frames)', () => {
    expect(adaptBatchPolls(8, 3, MAX)).toBe(4);
    expect(adaptBatchPolls(2, 7, MAX)).toBe(1);
  });

  it('clamps to [1, maxBatch]', () => {
    expect(adaptBatchPolls(1, 9, MAX)).toBe(1);    // never below 1
    expect(adaptBatchPolls(MAX, 1, MAX)).toBe(MAX); // never above max
    expect(adaptBatchPolls(12, 1, MAX)).toBe(MAX);  // 24 → clamped to 16
    expect(adaptBatchPolls(12, 1, 4)).toBe(4);      // Limit GPU load cap
  });

  it('a heavy scene decays a large batch back to 1 (the physics floor)', () => {
    let b = 16;
    b = adaptBatchPolls(b, 5, MAX); // 8
    b = adaptBatchPolls(b, 5, MAX); // 4
    b = adaptBatchPolls(b, 5, MAX); // 2
    b = adaptBatchPolls(b, 5, MAX); // 1
    expect(b).toBe(1);
    expect(adaptBatchPolls(b, 5, MAX)).toBe(1); // stays there
  });
});

// Row slicing — each sample renders as scissored row-slices via the tracer's
// row cursor, ONE ~45ms slice in flight at a time: a 2s full-res donut sample
// as a single job tripped the amdgpu watchdog (context loss) and froze the
// rAF/compositor for its full length — even split into 64 flushed draws queued
// together (measured on the Vega 7). The cursor lets the slice height adapt
// after EVERY submission, so even an 8s 1080p sample settles onto the target
// within a few slices.
describe('row slicing (initialRows / adaptRows)', () => {
  it('initialRows: ~32k px per slice, clamped to [1, h]', () => {
    expect(initialRows(64, 64)).toBe(64);        // tiny e2e canvases → whole frame
    expect(initialRows(988, 490)).toBe(34);      // viewport-ish
    expect(initialRows(1920, 1080)).toBe(18);    // F12 1080p
    expect(initialRows(100000, 100)).toBe(1);    // floor
  });

  it('rowsForSample: ~half-target uniform slices from the whole-sample cost', () => {
    // 490-row viewport, 2400ms donut sample → ~4-row slices (~22ms of the
    // cheapest region, ≤ ~45ms in the most expensive — 2× headroom).
    expect(rowsForSample(490, 2400)).toBe(4);
    // 1080-row F12, 8s sample → 3-row slices.
    expect(rowsForSample(1080, 8000)).toBe(3);
    // Never 0, even for absurd costs.
    expect(rowsForSample(100, 1000000)).toBe(1);
    // Never the full height unless the sample is cheap (no accidental
    // monolithic samples mid-flight).
    expect(rowsForSample(490, 68)).toBe(162);
  });

  it('rowsForSample: a cheap whole sample → whole-sample batch units', () => {
    expect(rowsForSample(490, 30)).toBe(490);
    expect(rowsForSample(490, 67)).toBe(490); // ≤ 1.5× target
  });
});
