import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import { evalFCurve } from './fcurve';
import { writeChannel } from './channels';
import type { Scene, SceneObject } from '../scene/Scene';

/**
 * Scene-time application (F15-1). applyAnimation(scene, frame) writes every
 * animated object's channels for that frame — called on scrub, playback tick
 * and load. LOCAL transforms are what animate; parenting (F12-2) then
 * composes world matrices as usual, so a keyed child riding an animated
 * parent Just Works.
 *
 * Transform channels are batched: current transform values seed a 9-float
 * (pos/euler/scale) record, sampled curves override their channel, and ONE
 * new Transform is written — avoiding 9 intermediate Transform allocations
 * and euler↔quat round-trip drift from per-channel writes.
 */
export function applyAnimation(scene: Scene, frame: number): void {
  for (const obj of scene.objects) {
    if (!obj.anim || obj.anim.fcurves.length === 0) continue;
    applyObject(scene, obj, frame);
  }
}

const TRANSFORM_HEADS = new Set(['location', 'rotation', 'scale']);

function applyObject(scene: Scene, obj: SceneObject, frame: number): void {
  let hasTransform = false;
  const t = obj.transform;
  const e = t.rotation.toEulerXYZ();
  const acc = {
    location: { x: t.position.x, y: t.position.y, z: t.position.z },
    rotation: { x: e.x, y: e.y, z: e.z },
    scale: { x: t.scale.x, y: t.scale.y, z: t.scale.z },
  };
  for (const curve of obj.anim!.fcurves) {
    if (curve.keys.length === 0) continue;
    const [head, sub] = curve.channelPath.split('.');
    const v = evalFCurve(curve, frame);
    if (TRANSFORM_HEADS.has(head) && (sub === 'x' || sub === 'y' || sub === 'z')) {
      acc[head as 'location' | 'rotation' | 'scale'][sub] = v;
      hasTransform = true;
    } else {
      writeChannel(scene, obj, curve.channelPath, v);
    }
  }
  if (hasTransform) {
    obj.transform = t
      .withPosition(new Vec3(acc.location.x, acc.location.y, acc.location.z))
      .withRotation(Quat.fromEulerXYZ(acc.rotation.x, acc.rotation.y, acc.rotation.z))
      .withScale(new Vec3(acc.scale.x, acc.scale.y, acc.scale.z));
  }
}
