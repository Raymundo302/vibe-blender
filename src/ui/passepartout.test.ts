import { describe, expect, it } from 'vitest';
import { frameRect } from './passepartout';

/**
 * frameRect (UR5-5) is the pure letterbox math: the largest `aspect` rect
 * centered in a w×h viewport. It drives both the passepartout overlay and (via
 * the matching clip-space scale) the through-camera projection, so it must be
 * correct for arbitrary, non-16:9 aspects.
 */
describe('frameRect', () => {
  it('a square (1:1) aspect in a wide canvas pillarboxes to a centered square', () => {
    const r = frameRect(2000, 1000, 1);
    expect(r.w).toBeCloseTo(1000, 6);
    expect(r.h).toBeCloseTo(1000, 6);
    expect(r.x).toBeCloseTo(500, 6); // (2000 - 1000) / 2
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.w / r.h).toBeCloseTo(1, 6);
  });

  it('a wide (21:9) aspect in a square canvas letterboxes top/bottom', () => {
    const aspect = 21 / 9;
    const r = frameRect(1000, 1000, aspect);
    expect(r.w).toBeCloseTo(1000, 6); // fills width
    expect(r.h).toBeCloseTo(1000 / aspect, 6);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo((1000 - 1000 / aspect) / 2, 6);
    expect(r.w / r.h).toBeCloseTo(aspect, 6);
  });

  it('matches the canvas aspect exactly → fills the whole canvas', () => {
    const r = frameRect(1600, 900, 1600 / 900);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.w).toBeCloseTo(1600, 6);
    expect(r.h).toBeCloseTo(900, 6);
  });

  it('the default aspect is 16:9', () => {
    const r = frameRect(1600, 1600);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 6);
  });

  it('a 4:3 aspect in a 16:9 canvas pillarboxes to a centered 4:3 rect', () => {
    const r = frameRect(1920, 1080, 4 / 3);
    expect(r.h).toBeCloseTo(1080, 6); // taller aspect fills height
    expect(r.w).toBeCloseTo(1440, 6); // 1080 * 4/3
    expect(r.x).toBeCloseTo(240, 6);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 6);
  });

  it('degenerate (zero) sizes collapse to an empty rect', () => {
    expect(frameRect(0, 500, 1)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(frameRect(500, 0, 1)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
