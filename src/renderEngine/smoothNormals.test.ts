import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { makeCube, makeUvSphere } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { buildSnapshot, type Snapshot } from './snapshot';
import { shadingNormalAtHit } from './tracer';
import { OrbitCamera } from '../camera/OrbitCamera';

/** buildSnapshot needs an OrbitCamera when the scene has no active camera. */
function snap(scene: Scene): Snapshot {
  return buildSnapshot(scene, new OrbitCamera());
}

describe('UR16-5 snapshot smooth-normal size guard', () => {
  it('omits triNormal entirely when NO object is shade-smooth (flat scene)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube(1)); // shadeSmooth defaults false
    const s = snap(scene);
    expect(s.triNormal).toBeUndefined();
  });

  it('carries per-corner normals parallel to tris when an object IS shade-smooth', () => {
    const scene = new Scene();
    const o = scene.add('Ball', makeUvSphere(1, 16, 8));
    o.shadeSmooth = true;
    const s = snap(scene);
    expect(s.triNormal).toBeDefined();
    // 9 floats per triangle, exactly parallel to tris.
    expect(s.triNormal!.length).toBe(s.tris.length);
  });

  it('smooth UV-sphere corner normals are UNIT and point radially outward', () => {
    const scene = new Scene();
    const o = scene.add('Ball', makeUvSphere(2, 24, 12));
    o.shadeSmooth = true;
    const s = snap(scene);
    const tn = s.triNormal!;
    const tris = s.tris;
    let checked = 0;
    for (let i = 0; i < tn.length; i += 3) {
      const nx = tn[i], ny = tn[i + 1], nz = tn[i + 2];
      const len = Math.hypot(nx, ny, nz);
      expect(len).toBeGreaterThan(0.99);
      expect(len).toBeLessThan(1.01);
      // The vert (world = local, origin sphere) direction ~ its normal.
      const px = tris[i], py = tris[i + 1], pz = tris[i + 2];
      const pl = Math.hypot(px, py, pz);
      if (pl > 1e-6) {
        const dot = (nx * px + ny * py + nz * pz) / pl;
        expect(dot).toBeGreaterThan(0.9); // outward radial
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a FLAT object in a mixed scene stores the ZERO sentinel for its corners', () => {
    const scene = new Scene();
    const ball = scene.add('Ball', makeUvSphere(1, 12, 6));
    ball.shadeSmooth = true;
    const cube = scene.add('Cube', makeCube(1));
    cube.transform = cube.transform.withPosition(new Vec3(5, 0, 0));
    // cube stays flat
    const s = snap(scene);
    expect(s.triNormal).toBeDefined();
    expect(s.triNormal!.length).toBe(s.tris.length);
    // Some corners are non-zero (the ball), some are exactly zero (the flat cube).
    let zero = 0, nonZero = 0;
    for (let i = 0; i < s.triNormal!.length; i += 3) {
      const l = Math.hypot(s.triNormal![i], s.triNormal![i + 1], s.triNormal![i + 2]);
      if (l < 1e-9) zero++; else nonZero++;
    }
    expect(zero).toBeGreaterThan(0);
    expect(nonZero).toBeGreaterThan(0);
  });
});

describe('UR16-5 shadingNormalAtHit interpolation math', () => {
  // One triangle: corner normals A=+X, B=+Y, C=+Z (all unit). tri 0.
  const tn = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const out: [number, number, number] = [0, 0, 0];

  it('returns false (keep geometric) when triNormal is null', () => {
    expect(shadingNormalAtHit(null, 0, 0.3, 0.3, 0, 0, 1, out)).toBe(false);
  });

  it('at corner A (u=v=0) returns A exactly', () => {
    const ok = shadingNormalAtHit(tn, 0, 0, 0, 1, 0, 0, out);
    expect(ok).toBe(true);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  it('at the barycentric centre returns the normalized average of the three', () => {
    // w0=w1=w2=1/3 → (1,1,1)/√3.
    const ok = shadingNormalAtHit(tn, 0, 1 / 3, 1 / 3, 1, 1, 1, out);
    expect(ok).toBe(true);
    const inv = 1 / Math.sqrt(3);
    expect(out[0]).toBeCloseTo(inv, 5);
    expect(out[1]).toBeCloseTo(inv, 5);
    expect(out[2]).toBeCloseTo(inv, 5);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
  });

  it('barycentric weights: u weights corner B, v weights corner C', () => {
    // u=1 → corner B (+Y).
    shadingNormalAtHit(tn, 0, 1, 0, 0, 1, 0, out);
    expect(out[1]).toBeCloseTo(1, 6);
    // v=1 → corner C (+Z).
    shadingNormalAtHit(tn, 0, 0, 1, 0, 0, 1, out);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('flat sentinel (zero corner triple) returns false → keep geometric', () => {
    const flat = new Float32Array(9); // all zeros
    expect(shadingNormalAtHit(flat, 0, 0.3, 0.3, 0, 0, 1, out)).toBe(false);
  });

  it('flip guard: a normal opposing the geometric hemisphere is flipped back', () => {
    // Corner normals all = -Z, geometric Ng = +Z → the interp (-Z) must flip to +Z.
    const opp = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]);
    const ok = shadingNormalAtHit(opp, 0, 0.3, 0.3, 0, 0, 1, out);
    expect(ok).toBe(true);
    expect(out[2]).toBeCloseTo(1, 6); // flipped into Ng's hemisphere
  });
});
