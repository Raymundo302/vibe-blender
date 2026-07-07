import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

/**
 * Area-weighted vertex normals. Newell's method produces, per face, a vector
 * whose magnitude equals twice the face area — so accumulating the UNnormalized
 * Newell vector onto each corner vert weights each face's contribution by its
 * area for free. The per-vert sums are normalized at the end; a vert whose
 * accumulated normal is degenerate gets a zero normal (no displacement).
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

/**
 * Solidify modifier (P9-1). Gives a surface thickness by building two shells —
 * an OUTER shell (the original faces, unflipped) and an INNER shell (a duplicate
 * with reversed winding) — offset along area-weighted vertex normals, then
 * stitches every boundary edge into a rim quad connecting the shells.
 *
 * `offset` (−1..1) slides where the two shells sit relative to the source
 * surface: offset 1 → outer shell at +thickness, inner shell at 0 (the tutorial
 * icing case, extruding outward). In general
 *   outerDisp = thickness · (offset + 1) / 2
 *   innerDisp = thickness · (offset − 1) / 2.
 *
 * `rimCrease` writes a crease weight onto every edge of the NEW rim quads so a
 * following creased Subsurf keeps the rim tight (Blender's Solidify "Edge
 * Data > Crease" / Rim Crease). Input creases are preserved on BOTH shells'
 * corresponding edges; faceTints copy to both shells.
 *
 * PURE + deterministic: builds a fresh mesh, verts/faces created in a fixed
 * iteration order (outer verts, inner verts, outer faces, inner faces, rim
 * quads) so identical input+params → byte-identical output.
 */
class SolidifyModifier implements Modifier {
  readonly type = 'solidify';
  name = 'Solidify';
  enabled = true;
  private thickness = 0.05;
  private offset = 1;
  private rimCrease = 0;

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh): EditableMesh {
    const out = new EditableMesh();
    const normals = vertexNormals(mesh);
    const outerDisp = (this.thickness * (this.offset + 1)) / 2;
    const innerDisp = (this.thickness * (this.offset - 1)) / 2;

    // Outer shell verts, then inner shell verts (deterministic order).
    const outerId = new Map<number, number>();
    for (const v of mesh.verts.values()) {
      const nrm = normals.get(v.id)!;
      outerId.set(v.id, out.addVert(v.co.add(nrm.scale(outerDisp))));
    }
    const innerId = new Map<number, number>();
    for (const v of mesh.verts.values()) {
      const nrm = normals.get(v.id)!;
      innerId.set(v.id, out.addVert(v.co.add(nrm.scale(innerDisp))));
    }

    // Outer faces keep winding; inner faces reverse it (normals face inward).
    const outerFace = new Map<number, number>();
    for (const f of mesh.faces.values()) {
      outerFace.set(f.id, out.addFace(f.verts.map((id) => outerId.get(id)!)));
    }
    const innerFace = new Map<number, number>();
    for (const f of mesh.faces.values()) {
      innerFace.set(f.id, out.addFace(f.verts.map((id) => innerId.get(id)!).reverse()));
    }

    // faceTints copy to both shells' corresponding faces.
    for (const [fid, tint] of mesh.faceTints) {
      const t: [number, number, number] = [tint[0], tint[1], tint[2]];
      out.faceTints.set(outerFace.get(fid)!, [t[0], t[1], t[2]]);
      out.faceTints.set(innerFace.get(fid)!, [t[0], t[1], t[2]]);
    }

    // Preserve input creases on both shells' corresponding edges.
    for (const [key, w] of mesh.creases) {
      const [a, b] = key.split(',').map((s) => parseInt(s, 10));
      if (!mesh.verts.has(a) || !mesh.verts.has(b)) continue;
      out.setCrease(outerId.get(a)!, outerId.get(b)!, w);
      out.setCrease(innerId.get(a)!, innerId.get(b)!, w);
    }

    // Rim: one quad per boundary edge of the source, connecting the two shells.
    for (const e of mesh.edges().values()) {
      if (e.faces.length !== 1) continue;
      const a = e.v0, b = e.v1;
      const oa = outerId.get(a)!, ob = outerId.get(b)!;
      const ia = innerId.get(a)!, ib = innerId.get(b)!;
      // outer a → outer b → inner b → inner a (a consistent side wall).
      out.addFace([oa, ob, ib, ia]);
      if (this.rimCrease > 0) {
        // Crease every edge of the rim quad so a following Subsurf keeps it tight.
        out.setCrease(oa, ob, this.rimCrease);
        out.setCrease(ob, ib, this.rimCrease);
        out.setCrease(ib, ia, this.rimCrease);
        out.setCrease(ia, oa, this.rimCrease);
      }
    }

    return out;
  }

  params(): ModifierParams {
    return { thickness: this.thickness, offset: this.offset, rimCrease: this.rimCrease };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (typeof value !== 'number') return;
    if (key === 'thickness') this.thickness = value;
    else if (key === 'offset') this.offset = Math.max(-1, Math.min(1, value));
    else if (key === 'rimCrease') this.rimCrease = Math.max(0, Math.min(1, value));
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.thickness === 'number') this.thickness = p.thickness;
    if (typeof p.offset === 'number') this.offset = Math.max(-1, Math.min(1, p.offset));
    if (typeof p.rimCrease === 'number') this.rimCrease = Math.max(0, Math.min(1, p.rimCrease));
  }

  fields(): ModifierField[] {
    return [
      { key: 'thickness', label: 'Thickness', kind: 'number', step: 0.01 },
      { key: 'offset', label: 'Offset', kind: 'number', min: -1, max: 1, step: 0.1 },
      { key: 'rimCrease', label: 'Rim Crease', kind: 'number', min: 0, max: 1, step: 0.1 },
    ];
  }
}

registerModifier('solidify', 'Solidify', (p) => new SolidifyModifier(p));
