import { Vec3 } from '../math/vec3';
import type { Transform } from '../math/transform';

/**
 * Phase 8 data payloads: what makes a SceneObject a light, a camera, or a
 * material user. Plain data only — no GL, no DOM — so serialization (P8-5)
 * and the path tracer (P8-4) can consume these without touching the renderer.
 */

export type ObjectKind = 'mesh' | 'light' | 'camera';

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
}

export function defaultCamera(): CameraData {
  return { focalLength: 50, near: 0.1, far: 500, lockToView: false };
}

/** Vertical FOV (radians) from focal length: 24mm-tall sensor → half-height 12. */
export function cameraFovY(cam: CameraData): number {
  return 2 * Math.atan(12 / cam.focalLength);
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
  /** Runtime decoded pixels cache — NOT serialized (rebuilt on load/select). */
  texImage?: { width: number; height: number; pixels: Float32Array };
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
