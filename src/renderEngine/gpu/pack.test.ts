import { describe, it, expect } from 'vitest';
import { buildBVH, buildEmitters } from '../tracer';
import type { SnapMaterial, SnapLight } from '../snapshot';
import {
  packTriangles, readTriangle,
  packMaterials, readMaterial,
  packLights, readLight,
  packUVs, readUV,
  packEmitters,
  flattenBVH, readNode, readTriIndex,
  TEX_MAX_WIDTH,
} from './pack';

describe('packTriangles', () => {
  it('round-trips positions and the material index', () => {
    const tris = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // tri 0
      2, 2, 2, 3, 2, 2, 2, 3, 2, // tri 1
    ]);
    const triMat = Int32Array.from([0, 7]);
    const p = packTriangles(tris, triMat);
    expect(p.count).toBe(2);
    expect(p.data.length).toBe(p.width * p.height * 4);

    const t0 = readTriangle(p, 0);
    expect(t0.a).toEqual([0, 0, 0]);
    expect(t0.b).toEqual([1, 0, 0]);
    expect(t0.c).toEqual([0, 1, 0]);
    expect(t0.material).toBe(0);

    const t1 = readTriangle(p, 1);
    expect(t1.a).toEqual([2, 2, 2]);
    expect(t1.c).toEqual([2, 3, 2]);
    expect(t1.material).toBe(7);
  });

  it('produces a bindable 1x1 texture for an empty triangle set', () => {
    const p = packTriangles(new Float32Array([]), new Int32Array([]));
    expect(p.count).toBe(0);
    expect(p.width).toBe(1);
    expect(p.height).toBe(1);
    expect(p.data.length).toBe(4);
  });
});

describe('packMaterials', () => {
  it('round-trips every packed field', () => {
    const mats: SnapMaterial[] = [
      {
        baseColor: [0.1, 0.2, 0.3], metallic: 0.4, roughness: 0.5,
        transmission: 0.6, ior: 1.33, emissive: [0.7, 0.8, 0.9],
        emissiveStrength: 2.5,
      },
      {
        baseColor: [1, 0, 0], metallic: 0, roughness: 1,
        emissive: [0, 0, 0], emissiveStrength: 0,
        // transmission/ior omitted → defaults
      },
    ];
    const p = packMaterials(mats);
    expect(p.count).toBe(2);

    const m0 = readMaterial(p, 0);
    expect(m0.baseColor[0]).toBeCloseTo(0.1);
    expect(m0.roughness).toBeCloseTo(0.5);
    expect(m0.metallic).toBeCloseTo(0.4);
    expect(m0.transmission).toBeCloseTo(0.6);
    expect(m0.ior).toBeCloseTo(1.33);
    expect(m0.emissiveStrength).toBeCloseTo(2.5);
    expect(m0.emissive[2]).toBeCloseTo(0.9);

    const m1 = readMaterial(p, 1);
    expect(m1.transmission).toBe(0);
    expect(m1.ior).toBeCloseTo(1.45);
  });

  it('round-trips the UR12-2 extended fields (texKind, shadeless, sss, alpha)', () => {
    const mats: SnapMaterial[] = [
      {
        baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5,
        emissive: [0, 0, 0], emissiveStrength: 0,
        texKind: 'checker', shadeless: true, alphaBlend: true,
        subsurfaceWeight: 0.3, subsurfaceRadius: 0.2,
      },
      {
        baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        emissive: [0, 0, 0], emissiveStrength: 0, texKind: 'image',
      },
    ];
    const p = packMaterials(mats);
    const m0 = readMaterial(p, 0);
    expect(m0.texKind).toBe(1); // checker
    expect(m0.shadeless).toBe(1);
    expect(m0.alphaBlend).toBe(1);
    expect(m0.subsurfaceWeight).toBeCloseTo(0.3);
    expect(m0.subsurfaceRadius).toBeCloseTo(0.2);
    const m1 = readMaterial(p, 1);
    expect(m1.texKind).toBe(2); // image
    expect(m1.shadeless).toBe(0);
    // defaults for an omitted-fields material
    expect(m0.texKind).not.toBe(m1.texKind);
  });
});

