import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierContext,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

/**
 * Scatter modifier (P9-5) — a scoped-down "Scatter on Surface". Instances a
 * SOURCE object's evaluated mesh over the HOST mesh's faces with seeded
 * randomness (the donut's sprinkles).
 *
 * Determinism: all randomness comes from a single mulberry32 stream seeded by
 * `seed` (Math.random is forbidden). Placement draws a fixed 4 values per
 * candidate attempt (face pick, in-face triangle pick, two barycentric
 * coords) so the rejection loop stays reproducible regardless of accept/reject
 * outcomes; per-instance appearance (spin, scale jitter, color hue) is drawn
 * in a second pass over the accepted points, in order.
 *
 * Space: instances live in HOST-LOCAL space at the sampled surface points. The
 * source's own world transform is IGNORED (like Blender's "reset transform"
 * instancing) — only its geometry (verts/faces/creases, and tints when
 * colorVariation is 0) is copied.
 *
 * No-op (returns a clone of the input host mesh, geometry unchanged) when:
 *   - there is no ctx (unit tests on bare meshes — an object-referencing
 *     modifier must no-op without a scene), or
 *   - the source is unresolved / -1 / the host itself (ctx.target returns null
 *     for a cycle back to the host — the modifierContext visited-guard), or
 *   - count <= 0, or the host has no eligible faces (e.g. upOnly with no
 *     upward faces) / zero total area.
 */

