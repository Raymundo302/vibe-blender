import { getNodeDef } from '../core/nodes/nodeGraph';
import { nodeImageCache } from '../core/nodes/imageCache';
import '../core/nodes/builtins';
import { Vec3 } from '../core/math/vec3';
import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { cameraFovY, cameraLensRadius, DOF_APERTURE_SCALE, objectForward, DEFAULT_MATERIAL, AREA_MIN_SIZE } from '../core/scene/objectData';
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
  /** Transmission (UR10-3): 0 = opaque, 1 = full dielectric glass. Above 0 the
   *  tracer traces a Fresnel-reflect / Snell-refract dielectric BSDF. Default 0. */
  transmission?: number;
  /** Index of refraction for the glass BSDF (UR10-3). Default 1.45. */
  ior?: number;
  /** Linear RGB emission (pre-strength). */
  emissive: [number, number, number];
  emissiveStrength: number;
  /** 0..1 probability a diffuse bounce is treated as subsurface. Default 0. */
  subsurfaceWeight?: number;
  /** Mean subsurface scatter distance, world units. Default 0.05. */
  subsurfaceRadius?: number;
  /** Shadeless (UR4-3): emit base×texture color and gather no further bounces
   *  (Blender "Emit"/image-plane look). Default false. */
  shadeless?: boolean;
  /** Alpha blend (UR8-3): the base-color texture carries transparency. The tracer
   *  treats a hit whose sampled texture alpha < 0.5 as a cutout (ray passes
   *  through). Default false. */
  alphaBlend?: boolean;
  /** Base-color texture kind (P11), sampled through per-corner UVs. Default 'none'. */
  texKind?: 'none' | 'checker' | 'image';
  /**
   * Decoded image pixels when texKind === 'image' (runtime cache, worldData-
   * style): length = width*height*3, linear RGB, row 0 = top. null/absent → the
   * image sample falls back to white (no tint), so a snapshot without decoded
   * pixels renders like an untextured material. `alpha` (UR8-3): per-pixel alpha
   * (0..1, length width*height) for the cutout test; absent → treated opaque.
   */
  texImage?: { width: number; height: number; pixels: Float32Array; alpha?: Float32Array } | null;
  /** P13 map slots (decoded RAW 0..1 pixels — data, not color; null = off).
   *  The tracer perturbs shading normals / scales rough+metal with these. */
  normalImage?: { width: number; height: number; pixels: Float32Array } | null;
  normalIsBump?: boolean;
  normalStrength?: number;
  roughImage?: { width: number; height: number; pixels: Float32Array } | null;
  metalImage?: { width: number; height: number; pixels: Float32Array } | null;
  /** P14 shader nodes: when set (useNodes), the tracer evaluates this graph
   *  per hit and OVERRIDES baseColor/metallic/roughness/emissive. Plain JSON;
   *  survives the worker postMessage structured clone. */
  nodeGraph?: import('../core/nodes/nodeGraph').NodeGraph | null;
  /** Decoded images for the graph's 'image' params, keyed by data URL
   *  (Map + Float32Array both structured-clone fine). */
  nodeImages?: Map<string, { width: number; height: number; pixels: Float32Array }> | null;
}

