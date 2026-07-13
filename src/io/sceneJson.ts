import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { Transform } from '../core/math/transform';
import { sanitizeGraph, type NodeGraph } from '../core/nodes/nodeGraph';
import { evalFCurve, type AnimData, type Interp, type Keyframe } from '../core/anim/fcurve';
import { applyAnimation } from '../core/anim/sampler';
import { EditableMesh } from '../core/mesh/EditableMesh';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type {
  CameraData,
  ChannelInput,
  CurveData,
  CurvePoint,
  EmptyData,
  GradientInput,
  HtmlPlaneData,
  LightData,
  LightType,
  Material,
  MaterialShader,
  ObjectKind,
  TextData,
} from '../core/scene/objectData';
import { clampHtmlFps, clampFStop, clampCurveResolution, AREA_MIN_SIZE, clampIor, clampTransmission, materialShader, MATERIAL_SHADERS, type GlareSettings } from '../core/scene/objectData';
import {
  createModifier,
  modifierTypes,
  type Modifier,
  type ModifierParams,
} from '../core/modifiers/Modifier';
import { defaultWorld, decodeHdriDataUrl, type World } from '../core/scene/worldData';

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
/** Version we WRITE. Loader accepts every entry of SUPPORTED_VERSIONS.
 *  v20 (UR16-1): shader model — materials serialize as named shader + per-channel
 *  SOCKET inputs (value/image/gradient) + an alpha channel, replacing the scattered
 *  baseColor/texKind/roughDataUrl/… fields. Pre-v20 materials migrate to shader
 *  'super' (or 'emit' when shadeless) with channels synthesized from the legacy
 *  fields — they render IDENTICALLY (the runtime fields are unchanged). */
const VERSION = 20;
const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

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

/** Full LightData payload, numbers rounded. Area width/height (v16/UR10-1) are
 *  only written for area lights so pre-area scenes/tests serialize identically. */
function serializeLight(l: LightData): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: l.type,
    color: rgb(l.color),
    power: num(l.power),
    spotAngle: num(l.spotAngle),
    spotBlend: num(l.spotBlend),
    radius: num(l.radius ?? (l.type === 'sun' || l.type === 'area' ? 0 : 0.1)),
  };
  if (l.type === 'area') {
    out.width = num(l.width ?? 1);
    out.height = num(l.height ?? 1);
  }
  return out;
}

/**
 * Full CameraData payload, numbers rounded. Focus Object / Look At refs
 * (UR5-7) are stored as OBJECT INDICES, not ids (the P8 activeCamera rule) —
 * omitted (undefined dropped by JSON.stringify) when unset or when the target is
 * no longer in the scene, so cameras without targets serialize byte-identically.
 */
function serializeCamera(c: CameraData, scene: Scene): Record<string, unknown> {
  const idxOf = (id: number | undefined): number | undefined => {
    if (id === undefined || id === null) return undefined;
    const i = scene.objects.findIndex((o) => o.id === id);
    return i < 0 ? undefined : i;
  };
  const out: Record<string, unknown> = {
    focalLength: num(c.focalLength),
    near: num(c.near),
    far: num(c.far),
    lockToView: !!c.lockToView,
    focusObject: idxOf(c.focusObjectId),
    lookAt: idxOf(c.lookAtId),
    // F-Stop DoF (UR10-2 Part C). Always written so round-trips are stable.
    dof: !!c.dof,
    fStop: num(clampFStop(c.fStop ?? 2.8)),
  };
  // Camera Glare (UR10-2 Part B) — only when present, so pre-UR10-2 cameras
  // serialize byte-identically (absent → no glare).
  if (c.glare) {
    out.glare = {
      enabled: !!c.glare.enabled,
      threshold: num(c.glare.threshold),
      strength: num(c.glare.strength),
      radius: num(c.glare.radius),
    };
  }
  return out;
}

/**
 * Serialize one modifier's params. 'object'-kind fields store the referenced
 * object's INDEX in scene.objects (or -1) — ids never hit the file (see
 * activeCamera note) — and are remapped back to fresh ids on load.
 */
function serializeModParams(m: { params(): ModifierParams; fields(): { key: string; kind: string }[] }, scene: Scene): Record<string, number | boolean | string> {
  const out = serializeParams(m.params());
  for (const f of m.fields()) {
    if (f.kind !== 'object') continue;
    const id = out[f.key];
    const idx = typeof id === 'number' ? scene.objects.findIndex((o) => o.id === id) : -1;
    out[f.key] = idx;
  }
  return out;
}

/** One scene object, in stable key order (light/camera keys only when present). */
function serializeObject(obj: SceneObject, scene: Scene): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: obj.name,
    kind: obj.kind,
    visible: obj.visible,
    shadeSmooth: obj.shadeSmooth,
    color: rgb(obj.color),
    materialId: obj.materialId,
    // Owning collection as an INDEX into the scene's collections array (or null).
    collection:
      obj.collectionId === null
        ? null
        : (() => {
            const i = scene.collections.findIndex((c) => c.id === obj.collectionId);
            return i < 0 ? null : i;
          })(),
    // Parent as an objects INDEX (v4) — same id-free rule as activeCamera.
    parent:
      obj.parentId === null
        ? null
        : (() => {
            const i = scene.objects.findIndex((o) => o.id === obj.parentId);
            return i < 0 ? null : i;
          })(),
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
      // Optional attributes (P9): pruned to live verts/faces, omitted when empty.
      ...meshAttrs(obj.mesh),
    },
    // Stack order = evaluation order; serialized top-to-bottom as shown.
    modifiers: obj.modifiers.map((m) => ({
      type: m.type,
      name: m.name,
      enabled: m.enabled,
      params: serializeModParams(m, scene),
    })),
  };
  if (obj.light) out.light = serializeLight(obj.light);
  if (obj.camera) out.camera = serializeCamera(obj.camera, scene);
  if (obj.empty) out.empty = { displaySize: num(obj.empty.displaySize) };
  // Text payload (v14/UR8-2) — the source of truth for a text object's mesh
  // (the mesh is serialized too, but regenerated from this on the first frame).
  if (obj.text) {
    out.text = {
      content: obj.text.content,
      font: obj.text.font,
      size: num(obj.text.size),
      wrap: obj.text.wrap,
      wrapWidth: num(obj.text.wrapWidth),
      align: obj.text.align,
      style: obj.text.style,
      faceColor: rgb(obj.text.faceColor),
      outlineColor: rgb(obj.text.outlineColor),
      thickness: num(obj.text.thickness),
    };
  }
  // Curve payload (v19/UR11-1) — the source of truth for a curve object's
  // viewport polyline (the object carries an empty mesh).
  if (obj.curve) out.curve = serializeCurve(obj.curve);
  // HTML-plane payload (v13/UR7-1). kind 'file' serializes the full source text.
  if (obj.html) {
    out.html = {
      kind: obj.html.kind,
      source: obj.html.source,
      pageW: num(obj.html.pageW),
      pageH: num(obj.html.pageH),
      scrollY: num(obj.html.scrollY),
      playing: obj.html.playing,
      fps: num(clampHtmlFps(obj.html.fps)),
      // UR8-3 A (v15) — only written when true so pre-v15 html planes stay
      // byte-identical (JSON.stringify drops undefined keys).
      transparent: obj.html.transparent ? true : undefined,
      autoCrop: obj.html.autoCrop ? true : undefined,
    };
  }
  // Animation (v7; v9 adds an optional per-key extras object: easing direction
  // + free bezier handles) — key omitted entirely for never-keyed objects.
  if (obj.anim && obj.anim.fcurves.length > 0) {
    out.anim = {
      fcurves: obj.anim.fcurves.map((c) => ({
        channelPath: c.channelPath,
        keys: c.keys.map((k) => {
          const base: unknown[] = [num(k.frame), num(k.value), k.interp];
          const extra: Record<string, unknown> = {};
          if (k.easing && k.easing !== 'auto') extra.e = k.easing;
          if (k.handleMode === 'free') {
            extra.hm = 'free';
            if (k.hl) extra.hl = [num(k.hl[0]), num(k.hl[1])];
            if (k.hr) extra.hr = [num(k.hr[0]), num(k.hr[1])];
          }
          if (Object.keys(extra).length > 0) base.push(extra);
          return base;
        }),
      })),
    };
  }
  return out;
}

/** Full CurveData payload (v19/UR11-1), numbers rounded; optional per-point
 *  handles/weight only written when present so bezier/nurbs stay minimal. */
