import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Loop cut (P2-7): walk a quad strip perpendicular to a starting edge and
 * split every quad in the strip with a new edge loop.
 *
 * The walk: inside a quad, an edge's "opposite" is the edge two corners away.
 * Hopping edge → quad → opposite edge → next quad traces the ring Blender
 * previews with Ctrl+R. The walk stops at non-quad faces or boundaries (open
 * loop) or when it returns to the start (closed loop, e.g. around a cube).
 */
export interface EdgeLoop {
  /** Ordered edge keys; consecutive entries share a quad of the strip. */
  edgeKeys: string[];
  closed: boolean;
}

/** The verts of `face` as an ordered quad, or null if not a quad. */
function quadVerts(mesh: EditableMesh, faceId: number): number[] | null {
  const f = mesh.faces.get(faceId);
  return f && f.verts.length === 4 ? f.verts : null;
}

/** Opposite edge of (a,b) within quad face — the edge two corners away. */
function oppositeEdge(quad: number[], a: number, b: number): [number, number] | null {
  for (let i = 0; i < 4; i++) {
    const va = quad[i], vb = quad[(i + 1) % 4];
    if ((va === a && vb === b) || (va === b && vb === a)) {
      return [quad[(i + 2) % 4], quad[(i + 3) % 4]];
    }
  }
  return null;
}

export function loopFromEdge(mesh: EditableMesh, startKey: string): EdgeLoop | null {
  const edges = mesh.edges();
  const start = edges.get(startKey);
  if (!start) return null;

  /** Walk one direction; returns the keys visited (excluding start) and whether we looped. */
  const walk = (firstFaceId: number): { keys: string[]; closed: boolean } => {
    const keys: string[] = [];
    let currentKey = startKey;
    let faceId: number | undefined = firstFaceId;
    const visitedFaces = new Set<number>();

    while (faceId !== undefined && !visitedFaces.has(faceId)) {
      visitedFaces.add(faceId);
      const quad = quadVerts(mesh, faceId);
      if (!quad) break;
      const cur = edges.get(currentKey)!;
      const opp = oppositeEdge(quad, cur.v0, cur.v1);
      if (!opp) break;
      const oppKey = EditableMesh.edgeKey(opp[0], opp[1]);
      if (oppKey === startKey) return { keys, closed: true };
      if (keys.includes(oppKey)) break; // self-intersecting strip: stop safely
      keys.push(oppKey);
      currentKey = oppKey;
      faceId = edges.get(oppKey)!.faces.find((f) => !visitedFaces.has(f));
    }
    return { keys, closed: false };
  };

  const [f0, f1] = start.faces;
  if (f0 === undefined) return null; // wire edge — nothing to cut

  const forward = walk(f0);
  if (forward.closed) {
    return { edgeKeys: [startKey, ...forward.keys], closed: true };
  }
  // Open strip: extend the other way too (if the edge is interior).
  const backward = f1 !== undefined ? walk(f1) : { keys: [], closed: false };
  return {
    edgeKeys: [...backward.keys.reverse(), startKey, ...forward.keys],
    closed: false,
  };
}

/**
 * Split every strip quad along the loop. Each loop edge gets a vert at
 * parameter t (measured from the edge's canonical v0), and each quad between
 * consecutive loop edges becomes two quads joined by a new loop-segment edge.
 * Returns the new verts and the new loop's edge keys (for selection).
 */
export function cutLoop(
  mesh: EditableMesh,
  loop: EdgeLoop,
  t = 0.5,
): { newVertIds: number[]; newEdgeKeys: string[] } {
  const edges = mesh.edges();
  const midByEdge = new Map<string, number>();
  for (const key of loop.edgeKeys) {
    const e = edges.get(key);
    if (!e) continue;
    const a = mesh.verts.get(e.v0)!.co;
    const b = mesh.verts.get(e.v1)!.co;
    midByEdge.set(key, mesh.addVert(a.lerp(b, t)));
  }

  // Strip faces: the quad shared by each consecutive pair of loop edges.
  const pairs: [string, string][] = [];
  for (let i = 0; i < loop.edgeKeys.length - 1; i++) {
    pairs.push([loop.edgeKeys[i], loop.edgeKeys[i + 1]]);
  }
  if (loop.closed) pairs.push([loop.edgeKeys.at(-1)!, loop.edgeKeys[0]]);

  const newEdgeKeys: string[] = [];
  const facesToDelete: number[] = [];
  for (const [keyA, keyB] of pairs) {
    const eA = edges.get(keyA), eB = edges.get(keyB);
    if (!eA || !eB) continue;
    const faceId = eA.faces.find((f) => eB.faces.includes(f));
    if (faceId === undefined) continue;
    const quad = quadVerts(mesh, faceId);
    if (!quad) continue;

    // Orient the quad as [a0, a1, b0, b1] where (a0,a1) lies on edge A
    // traversed in face order and (b0,b1) on edge B.
    let i0 = -1;
    for (let i = 0; i < 4; i++) {
      const va = quad[i], vb = quad[(i + 1) % 4];
      if (EditableMesh.edgeKey(va, vb) === keyA) { i0 = i; break; }
    }
    if (i0 < 0) continue;
    const [a0, a1, b0, b1] = [quad[i0], quad[(i0 + 1) % 4], quad[(i0 + 2) % 4], quad[(i0 + 3) % 4]];
    const mA = midByEdge.get(keyA)!;
    const mB = midByEdge.get(keyB)!;

    // Original winding a0→a1→b0→b1 is preserved in both halves.
    facesToDelete.push(faceId);
    mesh.addFace([mA, a1, b0, mB]);
    mesh.addFace([mB, b1, a0, mA]);
    newEdgeKeys.push(EditableMesh.edgeKey(mA, mB));
  }
  mesh.deleteFaces(facesToDelete);

  return { newVertIds: [...midByEdge.values()], newEdgeKeys: [...new Set(newEdgeKeys)] };
}

/** Preview polyline (pairs of segment endpoints) for the would-be cut. */
export function loopPreviewSegments(mesh: EditableMesh, loop: EdgeLoop, t = 0.5): Float32Array {
  const edges = mesh.edges();
  const mids: Vec3[] = [];
  for (const key of loop.edgeKeys) {
    const e = edges.get(key);
    if (!e) continue;
    mids.push(mesh.verts.get(e.v0)!.co.lerp(mesh.verts.get(e.v1)!.co, t));
  }
  const segCount = loop.closed ? mids.length : mids.length - 1;
  const out = new Float32Array(Math.max(0, segCount) * 6);
  for (let i = 0; i < segCount; i++) {
    const a = mids[i], b = mids[(i + 1) % mids.length];
    out.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
  }
  return out;
}
