import { describe, expect, it } from 'vitest';
import { adaptBatchPolls, adaptStrips, initialStrips } from './viewportRay';

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

// Band tiling — each sample splits into scissored row-bands, ONE in flight at a
// time (~45ms each): a 2s full-res donut sample as a single job tripped the
// amdgpu watchdog (context loss) and froze rAF/compositor for its full length —
// even split into 64 flushed draws queued together (measured on the Vega 7).
describe('band tiling (initialStrips / adaptStrips)', () => {
  it('initialStrips: ~32k px per band, clamped to [1, 256]', () => {
    expect(initialStrips(64 * 64)).toBe(1);            // tiny e2e canvases
    expect(initialStrips(988 * 490)).toBe(15);         // viewport-ish
    expect(initialStrips(1920 * 1080)).toBe(64);       // F12 1080p
    expect(initialStrips(8192 * 8192)).toBe(256);      // clamped
  });

  it('adaptStrips: splits finer when a band runs long', () => {
    expect(adaptStrips(4, 250)).toBe(8);
    expect(adaptStrips(256, 500)).toBe(256); // clamped at max
  });

  it('adaptStrips: merges when bands are cheap (fewer submissions)', () => {
    expect(adaptStrips(8, 10)).toBe(4);
    expect(adaptStrips(1, 1)).toBe(1); // floor
  });

  it('adaptStrips: holds in the comfortable band', () => {
    expect(adaptStrips(8, 30)).toBe(8);
  });
});
