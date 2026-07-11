import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import type { Scene, SceneObject } from '../scene/Scene';

/**
 * Channel-path resolution (F15-1). A channelPath addresses one float on an
 * object: transform channels ("location.x", "rotation.y" — euler XYZ
 * radians —, "scale.z") plus payload channels ("light.power",
 * "light.color.r", "camera.focalLength", and material channels via P15-4).
 *
 * Transform reads/writes bridge the immutable Transform + quaternion
 * rotation: rotation channels convert through toEulerXYZ/fromEulerXYZ. The
 * SAMPLER never uses per-channel set() for transforms (it batches all nine
 * into one Transform rebuild — see sampler.ts); set() exists for I-key
 * capture symmetry and payload channels.
 */

const AXES = ['x', 'y', 'z'] as const;
const RGB: Record<string, number> = { r: 0, g: 1, b: 2 };

export function readChannel(scene: Scene, obj: SceneObject, path: string): number | null {
  const [head, sub, subsub] = path.split('.');
  if (head === 'location' || head === 'scale' || head === 'rotation') {
    const axis = sub as (typeof AXES)[number];
    if (!AXES.includes(axis)) return null;
    if (head === 'location') return obj.transform.position[axis];
    if (head === 'scale') return obj.transform.scale[axis];
    return obj.transform.rotation.toEulerXYZ()[axis];
  }
  if (head === 'light' && obj.light) {
    if (sub === 'power') return obj.light.power;
    if (sub === 'color' && subsub !== undefined && subsub in RGB) return obj.light.color[RGB[subsub]];
    if (sub === 'spotAngle') return obj.light.spotAngle;
    return null;
  }
  if (head === 'camera' && obj.camera) {
    if (sub === 'focalLength') return obj.camera.focalLength;
    return null;
  }
  if (head === 'material') {
    const mat = scene.materialOf(obj);
    if (mat.id === -1) return null; // DEFAULT_MATERIAL is frozen/shared
    if (sub === 'baseColor' && subsub !== undefined && subsub in RGB) return mat.baseColor[RGB[subsub]];
    if (sub === 'roughness') return mat.roughness;
    if (sub === 'metallic') return mat.metallic;
    if (sub === 'emissiveStrength') return mat.emissiveStrength;
    return null;
  }
  // HTML plane keyable Play state (UR7-1): boolean mapped to 0/1.
  if (head === 'html' && obj.html) {
    if (sub === 'playing') return obj.html.playing ? 1 : 0;
    return null;
  }
  // Text extrude depth (UR8-2): the keyable `text.thickness` channel. The mesh
  // is regenerated from the payload by the text driver after the sampler writes.
  if (head === 'text' && obj.text) {
    if (sub === 'thickness') return obj.text.thickness;
    return null;
  }
  return null;
}

export function writeChannel(scene: Scene, obj: SceneObject, path: string, value: number): boolean {
  const [head, sub, subsub] = path.split('.');
  if (head === 'location' || head === 'scale' || head === 'rotation') {
    const axis = sub as (typeof AXES)[number];
    if (!AXES.includes(axis)) return false;
    const t = obj.transform;
    if (head === 'location') {
      obj.transform = t.withPosition(withAxis(t.position, axis, value));
    } else if (head === 'scale') {
      obj.transform = t.withScale(withAxis(t.scale, axis, value));
    } else {
      const e = t.rotation.toEulerXYZ();
      e[axis] = value;
      obj.transform = t.withRotation(Quat.fromEulerXYZ(e.x, e.y, e.z));
    }
    return true;
  }
  if (head === 'light' && obj.light) {
    if (sub === 'power') { obj.light.power = value; return true; }
    if (sub === 'color' && subsub !== undefined && subsub in RGB) { obj.light.color[RGB[subsub]] = value; return true; }
    if (sub === 'spotAngle') { obj.light.spotAngle = value; return true; }
    return false;
  }
  if (head === 'camera' && obj.camera) {
    if (sub === 'focalLength') { obj.camera.focalLength = value; return true; }
    return false;
  }
  if (head === 'material') {
    const mat = scene.materialOf(obj);
    if (mat.id === -1) return false;
    if (sub === 'baseColor' && subsub !== undefined && subsub in RGB) { mat.baseColor[RGB[subsub]] = value; return true; }
    if (sub === 'roughness') { mat.roughness = value; return true; }
    if (sub === 'metallic') { mat.metallic = value; return true; }
    if (sub === 'emissiveStrength') { mat.emissiveStrength = value; return true; }
    return false;
  }
  // HTML plane keyable Play state (UR7-1): a keyed 0/1 (constant interp) toggles
  // the boolean. >0.5 = playing so any positive keyed value reads as "on".
  if (head === 'html' && obj.html) {
    if (sub === 'playing') { obj.html.playing = value > 0.5; return true; }
    return false;
  }
  // Text extrude depth (UR8-2): sets obj.text.thickness; the text driver picks
  // up the payload change and regenerates the mesh on the next tick.
  if (head === 'text' && obj.text) {
    if (sub === 'thickness') { obj.text.thickness = Math.max(0, value); return true; }
    return false;
  }
  return false;
}

function withAxis(v: Vec3, axis: 'x' | 'y' | 'z', value: number): Vec3 {
  return new Vec3(axis === 'x' ? value : v.x, axis === 'y' ? value : v.y, axis === 'z' ? value : v.z);
}
