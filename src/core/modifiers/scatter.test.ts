import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'scatter'
import { createModifier, type Modifier } from './Modifier';
import { Scene } from '../scene/Scene';
import { makePlane, makeCube } from '../mesh/primitives';
import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';

/** Deterministic string form of a mesh (verts/faces/tints/creases). */
function serializeMesh(m: EditableMesh): string {
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const verts = [...m.verts.values()]
    .sort((a, b) => a.id - b.id)
    .map((v) => [v.id, r(v.co.x), r(v.co.y), r(v.co.z)]);
  const faces = [...m.faces.values()]
    .sort((a, b) => a.id - b.id)
    .map((f) => [f.id, f.verts]);
  const tints = [...m.faceTints.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, t]) => [id, r(t[0]), r(t[1]), r(t[2])]);
  const creases = [...m.creases.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify({ verts, faces, tints, creases });
}

/** Build (host, source) in a scene and a ctx for the host. */
function setup(host: EditableMesh, source: EditableMesh) {
  const scene = new Scene();
  const hostObj = scene.add('Host', host);
  const srcObj = scene.add('Source', source);
  const ctx = scene.modifierContext(hostObj);
  return { scene, hostObj, srcObj, ctx };
}

/** Centroids of each appended instance (host verts come first, then instances). */
function instanceCentroids(out: EditableMesh, hostVerts: number, srcVerts: number): Vec3[] {
  const all = [...out.verts.values()];
  const n = (all.length - hostVerts) / srcVerts;
  const cents: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    let c = new Vec3();
    for (let i = 0; i < srcVerts; i++) c = c.add(all[hostVerts + k * srcVerts + i].co);
    cents.push(c.scale(1 / srcVerts));
  }
  return cents;
}

const mk = (params: Record<string, number | boolean | string>): Modifier =>
  createModifier('scatter', params);

describe('Scatter modifier — geometry', () => {
  it('count N → base plane + N source instances (vert/face math)', () => {
    const { srcObj, ctx } = setup(makePlane(4), makePlane(2));
    const out = mk({ source: srcObj.id, count: 25, seed: 1 }).apply(makePlane(4), ctx);
    // Plane: 4 verts / 1 face. 25 instances of a plane (4 verts / 1 face).
    expect(out.verts.size).toBe(4 + 25 * 4);
    expect(out.faces.size).toBe(1 + 25 * 1);
  });

  it('is pure — the input host mesh is untouched', () => {
    const host = makePlane(4);
    const { srcObj, ctx } = setup(makePlane(4), makePlane(2));
    const beforeV = host.verts.size, beforeF = host.faces.size, beforeVer = host.version;
    mk({ source: srcObj.id, count: 30 }).apply(host, ctx);
    expect(host.verts.size).toBe(beforeV);
    expect(host.faces.size).toBe(beforeF);
    expect(host.version).toBe(beforeVer);
  });
});

describe('Scatter modifier — determinism', () => {
  it('same seed → byte-identical output', () => {
    const { srcObj, ctx } = setup(makePlane(6), makePlane(2));
    const a = mk({ source: srcObj.id, count: 40, seed: 7 }).apply(makePlane(6), ctx);
    const b = mk({ source: srcObj.id, count: 40, seed: 7 }).apply(makePlane(6), ctx);
    expect(serializeMesh(a)).toBe(serializeMesh(b));
  });

  it('different seed → different output', () => {
    const { srcObj, ctx } = setup(makePlane(6), makePlane(2));
    const a = mk({ source: srcObj.id, count: 40, seed: 7 }).apply(makePlane(6), ctx);
    const b = mk({ source: srcObj.id, count: 40, seed: 8 }).apply(makePlane(6), ctx);
    expect(serializeMesh(a)).not.toBe(serializeMesh(b));
  });
});

describe('Scatter modifier — placement rules', () => {
  it('minDistance: no accepted pair closer than minDistance', () => {
    const host = makePlane(10), src = makePlane(1);
    const { srcObj, ctx } = setup(host, src);
    const minD = 0.6;
    const out = mk({
      source: srcObj.id, count: 30, seed: 3, minDistance: minD,
      randomScale: 0, alignNormal: false, randomRotation: false,
    }).apply(makePlane(10), ctx);
    const cents = instanceCentroids(out, 4, 4);
    expect(cents.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < cents.length; i++) {
      for (let j = i + 1; j < cents.length; j++) {
        expect(cents[i].distanceTo(cents[j])).toBeGreaterThan(minD - 1e-6);
      }
    }
  });

  it('upOnly on a cube host → instances only on the +Z face', () => {
    const host = makeCube(), src = makePlane(0.2);
    const { srcObj, ctx } = setup(host, src);
    const out = mk({
      source: srcObj.id, count: 40, seed: 5, upOnly: true,
      randomScale: 0, alignNormal: false, randomRotation: false, offset: 0,
    }).apply(makeCube(), ctx);
    const cents = instanceCentroids(out, 8, 4);
    expect(cents.length).toBeGreaterThan(0);
    for (const c of cents) expect(c.z).toBeGreaterThan(0.99);
  });
});

