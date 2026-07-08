import { describe, expect, it } from 'vitest';
import { frameToX, xToFrame, tickStep, clampFrame, PAD_LEFT, PAD_RIGHT } from './timeline';

describe('timeline frame↔pixel math', () => {
  const W = 500; // canvas CSS width
  const start = 1;
  const end = 101; // span 100

  it('maps frameStart to the left pad and frameEnd to the right edge', () => {
    expect(frameToX(start, start, end, W)).toBeCloseTo(PAD_LEFT, 6);
    expect(frameToX(end, start, end, W)).toBeCloseTo(W - PAD_RIGHT, 6);
  });

  it('maps the midpoint frame to the plot centre', () => {
    const mid = (start + end) / 2;
    const plotCentre = PAD_LEFT + (W - PAD_LEFT - PAD_RIGHT) / 2;
    expect(frameToX(mid, start, end, W)).toBeCloseTo(plotCentre, 6);
  });

  it('xToFrame is the inverse of frameToX', () => {
    for (const f of [1, 12, 50, 88, 101]) {
      const x = frameToX(f, start, end, W);
      expect(xToFrame(x, start, end, W)).toBeCloseTo(f, 6);
    }
  });

  it('xToFrame(frameToX(x)) round-trips in pixel space too', () => {
    for (const x of [PAD_LEFT, 200, 350, W - PAD_RIGHT]) {
      const f = xToFrame(x, start, end, W);
      expect(frameToX(f, start, end, W)).toBeCloseTo(x, 6);
    }
  });

  it('handles a degenerate zero-length range without dividing by zero', () => {
    expect(Number.isFinite(frameToX(5, 5, 5, W))).toBe(true);
    expect(Number.isFinite(xToFrame(200, 5, 5, W))).toBe(true);
  });
});

describe('tickStep', () => {
  it('uses a 5-frame step when frames are roomy', () => {
    // 500px plot / 40-frame span → ~10 px/frame ≥ 8 → step 5
    expect(tickStep(1, 41, 500)).toBe(5);
  });

  it('uses a 10-frame step when frames are cramped', () => {
    // 500px plot / 200-frame span → ~2 px/frame < 8 → step 10
    expect(tickStep(1, 201, 500)).toBe(10);
  });

  it('switches at the ~8 px/frame threshold', () => {
    const plot = 500 - PAD_LEFT - PAD_RIGHT; // 392
    // span so that pxPerFrame is just under 8 → step 10
    const cramped = Math.ceil(plot / 8) + 5;
    expect(tickStep(0, cramped, 500)).toBe(10);
    // span so that pxPerFrame is comfortably over 8 → step 5
    expect(tickStep(0, Math.floor(plot / 20), 500)).toBe(5);
  });
});

describe('clampFrame', () => {
  it('rounds to the nearest whole frame', () => {
    expect(clampFrame(12.4, 1, 100)).toBe(12);
    expect(clampFrame(12.6, 1, 100)).toBe(13);
  });

  it('clamps below the start', () => {
    expect(clampFrame(-5, 1, 100)).toBe(1);
  });

  it('clamps above the end', () => {
    expect(clampFrame(999, 1, 100)).toBe(100);
  });

  it('leaves an in-range integer alone', () => {
    expect(clampFrame(50, 1, 100)).toBe(50);
  });
});
