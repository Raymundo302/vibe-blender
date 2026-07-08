import { Vec3 } from '../core/math/vec3';
import type { Quat } from '../core/math/quat';
import type { Mat4 } from '../core/math/mat4';
import { Transform } from '../core/math/transform';
import type { Scene, SceneObject } from '../core/scene/Scene';

/**
 * Parent-aware transform targets (P12). The G/R/S operators think entirely in
 * WORLD space — pivots, deltas, snapping — and these helpers re-express the
 * results in each object's parent space on write. For root objects (the common
 * case) every conversion is a no-op fast path, preserving pre-P12 behavior
 * exactly.
 */
export interface WorldTarget {
  object: SceneObject;
  /** Local transform at operator start (undo "before" / cancel restore). */
  before: Transform;
  /** World-space pose at operator start (== before for roots). */
  beforeWorld: Transform;
  /** Inverse parent world matrix, or null for roots. */
  parentInv: Mat4 | null;
  /** Inverse parent world ROTATION, or null for roots. */
  parentRotInv: Quat | null;
}

export function captureWorldTargets(scene: Scene, objects: SceneObject[]): WorldTarget[] {
  return objects.map((object) => {
    if (object.parentId === null || !scene.parentOf(object)) {
      return { object, before: object.transform, beforeWorld: object.transform, parentInv: null, parentRotInv: null };
    }
    const parentWorld = scene.parentWorldMatrix(object);
    return {
      object,
      before: object.transform,
      beforeWorld: Transform.fromMat4(scene.worldMatrix(object)),
      parentInv: parentWorld.invert(),
      parentRotInv: Transform.fromMat4(parentWorld).rotation.conjugate(),
    };
  });
}

/**
 * The world-space pivot the operator turns/scales around: the 3D cursor when
 * the header pivot dropdown says so, else the selection's world median.
 */
export function transformPivot(scene: Scene, targets: WorldTarget[]): Vec3 {
  if (scene.pivotMode === 'cursor') return scene.cursor;
  let sum = Vec3.ZERO;
  for (const t of targets) sum = sum.add(t.beforeWorld.position);
  return targets.length ? sum.scale(1 / targets.length) : Vec3.ZERO;
}

/** Write a world-space position, keeping the object's current local rot/scale. */
export function writeWorldPosition(t: WorldTarget, worldPos: Vec3): void {
  const local = t.parentInv ? t.parentInv.transformPoint(worldPos) : worldPos;
  t.object.transform = t.before.withPosition(local);
}

/** Write a world-space position + rotation (scale keeps its `before` value). */
export function writeWorldPosRot(t: WorldTarget, worldPos: Vec3, worldRot: Quat): void {
  const pos = t.parentInv ? t.parentInv.transformPoint(worldPos) : worldPos;
  const rot = t.parentRotInv ? t.parentRotInv.mul(worldRot) : worldRot;
  t.object.transform = t.before.withPosition(pos).withRotation(rot);
}

/**
 * Write a world-space position + per-axis scale factors applied to the local
 * scale. (Scaling a parented object along world axes that aren't parent-aligned
 * is approximated by scaling in local axes — Blender shows the same drift.)
 */
export function writeWorldPosScale(t: WorldTarget, worldPos: Vec3, sx: number, sy: number, sz: number): void {
  const pos = t.parentInv ? t.parentInv.transformPoint(worldPos) : worldPos;
  const s = t.before.scale;
  t.object.transform = t.before.withPosition(pos).withScale(new Vec3(s.x * sx, s.y * sy, s.z * sz));
}
