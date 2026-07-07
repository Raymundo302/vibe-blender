import { EditableMesh } from '../EditableMesh';

/**
 * Blender's "Merge by Distance" (a.k.a. Remove Doubles) restricted to a set of
 * verts. Greedily clusters the given verts so that every vert within
 * `threshold` of a cluster's seed joins that cluster, then collapses each
 * cluster of ≥ 2 verts through {@link EditableMesh.mergeVertsAtCenter} — the
 * lowest id survives at the cluster centroid, faces remap, degenerate faces
 * drop. Verts farther than `threshold` from every seed survive untouched.
 *
 * Seeds are visited in ascending id order, so the survivor of each cluster is
 * its lowest id and the whole operation is deterministic. Returns the number of
 * verts removed (Blender reports this as "Removed N vertices").
 *
 * O(n²) over the given verts — fine at demo scale.
 */
export function mergeByDistance(
  mesh: EditableMesh,
  vertIds: Iterable<number>,
  threshold = 0.0001,
): number {
  const ids = [...new Set(vertIds)]
    .filter((id) => mesh.verts.has(id))
    .sort((a, b) => a - b);
  if (ids.length < 2) return 0;

  const assigned = new Set<number>();
  let removed = 0;
  for (let i = 0; i < ids.length; i++) {
    const seed = ids[i];
    if (assigned.has(seed)) continue;
    const seedCo = mesh.verts.get(seed)!.co;
    const cluster = [seed];
    for (let j = i + 1; j < ids.length; j++) {
      const other = ids[j];
      if (assigned.has(other)) continue;
      if (seedCo.distanceTo(mesh.verts.get(other)!.co) <= threshold) {
        cluster.push(other);
        assigned.add(other);
      }
    }
    if (cluster.length >= 2) {
      mesh.mergeVertsAtCenter(cluster);
      removed += cluster.length - 1;
    }
  }
  return removed;
}
