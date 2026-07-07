import { Vec3 } from '../core/math/vec3';
import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { cameraFovY, objectForward, DEFAULT_MATERIAL } from '../core/scene/objectData';
import type { HdriImage } from '../core/scene/worldData';

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
  /** 0..1 probability a diffuse bounce is treated as subsurface. Default 0. */
  subsurfaceWeight?: number;
  /** Mean subsurface scatter distance, world units. Default 0.05. */
  subsurfaceRadius?: number;
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
  /**
   * Soft-shadow source size. Point/spot: emitter sphere radius (world units) —
   * a shadow ray samples a random point on that sphere. Sun: angular radius in
   * radians — the sun direction is jittered within that cone. 0/undefined =
   * hard shadow (samples the center → byte-identical to the center-only path).
   */
  radius?: number;
}

export interface SnapCamera {
  position: [number, number, number];
  /** Orthonormal camera basis (world space). */
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view, radians. */
  fovY: number;
  /**
   * Thin-lens aperture radius in world units (depth of field). 0/undefined =
   * pinhole (byte-identical to the current behavior — no lens RNG is drawn).
   */
  aperture?: number;
  /**
   * Distance from the eye to the in-focus plane along the forward axis. Used
   * only when aperture > 0. buildSnapshot seeds it to the scene bounding-box
   * center distance; the render window UI can override it.
   */
  focusDistance?: number;
}

/**
 * Environment/sky for the tracer's ray-miss color (P10-4). Plain data so it
 * crosses the Worker boundary: `hdri` is a decoded pixel blob (Float32Array),
 * NOT the data-URL string. `mode` codes: 0 flat, 1 gradient, 2 hdri.
 */
export interface SnapWorld {
  mode: 0 | 1 | 2;
  color: [number, number, number];
  horizon: [number, number, number];
  zenith: [number, number, number];
  strength: number;
  /** Equirect pixels when mode 2 (else null → falls back to the gradient). */
  hdri: HdriImage | null;
}

/**
 * The default snap world — reproduces the tracer's original hardcoded sky. Used
 * by prepareScene when a snapshot omits `world` (older tests build snapshots
 * without it), so their images stay byte-identical to the pre-P10-4 tracer.
 */
export function defaultSnapWorld(): SnapWorld {
  return {
    mode: 1,
    color: [0.05, 0.05, 0.05],
    horizon: [0.05, 0.05, 0.05],
    zenith: [0.11, 0.13, 0.16],
    strength: 1,
    hdri: null,
  };
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
  /** Sky/environment; optional so pre-P10-4 snapshots default to the old sky. */
  world?: SnapWorld;
}

function toMat(m: {
  baseColor: readonly [number, number, number];
  metallic: number;
  roughness: number;
  emissive: readonly [number, number, number];
  emissiveStrength: number;
  subsurfaceWeight?: number;
  subsurfaceRadius?: number;
}): SnapMaterial {
  return {
    baseColor: [m.baseColor[0], m.baseColor[1], m.baseColor[2]],
    metallic: m.metallic,
    roughness: m.roughness,
    emissive: [m.emissive[0], m.emissive[1], m.emissive[2]],
    emissiveStrength: m.emissiveStrength,
    subsurfaceWeight: m.subsurfaceWeight ?? 0,
    subsurfaceRadius: m.subsurfaceRadius ?? 0.05,
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
  /** Derived tinted materials, keyed by base index + tint (see face loop). */
  const tintedIndex = new Map<string, number>();
  for (const obj of scene.objects) {
    if (obj.kind !== 'mesh' || !scene.effectiveVisible(obj)) continue;
    const mesh = obj.evaluatedMesh(scene.modifierContext(obj));
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
      // Per-face tints (Scatter's per-instance colors) become DERIVED materials
      // (baseColor × tint), deduped — the tracer itself stays tint-unaware.
      // Scatter draws from a small hue set, so this adds at most a dozen entries.
      let faceMi = mi;
      const tint = mesh.faceTints.get(face.id);
      if (tint) {
        const key = `${mi}:${tint[0].toFixed(4)},${tint[1].toFixed(4)},${tint[2].toFixed(4)}`;
        let ti = tintedIndex.get(key);
        if (ti === undefined) {
          const base = materials[mi];
          ti = materials.length;
          materials.push({
            ...base,
            baseColor: [base.baseColor[0] * tint[0], base.baseColor[1] * tint[1], base.baseColor[2] * tint[2]],
            emissive: [...base.emissive] as [number, number, number],
          });
          tintedIndex.set(key, ti);
        }
        faceMi = ti;
      }
      for (let i = 1; i + 1 < vs.length; i++) {
        const b = world.get(vs[i]);
        const c = world.get(vs[i + 1]);
        if (!b || !c) continue;
        triPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        triMatArr.push(faceMi);
      }
    }
  }

  // --- lights (same premultiply as collectLights) ---
  const lights: SnapLight[] = [];
  for (const obj of scene.objects) {
    if (obj.kind !== 'light' || !scene.effectiveVisible(obj) || !obj.light) continue;
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
      radius: l.radius ?? (l.type === 'sun' ? 0 : 0.1),
    });
  }

  const tris = new Float32Array(triPos);
  const camera = buildCamera(scene, orbit);
  // Seed the depth-of-field focus plane to the scene bounding-box center so an
  // opened aperture focuses on the subject by default (aperture stays 0/pinhole
  // until the user opens it in the render window).
  camera.focusDistance = focusDistanceForBounds(tris, camera);

  const w = scene.world;
  const world: SnapWorld = {
    mode: w.mode === 'flat' ? 0 : w.mode === 'gradient' ? 1 : 2,
    color: [w.color[0], w.color[1], w.color[2]],
    horizon: [w.horizon[0], w.horizon[1], w.horizon[2]],
    zenith: [w.zenith[0], w.zenith[1], w.zenith[2]],
    strength: w.strength,
    hdri: w.mode === 'hdri' && w.hdriImage ? w.hdriImage : null,
  };

  return {
    tris,
    triMat: Int32Array.from(triMatArr),
    materials,
    lights,
    camera,
    world,
  };
}

/**
 * Distance from the camera eye to the geometry bounding-box center, projected
 * onto the forward axis. Falls back to the raw center distance (and to 5 for an
 * empty scene) so an opened aperture always has a sane focal plane.
 */
function focusDistanceForBounds(tris: Float32Array, cam: SnapCamera): number {
  if (tris.length < 9) return 5;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
  const vx = cx - cam.position[0], vy = cy - cam.position[1], vz = cz - cam.position[2];
  const along = vx * cam.forward[0] + vy * cam.forward[1] + vz * cam.forward[2];
  if (along > 1e-3) return along;
  const d = Math.hypot(vx, vy, vz);
  return d > 1e-3 ? d : 5;
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