function serializeCurve(c: CurveData): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: c.kind,
    cyclic: c.cyclic,
    resolution: num(clampCurveResolution(c.resolution)),
    points: c.points.map((p) => {
      const e: Record<string, unknown> = { co: vec(new Vec3(p.co[0], p.co[1], p.co[2])) };
      if (p.hl) e.hl = vec(new Vec3(p.hl[0], p.hl[1], p.hl[2]));
      if (p.hr) e.hr = vec(new Vec3(p.hr[0], p.hr[1], p.hr[2]));
      if (p.w !== undefined) e.w = num(p.w);
      return e;
    }),
  };
  if (c.order !== undefined) out.order = num(c.order);
  return out;
}

/** Crease/tint attribute blocks for a mesh, pruned + omitted when empty. */
function meshAttrs(mesh: EditableMesh): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const creases = [...mesh.creases.entries()]
    .map(([key, w]) => {
      const [a, b] = key.split(',').map(Number);
      return mesh.verts.has(a) && mesh.verts.has(b) ? [a, b, num(w)] : null;
    })
    .filter((e): e is number[] => e !== null);
  if (creases.length > 0) out.creases = creases;
  const tints = [...mesh.faceTints.entries()]
    .filter(([f]) => mesh.faces.has(f))
    .map(([f, c]) => [f, num(c[0]), num(c[1]), num(c[2])]);
  if (tints.length > 0) out.tints = tints;
  const uvs = [...mesh.uvs.entries()]
    .filter(([f]) => mesh.faces.has(f))
    .map(([f, us]) => [f, ...us.flatMap(([u, v]) => [num(u), num(v)])]);
  if (uvs.length > 0) out.uvs = uvs;
  const seams = [...mesh.seams]
    .map((key) => key.split(',').map(Number))
    .filter(([a, b]) => mesh.verts.has(a) && mesh.verts.has(b));
  if (seams.length > 0) out.seams = seams;
  return out;
}

// --- Material socket serialization (v20/UR16-1) ------------------------------

/** Serialize an object-space gradient input, numbers rounded. */
function serGradient(g: GradientInput): Record<string, unknown> {
  return { kind: 'gradient', a: rgb(g.a), b: rgb(g.b), axis: g.axis, offset: num(g.offset), scale: num(g.scale) };
}

/** Serialize the COLOR channel socket from a material's runtime fields. Gradient
 *  wins, then the procedural 'checker' extension, then image, then the value. */
function serColorChannel(m: Material): Record<string, unknown> {
  // The runtime model (and ALL THREE engines) computes value × map — a map
  // does not REPLACE the underlying value, it multiplies it. So the image/
  // checker sockets must CARRY the value or a save→load loses the tint
  // (UR16-1 verify catch 2026-07-12: baseColor [0.4,0.5,0.6] under a texture
  // came back [1,1,1]; metallic 0.9 under a metal map came back 0).
  if (m.colorGradient) return serGradient(m.colorGradient);
  if (m.texKind === 'checker') return { kind: 'checker', value: rgb(m.baseColor) };
  if (m.texKind === 'image') return { kind: 'image', dataUrl: m.texDataUrl, value: rgb(m.baseColor) };
  return { kind: 'value', value: rgb(m.baseColor) };
}

/** Serialize a SCALAR channel socket (roughness/metallic): gradient, image, value.
 *  Image sockets carry the multiplied-in value (see serColorChannel). */
function serScalarChannel(gradient: GradientInput | undefined, dataUrl: string | null, value: number): Record<string, unknown> {
  if (gradient) return serGradient(gradient);
  if (dataUrl) return { kind: 'image', dataUrl, value: num(value) };
  return { kind: 'value', value: num(value) };
}

/** Serialize the ALPHA channel socket (absent runtime alpha → opaque value 1). */
function serAlphaChannel(a: ChannelInput<number> | undefined): Record<string, unknown> {
  if (!a || a.kind === 'value') return { kind: 'value', value: num(a ? a.value : 1) };
  if (a.kind === 'gradient') return serGradient(a);
  return { kind: 'image', dataUrl: a.dataUrl };
}

/** One material in the v20 socket format: named shader + per-channel inputs +
 *  the super-shader extras. Deterministic key order; undefined keys dropped so
 *  opaque/default materials stay minimal and round-trip byte-identically. */
function serializeMaterial(m: Material): Record<string, unknown> {
  const shader = materialShader(m);
  const hasGlassData = shader === 'glass' || (m.transmission ?? 0) > 0;
  return {
    id: m.id,
    name: m.name,
    shader,
    color: serColorChannel(m),
    roughness: serScalarChannel(m.roughGradient, m.roughDataUrl, m.roughness),
    metallic: serScalarChannel(m.metalGradient, m.metalDataUrl, m.metallic),
    alpha: serAlphaChannel(m.alpha),
    // Super/glass/emit extras — written only when meaningful so simple materials
    // stay compact (JSON.stringify drops undefined keys).
    emissive: rgb(m.emissive),
    emissiveStrength: num(m.emissiveStrength),
    transmission: hasGlassData ? num(clampTransmission(m.transmission ?? 0)) : undefined,
    ior: hasGlassData ? num(clampIor(m.ior ?? 1.45)) : undefined,
    subsurfaceWeight: num(m.subsurfaceWeight),
    subsurfaceRadius: num(m.subsurfaceRadius),
    shadeless: m.shadeless ? true : undefined,
    alphaBlend: m.alphaBlend ? true : undefined,
    alwaysTextured: m.alwaysTextured ? true : undefined,
    // Normal/bump map (super) — written only when a map is set.
    normalDataUrl: m.normalDataUrl ?? undefined,
    normalIsBump: m.normalDataUrl ? m.normalIsBump : undefined,
    normalStrength: m.normalDataUrl ? num(m.normalStrength) : undefined,
    // Shader nodes (super).
    nodeGraph: m.nodeGraph ?? undefined,
    useNodes: m.useNodes ? true : undefined,
    bakeRes: m.bakeRes,
  };
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
    // World/environment (P10-4). The HDRI is "packed" as a data-URL string,
    // Blender-style: self-contained but it bloats the file by the encoded image
    // size (a 2K equirect PNG is a few MB of base64). Kept a plain string so the
    // serialize→parse→serialize round trip stays byte-identical + deterministic.
    world: {
      mode: scene.world.mode,
      color: rgb(scene.world.color),
      horizon: rgb(scene.world.horizon),
      zenith: rgb(scene.world.zenith),
      strength: num(scene.world.strength),
      hdri: scene.world.hdri,
    },
    // 3D cursor + transform pivot mode (v4/P12).
    cursor: vec(scene.cursor),
    pivotMode: scene.pivotMode,
    // Timeline (v7/P15).
    frameStart: scene.frameStart,
    frameEnd: scene.frameEnd,
    frameCurrent: scene.frameCurrent,
    // Output resolution (v12/UR5-5) — the real render frame + aspect. Always
    // written; pre-v12 files omit it and default to 1920×1080 on load.
    renderSettings: {
      width: scene.renderSettings.width,
      height: scene.renderSettings.height,
      // Transparent film (UR16-3) — omitted-tolerant on load (old scenes → false).
      transparent: scene.renderSettings.transparent ?? false,
    },
    collections: scene.collections.map((c) => ({ name: c.name, visible: c.visible })),
    // Materials in the v20 socket format (named shader + per-channel inputs).
    materials: scene.materials.map(serializeMaterial),
    objects: scene.objects.map((o) => serializeObject(o, scene)),
  };
  return JSON.stringify(data, null, 2);
}

// --- validated intermediate shapes (parsed BEFORE any scene mutation) -------

