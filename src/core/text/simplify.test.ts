import { describe, it, expect } from 'vitest';
import { simplifyOpen, simplifyClosed, type Pt } from './simplify';

describe('simplifyOpen', () => {
  it('keeps endpoints and drops collinear midpoints', () => {
    const line: Pt[] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
    expect(simplifyOpen(line, 0.75)).toEqual([[0, 0], [4, 0]]);
  });

  it('preserves a corner beyond tolerance', () => {
    const l: Pt[] = [[0, 0], [1, 0.01], [2, 0], [2, 2]];
    const out = simplifyOpen(l, 0.75);
    // The elbow at (2,0) must survive.
    expect(out).toContainEqual([2, 0]);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([2, 2]);
  });

  it('leaves 2-point lines unchanged', () => {
    const l: Pt[] = [[0, 0], [5, 5]];
    expect(simplifyOpen(l)).toEqual(l);
  });
});

describe('simplifyClosed', () => {
  it('reduces a many-point square outline to its 4 corners', () => {
    const pts: Pt[] = [];
    for (let x = 0; x <= 10; x++) pts.push([x, 0]);
    for (let y = 1; y <= 10; y++) pts.push([10, y]);
    for (let x = 9; x >= 0; x--) pts.push([x, 10]);
    for (let y = 9; y >= 1; y--) pts.push([0, y]);
    const out = simplifyClosed(pts, 0.75);
    expect(out.length).toBe(4);
    for (const corner of [[0, 0], [10, 0], [10, 10], [0, 10]] as Pt[]) {
      expect(out).toContainEqual(corner);
    }
  });

  it('never collapses below a triangle', () => {
    const noisy: Pt[] = [[0, 0], [0.1, 0.1], [0.2, 0], [0.1, -0.1]];
    const out = simplifyClosed(noisy, 100);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});
