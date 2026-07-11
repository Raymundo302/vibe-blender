import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { embedIntersections, type IntersectItem } from '../core/mesh/ops/embedIntersections';
import { EmbedIntersectionsCommand } from '../core/undo/intersectCommand';

/**
 * Intersect tool (object mode): with 2+ mesh objects selected, make the places
 * where their geometry passes through each other into REAL topology on every
 * selected mesh, in ONE undo step. The objects stay separate (not a boolean
 * union). Pure orchestration — all geometry lives in
 * `core/mesh/ops/embedIntersections.ts`.
 *
 * UX rules (mirroring how join guards non-mesh objects):
 *  - Object mode only; needs ≥2 selected objects whose `kind` is mesh. Otherwise
 *    `Intersect: select 2+ mesh objects`, nothing pushed.
 *  - Zero crossings found → `Intersect: no intersections`, nothing pushed, no
 *    mesh mutated (versions unchanged).
 *  - Success → status `Intersect: N verts, M face splits across K objects`; the
 *    edited meshes' versions are bumped by the op so the GPU re-uploads.
 *
 * UR3-1 imports `runIntersectTool` and wires the toolbar button + status; this
 * module does NOT touch main.ts/toolbar and wires no keyboard shortcut.
 */
export function runIntersectTool(
  scene: Scene,
  undo: UndoStack,
  setStatus: (s: string) => void,
): void {
  // Object mode only; ≥2 selected MESH objects (lights/cameras have no geometry).
  if (scene.editMode) {
    setStatus('Intersect: select 2+ mesh objects');
    return;
  }
  const meshObjs = scene.selectedObjects.filter((o) => o.kind === 'mesh');
  if (meshObjs.length < 2) {
    setStatus('Intersect: select 2+ mesh objects');
    return;
  }

  const items: IntersectItem[] = meshObjs.map((o) => ({
    mesh: o.mesh,
    world: scene.worldMatrix(o),
  }));

  // Snapshot every touched mesh BEFORE mutating (whole-mesh clones, A4).
  const before = items.map((it) => it.mesh.clone());
  const results = embedIntersections(items);
  const totalVerts = results.reduce((s, r) => s + r.verts, 0);
  const totalSplits = results.reduce((s, r) => s + r.splits, 0);

  // No crossings → the op mutated nothing (no addVert), versions untouched.
  if (totalVerts === 0) {
    setStatus('Intersect: no intersections');
    return;
  }

  const after = items.map((it) => it.mesh.clone());
  undo.push(new EmbedIntersectionsCommand(items.map((it) => it.mesh), before, after));
  setStatus(
    `Intersect: ${totalVerts} verts, ${totalSplits} face splits across ${meshObjs.length} objects`,
  );
}

// e2e handle (like `window.__timeline` / `window.__graph`): once this module is
// imported the test can drive the tool directly with the app's scene/undo,
// before UR3-1 wires the toolbar button. Guarded so unit tests (node) skip it.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__intersectTool = runIntersectTool;
}