describe('packUVs', () => {
  it('round-trips per-corner UVs', () => {
    const triUV = new Float32Array([
      0, 0, 1, 0, 0, 1,   // tri 0: A=(0,0) B=(1,0) C=(0,1)
      0.2, 0.3, 0.4, 0.5, 0.6, 0.7, // tri 1
    ]);
    const p = packUVs(triUV, 2);
    expect(p.count).toBe(2);
    const t0 = readUV(p, 0);
    expect(t0.a).toEqual([0, 0]);
    expect(t0.b).toEqual([1, 0]);
    expect(t0.c).toEqual([0, 1]);
    const t1 = readUV(p, 1);
    expect(t1.a[0]).toBeCloseTo(0.2);
    expect(t1.c[1]).toBeCloseTo(0.7);
  });

  it('packs (0,0) when UVs are missing', () => {
    const p = packUVs(null, 1);
    const t0 = readUV(p, 0);
    expect(t0.a).toEqual([0, 0]);
    expect(t0.c).toEqual([0, 0]);
  });
});

describe('packEmitters', () => {
  it('packs the emitter CDF + radiance from an emissive scene', () => {
    // One emissive tri + one dark tri.
    const tris = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // emitter
      5, 5, 5, 6, 5, 5, 5, 6, 5, // dark
    ]);
    const triMat = Int32Array.from([1, 0]);
    const mats: SnapMaterial[] = [
      { baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 1, emissive: [0, 0, 0], emissiveStrength: 0 },
      { baseColor: [1, 1, 1], metallic: 0, roughness: 1, emissive: [1, 0.5, 0.25], emissiveStrength: 4 },
    ];
    const em = buildEmitters(tris, triMat, mats);
    expect(em).not.toBeNull();
    const pe = packEmitters(em);
    expect(pe.count).toBe(1);
    expect(pe.totalArea).toBeCloseTo(0.5);
    // t0 = triIndex, cdf; t1 = radiance
    expect(pe.data.data[0]).toBeCloseTo(0); // tri index 0
    expect(pe.data.data[1]).toBeCloseTo(1); // last cdf entry = 1
    expect(pe.data.data[4]).toBeCloseTo(4); // radiance r = 1*4
    expect(pe.data.data[5]).toBeCloseTo(2); // g = 0.5*4
  });

  it('null emitters → empty payload that still binds', () => {
    const pe = packEmitters(null);
    expect(pe.count).toBe(0);
    expect(pe.totalArea).toBe(0);
    expect(pe.data.data.length).toBe(4); // 1x1 dummy
  });
});

describe('packLights', () => {
  it('round-trips all 4 light types incl. area axes', () => {
    const lights: SnapLight[] = [
      { type: 0, position: [1, 2, 3], direction: [0, -1, 0], energy: [5, 5, 5], cosInner: 1, cosOuter: 1, radius: 0.1 },
      { type: 1, position: [0, 10, 0], direction: [0, -1, 0], energy: [1, 1, 1], cosInner: 1, cosOuter: 1 },
      { type: 2, position: [2, 3, 4], direction: [0, 0, -1], energy: [3, 3, 3], cosInner: 0.9, cosOuter: 0.8, radius: 0.2 },
      {
        type: 3, position: [0, 5, 0], direction: [0, -1, 0], energy: [8, 8, 8],
        cosInner: 1, cosOuter: 1, uAxis: [1, 0, 0], vAxis: [0, 0, 1], width: 2, height: 3,
      },
    ];
    const p = packLights(lights);
    expect(p.count).toBe(4);

    const l0 = readLight(p, 0);
    expect(l0.type).toBe(0);
    expect(l0.position).toEqual([1, 2, 3]);
    expect(l0.radius).toBeCloseTo(0.1);

    const l2 = readLight(p, 2);
    expect(l2.type).toBe(2);
    expect(l2.cosInner).toBeCloseTo(0.9);
    expect(l2.cosOuter).toBeCloseTo(0.8);

    const l3 = readLight(p, 3);
    expect(l3.type).toBe(3);
    expect(l3.uAxis).toEqual([1, 0, 0]);
    expect(l3.vAxis).toEqual([0, 0, 1]);
    expect(l3.width).toBeCloseTo(2);
    expect(l3.height).toBeCloseTo(3);
  });
});

