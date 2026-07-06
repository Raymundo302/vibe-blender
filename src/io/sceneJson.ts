import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { Transform } from '../core/math/transform';
import { EditableMesh } from '../core/mesh/EditableMesh';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type {
  CameraData,
  LightData,
  LightType,
  Material,
  ObjectKind,
} from '../core/scene/objectData';
import {
  createModifier,
  modifierTypes,
  type Modifier,
  type ModifierParams,
} from '../core/modifiers/Modifier';

/**
 * Scene save/load as versioned JSON (task P3-2, extended to format v3 by P8-5).
 *
 * The on-disk shape is PLAIN DATA — never live class instances (A4 / P3
 * conventions). Output is deterministic (stable key order, insertion-order
 * iteration, numbers rounded to 6 decimals) so round-trip tests can compare
 * strings structurally. Vert/face ids and their Map insertion order are
 * preserved exactly, because element pick maps (and undo) key off them.
 *
 * Format v3 adds Phase-8 state: per-object `kind` ('mesh'|'light'|'camera'),
 * `light`/`camera` payloads, `materialId`, plus a scene-level `materials`
 * library and `activeCameraId`. Object ids are serialized so the loader can
 * remap the saved `activeCameraId` (ids are regenerated on load) back onto the
 * rebuilt camera by object-list position. v1/v2 files still load: their objects
 * default to kind 'mesh' / materialId null, with no materials / active camera.
 */

const FORMAT = 'vibe-blender-scene';
/** Version we WRITE. Loader accepts every entry of SUPPORTED_VERSIONS. */
const VERSION = 3;
const SUPPORTED_VERSIONS = [1, 2, 3];

/** Round to 6 decimals and drop the trailing zeros (0.5, 1, -1 — never -0). */
function num(n: number): number {
  const r = Number(n.toFixed(6));
  return r === 0 ? 0 : r; // collapse -0 → 0 so re-serialization is stable
}

function vec(v: Vec3): [number, number, number] {
  return [num(v.x), num(v.y), num(v.z)];
}

function quat(q: Quat): [number, number, number, number] {
  return [num(q.x), num(q.y), num(q.z), num(q.w)];
}

function rgb(c: readonly [number, number, number]): [number, number, number] {
  return [num(c[0]), num(c[1]), num(c[2])];
}

/**
 * Modifier params, serialized deterministically: keys sorted, numbers rounded
 * through num(). Booleans and axis strings pass through as-is.
 */
function serializeParams(p: ModifierParams): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const key of Object.keys(p).sort()) {
    const v = p[key];
    out[key] = typeof v === 'number' ? num(v) : v;
  }
  return out;
}

/** Full LightData payload, numbers rounded. */
function serializeLight(l: LightData): Record<string, unknown> {
  return {
    type: l.type,
    color: rgb(l.color),
    power: num(l.power),
    spotAngle: num(l.spotAngle),
    spotBlend: num(l.spotBlend),
  };
}

/** Full CameraData payload, numbers rounded. */
function serializeCamera(c: CameraData): Record<string, unknown> {
  return { focalLength: num(c.focalLength), near: num(c.near), far: num(c.far) };
}

/** One scene object, in stable key order (light/camera keys only when present). */
function serializeObject(obj: SceneObject): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: obj.name,
    kind: obj.kind,
    visible: obj.visible,
    shadeSmooth: obj.shadeSmooth,
    color: rgb(obj.color),
    materialId: obj.materialId,
    transform: {
      position: vec(obj.transform.position),
      rotation: quat(obj.transform.rotation),
      scale: vec(obj.transform.scale),
    },
    mesh: {
      // Map iteration is insertion order — preserve it verbatim. Non-mesh
      // objects carry an empty mesh → empty arrays.
      verts: [...obj.mesh.verts.values()].map((v) => [v.id, num(v.co.x), num(v.co.y), num(v.co.z)]),
      faces: [...obj.mesh.faces.values()].map((f) => [f.id, [...f.verts]]),
    },
    // Stack order = evaluation order; serialized top-to-bottom as shown.
    modifiers: obj.modifiers.map((m) => ({
      type: m.type,
      name: m.name,
      enabled: m.enabled,
      params: serializeParams(m.params()),
    })),
  };
  if (obj.light) out.light = serializeLight(obj.light);
  if (obj.camera) out.camera = serializeCamera(obj.camera);
  return out;
}

