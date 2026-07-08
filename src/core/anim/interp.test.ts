import { describe, expect, it } from 'vitest';
import { evalFCurve, type FCurve, type Interp, type Keyframe } from './fcurve';

/**
 * Deep evaluation coverage for evalFCurve (P15-2). fcurve.ts already
 * evaluates constant/linear/bezier; this suite hardens the evaluator against
 * the awkward cases: single keys, irregular spacing, span-by-left-key-mode,
 * flatness of equal-value keys, fractional & very large frames.
 */

function key(frame: number, value: number, interp: Interp = 'bezier'): Keyframe {
  return { frame, value, interp };
}
function curve(keys: Keyframe[]): FCurve {
  return { channelPath: 'location.x', keys: [...keys].sort((a, b) => a.frame - b.frame) };
}

describe('evalFCurve — single key', () => {
  it('returns that value everywhere left, at, and right of the key', () => {
    const c = curve([key(10, 4.2, 'bezier')]);
    expect(evalFCurve(c, -100)).toBe(4.2);
    expect(evalFCurve(c, 10)).toBe(4.2);
    expect(evalFCurve(c, 9.5)).toBe(4.2);
    expect(evalFCurve(c, 1000)).toBe(4.2);
  });

  it('an empty curve reads 0', () => {
    expect(evalFCurve(curve([]), 5)).toBe(0);
  });
});

describe('evalFCurve — bezier passes through every key exactly', () => {
  it('irregularly spaced keys are hit exactly at their frames', () => {
    const frames = [1, 3, 12, 13, 40];
    const values = [0, 5, -2, 7, 1];
    const c = curve(frames.map((f, i) => key(f, values[i], 'bezier')));
    frames.forEach((f, i) => {
      expect(evalFCurve(c, f)).toBeCloseTo(values[i], 10);
    });
  });

  it('clamps flat outside the first/last key', () => {
    const c = curve([key(2, 3, 'bezier'), key(8, 9, 'bezier')]);
    expect(evalFCurve(c, 0)).toBe(3);
    expect(evalFCurve(c, 100)).toBe(9);
  });
});

describe('evalFCurve — constant (step) holds the LEFT value', () => {
  it('holds right up to (but not at) the next key', () => {
    const c = curve([key(0, 10, 'constant'), key(10, 20, 'constant')]);
    expect(evalFCurve(c, 0)).toBe(10);
    expect(evalFCurve(c, 5)).toBe(10);
    expect(evalFCurve(c, 9.999)).toBe(10);
    // At the next key we get that key's value.
    expect(evalFCurve(c, 10)).toBe(20);
  });
});

describe('evalFCurve — linear', () => {
  it('interpolates straight between two keys', () => {
    const c = curve([key(0, 0, 'linear'), key(10, 100, 'linear')]);
    expect(evalFCurve(c, 0)).toBe(0);
    expect(evalFCurve(c, 2.5)).toBeCloseTo(25, 10);
    expect(evalFCurve(c, 7)).toBeCloseTo(70, 10);
    expect(evalFCurve(c, 10)).toBe(100);
  });
});

describe('evalFCurve — mixed interp: each span uses ITS left key mode', () => {
  // constant span [0,10], linear span [10,20], bezier span [20,30,40].
  const c = curve([
    key(0, 0, 'constant'),
    key(10, 10, 'linear'),
    key(20, 20, 'bezier'),
    key(30, 5, 'bezier'),
    key(40, 5, 'bezier'),
  ]);

  it('first span is stepped (holds left)', () => {
    expect(evalFCurve(c, 5)).toBe(0);
    expect(evalFCurve(c, 9.9)).toBe(0);
  });

  it('second span is linear', () => {
    expect(evalFCurve(c, 15)).toBeCloseTo(15, 10);
  });

  it('third span is smooth and hits its endpoints', () => {
    expect(evalFCurve(c, 20)).toBeCloseTo(20, 10);
    expect(evalFCurve(c, 30)).toBeCloseTo(5, 10);
    // A smooth span between differing values need not be monotone; just verify
    // it evaluates to a finite number strictly inside the span.
    const mid = evalFCurve(c, 25);
    expect(Number.isFinite(mid)).toBe(true);
  });
});

describe('evalFCurve — equal-value keys stay perfectly flat (no overshoot)', () => {
  it('bezier between two equal values is exactly that value across the span', () => {
    const c = curve([key(0, 7, 'bezier'), key(20, 7, 'bezier')]);
    for (let f = 0; f <= 20; f += 0.5) {
      expect(evalFCurve(c, f)).toBeCloseTo(7, 12);
    }
  });

  it('a flat plateau of 3+ equal keys never overshoots', () => {
    const c = curve([
      key(0, 3, 'bezier'),
      key(5, 3, 'bezier'),
      key(11, 3, 'bezier'),
      key(19, 3, 'bezier'),
    ]);
    for (let f = 0; f <= 19; f += 0.25) {
      expect(evalFCurve(c, f)).toBeCloseTo(3, 12);
    }
  });

  it('equal neighbours on either side of a peak do not distort the peak key', () => {
    // Catmull-Rom: flat-then-peak-then-flat still passes through each key.
    const c = curve([key(0, 0, 'bezier'), key(10, 0, 'bezier'), key(20, 5, 'bezier'), key(30, 5, 'bezier')]);
    expect(evalFCurve(c, 0)).toBeCloseTo(0, 12);
    expect(evalFCurve(c, 10)).toBeCloseTo(0, 12);
    expect(evalFCurve(c, 20)).toBeCloseTo(5, 12);
    expect(evalFCurve(c, 30)).toBeCloseTo(5, 12);
  });
});

describe('evalFCurve — fractional frames', () => {
  it('linear midpoint at a fractional frame', () => {
    const c = curve([key(1, 0, 'linear'), key(2, 1, 'linear')]);
    expect(evalFCurve(c, 1.25)).toBeCloseTo(0.25, 10);
    expect(evalFCurve(c, 1.75)).toBeCloseTo(0.75, 10);
  });

  it('bezier at a fractional frame is finite and within neighbouring bounds for equal keys', () => {
    const c = curve([key(0, 2, 'bezier'), key(3, 2, 'bezier')]);
    expect(evalFCurve(c, 1.4)).toBeCloseTo(2, 12);
  });
});

describe('evalFCurve — large frame numbers', () => {
  it('evaluates far-apart and far-out frames without blowing up', () => {
    const c = curve([key(0, 0, 'linear'), key(1_000_000, 1_000_000, 'linear')]);
    expect(evalFCurve(c, 500_000)).toBeCloseTo(500_000, 4);
    expect(evalFCurve(c, 10_000_000)).toBe(1_000_000); // clamped past the last key
  });

  it('bezier still hits keys exactly at large frames', () => {
    const c = curve([key(1000, 1, 'bezier'), key(5000, 9, 'bezier'), key(9999, -3, 'bezier')]);
    expect(evalFCurve(c, 1000)).toBeCloseTo(1, 8);
    expect(evalFCurve(c, 5000)).toBeCloseTo(9, 8);
    expect(evalFCurve(c, 9999)).toBeCloseTo(-3, 8);
  });
});
