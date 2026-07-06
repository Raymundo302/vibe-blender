import { Vec3 } from '../core/math/vec3';
import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { cameraFovY, objectForward, DEFAULT_MATERIAL } from '../core/scene/objectData';

/**
 * Plain-data scene snapshot for the path tracer (P8-4). Everything here is
 * structured-cloneable (typed arrays + plain objects) so it can cross the
 * Worker boundary. No GL, no DOM, no class instances with methods.
 *
 * The tracer (tracer.ts) and the Worker (worker.ts) consume ONLY these types —
 * they never import Scene / EditableMesh, which keeps them Node-testable.
 */

export interface SnapMaterial {
  /** Linear RGB albedo 0..1. */
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  /** Linear RGB emission (pre-strength). */
  emissive: [number, number, number];
  emissiveStrength: number;
}

/** 0 = point, 1 = sun, 2 = spot (matches renderedPass type codes). */
export interface SnapLight {
  type: 0 | 1 | 2;
  position: [number, number, number];
  /** Aim direction (local -Z rotated), for sun/spot. */
  direction: [number, number, number];
  /**
   * color × power, premultiplied per type exactly like collectLights():
   * point/spot → color·power/(4π) (radiance = energy/d²), sun → color·power.
   */
  energy: [number, number, number];
  /** Spot cone: cos(inner), cos(outer). */
  cosInner: number;
  cosOuter: number;
}

export interface SnapCamera {
  position: [number, number, number];
  /** Orthonormal camera basis (world space). */
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view, radians. */
  fovY: number;
}

export interface Snapshot {
  /** World-space triangle vertices, 9 floats per triangle (ax,ay,az, bx…). */
  tris: Float32Array;
  /** Material index (into `materials`) per triangle. 0 = the default material. */
  triMat: Int32Array;
  /** Material library; index 0 is always the default grey material. */
  materials: SnapMaterial[];
  lights: SnapLight[];
  camera: SnapCamera;
}

function toMat(m: {
  baseColor: readonly [number, number, number];
  metallic: number;
  roughness: number;
  emissive: readonly [number, number, number];
  emissiveStrength: number;
}): SnapMaterial {
  return {
    baseColor: [m.baseColor[0], m.baseColor[1], m.baseColor[2]],
    metallic: m.metallic,
    roughness: m.roughness,
    emissive: [m.emissive[0], m.emissive[1], m.emissive[2]],
    emissiveStrength: m.emissiveStrength,
  };
}

/**
 * Flatten the scene into a tracer snapshot. Mesh objects are triangulated
 * (fan) and baked to world space via their transform; non-mesh / hidden
 * objects are skipped for geometry. Lights reuse the collectLights() energy
 * scaling. The camera is the scene's active camera if any, else the viewport
 * OrbitCamera view.
 */
export function buildSnapshot(scene: Scene, orbit: OrbitCamera): Snapshot {
  // --- materials: index 0 = default, then scene library ---
  const materials: SnapMaterial[] = [toMat(DEFAULT_MATERIAL)];
  const matIndex = new Map<number, number>();
  for (const m of scene.materials) {
    matIndex.set(m.id, materials.length);
    materials.push(toMat(m));
  }

  // --- geometry ---
  const triPos: number[] = [];
  const triMatArr: number[] = [];
  for (const obj of scene.objects) {
    if (obj.kind !== 'mesh' || !obj.visible) continue;
    const mesh = obj.evaluatedMesh();
    if (mesh.faces.size === 0) continue;
    const model = obj.transform.matrix();
    const mi =
      obj.materialId !== null && matIndex.has(obj.materialId)
        ? matIndex.get(obj.materialId)!
        : 0;
    // Precompute world-space vert positions once.
    const world = new Map<number, Vec3>();
    for (const v of mesh.verts.values()) world.set(v.id, model.transformPoint(v.co));
    for (const face of mesh.faces.values()) {
      const vs = face.verts;
      const a = world.get(vs[0]);
      if (!a) continue;
      for (let i = 1; i + 1 < vs.length; i++) {
        const b = world.get(vs[i]);
        const c = world.get(vs[i + 1]);
        if (!b || !c) continue;
        triPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        triMatArr.push(mi);
      }
    }
  }

  // --- lights (same premultiply as collectLights) ---
  const lights: SnapLight[] = [];
  for (const obj of scene.objects) {
    if (obj.kind !== 'light' || !obj.visible || !obj.light) continue;
    const l = obj.light;
    const p = obj.transform.position;
    const d = objectForward(obj.transform);
    const scale = l.type === 'sun' ? 1 : 1 / (4 * Math.PI);
    const outer = l.spotAngle / 2;
    const inner = outer * (1 - l.spotBlend);
    lights.push({
      type: l.type === 'point' ? 0 : l.type === 'sun' ? 1 : 2,
      position: [p.x, p.y, p.z],
      direction: [d.x, d.y, d.z],
      energy: [l.color[0] * l.power * scale, l.color[1] * l.power * scale, l.color[2] * l.power * scale],
      cosInner: Math.cos(inner),
      cosOuter: Math.cos(outer),
    });
  }

  return {
    tris: new Float32Array(triPos),
    triMat: Int32Array.from(triMatArr),
    materials,
    lights,
    camera: buildCamera(scene, orbit),
  };
}

function buildCamera(scene: Scene, orbit: OrbitCamera): SnapCamera {
  const active = scene.activeCamera;
  if (active && active.camera) {
    const t = active.transform;
    const fwd = objectForward(t); // local -Z
    const up = t.rotation.rotate(Vec3.Y);
    const right = t.rotation.rotate(Vec3.X);
    const p = t.position;
    return {
      position: [p.x, p.y, p.z],
      forward: [fwd.x, fwd.y, fwd.z],
      right: [right.x, right.y, right.z],
      up: [up.x, up.y, up.z],
      fovY: cameraFovY(active.camera),
    };
  }
  // Viewport OrbitCamera: derive an orthonormal basis from eye→target.
  const eye = orbit.eye;
  const fwd = orbit.forward; // normalized target - eye
  let right = fwd.cross(Vec3.Y);
  right = right.lengthSq() < 1e-9 ? Vec3.X : right.normalize();
  const up = right.cross(fwd).normalize();
  return {
    position: [eye.x, eye.y, eye.z],
    forward: [fwd.x, fwd.y, fwd.z],
    right: [right.x, right.y, right.z],
    up: [up.x, up.y, up.z],
    fovY: orbit.fovY,
  };
}
