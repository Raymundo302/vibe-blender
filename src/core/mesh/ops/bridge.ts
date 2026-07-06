import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Bridge Edge Loops (Blender's Ctrl+E → Bridge): connect two separate,
 * equal-length edge loops with a ring of quads. This closes tubes and joins
 * cylinders — the two loops become the ends of a bridging strip.
 *
 * The op is pure geometry over the mesh's public API; the call site wraps it in
 * MeshEditCommand.capture('Bridge Edge Loops', …) for undo.
 */

/** One connected chain of selected edges, resolved to an ordered vert path. */
interface Chain {
  /** Ordered vert ids. Open: end-to-end (V verts, V-1 edges). Closed: cyclic
   *  (V verts, V edges — the wrap edge V-1→0 is implicit, not repeated). */
  path: number[];
  closed: boolean;
}

/** Parse a canonical edge key `"a,b"` (a<b) into its two vert ids. */
function keyVerts(key: string): [number, number] {
  const [a, b] = key.split(',').map(Number);
  return [a, b];
}

/**
 * Group selected edges into connected chains (edges sharing a vert), then order
 * each into a vert path. Returns chains, or an error string if any component is
 * not a simple path/cycle (a vert used by 3+ selected edges is branching).
 */
function chainsFromEdges(edgeKeys: Set<string>): Chain[] | { error: string } {
  const keys = [...edgeKeys];
  if (keys.length === 0) return { error: 'No edges selected' };

  // Adjacency: vert → incident selected-edge keys, and edge → its two verts.
  const adj = new Map<number, string[]>();
  const edgeVerts = new Map<string, [number, number]>();
  for (const key of keys) {
    const [a, b] = keyVerts(key);
    edgeVerts.set(key, [a, b]);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(key);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(key);
  }

  // Connected components over edges (two edges adjacent if they share a vert).
  const seen = new Set<string>();
  const chains: Chain[] = [];
  for (const startKey of keys) {
    if (seen.has(startKey)) continue;
    const comp: string[] = [];
    const stack = [startKey];
    seen.add(startKey);
    while (stack.length) {
      const key = stack.pop()!;
      comp.push(key);
      const [a, b] = edgeVerts.get(key)!;
      for (const v of [a, b]) {
        for (const nk of adj.get(v)!) {
          if (!seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
    }

    // Degrees within this component decide path vs cycle vs invalid.
    const compVerts = new Set<number>();
    const deg = new Map<number, number>();
    for (const key of comp) {
      const [a, b] = edgeVerts.get(key)!;
      compVerts.add(a); compVerts.add(b);
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    const endpoints: number[] = [];
    for (const v of compVerts) {
      const d = deg.get(v)!;
      if (d > 2) return { error: 'Selected edges branch (not a simple loop)' };
      if (d === 1) endpoints.push(v);
    }
    const closed = endpoints.length === 0;
    if (!closed && endpoints.length !== 2) {
      return { error: 'Selected edges do not form a single chain' };
    }

    // Walk the chain into an ordered vert path (deterministic: min start, min
    // edge at the first branch of a closed loop).
    const compSet = new Set(comp);
    const start = closed
      ? Math.min(...compVerts)
      : Math.min(...endpoints);
    const path = [start];
    let prevEdge: string | null = null;
    let current = start;
    for (;;) {
      const options = adj.get(current)!.filter((k) => compSet.has(k) && k !== prevEdge);
      if (options.length === 0) break; // open end reached
      const e = options.sort()[0];
      const [a, b] = edgeVerts.get(e)!;
      const next = a === current ? b : a;
      prevEdge = e;
      if (next === start) break; // closed loop completed
      path.push(next);
      current = next;
    }
    chains.push({ path, closed });
  }
  return chains;
}

/** Newell normal of a polygon given its vertex coordinates in order. */
function newellNormal(coords: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const a = coords[i], b = coords[(i + 1) % n];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return new Vec3(nx, ny, nz).normalize();
}

/** Total nearest-index vert distance for pairing loop A with a candidate B order. */
function pairingCost(mesh: EditableMesh, a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += mesh.verts.get(a[i])!.co.distanceTo(mesh.verts.get(b[i])!.co);
  }
  return sum;
}

/**
 * Choose the ordering of loop B (path `b`) that lines up best with loop A
 * (path `a`), minimising total vert-to-vert distance so the bridge doesn't
 * twist. Open loops: B forward vs reversed. Closed loops: every rotation of B
 * in both directions (≤ 2n candidates).
 */
function bestPairing(mesh: EditableMesh, a: number[], b: number[], closed: boolean): number[] {
  const candidates: number[][] = [];
  if (!closed) {
    candidates.push(b, [...b].reverse());
  } else {
    const n = b.length;
    const rev = [...b].reverse();
    for (let k = 0; k < n; k++) {
      candidates.push(b.map((_, i) => b[(i + k) % n]));
      candidates.push(rev.map((_, i) => rev[(i + k) % n]));
    }
  }
  let best = candidates[0];
  let bestCost = Infinity;
  for (const cand of candidates) {
    const cost = pairingCost(mesh, a, cand);
    if (cost < bestCost) { bestCost = cost; best = cand; }
  }
  return best;
}

/**
 * Bridge two selected edge loops with a ring of quads.
 *
 * Requires exactly two chains of equal edge count, both open or both closed.
 * Returns the new face ids, or an `{ error }` (shown in the status bar) with the
 * mesh left untouched.
 */
export function bridgeLoops(
  mesh: EditableMesh,
  edgeKeys: Set<string>,
): { newFaceIds: number[] } | { error: string } {
  const result = chainsFromEdges(edgeKeys);
  if ('error' in result) return result;
  const chains = result;

  if (chains.length !== 2) {
    return { error: `Bridge needs exactly 2 edge loops (got ${chains.length})` };
  }
  const [ca, cb] = chains;
  if (ca.closed !== cb.closed) {
    return { error: 'Both loops must be open or both closed' };
  }
  // Edge count per chain: open path has V-1 edges, closed loop has V.
  const edgesA = ca.closed ? ca.path.length : ca.path.length - 1;
  const edgesB = cb.closed ? cb.path.length : cb.path.length - 1;
  if (edgesA !== edgesB) {
    return { error: `Loops have mismatched edge counts (${edgesA} vs ${edgesB})` };
  }

  const a = ca.path;
  const b = bestPairing(mesh, a, cb.path, ca.closed);
  const n = a.length;
  const quadCount = ca.closed ? n : n - 1;

  // Build the quad vert-lists first so the winding heuristic can inspect them.
  const quads: number[][] = [];
  for (let i = 0; i < quadCount; i++) {
    const j = (i + 1) % n;
    quads.push([a[i], a[j], b[j], b[i]]);
  }

  // Winding heuristic: for a tube-like bridge the quads should face outward, so
  // each quad's normal should point away from the bridge centroid. If on
  // average it points inward, rebuild every quad reversed. (Interior bridges may
  // still need a manual flip — documented limitation.)
  const co = (id: number) => mesh.verts.get(id)!.co;
  let centroid = new Vec3();
  const allVerts = [...new Set([...a, ...b])];
  for (const v of allVerts) centroid = centroid.add(co(v));
  centroid = centroid.scale(1 / allVerts.length);

  let dotSum = 0;
  for (const q of quads) {
    const coords = q.map(co);
    const normal = newellNormal(coords);
    let qc = new Vec3();
    for (const c of coords) qc = qc.add(c);
    qc = qc.scale(1 / coords.length);
    dotSum += normal.dot(qc.sub(centroid));
  }

  const newFaceIds: number[] = [];
  for (const q of quads) {
    const verts = dotSum < 0 ? [...q].reverse() : q;
    newFaceIds.push(mesh.addFace(verts));
  }
  return { newFaceIds };
}
