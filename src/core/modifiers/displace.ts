import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

/**
 * Area-weighted vertex normals — same convention as Solidify. Newell's method
 * gives, per face, a vector whose magnitude is twice the face area, so summing
 * the UNnormalized Newell vector onto each corner vert area-weights each face's
 * contribution for free. Per-vert sums are normalized at the end; a degenerate
 * accumulation yields a zero normal (→ no displacement for that vert).
 *
 * Mirrored locally (not imported from solidify.ts) so this modifier stays
 * self-contained and deterministic.
 */
function vertexNormals(mesh: EditableMesh): Map<number, Vec3> {
  const acc = new Map<number, Vec3>();
  for (const v of mesh.verts.values()) acc.set(v.id, new Vec3());
  for (const f of mesh.faces.values()) {
    let nx = 0, ny = 0, nz = 0;
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const a = mesh.verts.get(f.verts[i])!.co;
      const b = mesh.verts.get(f.verts[(i + 1) % n])!.co;
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    const fn = new Vec3(nx, ny, nz);
    for (const vid of f.verts) acc.set(vid, acc.get(vid)!.add(fn));
  }
  const out = new Map<number, Vec3>();
  for (const [id, v] of acc) out.set(id, v.normalize());
  return out;
}

// --- Self-contained 3D fbm value noise ------------------------------------
// A 3D analogue of the 2D lattice noise in src/core/nodes/nodesA.ts (mirrored,
// NOT imported, so the modifier is deterministic and dependency-free): an
// integer-lattice hash → trilinear interpolation with Perlin's fade curve →
// fbm octaves (amp halving, freq doubling), normalized to 0..1. No Math.random,
// so identical (position, params) always produce identical output.

const NOISE_SEED = 0x1a2b3c4d;

/** Integer hash → float in [0,1). Deterministic; mulberry32 mixing idiom. */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let a =
    (Math.imul(ix | 0, 0x27d4eb2d) ^
      Math.imul(iy | 0, 0x165667b1) ^
      Math.imul(iz | 0, 0x9e3779b1) ^
      (seed | 0)) >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smooth (fade) interpolant, Perlin's 6t^5-15t^4+10t^3. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Trilinearly-interpolated value noise at (x,y,z). Range 0..1. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0);
  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x0 + 1, y0, z0, seed);
  const c010 = hash3(x0, y0 + 1, z0, seed);
  const c110 = hash3(x0 + 1, y0 + 1, z0, seed);
  const c001 = hash3(x0, y0, z0 + 1, seed);
  const c101 = hash3(x0 + 1, y0, z0 + 1, seed);
  const c011 = hash3(x0, y0 + 1, z0 + 1, seed);
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1, seed);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0i = x00 + (x10 - x00) * fy;
  const y1i = x01 + (x11 - x01) * fy;
  return y0i + (y1i - y0i) * fz;
}

/** fbm value noise, `octaves` layers. `seed` offsets the lattice. Returns 0..1. */
function fbm3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  const oct = Math.max(1, Math.floor(octaves));
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, NOISE_SEED + (seed | 0) + i);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

type TextureKind = 'noise' | 'none';

/**
 * Displace modifier (Blender's Displace, normal-direction only). Moves every
 * vertex along its area-weighted VERTEX NORMAL by `strength · (tex(v) −
 * midlevel)`, where:
 *   - `texture` = 'none' → tex(v) is a constant 1.0, so the whole surface
 *     inflates (or deflates, via midlevel/negative strength) uniformly.
 *   - `texture` = 'noise' → tex(v) is 3D fbm value noise sampled at the vertex's
 *     LOCAL position, scaled by `scale` (frequency) with `detail` octaves and a
 *     `seed` offset. Range 0..1, so `midlevel` 0.5 centers it (roughly
 *     zero-mean displacement).
 *
 * Topology is unchanged — verts/faces/ids and every attribute (UVs, seams,
 * creases, faceTints) survive via mesh.clone(); only positions move. PURE +
 * deterministic (no Math.random): identical mesh + params → identical output.
 */
class DisplaceModifier implements Modifier {
  readonly type = 'displace';
  name = 'Displace';
  enabled = true;
  private strength = 0.3;
  private midlevel = 0.5;
  private scale = 1;
  private detail = 4;
  private seed = 0;
  private texture: TextureKind = 'noise';

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  /** Texture value at a local-space position. 'none' → 1.0; 'noise' → fbm 0..1. */
  private tex(co: Vec3): number {
    if (this.texture === 'none') return 1.0;
    return fbm3(co.x * this.scale, co.y * this.scale, co.z * this.scale, this.detail, this.seed);
  }

  apply(mesh: EditableMesh): EditableMesh {
    const out = mesh.clone(); // preserves topology + UVs/seams/creases/faceTints
    const normals = vertexNormals(mesh);
    for (const v of mesh.verts.values()) {
      const disp = this.strength * (this.tex(v.co) - this.midlevel);
      if (disp === 0) continue; // leave the vert exactly put
      const nrm = normals.get(v.id)!;
      out.setVertCo(v.id, v.co.add(nrm.scale(disp)));
    }
    return out;
  }

  params(): ModifierParams {
    return {
      strength: this.strength,
      midlevel: this.midlevel,
      scale: this.scale,
      detail: this.detail,
      seed: this.seed,
      texture: this.texture,
    };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (key === 'texture') {
      if (value === 'noise' || value === 'none') this.texture = value;
      return;
    }
    if (typeof value !== 'number') return;
    if (key === 'strength') this.strength = value;
    else if (key === 'midlevel') this.midlevel = Math.max(0, Math.min(1, value));
    else if (key === 'scale') this.scale = value;
    else if (key === 'detail') this.detail = Math.max(1, Math.min(8, Math.round(value)));
    else if (key === 'seed') this.seed = Math.round(value);
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.strength === 'number') this.strength = p.strength;
    if (typeof p.midlevel === 'number') this.midlevel = Math.max(0, Math.min(1, p.midlevel));
    if (typeof p.scale === 'number') this.scale = p.scale;
    if (typeof p.detail === 'number') this.detail = Math.max(1, Math.min(8, Math.round(p.detail)));
    if (typeof p.seed === 'number') this.seed = Math.round(p.seed);
    if (p.texture === 'noise' || p.texture === 'none') this.texture = p.texture;
  }

  fields(): ModifierField[] {
    return [
      {
        key: 'texture',
        label: 'Texture',
        kind: 'select',
        options: [
          { value: 'noise', label: 'Noise' },
          { value: 'none', label: 'None' },
        ],
      },
      { key: 'strength', label: 'Strength', kind: 'number', step: 0.05 },
      { key: 'midlevel', label: 'Midlevel', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'scale', label: 'Scale', kind: 'number', min: 0, step: 0.1 },
      { key: 'detail', label: 'Detail', kind: 'int', min: 1, max: 8, step: 1 },
      { key: 'seed', label: 'Seed', kind: 'int', step: 1 },
    ];
  }
}

registerModifier('displace', 'Displace', (p) => new DisplaceModifier(p));

export { DisplaceModifier };
