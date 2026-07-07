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
}

export function defaultLight(type: LightType): LightData {
  return {
    type,
    color: [1, 1, 1],
    power: type === 'sun' ? 3 : 100,
    spotAngle: (45 * Math.PI) / 180,
    spotBlend: 0.15,
  };
}

export interface CameraData {
  /** Focal length in mm on a 36×24mm sensor (Blender default sensor). */
  focalLength: number;
  near: number;
  far: number;
}

export function defaultCamera(): CameraData {
  return { focalLength: 50, near: 0.1, far: 500 };
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
  };
}
