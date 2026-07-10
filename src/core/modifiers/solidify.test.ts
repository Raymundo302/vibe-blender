import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'solidify'
import { createModifier } from './Modifier';
import { makePlane, makeTorus } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';

describe('Solidify modifier — single quad', () => {
  it('a quad → 8 verts and 6 faces (2 shells + 4 rim quads)', () => {
    const out = createModifier('solidify', { thickness: 0.1, offset: 1 }).apply(makePlane(2));
    expect(out.verts.size).toBe(8);
    expect(out.faces.size).toBe(6);
  });

  it('outer shell displaced +thickness along the normal, inner shell at 0', () => {
    const thickness = 0.1;
    const out = createModifier('solidify', { thickness, offset: 1 }).apply(makePlane(2));
    // Outer verts (ids 0..3) are the originals pushed +thickness along +Z;
    // inner verts (ids 4..7) stay on the source surface (y = 0).
    for (let id = 0; id < 4; id++) expect(out.verts.get(id)!.co.z).toBeCloseTo(thickness, 6);
    for (let id = 4; id < 8; id++) expect(out.verts.get(id)!.co.z).toBeCloseTo(0, 6);
  });

  it('inner shell winding is flipped (its normal ≈ −outer normal)', () => {
    const out = createModifier('solidify', { thickness: 0.1, offset: 1 }).apply(makePlane(2));
    const outerN = out.faceNormal(0); // first face = outer shell
    const innerN = out.faceNormal(1); // second face = inner shell
    expect(outerN.dot(new Vec3(0, 0, 1))).toBeGreaterThan(0.99);
    expect(outerN.dot(innerN)).toBeLessThan(-0.99);
  });

  it('rimCrease 1 → rim edges carry crease weight 1 in the output', () => {
    const out = createModifier('solidify', { thickness: 0.1, offset: 1, rimCrease: 1 }).apply(makePlane(2));
    // Outer verts 0 and 1 are the endpoints of a source boundary edge, so the
    // rim quad built from it creases that edge fully.
    expect(out.crease(0, 1)).toBe(1);
    // A vertical connector edge (outer 0 ↔ inner 0) is also part of the rim.
    expect(out.crease(0, 4)).toBe(1);
  });

  it('rimCrease 0 (default) leaves no creases', () => {
    const out = createModifier('solidify', { thickness: 0.1 }).apply(makePlane(2));
    expect(out.creases.size).toBe(0);
  });

  it('is pure — the input mesh is untouched', () => {
    const plane = makePlane(2);
    const v = plane.verts.size, f = plane.faces.size, ver = plane.version;
    createModifier('solidify', { thickness: 0.2 }).apply(plane);
    expect(plane.verts.size).toBe(v);
    expect(plane.faces.size).toBe(f);
    expect(plane.version).toBe(ver);
  });

  it('is deterministic — identical output across two applies', () => {
    const a = createModifier('solidify', { thickness: 0.1, offset: 0.3, rimCrease: 0.5 }).apply(makePlane(2));
    const b = createModifier('solidify', { thickness: 0.1, offset: 0.3, rimCrease: 0.5 }).apply(makePlane(2));
    expect([...a.verts.keys()]).toEqual([...b.verts.keys()]);
    for (const id of a.verts.keys()) {
      expect(a.verts.get(id)!.co.equalsApprox(b.verts.get(id)!.co)).toBe(true);
    }
    expect([...a.faces.values()].map((f) => f.verts)).toEqual(
      [...b.faces.values()].map((f) => f.verts),
    );
  });
});

describe('Solidify modifier — UVs (P11-5)', () => {
  const uvPlane = () => {
    const p = makePlane(2);
    p.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    return p;
  };

  it('both shells carry the source face UVs; rim quads get none', () => {
    const out = createModifier('solidify', { thickness: 0.1, offset: 1 }).apply(uvPlane());
    // Faces: 0 = outer shell (verbatim), 1 = inner shell (reversed winding →
    // reversed UVs), 2..5 = rim quads (no UVs).
    expect(out.uvs.get(0)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(out.uvs.get(1)).toEqual([[0, 1], [1, 1], [1, 0], [0, 0]]);
    expect(out.uvs.size).toBe(2); // exactly the two shells, no rim UVs
  });

  it('a face without UVs yields no UVs', () => {
    const m = makePlane(2); m.uvs.clear(); // primitives now ship UVs; test the UV-less path
    const out = createModifier('solidify', { thickness: 0.1 }).apply(m);
    expect(out.uvs.size).toBe(0);
  });

  it('is deterministic — apply twice → identical UVs', () => {
    const a = createModifier('solidify', { thickness: 0.1, offset: 0.3 }).apply(uvPlane());
    const b = createModifier('solidify', { thickness: 0.1, offset: 0.3 }).apply(uvPlane());
    expect([...a.uvs.entries()]).toEqual([...b.uvs.entries()]);
  });
});

describe('Solidify modifier — offset mapping', () => {
  it('offset 0 splits the shells symmetrically about the surface', () => {
    const thickness = 0.2;
    const out = createModifier('solidify', { thickness, offset: 0 }).apply(makePlane(2));
    for (let id = 0; id < 4; id++) expect(out.verts.get(id)!.co.z).toBeCloseTo(thickness / 2, 6);
    for (let id = 4; id < 8; id++) expect(out.verts.get(id)!.co.z).toBeCloseTo(-thickness / 2, 6);
  });
});

it('tolerates stale UV entries for deleted faces (primitives ship unwrapped)', () => {
  // A torus with its bottom faces deleted keeps uvs entries for the dead
  // faces (EditableMesh convention) — solidify must skip them, not throw.
  const m = makeTorus();
  const dead: number[] = [];
  for (const [fid, f] of m.faces) {
    let z = 0;
    for (const vid of f.verts) z += m.verts.get(vid)!.co.z;
    if (z / f.verts.length < -0.02) dead.push(fid);
  }
  m.deleteFaces(dead);
  expect(m.uvs.size).toBeGreaterThan(m.faces.size); // stale entries present
  const out = createModifier('solidify').apply(m);
  expect(out.faces.size).toBeGreaterThan(0);
  // Live faces' UVs made it to both shells: 2 entries per surviving source face
  // (rim quads stay unmapped, documented).
  expect(out.uvs.size).toBe(m.faces.size * 2);
});
