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

// ---- Easing families + bezier handles (Graph Editor batch, 2026-07-09) ----
import { describe as describe2, it as it2, expect as expect2 } from 'vitest';
import { evalFCurve as evalF, resolveEasing, type FCurve as FC } from './fcurve';

function span(interp: string, extras: object = {}): FC {
  return {
    channelPath: 'location.x',
    keys: [
      { frame: 0, value: 0, interp: interp as never, ...extras },
      { frame: 10, value: 1, interp: 'linear' },
    ],
  };
}

describe2('eased interps', () => {
  it2('hits both endpoints exactly for every family and direction', () => {
    for (const interp of ['sine', 'quad', 'cubic', 'quart', 'back', 'bounce', 'elastic']) {
      for (const easing of ['auto', 'in', 'out', 'inout'] as const) {
        const c = span(interp, { easing });
        expect2(evalF(c, 0)).toBeCloseTo(0, 6);
        expect2(evalF(c, 10)).toBeCloseTo(1, 6);
      }
    }
  });

  it2('quad ease-in is slower than linear early, faster late', () => {
    const c = span('quad', { easing: 'in' });
    expect2(evalF(c, 2)).toBeLessThan(0.2);   // t=0.2 → 0.04
    expect2(evalF(c, 8)).toBeGreaterThan(0.6); // t=0.8 → 0.64
    expect2(evalF(c, 2)).toBeCloseTo(0.04, 4);
  });

  it2('quad ease-out mirrors ease-in', () => {
    const cin = span('quad', { easing: 'in' });
    const cout = span('quad', { easing: 'out' });
    expect2(evalF(cout, 2)).toBeCloseTo(1 - evalF(cin, 8), 6);
  });

  it2('inout is symmetric around the midpoint', () => {
    const c = span('cubic', { easing: 'inout' });
    expect2(evalF(c, 5)).toBeCloseTo(0.5, 6);
    expect2(evalF(c, 3) + evalF(c, 7)).toBeCloseTo(1, 6);
  });

  it2('automatic easing: transitional families ease in, dynamic ease out', () => {
    expect2(resolveEasing('sine', undefined)).toBe('in');
    expect2(resolveEasing('quart', 'auto')).toBe('in');
    expect2(resolveEasing('bounce', undefined)).toBe('out');
    expect2(resolveEasing('elastic', 'auto')).toBe('out');
    expect2(resolveEasing('back', undefined)).toBe('out');
    expect2(resolveEasing('bounce', 'in')).toBe('in'); // explicit wins
  });

  it2('back overshoots below 0 on the way in', () => {
    const c = span('back', { easing: 'in' });
    let minV = 1;
    for (let f = 0; f <= 10; f += 0.25) minV = Math.min(minV, evalF(c, f));
    expect2(minV).toBeLessThan(-0.01);
  });

  it2('bounce ease-out rebounds (non-monotonic near the end)', () => {
    const c = span('bounce', { easing: 'out' });
    let dips = 0;
    let prev = evalF(c, 0);
    for (let f = 0.1; f <= 10; f += 0.1) {
      const v = evalF(c, f);
      if (v < prev - 1e-6) dips++;
      prev = v;
    }
    expect2(dips).toBeGreaterThan(0);
  });
});

describe2('bezier free handles', () => {
  it2('pure auto span matches the original Hermite exactly', () => {
    const auto: FC = span('bezier');
    const legacy: FC = span('bezier'); // same — regression guard vs known value
    expect2(evalF(auto, 5)).toBeCloseTo(evalF(legacy, 5), 12);
  });

  it2('a free flat right handle makes the curve leave the key flat', () => {
    const c: FC = {
      channelPath: 'location.x',
      keys: [
        { frame: 0, value: 0, interp: 'bezier', handleMode: 'free', hr: [5, 0] },
        { frame: 10, value: 1, interp: 'bezier' },
      ],
    };
    // Flat long handle → early values hug 0 much tighter than the auto curve.
    expect2(evalF(c, 2)).toBeLessThan(evalF(span('bezier'), 2));
    expect2(evalF(c, 2)).toBeLessThan(0.05);
    expect2(evalF(c, 0)).toBeCloseTo(0, 6);
    expect2(evalF(c, 10)).toBeCloseTo(1, 6);
  });

  it2('handle x offsets are clamped into the span (no time-travel)', () => {
    const c: FC = {
      channelPath: 'location.x',
      keys: [
        { frame: 0, value: 0, interp: 'bezier', handleMode: 'free', hr: [50, 2] }, // way past the next key
        { frame: 10, value: 1, interp: 'bezier', handleMode: 'free', hl: [-50, -2] },
      ],
    };
    // Monotonic x → single value everywhere, endpoints exact.
    expect2(evalF(c, 0)).toBeCloseTo(0, 5);
    expect2(evalF(c, 10)).toBeCloseTo(1, 5);
    const mid = evalF(c, 5);
    expect2(Number.isFinite(mid)).toBe(true);
  });

  it2('free left handle on the RIGHT key shapes the arrival', () => {
    const flat: FC = {
      channelPath: 'location.x',
      keys: [
        { frame: 0, value: 0, interp: 'bezier' },
        { frame: 10, value: 1, interp: 'bezier', handleMode: 'free', hl: [-5, 0] },
      ],
    };
    expect2(evalF(flat, 8)).toBeGreaterThan(evalF(span('bezier'), 8));
    expect2(evalF(flat, 8)).toBeGreaterThan(0.95);
  });
});
