import { EditableMesh } from './EditableMesh';
import { Vec3 } from '../math/vec3';

/**
 * Flatten an EditableMesh into typed arrays for GPU upload. Verts are
 * duplicated per face corner; polygons are fan-triangulated.
 *
 * Flat shading (Blender default): corners carry their face's normal.
 * Smooth shading: corners carry their VERT's normal — the area-weighted
 * average of adjacent face normals (unnormalized Newell normals are already
 * area-weighted, so summing them weights big faces more, like Blender).
 */
export interface MeshRenderData {
  /** xyz per corner, 3 corners per triangle. */
  trianglePositions: Float32Array;
  /** Face normal per corner, parallel to trianglePositions. */
  triangleNormals: Float32Array;
  /** Per-corner RGB tint (faceTints or white), parallel to trianglePositions. */
  triangleColors: Float32Array;
  /** Per-corner UV (mesh.uvs or 0,0), 2 floats per corner (P11). */
  triangleUVs: Float32Array;
  triangleCount: number;
  /** xyz pairs, one segment per unique edge (wireframe / overlays). */
  edgePositions: Float32Array;
  edgeCount: number;
}

/** Area-weighted per-vert normals (smooth shading). */
export function vertexNormals(mesh: EditableMesh): Map<number, Vec3> {
  const acc = new Map<number, Vec3>();
  for (const face of mesh.faces.values()) {
    // Unnormalized Newell normal = 2×area-weighted face normal.
    let nx = 0, ny = 0, nz = 0;
    const n = face.verts.length;
    for (let i = 0; i < n; i++) {
      const a = mesh.verts.get(face.verts[i])!.co;
      const b = mesh.verts.get(face.verts[(i + 1) % n])!.co;
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    const fn = new Vec3(nx, ny, nz);
    for (const vid of face.verts) acc.set(vid, (acc.get(vid) ?? Vec3.ZERO).add(fn));
  }
  const out = new Map<number, Vec3>();
  for (const [vid, sum] of acc) out.set(vid, sum.normalize());
  return out;
}

export function meshToRenderData(mesh: EditableMesh, smooth = false): MeshRenderData {
  const smoothNormals = smooth ? vertexNormals(mesh) : null;
  let triCount = 0;
  for (const face of mesh.faces.values()) triCount += face.verts.length - 2;

  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  const uvArr = new Float32Array(triCount * 6);
  let p = 0;
  let q = 0;

  for (const face of mesh.faces.values()) {
    const faceN = mesh.faceNormal(face.id);
    const tint = mesh.faceTints.get(face.id);
    const faceUVs = mesh.uvs.get(face.id);
    const vs = face.verts;
    for (let i = 1; i < vs.length - 1; i++) {
      for (const corner of [0, i, i + 1]) {
        const uv = faceUVs?.[corner];
        uvArr[q++] = uv?.[0] ?? 0;
        uvArr[q++] = uv?.[1] ?? 0;
      }
      for (const vid of [vs[0], vs[i], vs[i + 1]]) {
        const co = mesh.verts.get(vid)!.co;
        const n = smoothNormals?.get(vid) ?? faceN;
        colors[p] = tint?.[0] ?? 1;
        positions[p] = co.x; normals[p++] = n.x;
        colors[p] = tint?.[1] ?? 1;
        positions[p] = co.y; normals[p++] = n.y;
        colors[p] = tint?.[2] ?? 1;
        positions[p] = co.z; normals[p++] = n.z;
      }
    }
  }

  const edges = mesh.edges();
  const edgePositions = new Float32Array(edges.size * 6);
  let e = 0;
  for (const edge of edges.values()) {
    const a = mesh.verts.get(edge.v0)!.co;
    const b = mesh.verts.get(edge.v1)!.co;
    edgePositions[e++] = a.x; edgePositions[e++] = a.y; edgePositions[e++] = a.z;
    edgePositions[e++] = b.x; edgePositions[e++] = b.y; edgePositions[e++] = b.z;
  }

  return {
    trianglePositions: positions,
    triangleNormals: normals,
    triangleColors: colors,
    triangleUVs: uvArr,
    triangleCount: triCount,
    edgePositions,
    edgeCount: edges.size,
  };
}
