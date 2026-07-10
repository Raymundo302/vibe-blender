import { describe, expect, it } from 'vitest';
import {
  normalizeStops, sampleRampColor, insertStop, removeStop, setStopPosition, setStopColor,
  rampGradientCss, type RampStop,
} from './rampWidget';

const bw = (): RampStop[] => [
  { pos: 0, color: [0, 0, 0] },
  { pos: 1, color: [1, 1, 1] },
];

describe('normalizeStops', () => {
  it('falls back to two default stops for garbage', () => {
    expect(normalizeStops(null)).toHaveLength(2);
    expect(normalizeStops({ stops: [] })).toHaveLength(2);
    expect(normalizeStops({ stops: [{ pos: 'x', color: 1 }] })).toHaveLength(2);
  });

  it('sorts stops by position and clamps to 0..1', () => {
    const s = normalizeStops({ stops: [
      { pos: 1.4, color: [1, 0, 0] },
      { pos: -0.2, color: [0, 1, 0] },
      { pos: 0.5, color: [0, 0, 1] },
    ] });
    expect(s.map((x) => x.pos)).toEqual([0, 0.5, 1]);
  });
});

describe('sampleRampColor', () => {
  it('clips below the first and above the last stop', () => {
    expect(sampleRampColor(bw(), -1)).toEqual([0, 0, 0]);
    expect(sampleRampColor(bw(), 2)).toEqual([1, 1, 1]);
  });

  it('linearly interpolates between bracketing stops', () => {
    expect(sampleRampColor(bw(), 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(sampleRampColor(bw(), 0.25)).toEqual([0.25, 0.25, 0.25]);
  });
});

describe('insertStop', () => {
  it('adds a midpoint stop with the interpolated color and selects it', () => {
    const { stops, selected } = insertStop(bw(), 0);
    expect(stops).toHaveLength(3);
    expect(stops[selected].pos).toBeCloseTo(0.5, 9);
    expect(stops[selected].color).toEqual([0.5, 0.5, 0.5]);
    // Stays sorted.
    expect(stops.map((s) => s.pos)).toEqual([0, 0.5, 1]);
  });

  it('inserts midway between the selected and next stop', () => {
    const three: RampStop[] = [
      { pos: 0, color: [0, 0, 0] },
      { pos: 0.4, color: [1, 0, 0] },
      { pos: 1, color: [1, 1, 1] },
    ];
    const { stops, selected } = insertStop(three, 1); // between 0.4 and 1.0
    expect(stops[selected].pos).toBeCloseTo(0.7, 9);
  });

  it('adds at 0.5 when the selected stop is the last one', () => {
    const { stops, selected } = insertStop(bw(), 1); // last stop selected → no next
    expect(stops[selected].pos).toBeCloseTo(0.5, 9);
  });
});

describe('removeStop', () => {
  it('enforces a minimum of 2 stops (no-op at 2)', () => {
    const { stops } = removeStop(bw(), 0);
    expect(stops).toHaveLength(2);
  });

  it('removes the selected stop above the minimum and clamps selection', () => {
    const three: RampStop[] = [
      { pos: 0, color: [0, 0, 0] },
      { pos: 0.5, color: [1, 0, 0] },
      { pos: 1, color: [1, 1, 1] },
    ];
    const { stops, selected } = removeStop(three, 2);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.pos)).toEqual([0, 0.5]);
    expect(selected).toBe(1);
  });
});

describe('setStopPosition', () => {
  it('clamps positions to 0..1', () => {
    expect(setStopPosition(bw(), 0, 1.5).stops[0].pos).toBe(1);
    expect(setStopPosition(bw(), 1, -0.3).stops[0].pos).toBe(0);
  });

  it('re-sorts when a stop crosses another and tracks the moved stop', () => {
    const three: RampStop[] = [
      { pos: 0, color: [1, 0, 0] },
      { pos: 0.5, color: [0, 1, 0] },
      { pos: 1, color: [0, 0, 1] },
    ];
    // Drag the first (red) stop to 0.8 → it should land at index 1 (past green).
    const { stops, selected } = setStopPosition(three, 0, 0.8);
    expect(stops.map((s) => s.pos)).toEqual([0.5, 0.8, 1]);
    expect(selected).toBe(1);
    expect(stops[selected].color).toEqual([1, 0, 0]); // identity preserved
  });

  it('does not mutate the input array', () => {
    const src = bw();
    setStopPosition(src, 0, 0.9);
    expect(src[0].pos).toBe(0);
  });
});

describe('setStopColor', () => {
  it('sets the selected stop color without reordering', () => {
    const out = setStopColor(bw(), 0, [0.2, 0.4, 0.6]);
    expect(out[0].color).toEqual([0.2, 0.4, 0.6]);
    expect(out.map((s) => s.pos)).toEqual([0, 1]);
  });
});

describe('rampGradientCss', () => {
  it('emits a to-right linear-gradient with percent stops', () => {
    const css = rampGradientCss(bw());
    expect(css).toContain('linear-gradient(to right');
    expect(css).toContain('rgb(0, 0, 0) 0.00%');
    expect(css).toContain('rgb(255, 255, 255) 100.00%');
  });
});