interface MeshData {
  verts: [number, number, number, number][];
  faces: [number, number[]][];
  /** [vertA, vertB, weight] crease entries (v3 optional). */
  creases: [number, number, number][];
  /** [faceId, r, g, b] tint entries (v3 optional). */
  tints: [number, number, number, number][];
  /** [faceId, u0, v0, u1, v1, ...] per-corner UV entries (P11 optional). */
  uvs: number[][];
  /** [vertA, vertB] seam edges (P11 optional). */
  seams: [number, number][];
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
  /** Named shader (v20/UR16-1). */
  shader: MaterialShader;
  /** Alpha channel (v20/UR16-1). */
  alpha: ChannelInput<number>;
  /** Object-space gradient overrides (v20/UR16-1), absent → value/image. */
  colorGradient?: GradientInput;
  roughGradient?: GradientInput;
  metalGradient?: GradientInput;
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  transmission: number;
  ior: number;
  emissive: [number, number, number];
  emissiveStrength: number;
  subsurfaceWeight: number;
  subsurfaceRadius: number;
  shadeless: boolean;
  alphaBlend: boolean;
  alwaysTextured: boolean;
  texKind: 'none' | 'checker' | 'image';
  texDataUrl: string | null;
  normalDataUrl: string | null;
  normalIsBump: boolean;
  normalStrength: number;
  roughDataUrl: string | null;
  metalDataUrl: string | null;
  nodeGraph: NodeGraph | null;
  useNodes: boolean;
  bakeRes?: number;
}
interface CollectionData {
  name: string;
  visible: boolean;
}
interface ObjectData {
  kind: ObjectKind;
  /** Index into collections, or null (scene root). */
  collection: number | null;
  /** Parent as an objects index (v4), or null. */
  parent: number | null;
  /** Animation curves (v7), or null. */
  anim: AnimData | null;
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
  empty?: EmptyData;
  html?: HtmlPlaneData;
  text?: TextData;
  curve?: CurveData;
}
interface SceneData {
  camera: { target: [number, number, number]; distance: number; yaw: number; pitch: number };
  /** Index into objects of the active camera, or null. */
  activeCamera: number | null;
  /** Environment/sky (absent in pre-P10-4 files → default). */
  world: World;
  collections: CollectionData[];
  materials: MaterialData[];
  objects: ObjectData[];
  /** 3D cursor position (absent pre-v4 → origin). */
  cursor: [number, number, number];
  /** R/S pivot mode (absent pre-v4 → median). */
  pivotMode: 'median' | 'cursor';
  /** Timeline (absent pre-v7 → 1/120/1). */
  frameStart: number;
  frameEnd: number;
  frameCurrent: number;
  /** Output resolution (absent pre-v12 → 1920×1080) + transparent film (UR16-3). */
  renderSettings: { width: number; height: number; transparent: boolean };
  /** File format version, for load-time migrations (v8: Y-up → Z-up). */
  version: number;
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
  const world = parseWorld(root.world);

  // Collections (P10, optional — absent in older files → empty).
  const collections: CollectionData[] = [];
  if (root.collections !== undefined) {
    if (!Array.isArray(root.collections)) fail('collections must be an array');
    for (const [ci, c] of (root.collections as unknown[]).entries()) {
      if (typeof c !== 'object' || c === null) fail(`collections[${ci}] is not an object`);
      const col = c as Record<string, unknown>;
      if (typeof col.name !== 'string') fail(`collections[${ci}].name must be a string`);
      if (typeof col.visible !== 'boolean') fail(`collections[${ci}].visible must be a boolean`);
      collections.push({ name: col.name, visible: col.visible });
    }
  }

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
  // Per-object collection indices validate against the parsed array.
  for (const [oi, od] of objects.entries()) {
    if (od.collection !== null && (od.collection < 0 || od.collection >= collections.length)) {
      fail(`objects[${oi}].collection index ${od.collection} is out of range`);
    }
  }
  // Camera Focus/Look-At refs (UR5-7) are objects indices — range-checked here;
  // remapped to fresh ids on apply. (Cyclic lookAt is tolerated at runtime, not
  // a file error.)
  for (const [oi, od] of objects.entries()) {
    if (od.kind !== 'camera' || !od.camera) continue;
    for (const [key, idx] of [['focusObject', od.camera.focusObjectId], ['lookAt', od.camera.lookAtId]] as const) {
      if (idx !== undefined && (idx < 0 || idx >= objects.length)) {
        fail(`objects[${oi}].camera.${key} index ${idx} is out of range`);
      }
    }
  }
  // Parent indices (v4): in range, not self, and acyclic.
  for (const [oi, od] of objects.entries()) {
    if (od.parent === null) continue;
    if (od.parent < 0 || od.parent >= objects.length) {
      fail(`objects[${oi}].parent index ${od.parent} is out of range`);
    }
    if (od.parent === oi) fail(`objects[${oi}].parent is itself`);
  }
  for (const [oi] of objects.entries()) {
    const seen = new Set<number>([oi]);
    for (let p = objects[oi].parent; p !== null; p = objects[p].parent) {
      if (seen.has(p)) fail(`objects[${oi}].parent chain forms a cycle`);
      seen.add(p);
    }
  }
  // Cursor + pivot mode (absent pre-v4 → defaults).
  const cursor = (root.cursor === undefined
    ? [0, 0, 0]
    : numArray(root.cursor, 3, 'cursor')) as [number, number, number];
  let pivotMode: 'median' | 'cursor' = 'median';
  if (root.pivotMode !== undefined) {
    if (root.pivotMode !== 'median' && root.pivotMode !== 'cursor') {
      fail('pivotMode must be median or cursor');
    }
    pivotMode = root.pivotMode;
  }
  const frameStart = root.frameStart === undefined ? 1 : numField(root.frameStart, 'frameStart');
  const frameEnd = root.frameEnd === undefined ? 120 : numField(root.frameEnd, 'frameEnd');
  const frameCurrent = root.frameCurrent === undefined ? 1 : numField(root.frameCurrent, 'frameCurrent');
  const renderSettings = parseRenderSettings(root.renderSettings);
  return { camera, activeCamera, world, collections, materials, objects, cursor, pivotMode, frameStart, frameEnd, frameCurrent, renderSettings, version: root.version as number };
}

/**
 * Parse the world/environment block (absent in pre-P10-4 files → defaultWorld,
 * which reproduces the old sky). The decoded HDRI cache is never in the file;
 * applySceneJson rebuilds it from the `hdri` data URL after load.
 */
function parseWorld(v: unknown): World {
  const def = defaultWorld();
  if (v === undefined || v === null) return def;
  if (typeof v !== 'object' || Array.isArray(v)) fail('world must be an object');
  const w = v as Record<string, unknown>;
  if (w.mode !== 'flat' && w.mode !== 'gradient' && w.mode !== 'hdri') {
    fail('world.mode must be one of flat, gradient, hdri');
  }
  const strength = w.strength === undefined ? 1 : numField(w.strength, 'world.strength');
  if (strength < 0) fail('world.strength must not be negative');
  let hdri: string | null = null;
  if (w.hdri !== undefined && w.hdri !== null) {
    if (typeof w.hdri !== 'string') fail('world.hdri must be a string or null');
    hdri = w.hdri;
  }
  return {
    mode: w.mode,
    color: (w.color === undefined ? def.color : numArray(w.color, 3, 'world.color')) as [number, number, number],
    horizon: (w.horizon === undefined ? def.horizon : numArray(w.horizon, 3, 'world.horizon')) as [number, number, number],
    zenith: (w.zenith === undefined ? def.zenith : numArray(w.zenith, 3, 'world.zenith')) as [number, number, number],
    strength,
    hdri,
    hdriImage: null,
  };
}

/**
 * Parse the output resolution block (absent pre-v12 → 1920×1080). Dimensions
 * must be positive integers; non-integers are floored, sub-1 values clamped to 1.
 */
function parseRenderSettings(v: unknown): { width: number; height: number; transparent: boolean } {
  if (v === undefined || v === null) return { width: 1920, height: 1080, transparent: false };
  if (typeof v !== 'object' || Array.isArray(v)) fail('renderSettings must be an object');
  const r = v as Record<string, unknown>;
  const dim = (raw: unknown, where: string): number => {
    const n = numField(raw, where);
    return Math.max(1, Math.floor(n));
  };
  return {
    width: r.width === undefined ? 1920 : dim(r.width, 'renderSettings.width'),
    height: r.height === undefined ? 1080 : dim(r.height, 'renderSettings.height'),
    // Transparent film (UR16-3): absent pre-UR16-3 → false; any non-boolean → false.
    transparent: r.transparent === true,
  };
}

/** Parse a v20 gradient input socket. */
function parseGradient(v: Record<string, unknown>, where: string): GradientInput {
  const axis = v.axis;
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') fail(`${where}.axis must be x|y|z`);
  return {
    kind: 'gradient',
    a: numArray(v.a, 3, `${where}.a`) as [number, number, number],
    b: numArray(v.b, 3, `${where}.b`) as [number, number, number],
    axis,
    offset: numField(v.offset, `${where}.offset`),
    scale: numField(v.scale, `${where}.scale`),
  };
}

/** Parsed pieces of a socket channel (v20): the source kind + its payload. */
interface ParsedChannel {
  kind: 'value' | 'checker' | 'image' | 'gradient';
  value?: number | [number, number, number];
  dataUrl?: string | null;
  gradient?: GradientInput;
}

/** Parse a channel socket. `colorLike` (color channel) allows [r,g,b] values and
 *  the 'checker' procedural kind; scalar channels take a number value. */
