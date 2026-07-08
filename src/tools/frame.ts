import { Vec3 } from '../core/math/vec3';
import type { OperatorContext } from '../core/operator/Operator';

/**
 * Frame selection (Blender's Numpad-. / View → Frame Selected), bound to the
 * period key. Not a modal operator — a one-shot camera move: point the orbit
 * target at the selection's bounding-box center and pull `distance` back so the
 * selection's bounding sphere fits the vertical field of view.
 *
 * Sources, in priority order:
 *  - edit mode: the selected elements' verts; else the whole edited object;
 *  - object mode: the selected objects; else the active object;
 *  - nothing at all: the scene origin.
 *
 * Only `target` and `distance` change — the yaw/pitch orbit angles are kept, so
 * framing feels like a dolly, not a jump-cut.
 */
export function frameSelection(ctx: OperatorContext): void {
  const { scene, camera } = ctx;
  const pts = gatherWorldPoints(scene);

  if (pts.length === 0) {
    camera.target = Vec3.ZERO;
    camera.distance = Math.max(camera.distance, 1);
    return;
  }

  // Bounding box → center; bounding sphere radius = farthest point from center.
  let min = pts[0], max = pts[0];
  for (const p of pts) {
    min = new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max = new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
  }
  const center = min.add(max).scale(0.5);
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, p.distanceTo(center));

  camera.target = center;
  camera.distance = Math.max((radius / Math.tan(camera.fovY / 2)) * 1.1, 1);
}

/** World-space points of whatever the frame should fit (see priority list above). */
function gatherWorldPoints(scene: OperatorContext['scene']): Vec3[] {
  const out: Vec3[] = [];

  if (scene.editMode && scene.editObject) {
    const obj = scene.editObject;
    const m = scene.worldMatrix(obj);
    const sel = scene.editMode.selectedVertIds(obj.mesh);
    const ids = sel.size > 0 ? [...sel] : [...obj.mesh.verts.keys()];
    for (const id of ids) {
      const v = obj.mesh.verts.get(id);
      if (v) out.push(m.transformPoint(v.co));
    }
    return out;
  }

  const objs = scene.selectedObjects.length > 0
    ? scene.selectedObjects
    : scene.activeObject ? [scene.activeObject] : [];
  for (const obj of objs) {
    const m = scene.worldMatrix(obj);
    for (const v of obj.evaluatedMesh().verts.values()) out.push(m.transformPoint(v.co)); // ctx-less: framing tolerates a stale/no-op scatter
  }
  return out;
}
