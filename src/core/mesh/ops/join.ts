import { EditableMesh } from '../EditableMesh';
import type { Mat4 } from '../../math/mat4';

/**
 * Append `source`'s geometry into `target`, baking every source vert through
 * `matrix` (a 4x4 model transform, points transformed with a w=1 divide).
 *
 * Blender's Join (Ctrl+J) semantics: the caller passes
 * `inv(activeModel) * sourceModel` so the source lands in the active object's
 * LOCAL space. Fresh vert/face ids are minted in `target`, so the appended
 * shell can never collide with existing ids and each shell stays independent
 * (its interior edges remain manifold on their own).
 *
 * Pure w.r.t. `source` (never mutated); mutates `target` in place. Deterministic:
 * source verts/faces are walked in ascending id order, so the appended ids and
 * insertion order depend only on the inputs.
 *
 * Returns the old-vert-id → new-vert-id map (handy for tests / callers).
 */
export function appendBaked(
  target: EditableMesh,
  source: EditableMesh,
  matrix: Mat4,
): Map<number, number> {
  const vertIdMap = new Map<number, number>();

  const verts = [...source.verts.values()].sort((a, b) => a.id - b.id);
  for (const v of verts) {
    vertIdMap.set(v.id, target.addVert(matrix.transformPoint(v.co)));
  }

  const faces = [...source.faces.values()].sort((a, b) => a.id - b.id);
  for (const f of faces) {
    target.addFace(f.verts.map((old) => vertIdMap.get(old)!));
  }

  return vertIdMap;
}