function parseChannel(v: unknown, where: string, colorLike: boolean): ParsedChannel {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${where} must be a channel object`);
  const c = v as Record<string, unknown>;
  if (c.kind === 'value') {
    if (colorLike) return { kind: 'value', value: numArray(c.value, 3, `${where}.value`) as [number, number, number] };
    return { kind: 'value', value: numField(c.value, `${where}.value`) };
  }
  // checker/image sockets CARRY the multiplied-in value (engines compute
  // value × map — dropping it changed renders on save→load; UR16-1 verify
  // catch). `value` is optional for tolerance of pre-fix files.
  if (c.kind === 'checker') {
    if (!colorLike) fail(`${where}.kind checker is color-only`);
    return {
      kind: 'checker',
      value: c.value === undefined ? undefined : numArray(c.value, 3, `${where}.value`) as [number, number, number],
    };
  }
  if (c.kind === 'image') {
    if (typeof c.dataUrl !== 'string' && c.dataUrl !== null) fail(`${where}.dataUrl must be a string`);
    const value = c.value === undefined ? undefined
      : colorLike ? numArray(c.value, 3, `${where}.value`) as [number, number, number]
      : numField(c.value, `${where}.value`);
    return { kind: 'image', dataUrl: (c.dataUrl as string | null) ?? null, value };
  }
  if (c.kind === 'gradient') return { kind: 'gradient', gradient: parseGradient(c, where) };
  fail(`${where}.kind must be value|image|gradient${colorLike ? '|checker' : ''}`);
}

/** Parse the alpha channel socket into a runtime ChannelInput<number>. */
function parseAlphaChannel(v: unknown, where: string): ChannelInput<number> {
  const p = parseChannel(v, where, false);
  if (p.kind === 'value') return { kind: 'value', value: p.value as number };
  if (p.kind === 'image') return { kind: 'image', dataUrl: (p.dataUrl as string) ?? '' };
  return p.gradient!;
}

/** Parse the scene material library (absent in v1/v2 → empty). Dispatches on
 *  format: a `shader` string OR a `color` object → v20 socket format; otherwise
 *  the legacy scattered-field format, migrated to shader 'super'/'emit'. */
function parseMaterials(v: unknown): MaterialData[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail('materials must be an array');
  return (v as unknown[]).map((m, mi) => {
    if (typeof m !== 'object' || m === null) fail(`materials[${mi}] is not an object`);
    const mat = m as Record<string, unknown>;
    if (typeof mat.id !== 'number' || !Number.isInteger(mat.id)) fail(`materials[${mi}].id must be an integer`);
    if (typeof mat.name !== 'string') fail(`materials[${mi}].name must be a string`);
    const isV20 = typeof mat.shader === 'string' || (typeof mat.color === 'object' && mat.color !== null && !Array.isArray(mat.color));
    return isV20 ? parseMaterialV20(mat, mi) : parseMaterialLegacy(mat, mi);
  });
}

/** Parse a v20 socket-format material into runtime fields. */
function parseMaterialV20(mat: Record<string, unknown>, mi: number): MaterialData {
  if (mat.shader !== undefined && !(MATERIAL_SHADERS as readonly string[]).includes(mat.shader as string)) {
    fail(`materials[${mi}].shader must be one of ${MATERIAL_SHADERS.join('|')}`);
  }
  const shader = (mat.shader as MaterialShader) ?? 'super';
  const color = parseChannel(mat.color, `materials[${mi}].color`, true);
  const rough = parseChannel(mat.roughness, `materials[${mi}].roughness`, false);
  const metal = parseChannel(mat.metallic, `materials[${mi}].metallic`, false);
  const alpha = mat.alpha === undefined ? ({ kind: 'value', value: 1 } as ChannelInput<number>) : parseAlphaChannel(mat.alpha, `materials[${mi}].alpha`);
  return {
    id: mat.id as number,
    name: mat.name as string,
    shader,
    alpha,
    colorGradient: color.kind === 'gradient' ? color.gradient : undefined,
    roughGradient: rough.kind === 'gradient' ? rough.gradient : undefined,
    metalGradient: metal.kind === 'gradient' ? metal.gradient : undefined,
    // Color channel → baseColor + texKind/texDataUrl. Image/checker sockets
    // restore their carried value (the tint the engines multiply with the
    // map); absent (pre-fix files) → the old neutral defaults.
    baseColor: (color.value as [number, number, number] | undefined) ?? [1, 1, 1],
    texKind: color.kind === 'image' ? 'image' : color.kind === 'checker' ? 'checker' : 'none',
    texDataUrl: color.kind === 'image' ? ((color.dataUrl as string | null) ?? null) : null,
    // Scalar channels → value + map url (carried value restored likewise).
    roughness: (rough.value as number | undefined) ?? 0.5,
    roughDataUrl: rough.kind === 'image' ? ((rough.dataUrl as string | null) ?? null) : null,
    metallic: (metal.value as number | undefined) ?? 0,
    metalDataUrl: metal.kind === 'image' ? ((metal.dataUrl as string | null) ?? null) : null,
    // Super/glass/emit extras.
    transmission: mat.transmission === undefined ? 0 : clampTransmission(numField(mat.transmission, `materials[${mi}].transmission`)),
    ior: mat.ior === undefined ? 1.45 : clampIor(numField(mat.ior, `materials[${mi}].ior`)),
    emissive: mat.emissive === undefined ? [0, 0, 0] : numArray(mat.emissive, 3, `materials[${mi}].emissive`) as [number, number, number],
    emissiveStrength: mat.emissiveStrength === undefined ? 0 : numField(mat.emissiveStrength, `materials[${mi}].emissiveStrength`),
    subsurfaceWeight: mat.subsurfaceWeight === undefined ? 0 : numField(mat.subsurfaceWeight, `materials[${mi}].subsurfaceWeight`),
    subsurfaceRadius: mat.subsurfaceRadius === undefined ? 0.05 : numField(mat.subsurfaceRadius, `materials[${mi}].subsurfaceRadius`),
    shadeless: mat.shadeless === true,
    alphaBlend: mat.alphaBlend === true,
    alwaysTextured: mat.alwaysTextured === true,
    normalDataUrl: optionalUrl(mat.normalDataUrl, `materials[${mi}].normalDataUrl`),
    normalIsBump: mat.normalIsBump === true,
    normalStrength: mat.normalStrength === undefined ? 1 : numField(mat.normalStrength, `materials[${mi}].normalStrength`),
    nodeGraph: parseNodeGraphField(mat.nodeGraph, mi),
    useNodes: mat.useNodes === true,
    bakeRes: parseBakeRes(mat.bakeRes, mi),
  };
}

/** Parse a legacy (pre-v20) scattered-field material and MIGRATE it to the shader
 *  model. The runtime fields are UNCHANGED (so it renders identically); the shader
 *  is synthesized: shadeless → 'emit'; a diffuse-mode image plane → 'diffuse';
 *  everything else → 'super' (the everything shader honors all fields). */
function parseMaterialLegacy(mat: Record<string, unknown>, mi: number): MaterialData {
  const shadeless = mat.shadeless === true;
  const alwaysTextured = mat.alwaysTextured === true;
  const texKind = (() => {
    if (mat.texKind === undefined) return 'none' as const;
    if (mat.texKind !== 'none' && mat.texKind !== 'checker' && mat.texKind !== 'image') {
      fail(`materials[${mi}].texKind must be none|checker|image`);
    }
    return mat.texKind;
  })();
  // Migration shader (RENDER-NEUTRAL — the engine resolves all shaders through the
  // same legacy fields, so this choice only affects UR16-2's channel UI):
  const shader: MaterialShader = shadeless
    ? 'emit'
    : alwaysTextured && texKind === 'image'
    ? 'diffuse'
    : 'super';
  return {
    id: mat.id as number,
    name: mat.name as string,
    shader,
    alpha: { kind: 'value', value: 1 },
    baseColor: numArray(mat.baseColor, 3, `materials[${mi}].baseColor`) as [number, number, number],
    metallic: numField(mat.metallic, `materials[${mi}].metallic`),
    roughness: numField(mat.roughness, `materials[${mi}].roughness`),
    transmission: mat.transmission === undefined ? 0 : clampTransmission(numField(mat.transmission, `materials[${mi}].transmission`)),
    ior: mat.ior === undefined ? 1.45 : clampIor(numField(mat.ior, `materials[${mi}].ior`)),
    emissive: numArray(mat.emissive, 3, `materials[${mi}].emissive`) as [number, number, number],
    emissiveStrength: numField(mat.emissiveStrength, `materials[${mi}].emissiveStrength`),
    subsurfaceWeight: mat.subsurfaceWeight === undefined ? 0 : numField(mat.subsurfaceWeight, `materials[${mi}].subsurfaceWeight`),
    subsurfaceRadius: mat.subsurfaceRadius === undefined ? 0.05 : numField(mat.subsurfaceRadius, `materials[${mi}].subsurfaceRadius`),
    shadeless,
    alphaBlend: mat.alphaBlend === true,
    alwaysTextured,
    texKind,
    texDataUrl: (() => {
      if (mat.texDataUrl === undefined || mat.texDataUrl === null) return null;
      if (typeof mat.texDataUrl !== 'string') fail(`materials[${mi}].texDataUrl must be a string or null`);
      return mat.texDataUrl;
    })(),
    normalDataUrl: optionalUrl(mat.normalDataUrl, `materials[${mi}].normalDataUrl`),
    normalIsBump: mat.normalIsBump === true,
    normalStrength: mat.normalStrength === undefined ? 1 : numField(mat.normalStrength, `materials[${mi}].normalStrength`),
    roughDataUrl: optionalUrl(mat.roughDataUrl, `materials[${mi}].roughDataUrl`),
    metalDataUrl: optionalUrl(mat.metalDataUrl, `materials[${mi}].metalDataUrl`),
    nodeGraph: parseNodeGraphField(mat.nodeGraph, mi),
    useNodes: mat.useNodes === true,
    bakeRes: parseBakeRes(mat.bakeRes, mi),
  };
}

/** Node graph field: sanitizeGraph validates BEFORE any scene mutation. */
function parseNodeGraphField(v: unknown, mi: number): NodeGraph | null {
  if (v === undefined || v === null) return null;
  try {
    return sanitizeGraph(v as NodeGraph);
  } catch (e) {
    return fail(`materials[${mi}].nodeGraph: ${(e as Error).message}`);
  }
}

/** Bake resolution: only 128/256/512/1024 honored; else undefined. */
function parseBakeRes(v: unknown, mi: number): number | undefined {
  if (v === undefined) return undefined;
  const r = numField(v, `materials[${mi}].bakeRes`);
  return [128, 256, 512, 1024].includes(r) ? r : undefined;
}

/** An optional packed-image field: absent/null → null, else a string. */
function optionalUrl(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(`${where} must be a string or null`);
  return v;
}

/** Parse an object's LightData payload (kind 'light' only). */
function parseLight(v: unknown, i: number): LightData {
  if (typeof v !== 'object' || v === null) fail(`objects[${i}].light is missing`);
  const l = v as Record<string, unknown>;
  if (l.type !== 'point' && l.type !== 'sun' && l.type !== 'spot' && l.type !== 'area') {
    fail(`objects[${i}].light.type must be one of point, sun, spot, area`);
  }
  const color = numArray(l.color, 3, `objects[${i}].light.color`) as [number, number, number];
  const power = numField(l.power, `objects[${i}].light.power`);
  if (power < 0) fail(`objects[${i}].light.power must not be negative`);
  const isArea = l.type === 'area';
  return {
    type: l.type as LightType,
    color,
    power,
    spotAngle: numField(l.spotAngle, `objects[${i}].light.spotAngle`),
    spotBlend: numField(l.spotBlend, `objects[${i}].light.spotBlend`),
    // Optional on load (mirrors spotAngle handling); default a small physical
    // size for point/spot, hard (0) for sun/area so old scenes keep sharp
    // sun shadows and area softness comes from width/height instead.
    radius: l.radius === undefined
      ? (l.type === 'sun' || isArea ? 0 : 0.1)
      : Math.max(0, numField(l.radius, `objects[${i}].light.radius`)),
    // Area rectangle (v16/UR10-1) — tolerant: absent → 1×1, clamped > AREA_MIN_SIZE.
    width: isArea
      ? Math.max(AREA_MIN_SIZE, l.width === undefined ? 1 : numField(l.width, `objects[${i}].light.width`))
      : undefined,
    height: isArea
      ? Math.max(AREA_MIN_SIZE, l.height === undefined ? 1 : numField(l.height, `objects[${i}].light.height`))
      : undefined,
  };
}

/** Parse an object's CameraData payload (kind 'camera' only). Focus/Look-At refs
 *  are OBJECT INDICES (UR5-7); they temporarily HOLD the index here and are
 *  remapped to fresh object ids in applySceneJson. Range-checked in parseScene. */
function parseCamera(v: unknown, i: number): CameraData {
  if (typeof v !== 'object' || v === null) fail(`objects[${i}].camera is missing`);
  const c = v as Record<string, unknown>;
  const parseRef = (raw: unknown, name: string): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const idx = numField(raw, `objects[${i}].camera.${name}`);
    if (!Number.isInteger(idx)) fail(`objects[${i}].camera.${name} must be an integer index`);
    return idx;
  };
  const focalLength = numField(c.focalLength, `objects[${i}].camera.focalLength`);
  // F-Stop DoF (UR10-2 Part C). MIGRATION: a scene that stored a raw thin-lens
  // `aperture` (radius, scene units) instead of an fStop loads as
  //   fStop = focalLength / (2000 · aperture)   [inverse of cameraLensRadius]
  // clamped to the supported range, with DoF enabled — so the derived aperture
  // matches the old radius and the old save renders the same. When `fStop` is
  // present it wins (no migration needed).
  let dof = c.dof === true;
  let fStop = 2.8;
  if (typeof c.fStop === 'number' && Number.isFinite(c.fStop)) {
    fStop = clampFStop(c.fStop);
  } else if (typeof c.aperture === 'number' && Number.isFinite(c.aperture) && c.aperture > 0) {
    fStop = clampFStop(focalLength / (2000 * c.aperture));
    dof = true;
  }
  return {
    focalLength,
    near: numField(c.near, `objects[${i}].camera.near`),
    far: numField(c.far, `objects[${i}].camera.far`),
    // Optional (pre-lock files omit it) → false.
    lockToView: c.lockToView === true,
    focusObjectId: parseRef(c.focusObject, 'focusObject'),
    lookAtId: parseRef(c.lookAt, 'lookAt'),
    dof,
    fStop,
    glare: parseGlare(c.glare),
  };
}

/** Parse a CameraData.glare payload (UR10-2 Part B); absent/invalid → undefined
 *  (no glare). Tolerant of partial data — missing fields fall back to defaults. */
function parseGlare(v: unknown): GlareSettings | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const g = v as Record<string, unknown>;
  const n = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    enabled: g.enabled === true,
    threshold: n(g.threshold, 1.0),
    strength: n(g.strength, 0.5),
    radius: n(g.radius, 0.05),
  };
}

/**
 * Parse an object's HtmlPlaneData payload (v13/UR7-1). Tolerant of older/partial
 * data: missing numeric fields fall back to the documented defaults, fps is
 * clamped to 1..15. `kind`/`source` are required and validated.
 */
function parseHtml(v: unknown, i: number): HtmlPlaneData {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`objects[${i}].html must be an object`);
  const h = v as Record<string, unknown>;
  if (h.kind !== 'file' && h.kind !== 'url') fail(`objects[${i}].html.kind must be file or url`);
  if (typeof h.source !== 'string') fail(`objects[${i}].html.source must be a string`);
  const numOr = (raw: unknown, def: number, where: string): number =>
    raw === undefined ? def : numField(raw, where);
  return {
    kind: h.kind,
    source: h.source,
    pageW: numOr(h.pageW, 1024, `objects[${i}].html.pageW`),
    pageH: numOr(h.pageH, 768, `objects[${i}].html.pageH`),
    scrollY: numOr(h.scrollY, 0, `objects[${i}].html.scrollY`),
    playing: h.playing === true,
    fps: clampHtmlFps(numOr(h.fps, 8, `objects[${i}].html.fps`)),
    // UR8-3 A — optional; kept absent (undefined) unless truthy so pre-v15 html
    // payloads round-trip byte-identically and stay minimal.
    transparent: h.transparent === true ? true : undefined,
    autoCrop: h.autoCrop === true ? true : undefined,
  };
}

/** Parse an object's TextData payload (kind 'text' only, v14/UR8-2). */
function parseText(v: unknown, i: number): TextData {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`objects[${i}].text must be an object`);
  const t = v as Record<string, unknown>;
  if (typeof t.content !== 'string') fail(`objects[${i}].text.content must be a string`);
  if (typeof t.font !== 'string') fail(`objects[${i}].text.font must be a string`);
  if (t.align !== 'left' && t.align !== 'center' && t.align !== 'right' && t.align !== 'justify') {
    fail(`objects[${i}].text.align must be left|center|right|justify`);
  }
  if (t.style !== 'face' && t.style !== 'outline' && t.style !== 'both') {
    fail(`objects[${i}].text.style must be face|outline|both`);
  }
  return {
    content: t.content,
    font: t.font,
    size: numField(t.size, `objects[${i}].text.size`),
    wrap: t.wrap === true,
    wrapWidth: numField(t.wrapWidth, `objects[${i}].text.wrapWidth`),
    align: t.align,
    style: t.style,
    faceColor: numArray(t.faceColor, 3, `objects[${i}].text.faceColor`) as [number, number, number],
    outlineColor: numArray(t.outlineColor, 3, `objects[${i}].text.outlineColor`) as [number, number, number],
    thickness: Math.max(0, numField(t.thickness, `objects[${i}].text.thickness`)),
  };
}

/** Parse an object's CurveData payload (kind 'curve' only, v19/UR11-1). */
function parseCurve(v: unknown, i: number): CurveData {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`objects[${i}].curve must be an object`);
  const c = v as Record<string, unknown>;
  if (c.kind !== 'bezier' && c.kind !== 'nurbs') fail(`objects[${i}].curve.kind must be bezier|nurbs`);
  if (!Array.isArray(c.points)) fail(`objects[${i}].curve.points must be an array`);
  const points: CurvePoint[] = (c.points as unknown[]).map((pt, pi) => {
    if (typeof pt !== 'object' || pt === null || Array.isArray(pt)) fail(`objects[${i}].curve.points[${pi}] must be an object`);
    const p = pt as Record<string, unknown>;
    const out: CurvePoint = { co: numArray(p.co, 3, `objects[${i}].curve.points[${pi}].co`) as [number, number, number] };
    if (p.hl !== undefined) out.hl = numArray(p.hl, 3, `objects[${i}].curve.points[${pi}].hl`) as [number, number, number];
    if (p.hr !== undefined) out.hr = numArray(p.hr, 3, `objects[${i}].curve.points[${pi}].hr`) as [number, number, number];
    if (p.w !== undefined) out.w = numField(p.w, `objects[${i}].curve.points[${pi}].w`);
    return out;
  });
  const data: CurveData = {
    kind: c.kind,
    cyclic: c.cyclic === true,
    resolution: clampCurveResolution(c.resolution === undefined ? 12 : numField(c.resolution, `objects[${i}].curve.resolution`)),
    points,
  };
  if (c.order !== undefined) data.order = Math.max(2, Math.round(numField(c.order, `objects[${i}].curve.order`)));
  return data;
}

/** Parse an object's EmptyData payload (kind 'empty' only). */
function parseEmpty(v: unknown, i: number): EmptyData {
  if (typeof v !== 'object' || v === null) fail(`objects[${i}].empty is missing`);
  const e = v as Record<string, unknown>;
  const displaySize = e.displaySize === undefined ? 1 : numField(e.displaySize, `objects[${i}].empty.displaySize`);
  return { displaySize };
}

function parseObject(o: unknown, i: number): ObjectData {
  if (typeof o !== 'object' || o === null) fail(`objects[${i}] is not an object`);
  const obj = o as Record<string, unknown>;
  if (typeof obj.name !== 'string') fail(`objects[${i}].name must be a string`);
  if (typeof obj.visible !== 'boolean') fail(`objects[${i}].visible must be a boolean`);

  // kind: absent (v1/v2) → 'mesh'; otherwise validated.
  let kind: ObjectKind = 'mesh';
  if (obj.kind !== undefined) {
    if (obj.kind !== 'mesh' && obj.kind !== 'light' && obj.kind !== 'camera' && obj.kind !== 'empty' && obj.kind !== 'text' && obj.kind !== 'curve') {
      fail(`objects[${i}].kind must be one of mesh, light, camera, empty, text, curve`);
    }
    kind = obj.kind;
  }

  // materialId: absent (v1/v2) → null; else null or a number.
  let materialId: number | null = null;
  if (obj.materialId !== undefined && obj.materialId !== null) {
    materialId = numField(obj.materialId, `objects[${i}].materialId`);
  }

  // collection: absent (pre-P10) or null → scene root; else an integer index
  // (range-checked against the collections array once both are parsed).
  let collection: number | null = null;
  if (obj.collection !== undefined && obj.collection !== null) {
    const idx = numField(obj.collection, `objects[${i}].collection`);
    if (!Number.isInteger(idx)) fail(`objects[${i}].collection must be an integer index`);
    collection = idx;
  }

  // parent: absent (pre-v4) or null → root; else an objects index
  // (range/cycle-checked once all objects are parsed).
  let parent: number | null = null;
  if (obj.parent !== undefined && obj.parent !== null) {
    const idx = numField(obj.parent, `objects[${i}].parent`);
    if (!Number.isInteger(idx)) fail(`objects[${i}].parent must be an integer index`);
    parent = idx;
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
  const faceIds = new Set(faces.map((f) => f[0]));
  const faceCorners = new Map(faces.map((f) => [f[0], f[1].length]));

  const creases: [number, number, number][] = [];
  if (m.creases !== undefined) {
    if (!Array.isArray(m.creases)) fail(`objects[${i}].mesh.creases must be an array`);
    for (const [ci, c] of (m.creases as unknown[]).entries()) {
      const a = numArray(c, 3, `objects[${i}].mesh.creases[${ci}]`);
      if (!vertIds.has(a[0]) || !vertIds.has(a[1])) fail(`objects[${i}].mesh.creases[${ci}] references a missing vert`);
      if (a[2] < 0 || a[2] > 1) fail(`objects[${i}].mesh.creases[${ci}] weight must be 0..1`);
      creases.push(a as [number, number, number]);
    }
  }
  const tints: [number, number, number, number][] = [];
  if (m.tints !== undefined) {
    if (!Array.isArray(m.tints)) fail(`objects[${i}].mesh.tints must be an array`);
    for (const [ti, c] of (m.tints as unknown[]).entries()) {
      const a = numArray(c, 4, `objects[${i}].mesh.tints[${ti}]`);
      if (!faceIds.has(a[0])) fail(`objects[${i}].mesh.tints[${ti}] references a missing face`);
      tints.push(a as [number, number, number, number]);
    }
  }
  const uvs: number[][] = [];
  if (m.uvs !== undefined) {
    if (!Array.isArray(m.uvs)) fail(`objects[${i}].mesh.uvs must be an array`);
    for (const [ui, entry] of (m.uvs as unknown[]).entries()) {
      if (!Array.isArray(entry) || entry.length < 3 || entry.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        fail(`objects[${i}].mesh.uvs[${ui}] must be [faceId, u0, v0, ...]`);
      }
      const e = entry as number[];
      const corners = faceCorners.get(e[0]);
      if (corners === undefined) fail(`objects[${i}].mesh.uvs[${ui}] references a missing face`);
      if (e.length !== 1 + corners * 2) {
        fail(`objects[${i}].mesh.uvs[${ui}] needs ${corners} uv pairs for face ${e[0]}`);
      }
      uvs.push(e);
    }
  }
  const seams: [number, number][] = [];
  if (m.seams !== undefined) {
    if (!Array.isArray(m.seams)) fail(`objects[${i}].mesh.seams must be an array`);
    for (const [si, s] of (m.seams as unknown[]).entries()) {
      const a = numArray(s, 2, `objects[${i}].mesh.seams[${si}]`);
      if (!vertIds.has(a[0]) || !vertIds.has(a[1])) fail(`objects[${i}].mesh.seams[${si}] references a missing vert`);
      seams.push(a as [number, number]);
    }
  }

  const data: ObjectData = {
    kind,
    name: obj.name,
    visible: obj.visible,
    shadeSmooth: obj.shadeSmooth === true, // absent in v1/v2 files → flat
    color: parseColor(obj.color, i), // absent in older files → default grey
    materialId,
    collection,
    parent,
    anim: parseAnim(obj.anim, i),
    position: numArray(tf.position, 3, `objects[${i}].transform.position`) as [number, number, number],
    rotation: numArray(tf.rotation, 4, `objects[${i}].transform.rotation`) as [number, number, number, number],
    scale: numArray(tf.scale, 3, `objects[${i}].transform.scale`) as [number, number, number],
    mesh: { verts, faces, creases, tints, uvs, seams },
    modifiers: parseModifiers(obj.modifiers, i),
  };

  // Light/camera/empty payloads validated up front (before any scene mutation).
  if (kind === 'light') data.light = parseLight(obj.light, i);
  if (kind === 'camera') data.camera = parseCamera(obj.camera, i);
  if (kind === 'empty') data.empty = obj.empty === undefined ? { displaySize: 1 } : parseEmpty(obj.empty, i);
  // Text payload (v14/UR8-2) — required for kind 'text'.
  if (kind === 'text') data.text = parseText(obj.text, i);
  // Curve payload (v19/UR11-1) — required for kind 'curve'.
  if (kind === 'curve') data.curve = parseCurve(obj.curve, i);
  // HTML plane (v13/UR7-1) — a mesh object with an html payload; absent in older
  // files, so pre-UR7 image planes stay plain static image planes.
  if (obj.html !== undefined) data.html = parseHtml(obj.html, i);
  return data;
}

const INTERPS = ['constant', 'linear', 'bezier', 'sine', 'quad', 'cubic', 'quart', 'back', 'bounce', 'elastic'] as const;
const EASINGS = ['auto', 'in', 'out', 'inout'] as const;

function parseHandle(v: unknown, where: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail(`${where} must be [dframes, dvalue]`);
  return [numField(v[0], `${where}[0]`), numField(v[1], `${where}[1]`)];
}

/** Parse an object's animation block (v7): fcurves of [frame, value, interp]
 *  key triplets; v9 allows a 4th element {e?, hm?, hl?, hr?} carrying the
 *  easing direction and free bezier handles. Keys re-sorted defensively. */
function parseAnim(v: unknown, i: number): AnimData | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) fail(`objects[${i}].anim must be an object`);
  const a = v as Record<string, unknown>;
  if (!Array.isArray(a.fcurves)) fail(`objects[${i}].anim.fcurves must be an array`);
  const fcurves = (a.fcurves as unknown[]).map((c, ci) => {
    if (typeof c !== 'object' || c === null) fail(`objects[${i}].anim.fcurves[${ci}] is not an object`);
    const curve = c as Record<string, unknown>;
    if (typeof curve.channelPath !== 'string') fail(`objects[${i}].anim.fcurves[${ci}].channelPath must be a string`);
    if (!Array.isArray(curve.keys)) fail(`objects[${i}].anim.fcurves[${ci}].keys must be an array`);
    const keys = (curve.keys as unknown[]).map((k, ki) => {
      const where = `objects[${i}].anim.fcurves[${ci}].keys[${ki}]`;
      if (!Array.isArray(k) || k.length < 3 || k.length > 4) fail(`${where} must be [frame, value, interp, extras?]`);
      const frame = numField(k[0], `objects[${i}].anim key frame`);
      const value = numField(k[1], `objects[${i}].anim key value`);
      if (!(INTERPS as readonly string[]).includes(k[2] as string)) {
        fail(`${where} interp must be one of ${INTERPS.join('|')}`);
      }
      const key: Keyframe = { frame, value, interp: k[2] as Keyframe['interp'] };
      if (k.length === 4) {
        const x = k[3];
        if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(`${where}[3] must be an object`);
        const extra = x as Record<string, unknown>;
        if (extra.e !== undefined) {
          if (!(EASINGS as readonly string[]).includes(extra.e as string)) fail(`${where}[3].e must be one of ${EASINGS.join('|')}`);
          if (extra.e !== 'auto') key.easing = extra.e as Keyframe['easing'];
        }
        if (extra.hm !== undefined) {
          if (extra.hm !== 'free') fail(`${where}[3].hm must be "free" when present`);
          key.handleMode = 'free';
          if (extra.hl !== undefined) key.hl = parseHandle(extra.hl, `${where}[3].hl`);
          if (extra.hr !== undefined) key.hr = parseHandle(extra.hr, `${where}[3].hr`);
        }
      }
      return key;
    });
    keys.sort((x, y) => x.frame - y.frame);
    return { channelPath: curve.channelPath, keys };
  });
  return { fcurves };
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
  for (const [a, b, w] of data.creases) mesh.creases.set(EditableMesh.edgeKey(a, b), w);
  for (const [f, r, g, bl] of data.tints) mesh.faceTints.set(f, [r, g, bl]);
  for (const entry of data.uvs) {
    const pairs: [number, number][] = [];
    for (let k = 1; k < entry.length; k += 2) pairs.push([entry[k], entry[k + 1]]);
    mesh.uvs.set(entry[0], pairs);
  }
  for (const [a, b] of data.seams) mesh.seams.add(EditableMesh.edgeKey(a, b));
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
/**
 * v8 migration: the world switched from Y-up to Z-up (Blender convention).
 * Older files were authored Y-up, so rotate their ROOT content by +90° about X
 * (old +Y up → new +Z up; children ride their parents). Pure data-level:
 *  - root transforms: position/rotation premultiplied by Rx90 (scale is local);
 *  - root location fcurves: new z = old y verbatim, new y = old z negated;
 *  - root euler-rotation fcurves: recomposed per keyed frame (Rx90 ∘ old);
 *  - 3D cursor rotated; orbit-camera target rotated (yaw/pitch carry over
 *    unchanged — the orbit frame rotates with the world).
 */
function migrateYupToZup(data: SceneData): void {
  const R = Quat.fromAxisAngle(Vec3.X, Math.PI / 2);
  const rot = (v: [number, number, number]): [number, number, number] => [v[0], -v[2], v[1]];
  data.cursor = rot(data.cursor);
  data.camera.target = rot(data.camera.target);
  for (const od of data.objects) {
    if (od.parent !== null) continue; // children inherit the parent's new frame
    od.position = rot(od.position);
    const q = new Quat(od.rotation[0], od.rotation[1], od.rotation[2], od.rotation[3]);
    const q2 = R.mul(q);
    od.rotation = [q2.x, q2.y, q2.z, q2.w];
    if (!od.anim) continue;
    const curves = od.anim.fcurves;
    const find = (path: string) => curves.find((c) => c.channelPath === path);
    // location: swap the vertical channel in (values: newY = -oldZ, newZ = oldY).
    const locY = find('location.y');
    const locZ = find('location.z');
    if (locY) locY.channelPath = 'location.z';
    if (locZ) {
      locZ.channelPath = 'location.y';
      for (const k of locZ.keys) k.value = -k.value;
    }
    // rotation (euler XYZ): recompose Rx90 ∘ R(e) at every keyed frame. Exact at
    // keys; between keys the auto-tangent interpolation differs infinitesimally.
    const rotCurves = (['x', 'y', 'z'] as const).map((a) => find(`rotation.${a}`));
    if (rotCurves.some(Boolean)) {
      const frames = [...new Set(rotCurves.flatMap((c) => c ? c.keys.map((k) => k.frame) : []))].sort((a, b) => a - b);
      const rest = q.toEulerXYZ();
      const evalAt = (c: (typeof rotCurves)[number], frame: number, fallback: number): number => {
        if (!c) return fallback;
        return evalFCurve(c, frame);
      };
      const newKeys: { frame: number; e: { x: number; y: number; z: number }; interp: Interp }[] = frames.map((frame) => {
        const e = {
          x: evalAt(rotCurves[0], frame, rest.x),
          y: evalAt(rotCurves[1], frame, rest.y),
          z: evalAt(rotCurves[2], frame, rest.z),
        };
        const composed = R.mul(Quat.fromEulerXYZ(e.x, e.y, e.z)).toEulerXYZ();
        const src = rotCurves.map((c) => c?.keys.find((k) => k.frame === frame));
        const interp: Interp = (src.find(Boolean)?.interp) ?? 'bezier';
        return { frame, e: composed, interp };
      });
      od.anim.fcurves = curves.filter((c) => !c.channelPath.startsWith('rotation.'));
      for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
        void i;
        od.anim.fcurves.push({
          channelPath: `rotation.${axis}`,
          keys: newKeys.map((k) => ({ frame: k.frame, value: k.e[axis], interp: k.interp })),
        });
      }
    }
  }
}

export function applySceneJson(json: string, scene: Scene, camera: OrbitCamera): void {
  const data = parseScene(json);
  if (data.version < 8) migrateYupToZup(data);
  // Build meshes AND modifier instances up front — any failure here (already
  // ruled out by validation, but createModifier is the source of truth) throws
  // before the first scene mutation, so a bad file can never half-load.
  const built = data.objects.map((od) => ({
    od,
    // Mesh-kind AND text objects carry geometry; lights/cameras/empties get an
    // empty mesh from the scene.addX helper.
    mesh: od.kind === 'mesh' || od.kind === 'text' ? buildMesh(od.mesh) : null,
    modifiers: od.modifiers.map(buildModifier),
  }));

  // Past validation — now it's safe to mutate. Drop existing objects + materials
  // via the public API (never `objects.length = 0`).
  scene.exitEditMode();
  for (const obj of [...scene.objects]) scene.remove(obj.id);
  for (const mat of [...scene.materials]) scene.removeMaterial(mat.id);
  for (const col of [...scene.collections]) scene.removeCollection(col.id);
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
      shader: md.shader,
      alpha: md.alpha.kind === 'gradient'
        ? { kind: 'gradient', a: [...md.alpha.a], b: [...md.alpha.b], axis: md.alpha.axis, offset: md.alpha.offset, scale: md.alpha.scale }
        : { ...md.alpha },
      colorGradient: md.colorGradient ? { ...md.colorGradient, a: [...md.colorGradient.a], b: [...md.colorGradient.b] } : undefined,
      roughGradient: md.roughGradient ? { ...md.roughGradient, a: [...md.roughGradient.a], b: [...md.roughGradient.b] } : undefined,
      metalGradient: md.metalGradient ? { ...md.metalGradient, a: [...md.metalGradient.a], b: [...md.metalGradient.b] } : undefined,
      baseColor: [...md.baseColor],
      metallic: md.metallic,
      roughness: md.roughness,
      transmission: md.transmission,
      ior: md.ior,
      emissive: [...md.emissive],
      emissiveStrength: md.emissiveStrength,
      subsurfaceWeight: md.subsurfaceWeight,
      subsurfaceRadius: md.subsurfaceRadius,
      shadeless: md.shadeless,
      alphaBlend: md.alphaBlend,
      alwaysTextured: md.alwaysTextured,
      texKind: md.texKind,
      texDataUrl: md.texDataUrl,
      normalDataUrl: md.normalDataUrl,
      normalIsBump: md.normalIsBump,
      normalStrength: md.normalStrength,
      roughDataUrl: md.roughDataUrl,
      metalDataUrl: md.metalDataUrl,
      nodeGraph: md.nodeGraph,
      useNodes: md.useNodes,
      bakeRes: md.bakeRes,
    };
    scene.materials.push(mat);
    if (md.id > maxMaterialId) maxMaterialId = md.id;
  }
  if (maxMaterialId >= 0) {
    (scene as unknown as { nextMaterialId: number }).nextMaterialId = maxMaterialId + 1;
  }

  // Rebuild collections first so member indices can resolve to fresh ids.
  const rebuiltCols = data.collections.map((cd) => {
    const col = scene.addCollection(cd.name);
    col.visible = cd.visible;
    return col;
  });

  // Rebuild objects through the kind-aware public API so kinds are real.
  const rebuilt: SceneObject[] = [];
  for (const { od, mesh, modifiers } of built) {
    let obj: SceneObject;
    if (od.kind === 'light') {
      obj = scene.addLight(od.name, od.light!.type, { ...od.light!, color: [...od.light!.color] });
    } else if (od.kind === 'camera') {
      // Focus/Look-At still hold INDICES here — remapped to ids below.
      obj = scene.addCamera(od.name, { ...od.camera! });
    } else if (od.kind === 'empty') {
      obj = scene.addEmpty(od.name, { ...od.empty! });
    } else if (od.kind === 'curve') {
      // Deep-copy the payload so the loaded object is independent of parse data.
      obj = scene.addCurve(od.name, {
        ...od.curve!,
        points: od.curve!.points.map((p) => ({ ...p, co: [...p.co], ...(p.hl ? { hl: [...p.hl] } : {}), ...(p.hr ? { hr: [...p.hr] } : {}) })) as CurvePoint[],
      });
    } else if (od.kind === 'text') {
      // Restore the payload AND the last-generated mesh verbatim (byte-identical
      // round trips). The text driver re-derives the mesh from the payload on the
      // first frame; for a headless/Node load there is no driver, so the stored
      // mesh stands in.
      obj = scene.addText(od.name, { ...od.text!, faceColor: [...od.text!.faceColor], outlineColor: [...od.text!.outlineColor] });
      obj.mesh = mesh!;
    } else {
      obj = scene.add(od.name, mesh!);
    }
    obj.visible = od.visible;
    obj.shadeSmooth = od.shadeSmooth === true;
    obj.color = [od.color[0], od.color[1], od.color[2]];
    obj.materialId = od.materialId;
    obj.collectionId = od.collection === null ? null : rebuiltCols[od.collection].id;
    obj.transform = new Transform(
      Vec3.fromArray(od.position),
      new Quat(od.rotation[0], od.rotation[1], od.rotation[2], od.rotation[3]),
      Vec3.fromArray(od.scale),
    );
    // HTML-plane payload (v13/UR7-1) — set BEFORE applyAnimation so a keyed
    // html.playing samples onto a live payload (byte-identical round trips).
    // UR7-3: a URL plane always LOADS PAUSED so opening a file never silently
    // hits the network or pops a live portal — the plane shows its card/raster
    // until the user presses ▶. (kind 'file' planes keep their saved play state.)
    if (od.html) {
      obj.html = { ...od.html };
      if (obj.html.kind === 'url') obj.html.playing = false;
    }
    obj.modifiers.push(...modifiers);
    if (modifiers.length > 0) obj.modifiersVersion++;
    rebuilt.push(obj);
  }

  // addCamera auto-activates the first camera; override with the saved choice
  // (an objects index — already validated to point at a camera).
  scene.activeCameraId = data.activeCamera === null ? null : rebuilt[data.activeCamera].id;

  // Parent indices (v4, already validated acyclic) → fresh ids.
  for (const [i, { od }] of built.entries()) {
    rebuilt[i].parentId = od.parent === null ? null : rebuilt[od.parent].id;
  }

  // Camera Focus/Look-At refs (UR5-7): saved as objects INDICES — remap onto the
  // rebuilt objects' fresh ids. Out-of-range (defensive) → unset. The clone from
  // addCamera copied the indices onto rebuilt[i].camera; overwrite with ids.
  for (const [i, { od }] of built.entries()) {
    if (od.kind !== 'camera' || !od.camera || !rebuilt[i].camera) continue;
    const cam = rebuilt[i].camera!;
    const remap = (idx: number | undefined): number | undefined =>
      idx !== undefined && idx >= 0 && idx < rebuilt.length ? rebuilt[idx].id : undefined;
    cam.focusObjectId = remap(od.camera.focusObjectId);
    cam.lookAtId = remap(od.camera.lookAtId);
  }

  // 3D cursor + pivot mode (P12).
  scene.cursor = Vec3.fromArray(data.cursor);
  scene.pivotMode = data.pivotMode;

  // Timeline + animation (v7/P15).
  scene.frameStart = data.frameStart;
  scene.frameEnd = data.frameEnd;
  scene.frameCurrent = data.frameCurrent;
  // Output resolution (v12/UR5-5) + transparent film (UR16-3).
  scene.renderSettings = {
    width: data.renderSettings.width,
    height: data.renderSettings.height,
    transparent: data.renderSettings.transparent,
  };
  for (const [i, { od }] of built.entries()) {
    if (od.anim) rebuilt[i].anim = od.anim;
  }
  // Land posed at the saved frame (idempotent: stored transforms are already
  // the sampled values, so re-serializing stays byte-identical).
  applyAnimation(scene, scene.frameCurrent);

  // 'object'-kind modifier params were saved as objects INDICES — remap them
  // onto the rebuilt objects' fresh ids (-1 stays "none", as does out-of-range).
  for (const obj of rebuilt) {
    for (const mod of obj.modifiers) {
      for (const field of mod.fields()) {
        if (field.kind !== 'object') continue;
        const idx = mod.params()[field.key];
        const id = typeof idx === 'number' && idx >= 0 && idx < rebuilt.length ? rebuilt[idx].id : -1;
        mod.setParam(field.key, id);
      }
    }
  }

  // Environment: adopt the parsed world (fresh object, no aliasing) and, when it
  // packs an HDRI, rebuild the decoded pixel cache off-thread (browser only —
  // Node/jsdom test loads just leave hdriImage null → tracer uses the gradient).
  scene.world = data.world;
  if (data.world.mode === 'hdri' && data.world.hdri && typeof Image !== 'undefined') {
    const w = data.world;
    decodeHdriDataUrl(w.hdri!).then((img) => { if (scene.world === w) w.hdriImage = img; }).catch(() => { /* leave gradient fallback */ });
  }

  if (scene.objects.length > 0) scene.selectOnly(scene.objects[0].id);

  camera.target = Vec3.fromArray(data.camera.target);
  camera.distance = data.camera.distance;
  camera.yaw = data.camera.yaw;
  camera.pitch = data.camera.pitch;
}
