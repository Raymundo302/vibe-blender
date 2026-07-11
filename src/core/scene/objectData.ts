import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import type { Transform } from '../math/transform';

/**
 * Phase 8 data payloads: what makes a SceneObject a light, a camera, or a
 * material user. Plain data only — no GL, no DOM — so serialization (P8-5)
 * and the path tracer (P8-4) can consume these without touching the renderer.
 */

export type ObjectKind = 'mesh' | 'light' | 'camera' | 'empty' | 'text';

export type LightType = 'point' | 'sun' | 'spot';

export interface LightData {
  type: LightType;
  /** Linear RGB 0..1. */
  color: [number, number, number];
  /**
   * Blender-style strength: watt-ish for point/spot (falls off 1/d²),
   * direct irradiance multiplier for sun (no falloff).
   */
  power: number;
  /** Spot cone FULL angle in radians (spot only; kept on all for simplicity). */
  spotAngle: number;
  /** 0..1 edge softness fraction of the cone (spot only). */
  spotBlend: number;
  /**
   * Soft-shadow source size (path tracer only; raster shading stays hard).
   * Point/spot: emitter sphere radius in world units. Sun: angular radius in
   * radians. 0 = hard shadow. Optional so pre-radius scenes/tests still parse.
   */
  radius?: number;
}

export function defaultLight(type: LightType): LightData {
  return {
    type,
    color: [1, 1, 1],
    power: type === 'sun' ? 3 : 100,
    spotAngle: (45 * Math.PI) / 180,
    spotBlend: 0.15,
    // Sun defaults to a hard shadow (angular radius 0); point/spot get a small
    // physical size so soft shadows are visible out of the box.
    radius: type === 'sun' ? 0 : 0.1,
  };
}

export interface CameraData {
  /** Focal length in mm on a 36×24mm sensor (Blender default sensor). */
  focalLength: number;
  near: number;
  far: number;
  /**
   * Blender's "Lock Camera to View": while looking through this camera
   * (Numpad0), viewport navigation MOVES the camera instead of exiting the
   * view. Optional so pre-lock scenes/tests still parse (default false).
   */
  lockToView?: boolean;
  /**
   * Focus Object for depth-of-field (UR5-7). When set to a scene object id, the
   * tracer's focus distance is overridden per render/frame by the distance from
   * the camera's world position to the target's world origin (an animated target
   * refocuses per frame). Manual focus distance applies when unset. Optional so
   * old scenes/tests parse unchanged. Serialized as an OBJECT INDEX, not an id
   * (the P8 rule): the field briefly HOLDS an index during load, then the loader
   * remaps it to the rebuilt object's fresh id.
   */
  focusObjectId?: number;
  /**
   * Look At target (UR5-7). When set, the camera's world ORIENTATION is replaced
   * by an aim-at-target basis (local -Z toward the target's world origin, up =
   * world +Z), computed centrally in Scene.cameraWorldMatrix so every consumer
   * agrees. Position still comes from the transform/parenting. Optional; absent
   * → the camera uses its own rotation. Serialized as an OBJECT INDEX like
   * focusObjectId.
   */
  lookAtId?: number;
}

export function defaultCamera(): CameraData {
  return { focalLength: 50, near: 0.1, far: 500, lockToView: false };
}

/**
 * The rotation a fresh Shift+A camera spawns with (UR5-5, Part B). With identity
 * rotation a camera looks along local -Z — in our Z-up world that points at the
 * floor. This +90° about world X re-aims local -Z toward world +Y (the horizon)
 * while keeping local +Y along world +Z (up), so Numpad0 through a new camera
 * shows the horizon, not the ground. Applied where the add menu creates the
 * object (addMenu.commitAdd), NOT inside Scene.addCamera — scene loads restore a
 * saved transform and must not be double-rotated.
 */
export const CAMERA_SPAWN_ROTATION: Quat = Quat.fromAxisAngle(Vec3.X, Math.PI / 2);

/** Empty object payload (UR5-7): a null object (rig/target helper) drawn as
 *  plain axes. `displaySize` is the half-extent of the world-axis cross. */
export interface EmptyData {
  displaySize: number;
}

