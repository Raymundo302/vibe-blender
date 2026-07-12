import { describe, expect, it } from 'vitest';
import { adaptBatch } from './viewportRay';

// UR15-1 — the GPU accumulation batch-size adapter is a pure function so the
// "keep the tick under ~targetMs" heuristic is testable without a GL context.
describe('adaptBatch (viewport raytraced GPU batch adapter)', () => {
  const TARGET = 22;
  const MAX = 32;

  it('DOUBLES when the tick finished well under half the target', () => {
    expect(adaptBatch(1, 5, TARGET, MAX)).toBe(2);
    expect(adaptBatch(4, 3, TARGET, MAX)).toBe(8);
  });

  it('HALVES when the tick blew the target', () => {
    expect(adaptBatch(8, 40, TARGET, MAX)).toBe(4);
    expect(adaptBatch(2, 30, TARGET, MAX)).toBe(1);
  });

  it('HOLDS in the comfortable band (between half-target and target)', () => {
    expect(adaptBatch(4, 15, TARGET, MAX)).toBe(4);
  });

  it('clamps to [1, maxBatch]', () => {
    expect(adaptBatch(1, 40, TARGET, MAX)).toBe(1);   // never below 1
    expect(adaptBatch(MAX, 1, TARGET, MAX)).toBe(MAX); // never above max
    expect(adaptBatch(24, 1, TARGET, MAX)).toBe(MAX);  // 48 → clamped to 32
  });

  it('a single slow tick decays a large batch back toward responsiveness', () => {
    let b = 32;
    b = adaptBatch(b, 50, TARGET, MAX); // 16
    b = adaptBatch(b, 50, TARGET, MAX); // 8
    expect(b).toBe(8);
  });
});