/** Serialize the whole scene + camera to a deterministic JSON string. */
export function serializeScene(scene: Scene, camera: OrbitCamera): string {
  const data = {
    format: FORMAT,
    version: VERSION,
    camera: {
      target: vec(camera.target),
      distance: num(camera.distance),
      yaw: num(camera.yaw),
      pitch: num(camera.pitch),
    },
    // Active camera stored as an INDEX into objects (never an id): object ids
    // are regenerated on load, and keeping ids out of the file is what makes
    // serialize→apply→serialize byte-identical even after deletions leave gaps.
    activeCamera:
      scene.activeCameraId === null
        ? null
        : (() => {
            const i = scene.objects.findIndex((o) => o.id === scene.activeCameraId);
            return i < 0 ? null : i;
          })(),
    materials: scene.materials.map((m) => ({
      id: m.id,
      name: m.name,
      baseColor: rgb(m.baseColor),
      metallic: num(m.metallic),
      roughness: num(m.roughness),
      emissive: rgb(m.emissive),
      emissiveStrength: num(m.emissiveStrength),
    })),
    objects: scene.objects.map(serializeObject),
  };
  return JSON.stringify(data, null, 2);
}

// --- validated intermediate shapes (parsed BEFORE any scene mutation) -------

interface MeshData {
  verts: [number, number, number, number][];
  faces: [number, number[]][];
}
interface ModifierData {
  type: string;
  name: string;
  enabled: boolean;
  params: ModifierParams;
}
interface MaterialData {
  id: number;
  name: string;
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  emissiveStrength: number;
}
interface ObjectData {
  kind: ObjectKind;
  name: string;
  visible: boolean;
  shadeSmooth?: boolean;
  color: [number, number, number];
  materialId: number | null;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  mesh: MeshData;
  modifiers: ModifierData[];
  light?: LightData;
  camera?: CameraData;
}
interface SceneData {
  camera: { target: [number, number, number]; distance: number; yaw: number; pitch: number };
  /** Index into objects of the active camera, or null. */
  activeCamera: number | null;
  materials: MaterialData[];
  objects: ObjectData[];
}

/** Default viewport color for files saved before per-object color existed. */
const DEFAULT_COLOR: [number, number, number] = [0.69, 0.69, 0.69];

function fail(msg: string): never {
  throw new Error(`Invalid scene file: ${msg}`);
}

/** Parse an optional [r,g,b] color; absent → default grey, present → validated. */
function parseColor(v: unknown, i: number): [number, number, number] {
  if (v === undefined) return [...DEFAULT_COLOR];
  return numArray(v, 3, `objects[${i}].color`) as [number, number, number];
}

function numArray(v: unknown, len: number, where: string): number[] {
  if (!Array.isArray(v) || v.length !== len || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    fail(`${where} must be an array of ${len} numbers`);
  }
  return v as number[];
}

/** A finite number field, or fail. */
function numField(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} must be a finite number`);
  return v;
}

/** Parse + fully validate. Throws a readable Error and touches nothing on failure. */
function parseScene(json: string): SceneData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    fail(`not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null) fail('root is not an object');
  const root = raw as Record<string, unknown>;
  if (root.format !== FORMAT) fail(`unrecognized format ${JSON.stringify(root.format)} (expected "${FORMAT}")`);
  if (typeof root.version !== 'number' || !SUPPORTED_VERSIONS.includes(root.version)) {
    fail(`unsupported version ${JSON.stringify(root.version)} (expected one of ${SUPPORTED_VERSIONS.join(', ')})`);
  }

  const cam = root.camera as Record<string, unknown> | undefined;
  if (typeof cam !== 'object' || cam === null) fail('missing camera');
  const camera = {
    target: numArray(cam.target, 3, 'camera.target') as [number, number, number],
    distance: numField(cam.distance, 'camera.distance'),
    yaw: numField(cam.yaw, 'camera.yaw'),
    pitch: numField(cam.pitch, 'camera.pitch'),
  };

  const materials = parseMaterials(root.materials);

  if (!Array.isArray(root.objects)) fail('objects must be an array');
  const objects = (root.objects as unknown[]).map((o, i) => parseObject(o, i));

  // Active camera as an objects INDEX (v3). Absent (v1/v2) or null → null.
  let activeCamera: number | null = null;
  if (root.activeCamera !== undefined && root.activeCamera !== null) {
    const idx = numField(root.activeCamera, 'activeCamera');
    if (!Number.isInteger(idx) || idx < 0 || idx >= objects.length) {
      fail(`activeCamera index ${idx} is out of range`);
    }
    if (objects[idx].kind !== 'camera') fail(`activeCamera index ${idx} is not a camera`);
    activeCamera = idx;
  }
  return { camera, activeCamera, materials, objects };
}

