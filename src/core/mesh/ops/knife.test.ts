import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import { knifeCut, type ScreenProjector } from './knife';

// Synthetic orthographic-style projector: drop z, treat x/y as screen pixels.
// (Camera-facing is out of the picture here — the test meshes are single-sided,
// so every face is eligible by default.)
const flat: ScreenProjector = (co: Vec3) => [co.x, co.y];

function unitQuad(): EditableMesh {
  // CCW: (0,0)-(1,0)-(1,1)-(0,1)
  return EditableMesh.fromData(
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    [[0, 1, 2, 3]],
  );
}

describe('knifeCut', () => {
  it('a straight vertical cut splits a unit quad into two faces with two new verts', () => {
    const mesh = unitQuad();
    // Vertical polyline at x=0.5 spanning y=-0.5..1.5 (crosses bottom + top edges).
    const res = knifeCut(mesh, [[0.5, -0.5], [0.5, 1.5]], flat);

    expect(res.newVerts).toBe(2);
    expect(res.cutEdges).toBe(2);
    expect(mesh.verts.size).toBe(6); // 4 + 2
    expect(mesh.faces.size).toBe(2); // one quad became two

    // The new verts sit at the edge midpoints in x=0.5.
    const news = [...mesh.verts.values()].filter((v) => Math.abs(v.co.x - 0.5) < 1e-9);
    expect(news.length).toBe(2);
    for (const v of news) expect(Math.abs(v.co.y - 0) < 1e-9 || Math.abs(v.co.y - 1) < 1e-9).toBe(true);

    // Both halves are real faces (>=3 corners) and cover the quad.
    for (const f of mesh.faces.values()) expect(f.verts.length).toBeGreaterThanOrEqual(3);
  });

  it('a polyline missing the quad changes nothing', () => {
    const mesh = unitQuad();
    const res = knifeCut(mesh, [[5, 5], [6, 6]], flat);
    expect(res.newVerts).toBe(0);
    expect(res.cutEdges).toBe(0);
    expect(mesh.verts.size).toBe(4);
    expect(mesh.faces.size).toBe(1);
  });

  it('crossing two adjacent faces cuts both and shares the new vert on their shared edge', () => {
    // Two quads sharing edge (1,0)-(1,1).
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0]],
      [[0, 1, 2, 3], [1, 4, 5, 2]],
    );
    // Horizontal polyline at y=0.5 spanning x=-0.5..2.5: crosses the left edge,
    // the shared edge, and the right edge.
    const res = knifeCut(mesh, [[-0.5, 0.5], [2.5, 0.5]], flat);

    expect(res.newVerts).toBe(3);
    expect(res.cutEdges).toBe(3);
    expect(mesh.faces.size).toBe(4); // each quad split in two
    expect(mesh.verts.size).toBe(9); // 6 + 3

    // The vert on the shared edge (x=1, y=0.5) is used by faces from BOTH quads.
    const shared = [...mesh.verts.values()].find(
      (v) => Math.abs(v.co.x - 1) < 1e-9 && Math.abs(v.co.y - 0.5) < 1e-9,
    );
    expect(shared).toBeDefined();
    const owners = mesh.facesOfVert(shared!.id);
    expect(owners.length).toBeGreaterThanOrEqual(2);
    // Owners straddle the shared edge: at least one face reaches into x<1 and one into x>2.
    const xs = owners.map((fid) =>
      mesh.faces.get(fid)!.verts.map((vid) => mesh.verts.get(vid)!.co.x),
    );
    expect(xs.some((row) => row.some((x) => x < 1 - 1e-9))).toBe(true);
    expect(xs.some((row) => row.some((x) => x > 1 + 1e-9))).toBe(true);
  });

  it('drops UVs on split faces (matching the house subdivide op, which does not interpolate UVs)', () => {
    const mesh = unitQuad();
    mesh.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const before = mesh.faces.size;
    knifeCut(mesh, [[0.5, -0.5], [0.5, 1.5]], flat);

    // The original face (id 0) was deleted and replaced by fresh ids with no UVs.
    expect(mesh.faces.size).toBe(2);
    expect(before).toBe(1);
    for (const fid of mesh.faces.keys()) {
      expect(mesh.uvs.has(fid)).toBe(false);
    }
  });

  it('a face crossed by only one edge just gains the vert on its boundary (no split)', () => {
    const mesh = unitQuad();
    // Polyline entering through the left edge and stopping inside the quad — only
    // one edge crossing. The face keeps one polygon, now with 5 corners.
    const res = knifeCut(mesh, [[-0.5, 0.5], [0.5, 0.5]], flat);
    expect(res.newVerts).toBe(1);
    expect(mesh.faces.size).toBe(1);
    expect([...mesh.faces.values()][0].verts.length).toBe(5);
  });
});