export function defaultEmpty(): EmptyData {
  return { displaySize: 1 };
}

/**
 * Text-object payload (UR8-2): what makes a SceneObject a text object. The
 * object's mesh is REGENERATED from these fields by buildTextMesh (UR8-1) on any
 * payload change — the payload is the source of truth, the mesh is derived. Plain
 * data only (serialized into the scene, sampled by the animation channel
 * `text.thickness`). Precedent: light/camera/empty payloads. Set iff the object
 * is kind 'text'; absent on every other kind and in scenes saved before UR8-2.
 */
export interface TextData {
  /** The string; `\n` starts a new line. */
  content: string;
  /** Font family name (probed for availability; canvas falls back when absent). */
  font: string;
  /** World units per em (glyph size). */
  size: number;
  /** Word-wrap toggle (off by default). */
  wrap: boolean;
  /** Wrap column in em units — used only when `wrap` is on. */
  wrapWidth: number;
  align: 'left' | 'center' | 'right' | 'justify';
  /** face = filled caps + walls; outline = hollow band; both = face + band. */
  style: 'face' | 'outline' | 'both';
  /** Linear RGB 0..1 of the filled faces. */
  faceColor: [number, number, number];
  /** Linear RGB 0..1 of the outline band. */
  outlineColor: [number, number, number];
  /** Extrude depth in world units — the KEYABLE `text.thickness` channel. */
  thickness: number;
}

/** Fresh payload for a newly-added text object (Shift+A default). */
export function defaultTextData(): TextData {
  return {
    content: 'Text',
    font: 'monospace',
    size: 0.5,
    wrap: false,
    wrapWidth: 12,
    align: 'left',
    style: 'face',
    faceColor: [1, 1, 1],
    outlineColor: [0, 0, 0],
    thickness: 0.05,
  };
}

/** Deep copy of a TextData (its non-primitives are the two color triples). */
export function cloneTextData(t: TextData): TextData {
  return { ...t, faceColor: [...t.faceColor], outlineColor: [...t.outlineColor] };
}

/**
 * HTML-plane payload (UR7-1): what makes a (mesh) SceneObject an HTML plane —
 * a web page rasterized onto the plane whose CSS animation is sampled by a
 * single page clock (see anim/pageTime), and whose **Play** state is a KEYABLE
 * channel ("html.playing"). Precedent: light/camera/empty payloads. Set iff the
 * object is an HTML plane; scenes saved before UR7-1 load with `html` absent, so
 * pre-UR7 image planes are untouched. Plain data only (serialized into the scene
 * for kind 'file').
 */
export interface HtmlPlaneData {
  /** file = self-contained HTML text serialized into the scene; url = an address
   *  (URL planes are UR7-3 — the field + serialization exist now). */
  kind: 'file' | 'url';
  /** kind 'file': the full HTML source text. kind 'url': the address. */
  source: string;
  /** Raster viewport width, CSS px (default 1024). */
  pageW: number;
  /** Raster viewport height, CSS px (default 768). */
  pageH: number;
  /** Page scroll offset in CSS px (consumed in UR7-2; serialized now). */
  scrollY: number;
  /** The keyable play state (the "html.playing" animation channel). */
  playing: boolean;
  /** Re-raster cap for live viewport playback, fps (clamped 1..15, default 8). */
  fps: number;
  /** UR8-3 A: rasterize with a TRANSPARENT background (no white ground) — set for
   *  bare fragments so the plane keeps real alpha. The playback driver re-uses this
   *  so re-rasters (scrub/playback) don't clobber the transparency. Default false. */
  transparent?: boolean;
  /** UR8-3 A: auto-crop the raster to the content bbox. When set, pageW/pageH hold
   *  the CROP box and re-rasters reproduce it from the base 1024×768. Default false. */
  autoCrop?: boolean;
}

export const HTML_PLANE_DEFAULT_W = 1024;
export const HTML_PLANE_DEFAULT_H = 768;
export const HTML_PLANE_DEFAULT_FPS = 8;
export const HTML_PLANE_FPS_MIN = 1;
export const HTML_PLANE_FPS_MAX = 15;

