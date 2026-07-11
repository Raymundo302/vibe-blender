import { describe, it, expect } from 'vitest';
import { ModalPointer } from './modalPointer';

/**
 * Pure continuous-grab accumulator (UR4-1). The interesting invariants:
 *  - precision transitions mid-gesture never jump the position;
 *  - accumulation is unbounded (no clamp to any canvas rect).
 */
describe('ModalPointer', () => {
  it('starts at the begin position', () => {
    const mp = new ModalPointer();
    mp.begin(30, 40);
    expect(mp.pos).toEqual({ x: 30, y: 40 });
  });

  it('accumulates raw deltas at full scale', () => {
    const mp = new ModalPointer();
    mp.begin(0, 0);
    expect(mp.move(10, 5, false)).toEqual({ x: 10, y: 5 });
    expect(mp.move(-4, 20, false)).toEqual({ x: 6, y: 25 });
    expect(mp.pos).toEqual({ x: 6, y: 25 });
  });

  it('scales deltas by 0.1 in precision mode', () => {
    const mp = new ModalPointer();
    mp.begin(0, 0);
    expect(mp.move(100, 50, true)).toEqual({ x: 10, y: 5 });
    expect(mp.move(100, 50, true)).toEqual({ x: 20, y: 10 });
  });

  it('has no positional jump when precision is engaged mid-gesture', () => {
    const mp = new ModalPointer();
    mp.begin(0, 0);
    // Full-scale move.
    mp.move(100, 0, false); // → 100
    // Engage Shift: position stays 100, only subsequent motion is scaled.
    const afterPress = mp.move(0, 0, true); // zero delta → NO jump
    expect(afterPress).toEqual({ x: 100, y: 0 });
    // Precise motion adds 0.1×.
    expect(mp.move(100, 0, true)).toEqual({ x: 110, y: 0 });
    // Release Shift: again no jump on the release itself.
    const afterRelease = mp.move(0, 0, false);
    expect(afterRelease).toEqual({ x: 110, y: 0 });
    // Full-scale motion resumes.
    expect(mp.move(100, 0, false)).toEqual({ x: 210, y: 0 });
  });

  it('is symmetric: a precise sub-gesture equals its scaled full-scale twin', () => {
    // Precision mode's only effect is scaling the increment — the absolute
    // position after N precise steps equals begin + 0.1·Σ deltas.
    const a = new ModalPointer();
    a.begin(5, 5);
    a.move(30, 30, true);
    a.move(30, 30, true);
    expect(a.pos).toEqual({ x: 5 + 6, y: 5 + 6 });
  });

  it('accumulates without any bound (far outside a canvas rect)', () => {
    const mp = new ModalPointer();
    mp.begin(500, 300);
    mp.move(100000, -80000, false);
    expect(mp.pos).toEqual({ x: 100500, y: -79700 });
    mp.move(-250000, 250000, false);
    expect(mp.pos).toEqual({ x: -149500, y: 170300 });
  });

  it('re-seeds cleanly on a fresh begin', () => {
    const mp = new ModalPointer();
    mp.begin(0, 0);
    mp.move(999, 999, false);
    mp.begin(7, 8);
    expect(mp.pos).toEqual({ x: 7, y: 8 });
  });
});