/** Parse the scene material library (absent in v1/v2 → empty). */
function parseMaterials(v: unknown): MaterialData[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail('materials must be an array');
  return (v as unknown[]).map((m, mi) => {
    if (typeof m !== 'object' || m === null) fail(`materials[${mi}] is not an object`);
    const mat = m as Record<string, unknown>;
    if (typeof mat.id !== 'number' || !Number.isInteger(mat.id)) fail(`materials[${mi}].id must be an integer`);
    if (typeof mat.name !== 'string') fail(`materials[${mi}].name must be a string`);
    return {
      id: mat.id,
      name: mat.name,
      baseColor: numArray(mat.baseColor, 3, `materials[${mi}].baseColor`) as [number, number, number],
      metallic: numField(mat.metallic, `materials[${mi}].metallic`),
      roughness: numField(mat.roughness, `materials[${mi}].roughness`),
      emissive: numArray(mat.emissive, 3, `materials[${mi}].emissive`) as [number, number, number],
      emissiveStrength: numField(mat.emissiveStrength, `materials[${mi}].emissiveStrength`),
    };
  });
}

/** Parse an object's LightData payload (kind 'light' only). */
function parseLight(v: unknown, i: number): LightData {
  if (typeof v !== 'object' || v === null) fail(`objects[${i}].light is missing`);
  const l = v as Record<string, unknown>;
  if (l.type !== 'point' && l.type !== 'sun' && l.type !== 'spot') {
    fail(`objects[${i}].light.type must be one of point, sun, spot`);
  }
  const color = numArray(l.color, 3, `objects[${i}].light.color`) as [number, number, number];
  const power = numField(l.power, `objects[${i}].light.power`);
  if (power < 0) fail(`objects[${i}].light.power must not be negative`);
  return {
    type: l.type as LightType,
    color,
    power,
    spotAngle: numField(l.spotAngle, `objects[${i}].light.spotAngle`),
    spotBlend: numField(l.spotBlend, `objects[${i}].light.spotBlend`),
  };
}

/** Parse an object's CameraData payload (kind 'camera' only). */
function parseCamera(v: unknown, i: number): CameraData {
  if (typeof v !== 'object' || v === null) fail(`objects[${i}].camera is missing`);
  const c = v as Record<string, unknown>;
  return {
    focalLength: numField(c.focalLength, `objects[${i}].camera.focalLength`),
    near: numField(c.near, `objects[${i}].camera.near`),
    far: numField(c.far, `objects[${i}].camera.far`),
  };
}

function parseObject(o: unknown, i: number): ObjectData {
  if (typeof o !== 'object' || o === null) fail(`objects[${i}] is not an object`);
  const obj = o as Record<string, unknown>;
  if (typeof obj.name !== 'string') fail(`objects[${i}].name must be a string`);
  if (typeof obj.visible !== 'boolean') fail(`objects[${i}].visible must be a boolean`);

  // kind: absent (v1/v2) → 'mesh'; otherwise validated.
  let kind: ObjectKind = 'mesh';
  if (obj.kind !== undefined) {
    if (obj.kind !== 'mesh' && obj.kind !== 'light' && obj.kind !== 'camera') {
      fail(`objects[${i}].kind must be one of mesh, light, camera`);
    }
    kind = obj.kind;
  }

  // materialId: absent (v1/v2) → null; else null or a number.
  let materialId: number | null = null;
  if (obj.materialId !== undefined && obj.materialId !== null) {
    materialId = numField(obj.materialId, `objects[${i}].materialId`);
  }

  const tf = obj.transform as Record<string, unknown> | undefined;
  if (typeof tf !== 'object' || tf === null) fail(`objects[${i}].transform is missing`);
  const m = obj.mesh as Record<string, unknown> | undefined;
  if (typeof m !== 'object' || m === null) fail(`objects[${i}].mesh is missing`);
  if (!Array.isArray(m.verts) || !Array.isArray(m.faces)) fail(`objects[${i}].mesh needs verts and faces arrays`);

  const vertIds = new Set<number>();
  const verts = (m.verts as unknown[]).map((v, vi) => {
    const a = numArray(v, 4, `objects[${i}].mesh.verts[${vi}]`);
    vertIds.add(a[0]);
    return a as [number, number, number, number];
  });
  const faces = (m.faces as unknown[]).map((f, fi) => {
    if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== 'number' || !Array.isArray(f[1])) {
      fail(`objects[${i}].mesh.faces[${fi}] must be [id, vertIds[]]`);
    }
    const ids = (f[1] as unknown[]).map((n) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) fail(`objects[${i}].mesh.faces[${fi}] has a non-number vert id`);
      if (!vertIds.has(n)) fail(`objects[${i}].mesh.faces[${fi}] references missing vert ${n}`);
      return n;
    });
    if (ids.length < 3) fail(`objects[${i}].mesh.faces[${fi}] needs at least 3 verts`);
    return [f[0] as number, ids] as [number, number[]];
  });

  const data: ObjectData = {
    kind,
    name: obj.name,
    visible: obj.visible,
    shadeSmooth: obj.shadeSmooth === true, // absent in v1/v2 files → flat
    color: parseColor(obj.color, i), // absent in older files → default grey
    materialId,
    position: numArray(tf.position, 3, `objects[${i}].transform.position`) as [number, number, number],
    rotation: numArray(tf.rotation, 4, `objects[${i}].transform.rotation`) as [number, number, number, number],
    scale: numArray(tf.scale, 3, `objects[${i}].transform.scale`) as [number, number, number],
    mesh: { verts, faces },
    modifiers: parseModifiers(obj.modifiers, i),
  };

  // Light/camera payloads validated up front (before any scene mutation).
  if (kind === 'light') data.light = parseLight(obj.light, i);
  if (kind === 'camera') data.camera = parseCamera(obj.camera, i);
  return data;
}