/** Clamp an html re-raster fps into the supported 1..15 range. */
export function clampHtmlFps(fps: number): number {
  if (!Number.isFinite(fps)) return HTML_PLANE_DEFAULT_FPS;
  return Math.max(HTML_PLANE_FPS_MIN, Math.min(HTML_PLANE_FPS_MAX, fps));
}

/** Fresh payload for a newly-added HTML plane (playing off, at page-clock 0). */
export function defaultHtmlPlaneData(kind: 'file' | 'url', source: string): HtmlPlaneData {
  return {
    kind,
    source,
    pageW: HTML_PLANE_DEFAULT_W,
    pageH: HTML_PLANE_DEFAULT_H,
    scrollY: 0,
    playing: false,
    fps: HTML_PLANE_DEFAULT_FPS,
  };
}

/**
 * The single mm↔FOV convention for the whole app: a 36×24mm sensor, so the
 * vertical half-height is 12mm. Both the through-camera projection (via
 * `cameraFovY`) and the viewport-lens field (UR5-6, N-panel View tab) go through
 * these two helpers so there is exactly ONE formula and ONE sensor constant.
 */
const SENSOR_HALF_HEIGHT_MM = 12;

/** Vertical FOV (radians) from a focal length in mm. */
export function focalLengthToFovY(focalMm: number): number {
  return 2 * Math.atan(SENSOR_HALF_HEIGHT_MM / focalMm);
}

/** Focal length in mm from a vertical FOV (radians) — the exact inverse. */
export function fovYToFocalLength(fovY: number): number {
  return SENSOR_HALF_HEIGHT_MM / Math.tan(fovY / 2);
}

/** Vertical FOV (radians) from focal length: 24mm-tall sensor → half-height 12. */
export function cameraFovY(cam: CameraData): number {
  return focalLengthToFovY(cam.focalLength);
}

/**
 * The direction a light/camera aims: local -Z rotated by the object's rotation
 * (Blender convention — a new sun points straight down after X-rot 0 means -Z…
 * we keep identity = looking down -Z like Blender's camera).
 */
export function objectForward(t: Transform): Vec3 {
  return t.rotation.rotate(new Vec3(0, 0, -1));
}

// --- Materials ---------------------------------------------------------------

