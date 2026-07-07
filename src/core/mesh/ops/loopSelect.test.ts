import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { makeTorus } from '../primitives';
import { edgeLoop, vertLoop, faceLoop } from './loopSelect';

/**
 * An N×N grid of quads in the XZ plane: (N+1)² verts, indexed row-major with
 * vert(i,j) = j*(N+1)+i. Interior verts are 4-valence; boundary verts are not,
 * so edge/face loops stop there.
 */
function makeGrid(n: number): { mesh: EditableMesh; vid: (i: number, j: number) => number } {
  const positions: [number, number, number][] = [];
  const vid = (i: number, j: number): number => j * (n + 1) + i;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push([i, 0, j]);
  const faces: number[][] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      faces.push([vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)]);
  return { mesh: EditableMesh.fromData(positions, faces), vid };
}

const key = (a: number, b: number): string => EditableMesh.edgeKey(a, b);

describe('edgeLoop on a 4×4 grid', () => {
  it('picks the straight horizontal loop and stops at both boundaries', () => {
    const { mesh, vid } = makeGrid(4);
    const loop = edgeLoop(mesh, key(vid(1, 2), vid(2, 2)));
    // The whole middle row: 4 horizontal edges across the grid.
    const expected = [
      key(vid(0, 2), vid(1, 2)),
      key(vid(1, 2), vid(2, 2)),
      key(vid(2, 2), vid(3, 2)),
      key(vid(3, 2), vid(4, 2)),
    ].sort();
    expect([...loop].sort()).toEqual(expected);
  });

  it('a vertical starting edge gives the straight vertical loop', () => {
    const { mesh, vid } = makeGrid(4);
    const loop = edgeLoop(mesh, key(vid(2, 1), vid(2, 2)));
    expect(loop.size).toBe(4);
    // Every edge in the loop is a vertical segment on column i=2.
    for (const k of loop) {
      const [a, b] = k.split(',').map(Number);
      expect(a % 5).toBe(2);
      expect(b % 5).toBe(2);
    }
  });

  it('vertLoop returns the verts of the edge loop', () => {
    const { mesh, vid } = makeGrid(4);
    const verts = vertLoop(mesh, key(vid(1, 2), vid(2, 2)));
    expect([...verts].sort((a, b) => a - b)).toEqual(
      [vid(0, 2), vid(1, 2), vid(2, 2), vid(3, 2), vid(4, 2)].sort((a, b) => a - b),
    );
  });
});

describe('edgeLoop on a torus closes', () => {
  const major = 8;
  const minor = 6;
  const mesh = makeTorus(1, 0.25, major, minor);
  const idx = (i: number, j: number): number => (i % major) * minor + (j % minor);

  it('a major-direction edge closes with majorSegments edges', () => {
    const loop = edgeLoop(mesh, key(idx(0, 0), idx(1, 0)));
    expect(loop.size).toBe(major);
  });

  it('a minor-direction edge closes with minorSegments edges', () => {
    const loop = edgeLoop(mesh, key(idx(0, 0), idx(0, 1)));
    expect(loop.size).toBe(minor);
  });
});

describe('faceLoop', () => {
  it('crosses a straight row of quads on a grid and stops at the boundary', () => {
    const { mesh, vid } = makeGrid(4);
    // Enter face(1,2) through its left (vertical) edge → loop runs horizontally.
    const entry = key(vid(1, 2), vid(1, 3));
    const start = [...mesh.faces.values()].find(
      (f) => f.verts.includes(vid(1, 2)) && f.verts.includes(vid(2, 3)) && f.verts.length === 4,
    )!;
    const loop = faceLoop(mesh, start.id, entry);
    expect(loop.size).toBe(4); // the whole j=2 row of quads
  });

  it('closes around a torus with segment-count faces', () => {
    const major = 8;
    const minor = 6;
    const torus = makeTorus(1, 0.25, major, minor);
    const idx = (i: number, j: number): number => (i % major) * minor + (j % minor);
    // A quad of the torus + one of its edges; the loop wraps all the way around.
    const face = [...torus.faces.values()].find(
      (f) => f.verts.includes(idx(0, 0)) && f.verts.includes(idx(1, 1)),
    )!;
    const entry = key(idx(0, 0), idx(0, 1)); // minor-direction edge of that quad
    const loop = faceLoop(torus, face.id, entry);
    expect(loop.size).toBe(major); // crossing minor edges walks the major ring
  });
});
