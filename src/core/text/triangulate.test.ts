import { describe, it, expect } from 'vitest';
import { triangulate, type Pt } from './triangulate';

function triArea(v: Pt[], t: [number, number, number][]): number {
  let a = 0;
  for (const [i, j, k] of t) {
    const p = v[i], q = v[j], r = v[k];
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
  }
  return a;
}

describe('triangulate', () => {
  it('a square makes 2 triangles covering its area', () => {
    const sq: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const r = triangulate(sq);
    expect(r.triangles.length).toBe(2);
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(16, 4);
  });

  it('handles a concave L-shape', () => {
    const L: Pt[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    const r = triangulate(L);
    expect(r.triangles.length).toBe(4); // n-2
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(12, 4); // 16 - 4
  });

  it('accepts clockwise input (normalizes winding)', () => {
    const cw: Pt[] = [[0, 0], [0, 4], [4, 4], [4, 0]];
    const r = triangulate(cw);
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(16, 4);
  });

  it("a square with a hole (letter 'o') keeps the hole open", () => {
    const outer: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: Pt[] = [[3, 3], [3, 7], [7, 7], [7, 3]]; // note winding will be normalized
    const r = triangulate(outer, [hole]);
    // Net area = 100 - 16 = 84.
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(84, 3);
  });

  it("two holes (letter '8') both survive", () => {
    const outer: Pt[] = [[0, 0], [10, 0], [10, 20], [0, 20]];
    const holeA: Pt[] = [[3, 3], [7, 3], [7, 7], [3, 7]];
    const holeB: Pt[] = [[3, 13], [7, 13], [7, 17], [3, 17]];
    const r = triangulate(outer, [holeA, holeB]);
    // Net area = 200 - 16 - 16 = 168.
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(168, 3);
  });

  it('degenerate sliver polygons do not crash', () => {
    const sliver: Pt[] = [[0, 0], [10, 0], [10, 0.0001], [5, 0.00005]];
    expect(() => triangulate(sliver)).not.toThrow();
    const collinear: Pt[] = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(() => triangulate(collinear)).not.toThrow();
  });

  it('a triangle passes straight through', () => {
    const tri: Pt[] = [[0, 0], [4, 0], [2, 3]];
    const r = triangulate(tri);
    expect(r.triangles.length).toBe(1);
    expect(triArea(r.vertices, r.triangles)).toBeCloseTo(6, 4);
  });
});
