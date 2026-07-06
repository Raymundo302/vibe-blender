import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { Transform } from '../core/math/transform';
import { EditableMesh } from '../core/mesh/EditableMesh';
import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import {
  createModifier,
  modifierTypes,
  type Modifier,
  type ModifierParams,
} from '../core/modifiers/Modifier';

/**
 * Scene save/load as versioned JSON (task P3-2).
 *
 * The on-disk shape is PLAIN DATA — never live class instances (A4 / P3
 * conventions). Output is deterministic (stable key order, insertion-order
 * iteration, numbers rounded to 6 decimals) so round-trip tests can compare
 * strings structurally. Vert/face ids and their Map insertion order are
 * preserved exactly, because element pick maps (and undo) key off them.
 */

const FORMAT = 'vibe-blender-scene';
/** Version we WRITE. Loader also accepts v1 (a scene with no modifier stacks). */
const VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];

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
    objects: scene.objects.map((obj) => ({
      name: obj.name,
      visible: obj.visible,
      shadeSmooth: obj.shadeSmooth,
      color: [num(obj.color[0]), num(obj.color[1]), num(obj.color[2])],
      transform: {
        position: vec(obj.transform.position),
        rotation: quat(obj.transform.rotation),
        scale: vec(obj.transform.scale),
      },
      mesh: {
        // Map iteration is insertion order — preserve it verbatim.
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
    })),
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
interface ObjectData {
  name: string;
  visible: boolean;
  shadeSmooth?: boolean;
  color: [number, number, number];
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  mesh: MeshData;
  modifiers: ModifierData[];
}
interface SceneData {
  camera: { target: [number, number, number]; distance: number; yaw: number; pitch: number };
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
    distance: (() => { if (typeof cam.distance !== 'number' || !Number.isFinite(cam.distance)) fail('camera.distance must be a number'); return cam.distance; })(),
    yaw: (() => { if (typeof cam.yaw !== 'number' || !Number.isFinite(cam.yaw)) fail('camera.yaw must be a number'); return cam.yaw; })(),
    pitch: (() => { if (typeof cam.pitch !== 'number' || !Number.isFinite(cam.pitch)) fail('camera.pitch must be a number'); return cam.pitch; })(),
  };

  if (!Array.isArray(root.objects)) fail('objects must be an array');
  const objects = (root.objects as unknown[]).map((o, i) => parseObject(o, i));
  return { camera, objects };
}

function parseObject(o: unknown, i: number): ObjectData {
  if (typeof o !== 'object' || o === null) fail(`objects[${i}] is not an object`);
  const obj = o as Record<string, unknown>;
  if (typeof obj.name !== 'string') fail(`objects[${i}].name must be a string`);
  if (typeof obj.visible !== 'boolean') fail(`objects[${i}].visible must be a boolean`);
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

  return {
    name: obj.name,
    visible: obj.visible,
    shadeSmooth: obj.shadeSmooth === true, // absent in v1/v2 files → flat
    color: parseColor(obj.color, i), // absent in older files → default grey
    position: numArray(tf.position, 3, `objects[${i}].transform.position`) as [number, number, number],
    rotation: numArray(tf.rotation, 4, `objects[${i}].transform.rotation`) as [number, number, number, number],
    scale: numArray(tf.scale, 3, `objects[${i}].transform.scale`) as [number, number, number],
    mesh: { verts, faces },
    modifiers: parseModifiers(obj.modifiers, i),
  };
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
    mesh: buildMesh(od.mesh),
    modifiers: od.modifiers.map(buildModifier),
  }));

  // Past validation — now it's safe to mutate. Drop existing objects via the
  // public API (never `objects.length = 0`).
  scene.exitEditMode();
  for (const obj of [...scene.objects]) scene.remove(obj.id);
  scene.deselectAll();

  for (const { od, mesh, modifiers } of built) {
    const obj = scene.add(od.name, mesh);
    obj.visible = od.visible;
    obj.shadeSmooth = od.shadeSmooth === true;
    obj.color = [od.color[0], od.color[1], od.color[2]];
    obj.transform = new Transform(
      Vec3.fromArray(od.position),
      new Quat(od.rotation[0], od.rotation[1], od.rotation[2], od.rotation[3]),
      Vec3.fromArray(od.scale),
    );
    obj.modifiers.push(...modifiers);
    if (modifiers.length > 0) obj.modifiersVersion++;
  }
  if (scene.objects.length > 0) scene.selectOnly(scene.objects[0].id);

  camera.target = Vec3.fromArray(data.camera.target);
  camera.distance = data.camera.distance;
  camera.yaw = data.camera.yaw;
  camera.pitch = data.camera.pitch;
}
