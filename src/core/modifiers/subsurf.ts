import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

const MIN_LEVELS = 1;
const MAX_LEVELS = 3;

function clampLevels(n: number): number {
  return Math.max(MIN_LEVELS, Math.min(MAX_LEVELS, Math.round(n)));
}

/**
 * One Catmull-Clark subdivision iteration. Builds a fresh EditableMesh whose
 * verts are, in Map insertion order: every original vert's new position (vert
 * points), then every edge point, then every face point. Each n-gon becomes n
 * quads. Ordering is deterministic (mesh.verts / mesh.edges() / mesh.faces are
 * all iterated in insertion order), so equal input + params → identical output.
 *
 * Edge creases (mesh.creases, 0..1 per edge) are honored with the standard
 * crease rule: an edge point lerps from the smooth Catmull-Clark point toward
 * the sharp midpoint by the edge weight; a vert bordered by ≥ 2 creased edges
 * lerps from its smooth position toward the sharp crease/corner rule by the
 * average incident crease weight. Output creases: each child edge of a creased
 * edge inherits the parent weight UNCHANGED (Blender-simple — repeated
 * subdivision keeps the crease). faceTints carry to every child face.
 */
function subdivideOnce(mesh: EditableMesh): EditableMesh {
  // Face points: centroid of each face.
  const faceCentroid = new Map<number, Vec3>();
  for (const f of mesh.faces.values()) {
    let c = new Vec3();
    for (const vid of f.verts) c = c.add(mesh.verts.get(vid)!.co);
    faceCentroid.set(f.id, c.scale(1 / f.verts.length));
  }

  const edges = mesh.edges();

  // Edge midpoints (used by vert-point rule + boundary edge points) and edge
  // points (face-aware for interior edges).
  const edgeMidpoint = new Map<string, Vec3>();
  const edgePoint = new Map<string, Vec3>();
  for (const e of edges.values()) {
    const a = mesh.verts.get(e.v0)!.co;
    const b = mesh.verts.get(e.v1)!.co;
    const mid = a.add(b).scale(0.5);
    edgeMidpoint.set(e.key, mid);
    if (e.faces.length === 2) {
      // Average of the two endpoints and the two adjacent face points.
      const fp = faceCentroid.get(e.faces[0])!.add(faceCentroid.get(e.faces[1])!);
      const smooth = a.add(b).add(fp).scale(0.25);
      // Crease: lerp the smooth point toward the sharp midpoint by the weight.
      const w = mesh.creases.get(e.key) ?? 0;
      edgePoint.set(e.key, w > 0 ? smooth.lerp(mid, w) : smooth);
    } else {
      // Boundary (or non-manifold) edge → endpoint midpoint (already sharp).
      edgePoint.set(e.key, mid);
    }
  }

  // Per-vert adjacency (insertion-ordered).
  const vertFaces = new Map<number, number[]>();
  const vertEdges = new Map<number, string[]>();
  for (const v of mesh.verts.values()) {
    vertFaces.set(v.id, []);
    vertEdges.set(v.id, []);
  }
  for (const f of mesh.faces.values()) {
    for (const vid of f.verts) vertFaces.get(vid)!.push(f.id);
  }
  for (const e of edges.values()) {
    vertEdges.get(e.v0)!.push(e.key);
    vertEdges.get(e.v1)!.push(e.key);
  }

  // Vert points: new position of each original vert.
  const newVertPos = new Map<number, Vec3>();
  for (const v of mesh.verts.values()) {
    const P = v.co;
    const adjEdges = vertEdges.get(v.id)!;
    const boundaryEdges = adjEdges.filter((k) => edges.get(k)!.faces.length === 1);
    // Smooth position first; a crease/corner blend (below) may pull it sharp.
    let smooth: Vec3;
    if (boundaryEdges.length === 0) {
      // Interior: (F + 2R + (n-3)P) / n. F = avg adjacent face points,
      // R = avg adjacent edge MIDPOINTS, n = number of adjacent faces.
      const adjFaces = vertFaces.get(v.id)!;
      const n = adjFaces.length;
      if (n === 0) {
        newVertPos.set(v.id, P); // floating vert with no faces
        continue;
      }
      let F = new Vec3();
      for (const fid of adjFaces) F = F.add(faceCentroid.get(fid)!);
      F = F.scale(1 / n);
      let R = new Vec3();
      for (const k of adjEdges) R = R.add(edgeMidpoint.get(k)!);
      R = R.scale(1 / adjEdges.length);
      smooth = F.add(R.scale(2)).add(P.scale(n - 3)).scale(1 / n);
    } else if (boundaryEdges.length === 2) {
      // Boundary crease: (m1 + m2 + 6P) / 8.
      const m1 = edgeMidpoint.get(boundaryEdges[0])!;
      const m2 = edgeMidpoint.get(boundaryEdges[1])!;
      smooth = m1.add(m2).add(P.scale(6)).scale(1 / 8);
    } else {
      // Single or >2 boundary edges (non-manifold corner) → keep P.
      smooth = P;
    }

    // Crease/corner blend: a vert bordered by ≥ 2 creased edges lerps from the
    // smooth position toward the sharp rule by the average incident weight.
    const creasedEdges = adjEdges.filter((k) => (mesh.creases.get(k) ?? 0) > 0);
    if (creasedEdges.length >= 2) {
      let sumW = 0;
      for (const k of creasedEdges) sumW += mesh.creases.get(k)!;
      const avgW = Math.min(1, sumW / creasedEdges.length);
      let sharp: Vec3;
      if (creasedEdges.length === 2) {
        // Crease rule: (m1 + m2 + 6P) / 8 using the two creased-edge midpoints.
        const m1 = edgeMidpoint.get(creasedEdges[0])!;
        const m2 = edgeMidpoint.get(creasedEdges[1])!;
        sharp = m1.add(m2).add(P.scale(6)).scale(1 / 8);
      } else {
        // ≥ 3 creased edges → corner: the vert stays put.
        sharp = P;
      }
      smooth = smooth.lerp(sharp, avgW);
    }
    newVertPos.set(v.id, smooth);
  }

  // Assemble output. Vert points first, then edge points, then face points.
  const out = new EditableMesh();
  const vpId = new Map<number, number>();
  for (const v of mesh.verts.values()) vpId.set(v.id, out.addVert(newVertPos.get(v.id)!));
  const epId = new Map<string, number>();
  for (const e of edges.values()) epId.set(e.key, out.addVert(edgePoint.get(e.key)!));
  const fpId = new Map<number, number>();
  for (const f of mesh.faces.values()) fpId.set(f.id, out.addVert(faceCentroid.get(f.id)!));

  // Each n-gon → n quads, winding preserving the original orientation. A tinted
  // parent passes its tint to every child quad.
  for (const f of mesh.faces.values()) {
    const vs = f.verts;
    const n = vs.length;
    const tint = mesh.faceTints.get(f.id);
    for (let i = 0; i < n; i++) {
      const vi = vs[i];
      const vNext = vs[(i + 1) % n];
      const vPrev = vs[(i - 1 + n) % n];
      const childId = out.addFace([
        vpId.get(vi)!,
        epId.get(EditableMesh.edgeKey(vi, vNext))!,
        fpId.get(f.id)!,
        epId.get(EditableMesh.edgeKey(vPrev, vi))!,
      ]);
      if (tint) out.faceTints.set(childId, [tint[0], tint[1], tint[2]]);
    }
  }

  // Output creases: each creased parent edge splits into two child edges
  // (endpoint → edge point), both inheriting the parent's weight unchanged.
  for (const e of edges.values()) {
    const w = mesh.creases.get(e.key) ?? 0;
    if (w <= 0) continue;
    const ep = epId.get(e.key)!;
    out.setCrease(vpId.get(e.v0)!, ep, w);
    out.setCrease(vpId.get(e.v1)!, ep, w);
  }
  return out;
}

/**
 * Subdivision Surface modifier (P4-6). Catmull-Clark, applied `levels` times.
 * PURE: derives a fresh mesh each level, never mutating the input.
 */
class SubsurfModifier implements Modifier {
  readonly type = 'subsurf';
  name = 'Subdivision';
  enabled = true;
  private levels = 1;

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh): EditableMesh {
    let current = mesh;
    for (let i = 0; i < this.levels; i++) current = subdivideOnce(current);
    // Guarantee a fresh mesh even at levels 0 (clamped away, but be safe).
    return current === mesh ? mesh.clone() : current;
  }

  params(): ModifierParams {
    return { levels: this.levels };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (key === 'levels' && typeof value === 'number') this.levels = clampLevels(value);
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.levels === 'number') this.levels = clampLevels(p.levels);
  }

  fields(): ModifierField[] {
    return [{ key: 'levels', label: 'Levels', kind: 'int', min: MIN_LEVELS, max: MAX_LEVELS, step: 1 }];
  }
}

registerModifier('subsurf', 'Subdivision Surface', (p) => new SubsurfModifier(p));
