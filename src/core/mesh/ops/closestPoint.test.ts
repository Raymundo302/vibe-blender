import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../math/vec3';
import { EditableMesh } from '../EditableMesh';
import { makeCube } from '../primitives';
import { closestPointOnTriangle, closestPointOnMesh } from './closestPoint';

const A = new Vec3(0, 0, 0);
const B = new Vec3(1, 0, 0);
const C = new Vec3(0, 0, 1);

describe('closestPointOnTriangle (Ericson)', () => {
  it('projects a point above the interior straight down onto the face', () => {
    const q = closestPointOnTriangle(new Vec3(0.2, 5, 0.2), A, B, C);
    expect(q.equalsApprox(new Vec3(0.2, 0, 0.2))).toBe(true);
  });

  it('clamps a point beyond an edge onto that edge', () => {
    // Directly outside edge AB (the x-axis edge), pushed in -z.
    const q = closestPointOnTriangle(new Vec3(0.5, 0, -3), A, B, C);
    expect(q.equalsApprox(new Vec3(0.5, 0, 0))).toBe(true);
  });

  it('clamps a point beyond a corner onto that corner', () => {
    const q = closestPointOnTriangle(new Vec3(-4, 0, -4), A, B, C);
    expect(q.equalsApprox(A)).toBe(true);
  });
});

describe('closestPointOnMesh', () => {
  it('picks the nearer of two candidate faces', () => {
    // Two parallel quads (XZ), one at y=0 and one at y=10.
    const mesh = new EditableMesh();
    const low = [
      mesh.addVert(new Vec3(-1, 0, -1)),
      mesh.addVert(new Vec3(1, 0, -1)),
      mesh.addVert(new Vec3(1, 0, 1)),
      mesh.addVert(new Vec3(-1, 0, 1)),
    ];
    const high = [
      mesh.addVert(new Vec3(-1, 10, -1)),
      mesh.addVert(new Vec3(1, 10, -1)),
      mesh.addVert(new Vec3(1, 10, 1)),
      mesh.addVert(new Vec3(-1, 10, 1)),
    ];
    const lowFace = mesh.addFace(low);
    mesh.addFace(high);

    const hit = closestPointOnMesh(mesh, new Vec3(0, 1, 0));
    expect(hit.faceId).toBe(lowFace);
    expect(hit.point.equalsApprox(new Vec3(0, 0, 0))).toBe(true);
  });

  it('snaps a point above a unit cube onto its top face', () => {
    const cube = makeCube();
    const hit = closestPointOnMesh(cube, new Vec3(0, 5, 0));
    expect(hit.point.equalsApprox(new Vec3(0, 1, 0))).toBe(true);
    // Top-face normal points +Y.
    expect(hit.normal.y).toBeGreaterThan(0.99);
  });

  it('returns a sentinel face id for a mesh with no faces', () => {
    const mesh = new EditableMesh();
    mesh.addVert(new Vec3(0, 0, 0));
    const hit = closestPointOnMesh(mesh, new Vec3(1, 1, 1));
    expect(hit.faceId).toBe(-1);
  });
});