describe('Scatter modifier — color variation', () => {
  it('each instance shares one tint; ≥2 distinct across 20 instances', () => {
    const host = makePlane(6), src = makeCube(); // cube source = 6 faces/instance
    const { srcObj, ctx } = setup(host, src);
    const out = mk({ source: srcObj.id, count: 20, seed: 2, colorVariation: 1 })
      .apply(makePlane(6), ctx);
    const faces = [...out.faces.values()].sort((a, b) => a.id - b.id);
    // Host face 0 first, then 20 instances of 6 faces each.
    const perInstance: string[] = [];
    for (let k = 0; k < 20; k++) {
      const tints: string[] = [];
      for (let f = 0; f < 6; f++) {
        const face = faces[1 + k * 6 + f];
        const t = out.faceTints.get(face.id);
        expect(t).toBeDefined();
        tints.push(JSON.stringify(t!.map((n) => Math.round(n * 1e4))));
      }
      expect(new Set(tints).size).toBe(1); // one tint per instance
      perInstance.push(tints[0]);
    }
    expect(new Set(perInstance).size).toBeGreaterThanOrEqual(2);
  });

  it('colorVariation 0 copies the source tints (no random tint added)', () => {
    const host = makePlane(6);
    const src = makeCube();
    const srcFace0 = [...src.faces.keys()][0];
    src.faceTints.set(srcFace0, [0.5, 0.25, 0.75]);
    const { srcObj, ctx } = setup(host, src);
    const out = mk({ source: srcObj.id, count: 3, seed: 1, colorVariation: 0 })
      .apply(makePlane(6), ctx);
    // 3 instances × 6 faces, exactly one tinted face each (the copied source tint).
    expect(out.faceTints.size).toBe(3);
    for (const t of out.faceTints.values()) {
      expect(t[0]).toBeCloseTo(0.5);
      expect(t[1]).toBeCloseTo(0.25);
      expect(t[2]).toBeCloseTo(0.75);
    }
  });
});

describe('Scatter modifier — UVs (P11-5)', () => {
  it('each instance copies the SOURCE face UVs verbatim', () => {
    const src = makePlane(2);
    src.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const { srcObj, ctx } = setup(makePlane(6), src);
    const out = mk({ source: srcObj.id, count: 3, seed: 4 }).apply(makePlane(6), ctx);
    // Host face 0 has no UVs; the 3 instanced faces (ids 1..3) each copy source.
    expect(out.uvs.size).toBe(3);
    for (const us of out.uvs.values()) {
      expect(us).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  });

  it('a UV-less source yields UV-less instances', () => {
    const { srcObj, ctx } = setup(makePlane(6), makePlane(2));
    const out = mk({ source: srcObj.id, count: 5, seed: 1 }).apply(makePlane(6), ctx);
    expect(out.uvs.size).toBe(0);
  });
});

describe('Scatter modifier — no-op guards', () => {
  it('no ctx → identity (object modifier must no-op without a scene)', () => {
    const out = mk({ source: 0, count: 50 }).apply(makePlane(4));
    expect(out.verts.size).toBe(4);
    expect(out.faces.size).toBe(1);
  });

  it('source -1 / unresolved → identity', () => {
    const { ctx } = setup(makePlane(4), makePlane(2));
    const out = mk({ source: -1, count: 50 }).apply(makePlane(4), ctx);
    expect(out.verts.size).toBe(4);
  });

  it('source === host (cycle-guarded to null) → identity', () => {
    const scene = new Scene();
    const host = scene.add('Host', makePlane(4));
    const ctx = scene.modifierContext(host);
    const out = mk({ source: host.id, count: 50 }).apply(makePlane(4), ctx);
    expect(out.verts.size).toBe(4);
  });

  it('count 0 → identity', () => {
    const { srcObj, ctx } = setup(makePlane(4), makePlane(2));
    const out = mk({ source: srcObj.id, count: 0 }).apply(makePlane(4), ctx);
    expect(out.verts.size).toBe(4);
  });
});