/** 0 = point, 1 = sun, 2 = spot, 3 = area (matches renderedPass type codes). */
export interface SnapLight {
  type: 0 | 1 | 2 | 3;
  position: [number, number, number];
  /** Aim direction (local -Z rotated), for sun/spot/area (= area's face normal). */
  direction: [number, number, number];
  /**
   * Area light only (type 3): the emitting rectangle's world-space basis and
   * size. `uAxis`/`vAxis` are unit local X/Y rotated into world; width/height are
   * the extents along them. A shadow-ray sample point on the rect is
   * position + (su·width)·uAxis + (sv·height)·vAxis for su,sv ∈ [-0.5, 0.5].
   * Absent for non-area lights.
   */
  uAxis?: [number, number, number];
  vAxis?: [number, number, number];
  width?: number;
  height?: number;
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
  /**
   * True when focusDistance was locked by the active camera's Focus Object
   * (UR5-7): the manual render-window focus field must NOT override it.
   */
  focusFromObject?: boolean;
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
  /** Per-corner UV (2 floats × 3 corners per tri), parallel to tris (P11).
   * Optional so hand-built test snapshots stay valid; absent → all (0,0). */
  triUV?: Float32Array;
  /** Per-corner GENERATED texture coord (3 floats × 3 corners per tri),
   * parallel to tris (P16-2): the corner vert's LOCAL position normalized to
   * the object's base evaluated-mesh AABB, 0..1 per axis. The tracer
   * interpolates it like triUV and passes it as ctx.gen. Optional; absent →
   * the Texture Coordinate node's generated output falls back to (u, v, 0). */
  triGen?: Float32Array;
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
  transmission?: number;
  ior?: number;
  emissive: readonly [number, number, number];
  emissiveStrength: number;
  subsurfaceWeight?: number;
  subsurfaceRadius?: number;
  shadeless?: boolean;
  alphaBlend?: boolean;
  texKind?: 'none' | 'checker' | 'image';
  texImage?: { width: number; height: number; pixels: Float32Array; alpha?: Float32Array };
  normalImage?: { width: number; height: number; pixels: Float32Array };
  normalIsBump?: boolean;
  normalStrength?: number;
  roughImage?: { width: number; height: number; pixels: Float32Array };
  metalImage?: { width: number; height: number; pixels: Float32Array };
  nodeGraph?: import('../core/nodes/nodeGraph').NodeGraph | null;
  useNodes?: boolean;
}): SnapMaterial {
  const texKind = m.texKind ?? 'none';
  return {
    baseColor: [m.baseColor[0], m.baseColor[1], m.baseColor[2]],
    metallic: m.metallic,
    roughness: m.roughness,
    transmission: m.transmission ?? 0,
    ior: m.ior ?? 1.45,
    emissive: [m.emissive[0], m.emissive[1], m.emissive[2]],
    emissiveStrength: m.emissiveStrength,
    subsurfaceWeight: m.subsurfaceWeight ?? 0,
    subsurfaceRadius: m.subsurfaceRadius ?? 0.05,
    shadeless: m.shadeless ?? false,
    alphaBlend: m.alphaBlend ?? false,
    texKind,
    // Only carry the decoded pixels for image materials; share the Float32Array
    // (it is immutable per data URL) so the snapshot stays cheap.
    texImage: texKind === 'image' && m.texImage ? m.texImage : null,
    normalImage: m.normalImage ?? null,
    normalIsBump: m.normalIsBump ?? false,
    normalStrength: m.normalStrength ?? 1,
    roughImage: m.roughImage ?? null,
    metalImage: m.metalImage ?? null,
    nodeGraph: m.useNodes && m.nodeGraph ? m.nodeGraph : null,
    nodeImages: m.useNodes && m.nodeGraph ? collectNodeImages(m.nodeGraph) : null,
  };
}

/** Decoded images for every 'image' param in the graph, from the UI-filled
 *  cache (missing decodes just sample as white — same as the map slots). */
