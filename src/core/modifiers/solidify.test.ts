import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'solidify'
import { createModifier } from './Modifier';
import { makePlane } from '../mesh/primitives';
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
    // Outer verts (ids 0..3) are the originals pushed +thickness along +Y;
    // inner verts (ids 4..7) stay on the source surface (y = 0).
    for (let id = 0; id < 4; id++) expect(out.verts.get(id)!.co.y).toBeCloseTo(thickness, 6);
    for (let id = 4; id < 8; id++) expect(out.verts.get(id)!.co.y).toBeCloseTo(0, 6);
  });

  it('inner shell winding is flipped (its normal ≈ −outer normal)', () => {
    const out = createModifier('solidify', { thickness: 0.1, offset: 1 }).apply(makePlane(2));
    const outerN = out.faceNormal(0); // first face = outer shell
    const innerN = out.faceNormal(1); // second face = inner shell
    expect(outerN.dot(new Vec3(0, 1, 0))).toBeGreaterThan(0.99);
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

describe('Solidify modifier — offset mapping', () => {
  it('offset 0 splits the shells symmetrically about the surface', () => {
    const thickness = 0.2;
    const out = createModifier('solidify', { thickness, offset: 0 }).apply(makePlane(2));
    for (let id = 0; id < 4; id++) expect(out.verts.get(id)!.co.y).toBeCloseTo(thickness / 2, 6);
    for (let id = 4; id < 8; id++) expect(out.verts.get(id)!.co.y).toBeCloseTo(-thickness / 2, 6);
  });
});
