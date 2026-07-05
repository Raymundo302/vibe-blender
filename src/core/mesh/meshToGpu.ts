import { EditableMesh } from './EditableMesh';

/**
 * Flatten an EditableMesh into typed arrays for GPU upload.
 * Flat shading (Blender default): verts are duplicated per face corner and
 * carry the face normal. Polygons are fan-triangulated.
 */
export interface MeshRenderData {
  /** xyz per corner, 3 corners per triangle. */
  trianglePositions: Float32Array;
  /** Face normal per corner, parallel to trianglePositions. */
  triangleNormals: Float32Array;
  triangleCount: number;
  /** xyz pairs, one segment per unique edge (wireframe / overlays). */
  edgePositions: Float32Array;
  edgeCount: number;
}

export function meshToRenderData(mesh: EditableMesh): MeshRenderData {
  let triCount = 0;
  for (const face of mesh.faces.values()) triCount += face.verts.length - 2;

  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  let p = 0;

  for (const face of mesh.faces.values()) {
    const n = mesh.faceNormal(face.id);
    const vs = face.verts;
    for (let i = 1; i < vs.length - 1; i++) {
      for (const vid of [vs[0], vs[i], vs[i + 1]]) {
        const co = mesh.verts.get(vid)!.co;
        positions[p] = co.x; normals[p++] = n.x;
        positions[p] = co.y; normals[p++] = n.y;
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
    triangleCount: triCount,
    edgePositions,
    edgeCount: edges.size,
  };
}
