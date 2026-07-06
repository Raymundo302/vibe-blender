import { describe, it, expect } from 'vitest';
import { makeCube, makePlane } from '../primitives';
import { EditableMesh } from '../EditableMesh';
import { MeshEditCommand } from '../../undo/meshCommands';
import { dissolveEdges } from './dissolve';

const key = EditableMesh.edgeKey;

describe('dissolveEdges', () => {
  it('merges the two faces across a cube edge into one 6-gon', () => {
    const cube = makeCube();
    // Edge (0,1) is shared by the -Z and -Y faces (both quads).
    const shared = cube.edges().get(key(0, 1))!;
    expect(new Set(shared.faces).size).toBe(2);

    dissolveEdges(cube, new Set([key(0, 1)]));

    expect(cube.verts.size).toBe(8); // verts are kept
    expect(cube.faces.size).toBe(5); // two quads became one face

    // The merged face has 6 corners (4+4 minus the 2 shared verts counted once).
    const sixGon = [...cube.faces.values()].find((f) => f.verts.length === 6);
    expect(sixGon).toBeDefined();
    expect(new Set(sixGon!.verts).size).toBe(6);
    // The dissolved edge (0,1) is gone as a topological edge.
    expect(cube.edges().has(key(0, 1))).toBe(false);
  });

  it('leaves every remaining edge manifold', () => {
    const cube = makeCube();
    dissolveEdges(cube, new Set([key(0, 1)]));
    for (const e of cube.edges().values()) {
      expect(new Set(e.faces).size).toBe(2);
    }
  });

  it('is a no-op for a boundary-only selection', () => {
    const plane = makePlane(); // single quad — all four edges are boundary (1 face)
    const before = plane.clone();
    const allEdges = new Set(plane.edges().keys());
    dissolveEdges(plane, allEdges);
    expect(plane.verts.size).toBe(before.verts.size);
    expect(plane.faces.size).toBe(before.faces.size);
    // Topology unchanged.
    expect([...plane.faces.values()][0].verts).toEqual([...before.faces.values()][0].verts);
  });

  it('skips stale / nonexistent edge keys without throwing', () => {
    const cube = makeCube();
    expect(() => dissolveEdges(cube, new Set(['999,1000']))).not.toThrow();
    expect(cube.faces.size).toBe(6);
  });

  it('collapses a chain of edges between advancing face pairs', () => {
    const cube = makeCube();
    // Dissolve two edges of the -Z face in turn: (0,1) then (2,3). The first
    // merges -Z with -Y; the second must re-query and merge the running n-gon
    // with the +Y face. Net: 6 faces → 4, verts preserved.
    dissolveEdges(cube, new Set([key(0, 1), key(2, 3)]));
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(4);
    for (const e of cube.edges().values()) {
      expect(new Set(e.faces).size).toBe(2); // still manifold
    }
  });

  it('undoes via MeshEditCommand.capture', () => {
    const cube = makeCube();
    const facesBefore = cube.faces.size;
    const vertsBefore = cube.verts.size;
    const cmd = MeshEditCommand.capture('Dissolve Edges', cube, () =>
      dissolveEdges(cube, new Set([key(0, 1)])),
    );
    expect(cube.faces.size).toBe(5);
    cmd.undo();
    expect(cube.faces.size).toBe(facesBefore);
    expect(cube.verts.size).toBe(vertsBefore);
    expect(cube.edges().has(key(0, 1))).toBe(true);
    cmd.redo();
    expect(cube.faces.size).toBe(5);
  });
});