const MAX_COUNT = 2000;

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** mulberry32 — small, fast, deterministic PRNG. Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** HSL(h∈[0,1), s, l) → linear-ish RGB in [0,1]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h - Math.floor(h)) * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Binary search: smallest index i in cum such that value < cum[i]. */
function pickCumulative(cum: number[], value: number): number {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < cum[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** A host face prepared for area-weighted sampling. */
interface HostFace {
  co: Vec3[];        // polygon vertex coords, in order
  normal: Vec3;      // host-local face normal
  triCum: number[];  // cumulative fan-triangle areas (last = face area)
}

class ScatterModifier implements Modifier {
  readonly type = 'scatter';
  name = 'Scatter';
  enabled = true;

  private source = -1;
  private count = 100;
  private seed = 0;
  private scale = 1;
  private randomScale = 0.2;
  private alignNormal = true;
  private randomRotation = true;
  private offset = 0;
  private minDistance = 0;
  private upOnly = false;
  private colorVariation = 0;
  // Orientation mode (P-punchlist "sprinkles align-to-normal"):
  //   'normal' — orient each instance so its LOCAL +Z axis points along the
  //              scattered face's normal (sprinkles rest ON the icing), with
  //              the existing per-instance random YAW about that normal.
  //   'none'   — the legacy axis-aligned path (local +Y → up), byte-identical
  //              to the pre-`align` algorithm for a given seed.
  // Default is context-dependent (see constructor): a freshly UI-added Scatter
  // defaults to 'normal' (the wanted look), but a DESERIALIZED modifier whose
  // saved params predate this field defaults to 'none' so old scenes — the
  // frozen donut fixture included — load looking exactly as they were saved.
  private align: 'normal' | 'none' = 'normal';

  constructor(params?: ModifierParams) {
    if (params) {
      // Old saved scatter params carry no `align`; keep their look unchanged.
      if (params.align === undefined) this.align = 'none';
      this.ingest(params);
    }
  }

  apply(mesh: EditableMesh, ctx?: ModifierContext): EditableMesh {
    const out = mesh.clone();
    if (!ctx || this.count <= 0) return out;

    const target = this.source >= 0 ? ctx.target(this.source) : null;
    if (!target) return out; // unresolved / -1 / host (cycle-guarded to null)

    // Eligible host faces (area-weighted). upOnly keeps only upward faces.
    const faces: HostFace[] = [];
    const faceCum: number[] = [];
    let totalArea = 0;
    for (const f of mesh.faces.values()) {
      const co = f.verts.map((id) => mesh.verts.get(id)!.co);
      if (co.length < 3) continue;
      const normal = mesh.faceNormal(f.id);
      if (this.upOnly && normal.z <= 0) continue;
      const triCum: number[] = [];
      let area = 0;
      for (let i = 1; i < co.length - 1; i++) {
        const tri = 0.5 * co[i].sub(co[0]).cross(co[i + 1].sub(co[0])).length();
        area += tri;
        triCum.push(area);
      }
      if (area <= 0) continue;
      totalArea += area;
      faces.push({ co, normal, triCum });
      faceCum.push(totalArea);
    }
    if (faces.length === 0 || totalArea <= 0) return out;

    const rng = mulberry32(this.seed);

    // --- Phase A: placement (fixed 4 draws per attempt) with dart-throwing. ---
    const points: { pos: Vec3; normal: Vec3 }[] = [];
    const maxAttempts = Math.max(this.count, this.count * 10);
    const minDistSq = this.minDistance * this.minDistance;
    for (let a = 0; a < maxAttempts && points.length < this.count; a++) {
      const face = faces[pickCumulative(faceCum, rng() * totalArea)];
      const triIdx = pickCumulative(face.triCum, rng() * face.triCum[face.triCum.length - 1]);
      let r1 = rng(), r2 = rng();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const p0 = face.co[0];
      const pa = face.co[triIdx + 1];
      const pb = face.co[triIdx + 2];
      const surface = p0.add(pa.sub(p0).scale(r1)).add(pb.sub(p0).scale(r2));
      const pos = surface.add(face.normal.scale(this.offset));
      if (this.minDistance > 0) {
        let rejected = false;
        for (const q of points) {
          if (pos.sub(q.pos).lengthSq() < minDistSq) { rejected = true; break; }
        }
        if (rejected) continue;
      }
      points.push({ pos, normal: face.normal });
    }

    // Source geometry snapshot (evaluated mesh — its transform is ignored).
    const src = target.mesh;
    const srcVertIds = [...src.verts.keys()];
    const srcIndexOf = new Map<number, number>();
    srcVertIds.forEach((id, i) => srcIndexOf.set(id, i));
    const srcCo = srcVertIds.map((id) => src.verts.get(id)!.co);
    const srcFaces = [...src.faces.values()];

    // --- Phase B: build each instance (per-instance draws in order). ---
    for (const { pos, normal } of points) {
      // Scale jitter: scale * (1 + (u*2-1)*randomScale).
      const s = this.randomScale > 0
        ? this.scale * (1 + (rng() * 2 - 1) * this.randomScale)
        : this.scale;

      // Per-instance random YAW (rotation about the up/normal axis). Drawn from
      // the SAME rng slot as before — only when randomRotation — so the seed
      // stream (and thus positions/tints) is untouched by the `align` field.
      const yaw = this.randomRotation ? rng() * Math.PI * 2 : 0;

      // Orientation basis. `basisX/basisY/basisZ` are the world directions that
      // the instance's LOCAL +X/+Y/+Z map to.
      let basisX: Vec3, basisY: Vec3, basisZ: Vec3;
      if (this.align === 'normal') {
        // Align-to-surface: local +Z → face normal. Build an orthonormal frame
        // from the normal, guarding the near-parallel-to-Z degenerate case, then
        // spin the tangents by yaw around the normal.
        const n = normal.normalize();
        const ref = Math.abs(n.z) < 0.9 ? Vec3.Z : Vec3.X;
        let tanX = ref.cross(n).normalize();
        let tanY = n.cross(tanX);
        if (yaw !== 0) {
          const c = Math.cos(yaw), sn = Math.sin(yaw);
          const nx = tanX.scale(c).add(tanY.scale(sn));
          const ny = tanX.scale(-sn).add(tanY.scale(c));
          tanX = nx; tanY = ny;
        }
        basisX = tanX; basisY = tanY; basisZ = n;
      } else {
        // Legacy path: local +Y → up (surface normal when alignNormal, else +Y).
        // Deterministic tangent from a non-parallel reference. Byte-identical to
        // the pre-`align` algorithm.
        const up = this.alignNormal ? normal : Vec3.Y;
        const ref = Math.abs(up.x) < 0.9 ? Vec3.X : Vec3.Z;
        let tanX = ref.cross(up).normalize();
        let tanZ = up.cross(tanX);
        if (this.randomRotation) {
          const c = Math.cos(yaw), sn = Math.sin(yaw);
          const nx = tanX.scale(c).add(tanZ.scale(sn));
          const nz = tanX.scale(-sn).add(tanZ.scale(c));
          tanX = nx; tanZ = nz;
        }
        basisX = tanX; basisY = up; basisZ = tanZ;
      }

      // Instance color: one pastel tint per instance when colorVariation > 0.
      let tint: [number, number, number] | null = null;
      if (this.colorVariation > 0) {
        const rgb = hslToRgb(rng(), 0.55, 0.72);
        const k = this.colorVariation;
        tint = [1 + (rgb[0] - 1) * k, 1 + (rgb[1] - 1) * k, 1 + (rgb[2] - 1) * k];
      }

      // Copy source verts into out with the composed transform:
      // scale · rotate(basis) · translate(pos).
      const newVertId: number[] = new Array(srcCo.length);
      for (let i = 0; i < srcCo.length; i++) {
        const v = srcCo[i].scale(s);
        const world = basisX.scale(v.x).add(basisY.scale(v.y)).add(basisZ.scale(v.z)).add(pos);
        newVertId[i] = out.addVert(world);
      }
      for (const f of srcFaces) {
        const fid = out.addFace(f.verts.map((id) => newVertId[srcIndexOf.get(id)!]));
        if (tint) out.faceTints.set(fid, tint);
        else {
          const st = src.faceTints.get(f.id);
          if (st) out.faceTints.set(fid, [st[0], st[1], st[2]]);
        }
        // Face UVs (P11-5) copy verbatim from the SOURCE object's face — the
        // instance transform is a rigid placement, so the corner order (and
        // thus the mapping) is unchanged.
        const suv = src.uvs.get(f.id);
        if (suv) out.setFaceUVs(fid, suv.map(([u, v]) => [u, v] as [number, number]));
      }
      // Copy the source's creases, remapped to this instance's verts.
      for (const [key, w] of src.creases) {
        const [a, b] = key.split(',').map(Number);
        const ia = srcIndexOf.get(a), ib = srcIndexOf.get(b);
        if (ia === undefined || ib === undefined) continue;
        out.setCrease(newVertId[ia], newVertId[ib], w);
      }
    }

    return out;
  }

  /**
   * Cache key: the SOURCE's evaluated-mesh version. Offset/normals are all
   * host-local (host matrix cancels), so the host world matrix does NOT change
   * the scattered output and is intentionally omitted here. Params ride the
   * host's modifiersVersion (bumped on every edit) and the host geometry rides
   * mesh.version, so both already invalidate the evaluatedMesh cache.
   */
  depVersion(ctx?: ModifierContext): string {
    return (this.source >= 0 ? ctx?.target(this.source)?.version : '') ?? '';
  }

  params(): ModifierParams {
    return {
      source: this.source,
      count: this.count,
      seed: this.seed,
      scale: this.scale,
      randomScale: this.randomScale,
      align: this.align,
      alignNormal: this.alignNormal,
      randomRotation: this.randomRotation,
      offset: this.offset,
      minDistance: this.minDistance,
      upOnly: this.upOnly,
      colorVariation: this.colorVariation,
    };
  }

  setParam(key: string, value: number | boolean | string): void {
    switch (key) {
      case 'source': if (typeof value === 'number') this.source = Math.round(value); break;
      case 'count': if (typeof value === 'number') this.count = clampInt(value, 0, MAX_COUNT); break;
      case 'seed': if (typeof value === 'number') this.seed = Math.round(value); break;
      case 'scale': if (typeof value === 'number') this.scale = value; break;
      case 'randomScale': if (typeof value === 'number') this.randomScale = clamp01(value); break;
      case 'align': if (value === 'normal' || value === 'none') this.align = value; break;
      case 'alignNormal': if (typeof value === 'boolean') this.alignNormal = value; break;
      case 'randomRotation': if (typeof value === 'boolean') this.randomRotation = value; break;
      case 'offset': if (typeof value === 'number') this.offset = value; break;
      case 'minDistance': if (typeof value === 'number') this.minDistance = Math.max(0, value); break;
      case 'upOnly': if (typeof value === 'boolean') this.upOnly = value; break;
      case 'colorVariation': if (typeof value === 'number') this.colorVariation = clamp01(value); break;
    }
  }

  private ingest(p: ModifierParams): void {
    for (const key of Object.keys(this.params())) {
      if (p[key] !== undefined) this.setParam(key, p[key]);
    }
  }

  fields(): ModifierField[] {
    return [
      { key: 'source', label: 'Source', kind: 'object' },
      { key: 'count', label: 'Count', kind: 'int', min: 0, max: MAX_COUNT, step: 1 },
      { key: 'seed', label: 'Seed', kind: 'int', step: 1 },
      { key: 'scale', label: 'Scale', kind: 'number', step: 0.05 },
      { key: 'randomScale', label: 'Random Scale', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'align', label: 'Align', kind: 'select', options: [
        { value: 'normal', label: 'To Normal' },
        { value: 'none', label: 'None' },
      ] },
      { key: 'alignNormal', label: 'Align to Normal', kind: 'bool' },
      { key: 'randomRotation', label: 'Random Rotation', kind: 'bool' },
      { key: 'offset', label: 'Offset', kind: 'number', step: 0.02 },
      { key: 'minDistance', label: 'Min Distance', kind: 'number', min: 0, step: 0.02 },
      { key: 'upOnly', label: 'Up Faces Only', kind: 'bool' },
      { key: 'colorVariation', label: 'Color Variation', kind: 'number', min: 0, max: 1, step: 0.05 },
    ];
  }
}

registerModifier('scatter', 'Scatter', (p) => new ScatterModifier(p));