describe('flattenBVH', () => {
  // A cube-ish spread of triangles so the median-split BVH has real internal
  // nodes AND leaves.
  function scatterTris(n: number): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i % 5) * 2, y = ((i / 5) | 0) * 2;
      out.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
    }
    return new Float32Array(out);
  }

  it('flattens a pointer tree to an indexed array with valid child links', () => {
    const tris = scatterTris(20);
    const root = buildBVH(tris);
    const flat = flattenBVH(root);
    expect(flat.nodeCount).toBeGreaterThan(1);
    expect(flat.nodes.data.length).toBe(flat.nodes.width * flat.nodes.height * 4);

    // Every internal child index is in range; every leaf range is in bounds.
    let leafTriTotal = 0;
    const seen = new Set<number>();
    for (let i = 0; i < flat.nodeCount; i++) {
      const node = readNode(flat.nodes, i);
      expect(node.min.length).toBe(3);
      if (node.isLeaf) {
        expect(node.triOffset).toBeGreaterThanOrEqual(0);
        expect(node.triOffset + node.triCount).toBeLessThanOrEqual(flat.triIndexCount);
        for (let k = 0; k < node.triCount; k++) {
          const ti = readTriIndex(flat.triIndices, node.triOffset + k);
          expect(ti).toBeGreaterThanOrEqual(0);
          expect(ti).toBeLessThan(20);
          seen.add(ti);
        }
        leafTriTotal += node.triCount;
      } else {
        expect(node.left).toBeGreaterThanOrEqual(0);
        expect(node.left).toBeLessThan(flat.nodeCount);
        expect(node.right).toBeGreaterThanOrEqual(0);
        expect(node.right).toBeLessThan(flat.nodeCount);
      }
    }
    // Every triangle is referenced exactly once across all leaves.
    expect(leafTriTotal).toBe(20);
    expect(seen.size).toBe(20);
  });

  it('root bounds enclose all triangle vertices', () => {
    const tris = scatterTris(12);
    const flat = flattenBVH(buildBVH(tris));
    const root = readNode(flat.nodes, 0);
    for (let i = 0; i < tris.length; i += 3) {
      expect(tris[i]).toBeGreaterThanOrEqual(root.min[0] - 1e-5);
      expect(tris[i]).toBeLessThanOrEqual(root.max[0] + 1e-5);
      expect(tris[i + 1]).toBeGreaterThanOrEqual(root.min[1] - 1e-5);
      expect(tris[i + 1]).toBeLessThanOrEqual(root.max[1] + 1e-5);
    }
  });

  it('handles a null BVH (empty scene)', () => {
    const flat = flattenBVH(null);
    expect(flat.nodeCount).toBe(0);
    expect(flat.triIndexCount).toBe(0);
    expect(flat.nodes.data.length).toBe(4); // 1x1 dummy
  });

  it('row width never exceeds TEX_MAX_WIDTH', () => {
    const tris = scatterTris(2000);
    const p = packTriangles(tris, new Int32Array(2000));
    expect(p.width).toBeLessThanOrEqual(TEX_MAX_WIDTH);
    expect(p.width * p.height).toBeGreaterThanOrEqual(2000 * 3);
  });
});