function collectNodeImages(
  graph: import('../core/nodes/nodeGraph').NodeGraph,
): Map<string, { width: number; height: number; pixels: Float32Array }> | null {
  const cache = nodeImageCache();
  const out = new Map<string, { width: number; height: number; pixels: Float32Array }>();
  for (const node of graph.nodes) {
    const def = getNodeDef(node.type);
    if (!def) continue;
    for (const pd of def.params) {
      if (pd.kind !== 'image') continue;
      const url = node.params[pd.key];
      if (typeof url !== 'string') continue;
      const dec = cache.get(url);
      if (dec) out.set(url, dec);
    }
  }
  return out.size ? out : null;
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
  const triUVArr: number[] = [];
  const triGenArr: number[] = [];
  /** Derived tinted materials, keyed by base index + tint (see face loop). */
  const tintedIndex = new Map<string, number>();
  for (const obj of scene.objects) {
    if (obj.kind !== 'mesh' || !scene.effectiveVisible(obj)) continue;
    const mesh = obj.evaluatedMesh(scene.modifierContext(obj));
    if (mesh.faces.size === 0) continue;
    const model = scene.worldMatrix(obj);
    const mi =
      obj.materialId !== null && matIndex.has(obj.materialId)
        ? matIndex.get(obj.materialId)!
        : 0;
    // Precompute world-space vert positions once.
    const world = new Map<number, Vec3>();
    for (const v of mesh.verts.values()) world.set(v.id, model.transformPoint(v.co));
    // GENERATED coords (P16-2): each vert's LOCAL position normalized to the
    // evaluated mesh's local AABB, 0..1 per axis. Computed once per object; a
    // degenerate (flat) axis maps to 0.5 (the normalized center).
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (const v of mesh.verts.values()) {
      const c = v.co;
      if (c.x < mnx) mnx = c.x; if (c.x > mxx) mxx = c.x;
      if (c.y < mny) mny = c.y; if (c.y > mxy) mxy = c.y;
      if (c.z < mnz) mnz = c.z; if (c.z > mxz) mxz = c.z;
    }
    const sx = mxx - mnx, sy = mxy - mny, sz = mxz - mnz;
    const gen = new Map<number, [number, number, number]>();
    for (const v of mesh.verts.values()) {
      const c = v.co;
      gen.set(v.id, [
        sx > 1e-12 ? (c.x - mnx) / sx : 0.5,
        sy > 1e-12 ? (c.y - mny) / sy : 0.5,
        sz > 1e-12 ? (c.z - mnz) / sz : 0.5,
      ]);
    }
    for (const face of mesh.faces.values()) {
      const vs = face.verts;
      const a = world.get(vs[0]);
      if (!a) continue;
      const faceUVs = mesh.uvs.get(face.id);
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
        for (const corner of [0, i, i + 1]) {
          const uv = faceUVs?.[corner];
          triUVArr.push(uv?.[0] ?? 0, uv?.[1] ?? 0);
          const g = gen.get(vs[corner]);
          triGenArr.push(g?.[0] ?? 0, g?.[1] ?? 0, g?.[2] ?? 0);
        }
        triMatArr.push(faceMi);
      }
    }
  }

  // --- lights (same premultiply as collectLights) ---
  const lights: SnapLight[] = [];
  for (const obj of scene.objects) {
    if (obj.kind !== 'light' || !scene.effectiveVisible(obj) || !obj.light) continue;
    const l = obj.light;
    const pose = scene.worldTransformOf(obj);
    const p = pose.position;
    const d = objectForward(pose);
    const scale = l.type === 'sun' ? 1 : 1 / (4 * Math.PI);
    const outer = l.spotAngle / 2;
    const inner = outer * (1 - l.spotBlend);
    const snap: SnapLight = {
      type: l.type === 'point' ? 0 : l.type === 'sun' ? 1 : l.type === 'spot' ? 2 : 3,
      position: [p.x, p.y, p.z],
      direction: [d.x, d.y, d.z],
      energy: [l.color[0] * l.power * scale, l.color[1] * l.power * scale, l.color[2] * l.power * scale],
      cosInner: Math.cos(inner),
      cosOuter: Math.cos(outer),
      radius: l.radius ?? (l.type === 'sun' || l.type === 'area' ? 0 : 0.1),
    };
    if (l.type === 'area') {
      // World-space rect basis: local X/Y rotated by the light's world rotation.
      const u = pose.rotation.rotate(new Vec3(1, 0, 0));
      const v = pose.rotation.rotate(new Vec3(0, 1, 0));
      snap.uAxis = [u.x, u.y, u.z];
      snap.vAxis = [v.x, v.y, v.z];
      snap.width = Math.max(AREA_MIN_SIZE, l.width ?? 1);
      snap.height = Math.max(AREA_MIN_SIZE, l.height ?? 1);
    }
    lights.push(snap);
  }

  const tris = new Float32Array(triPos);
  const camera = buildCamera(scene, orbit);
  // Seed the depth-of-field focus plane to the scene bounding-box center so an
  // opened aperture focuses on the subject by default (aperture stays 0/pinhole
  // until the user opens it in the render window).
  camera.focusDistance = focusDistanceForBounds(tris, camera);
  // Focus Object override (UR5-7): when the active camera targets an object, the
  // focus distance is the camera→target world-origin distance, evaluated per
  // render/frame (buildSnapshot is called per frame by Ctrl+F12), so an animated
  // target refocuses. Stale/deleted targets fall back to the bounds seed.
  const activeCam = scene.activeCamera;
  const focusId = activeCam?.camera?.focusObjectId;
  if (activeCam && focusId !== undefined && focusId !== null) {
    const target = scene.get(focusId);
    if (target) {
      const camPos = scene.worldTransformOf(activeCam).position;
      const targetPos = scene.worldTransformOf(target).position;
      camera.focusDistance = camPos.distanceTo(targetPos);
      camera.focusFromObject = true;
    }
  }

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
    triUV: new Float32Array(triUVArr),
    triGen: new Float32Array(triGenArr),
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
    // Central world matrix (UR5-7): applies the Look At orientation when set, so
    // the tracer aims exactly like the through-camera viewport view. Basis =
    // matrix columns (col-major): right/up/back; forward = -back.
    const m = scene.cameraWorldMatrix(active).m;
    const right = [m[0], m[1], m[2]] as [number, number, number];
    const up = [m[4], m[5], m[6]] as [number, number, number];
    const forward = [-m[8], -m[9], -m[10]] as [number, number, number];
    const position = [m[12], m[13], m[14]] as [number, number, number];
    return {
      position,
      forward,
      right,
      up,
      fovY: cameraFovY(active.camera),
      // F-Stop DoF (UR10-2 Part C): the physical thin-lens radius from the active
      // camera's dof/fStop, times the empirical DOF_APERTURE_SCALE "feel" factor.
      // 0 (pinhole) when DoF is off. The render window's manual aperture (init.ts)
      // still overrides for the viewport-view case.
      aperture: cameraLensRadius(active.camera) * DOF_APERTURE_SCALE,
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