/**
 * Parse an object's modifier stack (absent in v1 → empty). Every type must be
 * registered NOW — an unknown type throws the standard readable error during
 * validation, before applySceneJson mutates anything.
 */
function parseModifiers(v: unknown, i: number): ModifierData[] {
  if (v === undefined) return []; // v1 file, or object saved before modifiers existed
  if (!Array.isArray(v)) fail(`objects[${i}].modifiers must be an array`);
  const known = new Set(modifierTypes().map((m) => m.type));
  return (v as unknown[]).map((m, mi) => {
    if (typeof m !== 'object' || m === null) fail(`objects[${i}].modifiers[${mi}] is not an object`);
    const mod = m as Record<string, unknown>;
    if (typeof mod.type !== 'string') fail(`objects[${i}].modifiers[${mi}].type must be a string`);
    if (!known.has(mod.type)) fail(`objects[${i}].modifiers[${mi}] has unknown modifier type "${mod.type}"`);
    if (typeof mod.name !== 'string') fail(`objects[${i}].modifiers[${mi}].name must be a string`);
    if (typeof mod.enabled !== 'boolean') fail(`objects[${i}].modifiers[${mi}].enabled must be a boolean`);
    if (typeof mod.params !== 'object' || mod.params === null || Array.isArray(mod.params)) {
      fail(`objects[${i}].modifiers[${mi}].params must be an object`);
    }
    const params: ModifierParams = {};
    for (const [key, val] of Object.entries(mod.params as Record<string, unknown>)) {
      if (typeof val !== 'number' && typeof val !== 'boolean' && typeof val !== 'string') {
        fail(`objects[${i}].modifiers[${mi}].params.${key} must be a number, boolean or string`);
      }
      if (typeof val === 'number' && !Number.isFinite(val)) {
        fail(`objects[${i}].modifiers[${mi}].params.${key} must be a finite number`);
      }
      params[key] = val;
    }
    return { type: mod.type, name: mod.name, enabled: mod.enabled, params };
  });
}

/**
 * Rebuild an EditableMesh preserving ids and insertion order exactly. We add
 * entries directly to the public verts/faces Maps (allowed by the P3-2 spec)
 * and restore the private id counters so later edits don't collide — mirroring
 * the way copyFrom() carries those counters across a snapshot restore.
 */
function buildMesh(data: MeshData): EditableMesh {
  const mesh = new EditableMesh();
  let maxVert = -1;
  let maxFace = -1;
  for (const [id, x, y, z] of data.verts) {
    mesh.verts.set(id, { id, co: new Vec3(x, y, z) });
    if (id > maxVert) maxVert = id;
  }
  for (const [id, verts] of data.faces) {
    mesh.faces.set(id, { id, verts: [...verts] });
    if (id > maxFace) maxFace = id;
  }
  const priv = mesh as unknown as { nextVertId: number; nextFaceId: number; version: number };
  priv.nextVertId = maxVert + 1;
  priv.nextFaceId = maxFace + 1;
  priv.version = 1; // force GPU/pick caches to re-upload for this fresh mesh
  return mesh;
}

