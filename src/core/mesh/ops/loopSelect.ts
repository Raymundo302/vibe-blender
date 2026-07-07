import { EditableMesh } from '../EditableMesh';

/**
 * Loop-selection walks (Alt+click in edit mode). All pure — given a mesh and a
 * starting element they return the set of elements forming the loop, with unit
 * tests on grid and torus meshes. No selection state or rendering here; the
 * InputManager feeds the picked element in and applies the result.
 *
 * Edge loop (Blender semantics): from a starting edge, walk through each shared
 * vertex to the edge "across" it — the incident edge that shares NO face with
 * the incoming edge. This only has a unique answer at a regular 4-valence
 * vertex; at boundaries or poles (valence ≠ 4) the walk stops. Walking both ways
 * and stopping when the loop closes gives the full ring.
 */

interface Adjacency {
  /** edgeKey → the two face ids that use it (1 = boundary, 2 = manifold). */
  edgeFaces: Map<string, number[]>;
  /** vert id → the edge keys incident to it. */
  vertEdges: Map<number, string[]>;
}

function buildAdjacency(mesh: EditableMesh): Adjacency {
  const edges = mesh.edges();
  const edgeFaces = new Map<string, number[]>();
  const vertEdges = new Map<number, string[]>();
  for (const e of edges.values()) {
    edgeFaces.set(e.key, [...e.faces]);
    for (const v of [e.v0, e.v1]) {
      const list = vertEdges.get(v) ?? [];
      list.push(e.key);
      vertEdges.set(v, list);
    }
  }
  return { edgeFaces, vertEdges };
}

/**
 * The next edge in the loop when arriving at `pivot` along `edgeKey`, or null to
 * stop (pole/boundary/ambiguous). "Across" = the incident edge at the 4-valence
 * pivot that shares no face with the incoming edge.
 */
function acrossEdge(adj: Adjacency, edgeKey: string, pivot: number): string | null {
  const incident = adj.vertEdges.get(pivot);
  if (!incident || incident.length !== 4) return null; // boundary/pole → stop
  const incomingFaces = new Set(adj.edgeFaces.get(edgeKey) ?? []);
  const across = incident.filter(
    (k) => k !== edgeKey && !(adj.edgeFaces.get(k) ?? []).some((f) => incomingFaces.has(f)),
  );
  return across.length === 1 ? across[0] : null;
}

/** The vertex at the other end of `edgeKey` from `vert`. */
function otherEnd(mesh: EditableMesh, edgeKey: string, vert: number): number {
  const e = mesh.edges().get(edgeKey)!;
  return e.v0 === vert ? e.v1 : e.v0;
}

/**
 * The full edge loop containing `startKey` (inclusive). Walks both directions
 * from the start edge, stopping at boundaries/poles or when the loop closes.
 */
export function edgeLoop(mesh: EditableMesh, startKey: string): Set<string> {
  const loop = new Set<string>();
  const start = mesh.edges().get(startKey);
  if (!start) return loop;
  loop.add(startKey);
  const adj = buildAdjacency(mesh);

  for (const startPivot of [start.v1, start.v0]) {
    let cur = startKey;
    let pivot = startPivot;
    // Guard against pathological non-manifold cycles with an iteration cap.
    for (let guard = 0; guard < mesh.edges().size + 1; guard++) {
      const next = acrossEdge(adj, cur, pivot);
      if (next === null || loop.has(next)) break;
      loop.add(next);
      pivot = otherEnd(mesh, next, pivot);
      cur = next;
    }
  }
  return loop;
}

/** The verts touched by the edge loop through `startKey` (vertex-mode loop). */
export function vertLoop(mesh: EditableMesh, startKey: string): Set<number> {
  const verts = new Set<number>();
  const edges = mesh.edges();
  for (const key of edgeLoop(mesh, startKey)) {
    const e = edges.get(key);
    if (e) { verts.add(e.v0); verts.add(e.v1); }
  }
  return verts;
}

/** Directed edges of a face, in winding order: [[a,b], ...]. */
function faceDirectedEdges(mesh: EditableMesh, faceId: number): [number, number][] {
  const vs = mesh.faces.get(faceId)!.verts;
  return vs.map((v, i) => [v, vs[(i + 1) % vs.length]] as [number, number]);
}

/** The edge of `faceId` "opposite" to `edgeKey` (index + 2 on a quad), or null. */
function oppositeEdgeInFace(mesh: EditableMesh, faceId: number, edgeKey: string): string | null {
  const f = mesh.faces.get(faceId);
  if (!f || f.verts.length !== 4) return null; // face loops only cross quads
  const keys = faceDirectedEdges(mesh, faceId).map(([a, b]) => EditableMesh.edgeKey(a, b));
  const i = keys.indexOf(edgeKey);
  return i < 0 ? null : keys[(i + 2) % 4];
}

/**
 * The quad face loop containing `startFace`, entered through `entryEdge` (an
 * edge of `startFace`). Walks both directions, crossing each quad to the face
 * sharing the opposite edge; stops at non-quads, boundaries, or on closing.
 * Enter-edge choice is the InputManager's job (picked face + nearest edge).
 */
export function faceLoop(mesh: EditableMesh, startFace: number, entryEdge: string): Set<number> {
  const loop = new Set<number>();
  const start = mesh.faces.get(startFace);
  if (!start) return loop;
  loop.add(startFace);
  if (start.verts.length !== 4) return loop; // single non-quad: just itself
  const adj = buildAdjacency(mesh);

  const opp = oppositeEdgeInFace(mesh, startFace, entryEdge);
  // The two seed edges to leave the start quad through: the entry edge and its
  // opposite — one for each direction along the loop.
  const seeds = opp ? [entryEdge, opp] : [entryEdge];

  for (const seed of seeds) {
    let face = startFace;
    let through = seed;
    for (let guard = 0; guard < mesh.faces.size + 1; guard++) {
      const faces = adj.edgeFaces.get(through) ?? [];
      const next = faces.find((f) => f !== face);
      if (next === undefined || loop.has(next)) break;
      if (mesh.faces.get(next)!.verts.length !== 4) break;
      loop.add(next);
      const nextOpp = oppositeEdgeInFace(mesh, next, through);
      if (nextOpp === null) break;
      face = next;
      through = nextOpp;
    }
  }
  return loop;
}