export interface Material {
  /** Stable id, unique within the scene (referenced by SceneObject.materialId). */
  readonly id: number;
  name: string;
  /** Linear RGB 0..1 albedo. */
  baseColor: [number, number, number];
  /** 0 = dielectric, 1 = metal. */
  metallic: number;
  /** 0 = mirror, 1 = fully rough. */
  roughness: number;
  /** Linear RGB emission color. */
  emissive: [number, number, number];
  emissiveStrength: number;
  /** 0 = opaque surface, 1 = full subsurface scattering (donut flesh). */
  subsurfaceWeight: number;
  /** Mean scatter distance in world units (Blender's Scale, roughly). */
  subsurfaceRadius: number;
  /** Shadeless (UR4-3): output the base/texture color DIRECTLY — no lighting,
   *  no shadows (Blender's "Emit"/image-plane look for blueprints & refs). The
   *  Rendered viewport bypasses the BRDF sum; the tracer treats the hit as
   *  emission of the base×texture color and gathers no further bounces. Screen-
   *  space AO still multiplies in Rendered mode. Optional; absent → false, so
   *  pre-v10 scenes/materials are byte-identically unaffected. */
  shadeless?: boolean;
  /** Alpha blending (UR8-3 B): the material's base-color texture carries real
   *  transparency (its alpha channel). Rendered viewport draws these in a second
   *  blended pass (back-to-front, depth-write off); the tracer treats alpha<0.5
   *  as a cutout (ray passes through); alphaBlend objects DON'T cast shadow-map /
   *  AO occlusion. Set automatically for transparent HTML rasters. Optional;
   *  absent → false, so opaque materials are byte-identically unaffected. */
  alphaBlend?: boolean;
  /** Always Textured (UR8-3 C): the object shows its texture in EVERY solid
   *  shading mode (matcap / studio / wireframe), not just Rendered — image + HTML
   *  planes look like themselves everywhere. Set TRUE by default when an image /
   *  html plane creates its material; off → the plane shades like any mesh
   *  (matcap grey). Optional; absent → false. */
  alwaysTextured?: boolean;
  /** Base-color texture (P11): none, procedural checker, or a packed image. */
  texKind: 'none' | 'checker' | 'image';
  /** Packed image as a data URL when texKind === 'image' (worldData-style). */
  texDataUrl: string | null;
  /** Normal/bump map (P13): packed image data URL, or null = off. */
  normalDataUrl: string | null;
  /** Interpret normalDataUrl as a HEIGHT field (bump) instead of a
   *  tangent-space normal map. */
  normalIsBump: boolean;
  /** Normal/bump perturbation strength (0..2, default 1). */
  normalStrength: number;
  /** Grayscale roughness map — MULTIPLIES `roughness`. null = off. */
  roughDataUrl: string | null;
  /** Grayscale metallic map — MULTIPLIES `metallic`. null = off. */
  metalDataUrl: string | null;
  /** Shader node graph (P14, A14). null = no graph created yet. */
  nodeGraph: import('../nodes/nodeGraph').NodeGraph | null;
  /** When true (and nodeGraph exists), shading comes from the graph: the
   *  tracer evaluates it per hit; the Rendered viewport uses baked textures. */
  useNodes: boolean;
  /** Node-bake resolution for the Rendered viewport (128/256/512/1024).
   *  Optional; absent → 128 (the historical fixed size). Serialized. */
  bakeRes?: number;
  /** Runtime node-bake cache (Rendered viewport, NOT serialized): the graph
   *  baked to `size`² textures at `version` (a counter the shader editor
   *  bumps). `meshVersion` is set only when generated coords were rasterized
   *  from the mesh, so a geometry edit re-bakes. */
  baked?: {
    version: number;
    size: number;
    meshVersion?: number;
    baseUrl: string;
    roughUrl: string;
    metalUrl: string;
  };
  /** Bumped by the shader editor on ANY graph mutation → re-bake + re-trace. */
  nodeGraphVersion?: number;
  /** Runtime decoded pixels cache — NOT serialized (rebuilt on load/select).
   *  `alpha` (UR8-3) is the per-pixel alpha channel (0..1, row 0 = top), present
   *  when the packed image had transparency — the tracer's cutout reads it. */
  texImage?: { width: number; height: number; pixels: Float32Array; alpha?: Float32Array };
  /** Runtime decoded map caches (P13) — NOT serialized. Raw 0..1 values (no
   *  sRGB conversion — normal/rough/metal maps store data, not color). */
  normalImage?: { width: number; height: number; pixels: Float32Array };
  roughImage?: { width: number; height: number; pixels: Float32Array };
  metalImage?: { width: number; height: number; pixels: Float32Array };
}

/** What objects without an assigned material render as (Blender's grey). */
export const DEFAULT_MATERIAL: Readonly<Material> = Object.freeze({
  id: -1,
  name: 'Default',
  baseColor: [0.8, 0.8, 0.8] as [number, number, number],
  metallic: 0,
  roughness: 0.5,
  emissive: [0, 0, 0] as [number, number, number],
  emissiveStrength: 0,
  subsurfaceWeight: 0,
  subsurfaceRadius: 0.05,
  shadeless: false,
  texKind: 'none' as const,
  texDataUrl: null,
  normalDataUrl: null,
  normalIsBump: false,
  normalStrength: 1,
  roughDataUrl: null,
  metalDataUrl: null,
  nodeGraph: null,
  useNodes: false,
});

/** Fresh mutable material with default params (scene assigns the id). */
export function makeMaterial(id: number, name: string): Material {
  return {
    id,
    name,
    baseColor: [0.8, 0.8, 0.8],
    metallic: 0,
    roughness: 0.5,
    emissive: [0, 0, 0],
    emissiveStrength: 0,
    subsurfaceWeight: 0,
    subsurfaceRadius: 0.05,
    shadeless: false,
    texKind: 'none',
    texDataUrl: null,
    normalDataUrl: null,
    normalIsBump: false,
    normalStrength: 1,
    roughDataUrl: null,
    metalDataUrl: null,
    nodeGraph: null,
    useNodes: false,
  };
}