/** Reconstruct a live Modifier from its plain data (type already validated). */
function buildModifier(data: ModifierData): Modifier {
  const mod = createModifier(data.type, data.params);
  mod.name = data.name;
  mod.enabled = data.enabled;
  return mod;
}

/**
 * Replace the scene's contents with a saved JSON string and restore the camera.
 * Throws a readable Error (leaving the scene untouched) on malformed input:
 * everything is parsed and every mesh is built BEFORE the first mutation, so a
 * bad file can never half-load. The caller is responsible for `undo.clear()`.
 */
export function applySceneJson(json: string, scene: Scene, camera: OrbitCamera): void {
  const data = parseScene(json);
  // Build meshes AND modifier instances up front — any failure here (already
  // ruled out by validation, but createModifier is the source of truth) throws
  // before the first scene mutation, so a bad file can never half-load.
  const built = data.objects.map((od) => ({
    od,
    // Only mesh-kind objects carry geometry; lights/cameras get an empty mesh
    // from scene.addLight/addCamera.
    mesh: od.kind === 'mesh' ? buildMesh(od.mesh) : null,
    modifiers: od.modifiers.map(buildModifier),
  }));

  // Past validation — now it's safe to mutate. Drop existing objects + materials
  // via the public API (never `objects.length = 0`).
  scene.exitEditMode();
  for (const obj of [...scene.objects]) scene.remove(obj.id);
  for (const mat of [...scene.materials]) scene.removeMaterial(mat.id);
  scene.deselectAll();
  // Reset the object id counter so a full load reproduces the saved ids from a
  // clean 0-based space — otherwise applying into a scene that already handed
  // out ids would renumber the rebuilt objects, breaking the deterministic
  // serialize→apply→serialize round trip (mirrors buildMesh's counter reset).
  (scene as unknown as { nextId: number }).nextId = 0;

  // Restore the material library verbatim (ids kept as-is; SceneObject.materialId
  // references them directly) and bump the private id counter past the highest
  // restored id so a later addMaterial() can't collide — mirroring buildMesh.
  let maxMaterialId = -1;
  for (const md of data.materials) {
    const mat: Material = {
      id: md.id,
      name: md.name,
      baseColor: [...md.baseColor],
      metallic: md.metallic,
      roughness: md.roughness,
      emissive: [...md.emissive],
      emissiveStrength: md.emissiveStrength,
    };
    scene.materials.push(mat);
    if (md.id > maxMaterialId) maxMaterialId = md.id;
  }
  if (maxMaterialId >= 0) {
    (scene as unknown as { nextMaterialId: number }).nextMaterialId = maxMaterialId + 1;
  }

  // Rebuild objects through the kind-aware public API so kinds are real.
  const rebuilt: SceneObject[] = [];
  for (const { od, mesh, modifiers } of built) {
    let obj: SceneObject;
    if (od.kind === 'light') {
      obj = scene.addLight(od.name, od.light!.type, { ...od.light!, color: [...od.light!.color] });
    } else if (od.kind === 'camera') {
      obj = scene.addCamera(od.name, { ...od.camera! });
    } else {
      obj = scene.add(od.name, mesh!);
    }
    obj.visible = od.visible;
    obj.shadeSmooth = od.shadeSmooth === true;
    obj.color = [od.color[0], od.color[1], od.color[2]];
    obj.materialId = od.materialId;
    obj.transform = new Transform(
      Vec3.fromArray(od.position),
      new Quat(od.rotation[0], od.rotation[1], od.rotation[2], od.rotation[3]),
      Vec3.fromArray(od.scale),
    );
    obj.modifiers.push(...modifiers);
    if (modifiers.length > 0) obj.modifiersVersion++;
    rebuilt.push(obj);
  }

  // addCamera auto-activates the first camera; override with the saved choice
  // (an objects index — already validated to point at a camera).
  scene.activeCameraId = data.activeCamera === null ? null : rebuilt[data.activeCamera].id;

  if (scene.objects.length > 0) scene.selectOnly(scene.objects[0].id);

  camera.target = Vec3.fromArray(data.camera.target);
  camera.distance = data.camera.distance;
  camera.yaw = data.camera.yaw;
  camera.pitch = data.camera.pitch;
}
