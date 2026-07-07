import type { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Closest-point-on-mesh query (P9). Reusable by Shrinkwrap and any tool that
 * needs to snap a point onto a surface. Pure: never mutates the mesh.
 *
 * Polygons are fan-triangulated the same way meshToGpu does — corners
 * (vs[0], vs[i], vs[i+1]) — so a face's closest point matches what the GPU
 * actually renders. Brute force over every triangle; fine at demo scale.
 */

export interface ClosestPoint {
  /** Closest point on the mesh surface, in mesh-local space. */
  point: Vec3;
  /** Face the closest point lies on (-1 if the mesh has no faces). */
  faceId: number;
  /** Geometric normal of the triangle the closest point lies on. */
  normal: Vec3;
}

/**
 * Closest point on a triangle to p, via Ericson's region-based method
 * (Real-Time Collision Detection §5.1.5). Returns a point in the closed
 * triangle: a vertex, an edge projection, or an interior (face) projection.
 */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = b.sub(a);
  const ac = c.sub(a);
  const ap = p.sub(a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return a; // vertex region A

  const bp = p.sub(b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return b; // vertex region B

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return a.add(ab.scale(v)); // edge AB
  }

  const cp = p.sub(c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return c; // vertex region C

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return a.add(ac.scale(w)); // edge AC
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return b.add(c.sub(b).scale(w)); // edge BC
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return a.add(ab.scale(v)).add(ac.scale(w)); // interior
}

/**
 * Nearest surface point on `mesh` to `p` (mesh-local space on both sides).
 * Iterates every fan triangle of every face and keeps the global minimum.
 */
export function closestPointOnMesh(mesh: EditableMesh, p: Vec3): ClosestPoint {
  let best: Vec3 | null = null;
  let bestDistSq = Infinity;
  let bestFace = -1;
  let bestNormal = Vec3.Y;

  for (const face of mesh.faces.values()) {
    const vs = face.verts;
    if (vs.length < 3) continue;
    const a = mesh.verts.get(vs[0])!.co;
    for (let i = 1; i < vs.length - 1; i++) {
      const b = mesh.verts.get(vs[i])!.co;
      const c = mesh.verts.get(vs[i + 1])!.co;
      const q = closestPointOnTriangle(p, a, b, c);
      const distSq = q.sub(p).lengthSq();
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = q;
        bestFace = face.id;
        bestNormal = b.sub(a).cross(c.sub(a)).normalize();
      }
    }
  }

  return best
    ? { point: best, faceId: bestFace, normal: bestNormal }
    : { point: p, faceId: -1, normal: Vec3.Y };
}
