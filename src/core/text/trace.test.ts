import { describe, it, expect } from 'vitest';
import { traceContours, signedArea, pointInPolygon, type Pt } from './trace';

/** Rasterize a disc / annulus into an alpha bitmap for hand-built tests. */
function makeField(w: number, h: number, fn: (x: number, y: number) => boolean): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y) ? 255 : 0;
  return a;
}

describe('signedArea / pointInPolygon', () => {
  it('computes area of a unit square', () => {
    const sq: Pt[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(Math.abs(signedArea(sq))).toBe(4);
  });
  it('point in / out of a square', () => {
    const sq: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(pointInPolygon([2, 2], sq)).toBe(true);
    expect(pointInPolygon([5, 2], sq)).toBe(false);
  });
});

describe('traceContours', () => {
  it('a filled disc yields one outer contour, no holes', () => {
    const w = 40, h = 40, cx = 20, cy = 20, r = 14;
    const field = makeField(w, h, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
    const cs = traceContours(field, w, h);
    expect(cs.length).toBe(1);
    expect(cs[0].isHole).toBe(false);
  });

  it('an annulus yields an outer contour plus one hole', () => {
    const w = 50, h = 50, cx = 25, cy = 25;
    const field = makeField(w, h, (x, y) => {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      return d2 <= 20 * 20 && d2 >= 9 * 9;
    });
    const cs = traceContours(field, w, h);
    expect(cs.length).toBe(2);
    const holes = cs.filter((c) => c.isHole);
    const outers = cs.filter((c) => !c.isHole);
    expect(outers.length).toBe(1);
    expect(holes.length).toBe(1);
    // The hole's parent is the outer contour.
    expect(holes[0].parent).toBe(cs.indexOf(outers[0]));
  });

  it('two separate discs yield two independent outer contours', () => {
    const w = 60, h = 30;
    const field = makeField(w, h, (x, y) =>
      (x - 15) ** 2 + (y - 15) ** 2 <= 8 * 8 || (x - 45) ** 2 + (y - 15) ** 2 <= 8 * 8);
    const cs = traceContours(field, w, h);
    expect(cs.length).toBe(2);
    expect(cs.every((c) => !c.isHole)).toBe(true);
  });

  it('a shape touching the bitmap edge still closes', () => {
    const w = 20, h = 20;
    const field = makeField(w, h, (x, y) => x >= 5 && y >= 5); // corner block to edges
    const cs = traceContours(field, w, h);
    expect(cs.length).toBe(1);
    expect(cs[0].points.length).toBeGreaterThanOrEqual(3);
  });

  it('an empty field yields no contours', () => {
    const cs = traceContours(new Uint8Array(100), 10, 10);
    expect(cs.length).toBe(0);
  });
});
