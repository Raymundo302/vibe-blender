import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import type { Transform } from '../math/transform';

/**
 * Phase 8 data payloads: what makes a SceneObject a light, a camera, or a
 * material user. Plain data only — no GL, no DOM — so serialization (P8-5)
 * and the path tracer (P8-4) can consume these without touching the renderer.
 */

export type ObjectKind = 'mesh' | 'light' | 'camera' | 'empty' | 'text' | 'curve';

export type LightType = 'point' | 'sun' | 'spot' | 'area';

/** Minimum world-unit extent for an area light's width/height (clamp > 0.01). */
export const AREA_MIN_SIZE = 0.01;

export interface LightData {
  type: LightType;
  /** Linear RGB 0..1. */
  color: [number, number, number];
  /**
   * Blender-style strength: watt-ish for point/spot/area (falls off 1/d²),
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
   * Unused for area lights (their softness comes from the rect's width/height).
   */
  radius?: number;
  /**
   * Area light only (UR10-1): the emitting rectangle's width/height in world
   * units, in the light's local X/Y plane. Emits from its face along local −Z
   * (Blender convention, same aim as spot/sun). Clamped to > AREA_MIN_SIZE.
   * Optional so pre-area scenes/tests parse; absent → 1×1.
   */
  width?: number;
  height?: number;
}

export function defaultLight(type: LightType): LightData {
  const l: LightData = {
    type,
    color: [1, 1, 1],
    power: type === 'sun' ? 3 : 100,
    spotAngle: (45 * Math.PI) / 180,
    spotBlend: 0.15,
    // Sun defaults to a hard shadow (angular radius 0); point/spot get a small
    // physical size so soft shadows are visible out of the box. Area lights get
    // no sphere radius (softness is the rect's extent).
    radius: type === 'sun' || type === 'area' ? 0 : 0.1,
  };
  // width/height are AREA-ONLY so point/spot/sun payloads stay identical to the
  // pre-UR10-1 shape (the tab, serializer and tracer all default them to 1×1).
  if (type === 'area') {
    l.width = 1;
    l.height = 1;
  }
  return l;
}

/**
 * Area-light EMITTED RADIANCE scale factor (UR10-1 energy model). A Lambertian
 * rectangle of area w·h radiating `power` has emitted radiance Le = power /
 * (4π·w·h) per unit color — the same power→radiance premultiply as a point light
 * (power/4π), divided by the emitter area. Consequence (Blender's feel): a bigger
 * light at the same power is DIMMER per-area (smaller Le) but the total light a
 * surface receives is unchanged (the solid-angle estimator multiplies Le back by
 * the area A), so only the SHADOWS get softer. Clamps the extents like the model.
 * Exported for the energy-formula unit test.
 */
export function areaEmittedRadiance(power: number, width: number, height: number): number {
  const w = Math.max(width, AREA_MIN_SIZE);
  const h = Math.max(height, AREA_MIN_SIZE);
  return power / (4 * Math.PI * w * h);
}

/**
 * Camera Glare / bloom (UR10-2 Part B). A post-process applied wherever this
 * camera renders: F12 / Ctrl+F12 tracer output and the Rendered viewport when
 * looking THROUGH the camera. Bright-pass (luminance ≥ threshold) → separable
 * Gaussian at `radius` → add ×strength. Pure function of the frame — no temporal
 * accumulation. Optional on CameraData so pre-UR10-2 scenes/tests parse unchanged
 * (absent → no glare, byte-identical).
 */
export interface GlareSettings {
  enabled: boolean;
  /** Luminance cutoff for the bright-pass (default 1.0 — only HDR-ish pixels
   *  above display white bloom). */
  threshold: number;
  /** Additive bloom scale (default 0.5). */
  strength: number;
  /** Gaussian blur radius as a FRACTION of image height (default 0.05). */
  radius: number;
}

/** Fresh Glare payload (disabled, Blender-ish defaults). */
export function defaultGlare(): GlareSettings {
  return { enabled: false, threshold: 1.0, strength: 0.5, radius: 0.05 };
}

/** Deep copy of a GlareSettings (all fields primitive). */
export function cloneGlare(g: GlareSettings): GlareSettings {
  return { ...g };
}

/** F-Stop clamp range (UR10-2 Part C). Smaller = wider aperture = blurrier. */
export const F_STOP_MIN = 0.5;
export const F_STOP_MAX = 22;

/** Clamp an f-stop into the supported range. */
export function clampFStop(f: number): number {
  if (!Number.isFinite(f)) return 2.8;
  return Math.max(F_STOP_MIN, Math.min(F_STOP_MAX, f));
}

/**
 * Thin-lens aperture (lens) radius in world units derived from the camera's
 * DoF settings (UR10-2 Part C). Returns 0 (pinhole) when DoF is disabled.
 *
 *   radius = (focalLength / 1000) / (2 · fStop)
 *
 * UNIT ASSUMPTION: focalLength is mm; /1000 converts to metres, and the app's
 * world unit ≈ 1 metre (the Blender convention), so the result is directly in
 * scene units. 50mm f/2.8 ≈ 0.0089. No artificial scale factor is applied — the
 * physical value already yields visible blur at the default scene scale (a wide
 * f/0.5 ≈ 0.05 units is clearly blurry, f/16 ≈ 0.0016 ≈ pinhole; verified by the
 * UR10-2 DoF e2e). If a Blender-matching feel ever needs a boost, multiply here.
 */
export function cameraLensRadius(cam: CameraData): number {
  if (!cam.dof) return 0;
  const f = clampFStop(cam.fStop ?? 2.8);
  return (cam.focalLength / 1000) / (2 * f);
}

/**
 * Empirical "feel like Blender" multiplier applied to the physical lens radius
 * before the thin-lens tracer consumes it (UR10-2 Part C). The raw physical
 * radius (0.0089 at 50mm f/2.8) produces only a sub-pixel blur at the app's
 * typical subject distances (a few world units), so f/2.8 reads as pinhole —
 * unlike Blender, where f/2.8 is clearly shallow. This 3× boost makes f/2.8
 * visibly shallow and f/0.5 strongly blurred while keeping f/16 ≈ near-pinhole,
 * matched against Blender's perceived depth of field. Applied in
 * buildSnapshot (the tracer boundary), NOT baked into cameraLensRadius, so the
 * documented physical formula and its unit test stay exact.
 */
export const DOF_APERTURE_SCALE = 3;

export interface CameraData {
  /** Focal length in mm on a 36×24mm sensor (Blender default sensor). */
  focalLength: number;
  near: number;
  far: number;
  /**
   * Depth-of-field enable (UR10-2 Part C). false → pinhole (aperture 0). When
   * on, the tracer's thin-lens radius is derived from `fStop` via
   * cameraLensRadius(). Optional so pre-UR10-2 scenes parse (absent → false).
   */
  dof?: boolean;
  /**
   * Lens f-stop (UR10-2 Part C). Drives the DoF blur when `dof` is on: smaller =
   * wider aperture = blurrier. Clamped to F_STOP_MIN..F_STOP_MAX. Optional
   * (absent → 2.8, the default).
   */
  fStop?: number;
  /** Camera Glare / bloom post-process (UR10-2 Part B). Absent → no glare. */
  glare?: GlareSettings;
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
  return { focalLength: 50, near: 0.1, far: 500, lockToView: false, dof: false, fStop: 2.8 };
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

// --- Curves (UR11-1) ---------------------------------------------------------

/**
 * One control point of a curve. `co` is the anchor (object-local). Bezier points
 * additionally carry left/right handles `hl`/`hr` (absolute object-local coords,
 * NOT offsets); when a handle is absent the evaluator mirrors the opposite one
 * about `co` (or falls back to `co` itself → a straight span). NURBS points carry
 * a rational weight `w` (default 1); handles are ignored for NURBS.
 */
export interface CurvePoint {
  co: [number, number, number];
  hl?: [number, number, number];
  hr?: [number, number, number];
  w?: number;
}

/**
 * Curve-object payload (UR11-1): a Bezier or NURBS spline. Plain data only —
 * the viewport polyline is DERIVED by evaluateCurve (core/curve/eval). Set iff
 * the object is kind 'curve'; absent on every other kind. Precedent:
 * light/camera/empty/text payloads.
 */
export interface CurveData {
  kind: 'bezier' | 'nurbs';
  /** Closed loop (bezier wraps the last→first span; nurbs periodic-lite). */
  cyclic: boolean;
  /** Eval segments per span (clamped 2..64, default 12). */
  resolution: number;
  points: CurvePoint[];
  /** NURBS order k (degree+1), clamped 2..#points; default 4. Unused for bezier. */
  order?: number;
}

/** Resolution clamp bounds for a curve (eval segments per span). */
export const CURVE_RES_MIN = 2;
export const CURVE_RES_MAX = 64;

/** Clamp a curve resolution into the supported range (default 12). */
export function clampCurveResolution(r: number): number {
  if (!Number.isFinite(r)) return 12;
  return Math.max(CURVE_RES_MIN, Math.min(CURVE_RES_MAX, Math.round(r)));
}

/** Deep copy of a CurveData (its points + handle/weight arrays are copied). */
export function cloneCurveData(c: CurveData): CurveData {
  return {
    kind: c.kind,
    cyclic: c.cyclic,
    resolution: c.resolution,
    order: c.order,
    points: c.points.map((p) => ({
      co: [...p.co] as [number, number, number],
      ...(p.hl ? { hl: [...p.hl] as [number, number, number] } : {}),
      ...(p.hr ? { hr: [...p.hr] as [number, number, number] } : {}),
      ...(p.w !== undefined ? { w: p.w } : {}),
    })),
  };
}

// --- Materials ---------------------------------------------------------------

/** IOR clamp range (UR10-3). Below 1.0 is unphysical; 2.5 covers diamond. */
export const IOR_MIN = 1.0;
export const IOR_MAX = 2.5;

/** Clamp an index of refraction into the supported range (default 1.45). */
export function clampIor(v: number): number {
  if (!Number.isFinite(v)) return 1.45;
  return Math.max(IOR_MIN, Math.min(IOR_MAX, v));
}

/** Clamp transmission into 0..1 (default 0). */
export function clampTransmission(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// --- Shader model v2 (UR16-1) -----------------------------------------------

/**
 * Top-level material shader (UR16-1, Ray's redesign). A material picks ONE
 * shader; each shader exposes only the channels it needs (see channelsForShader).
 *  - 'diffuse' (default for NEW materials): color, roughness, alpha.
 *  - 'metal':   color, roughness, alpha — metallic forced 1 in the BRDF.
 *  - 'glass':   color, roughness, ior, alpha — transmission forced 1.
 *  - 'emit':    color, strength, alpha — shadeless (unlit) semantics.
 *  - 'super':   the everything shader — every legacy field (metallic, emissive,
 *               transmission/ior, subsurface, normal/bump/rough/metal maps,
 *               node graph). This is what MIGRATED legacy materials become.
 * Optional on Material so a material/test that never set it parses (absent →
 * 'super', the field-honoring everything shader — so the engines never clobber
 * a hand-built material's stored fields).
 */
export type MaterialShader = 'diffuse' | 'super' | 'metal' | 'glass' | 'emit';

export const MATERIAL_SHADERS: readonly MaterialShader[] = ['diffuse', 'super', 'metal', 'glass', 'emit'];

/** Object-space linear gradient input for a channel (UR16-1). t = clamp(p[axis]·
 *  scale + offset, 0, 1) evaluated at the OBJECT-LOCAL hit position; the channel
 *  value = lerp(a, b, t). For scalar channels (roughness/metallic/alpha) the
 *  a/b endpoints' RED component is used. */
export interface GradientInput {
  kind: 'gradient';
  a: [number, number, number];
  b: [number, number, number];
  axis: 'x' | 'y' | 'z';
  offset: number;
  scale: number;
}

/** A channel socket (UR16-1): a value, an image, or an object-space gradient.
 *  T is [r,g,b] for the color channel, number for scalar channels. */
export type ChannelInput<T> =
  | { kind: 'value'; value: T }
  | { kind: 'image'; dataUrl: string }
  | GradientInput;

/** The socketable channels UR16-2's UI edits (and the engines evaluate). */
export type MaterialChannelName = 'color' | 'roughness' | 'metallic' | 'alpha';

/** Which channel rows a shader exposes (UR16-1 table; UR16-2 builds the UI from
 *  this). 'super' additionally has emissive/transmission/ior/subsurface/maps/
 *  nodes, handled by that tab directly. */
export function channelsForShader(shader: MaterialShader): MaterialChannelName[] {
  switch (shader) {
    case 'diffuse': return ['color', 'roughness', 'alpha'];
    case 'metal':   return ['color', 'roughness', 'alpha'];
    case 'glass':   return ['color', 'roughness', 'alpha']; // + ior (value only, its own row)
    case 'emit':    return ['color', 'alpha'];              // + strength (value only)
    case 'super':   return ['color', 'roughness', 'metallic', 'alpha'];
  }
}

/** The named shader a material resolves as (absent → 'super': the everything
 *  shader that honors all stored fields, so legacy/hand-built materials render
 *  exactly as before). */
export function materialShader(mat: Pick<Material, 'shader'>): MaterialShader {
  return mat.shader ?? 'super';
}

/** Gradient parameter t at an object-LOCAL position (UR16-1 closed form):
 *  t = clamp(p[axis]·scale + offset, 0, 1). */
export function gradientT(g: GradientInput, px: number, py: number, pz: number): number {
  const p = g.axis === 'x' ? px : g.axis === 'y' ? py : pz;
  const t = p * g.scale + g.offset;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Evaluate a color gradient at an object-LOCAL position → lerp(a, b, t). */
export function evalGradientColor(
  g: GradientInput, px: number, py: number, pz: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const t = gradientT(g, px, py, pz);
  out[0] = g.a[0] + (g.b[0] - g.a[0]) * t;
  out[1] = g.a[1] + (g.b[1] - g.a[1]) * t;
  out[2] = g.a[2] + (g.b[2] - g.a[2]) * t;
  return out;
}

/** Evaluate a scalar gradient (roughness/metallic/alpha) → lerp of the a/b RED
 *  components at t. */
export function evalGradientScalar(g: GradientInput, px: number, py: number, pz: number): number {
  const t = gradientT(g, px, py, pz);
  return g.a[0] + (g.b[0] - g.a[0]) * t;
}

/** Named-shader BRDF overrides (UR16-1): metal→metallic 1, glass→transmission 1
 *  (+ metallic 0), emit→shadeless. 'diffuse'/'super'/absent honor the stored
 *  fields (so migrated + default-new materials render byte-identically). The
 *  engines merge these over the material's legacy fields at their boundary. */
export function shaderOverrides(mat: Pick<Material, 'shader' | 'transmission'>): {
  metallic?: number; transmission?: number; ior?: number; shadeless?: boolean;
} {
  switch (materialShader(mat)) {
    case 'metal': return { metallic: 1 };
    case 'glass': return { metallic: 0, transmission: 1 };
    case 'emit':  return { shadeless: true };
    default:      return {};
  }
}

/** Read a channel as a ChannelInput socket (UR16-1) synthesized from the
 *  material's runtime fields — the gradient overrides win, then image, then the
 *  scalar/color value. This is the accessor UR16-2's socket UI reads. */
export function getMaterialChannel(mat: Material, ch: MaterialChannelName): ChannelInput<[number, number, number]> | ChannelInput<number> {
  switch (ch) {
    case 'color':
      if (mat.colorGradient) return mat.colorGradient;
      if (mat.texKind === 'image' && mat.texDataUrl) return { kind: 'image', dataUrl: mat.texDataUrl };
      return { kind: 'value', value: [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]] };
    case 'roughness':
      if (mat.roughGradient) return mat.roughGradient;
      if (mat.roughDataUrl) return { kind: 'image', dataUrl: mat.roughDataUrl };
      return { kind: 'value', value: mat.roughness };
    case 'metallic':
      if (mat.metalGradient) return mat.metalGradient;
      if (mat.metalDataUrl) return { kind: 'image', dataUrl: mat.metalDataUrl };
      return { kind: 'value', value: mat.metallic };
    case 'alpha':
      return mat.alpha ?? { kind: 'value', value: 1 };
  }
}

/** Write a channel from a ChannelInput socket (UR16-1) into the material's
 *  runtime fields (the inverse of getMaterialChannel). Used by UR16-2's socket
 *  UI and by the serializer's parse path. */
export function setMaterialChannel(mat: Material, ch: MaterialChannelName, input: ChannelInput<[number, number, number]> | ChannelInput<number>): void {
  switch (ch) {
    case 'color':
      mat.colorGradient = input.kind === 'gradient' ? input : undefined;
      if (input.kind === 'value') { mat.texKind = 'none'; mat.texDataUrl = null; mat.baseColor = [...(input.value as [number, number, number])]; }
      else if (input.kind === 'image') { mat.texKind = 'image'; mat.texDataUrl = input.dataUrl; }
      break;
    case 'roughness':
      mat.roughGradient = input.kind === 'gradient' ? input : undefined;
      if (input.kind === 'value') { mat.roughDataUrl = null; mat.roughness = input.value as number; }
      else if (input.kind === 'image') { mat.roughDataUrl = input.dataUrl; }
      break;
    case 'metallic':
      mat.metalGradient = input.kind === 'gradient' ? input : undefined;
      if (input.kind === 'value') { mat.metalDataUrl = null; mat.metallic = input.value as number; }
      else if (input.kind === 'image') { mat.metalDataUrl = input.dataUrl; }
      break;
    case 'alpha':
      mat.alpha = input as ChannelInput<number>;
      break;
  }
}

/** Deep-copy a GradientInput. */
export function cloneGradient(g: GradientInput): GradientInput {
  return { kind: 'gradient', a: [...g.a], b: [...g.b], axis: g.axis, offset: g.offset, scale: g.scale };
}

/** Deep-copy an alpha ChannelInput. */
export function cloneAlpha(a: ChannelInput<number>): ChannelInput<number> {
  if (a.kind === 'gradient') return cloneGradient(a);
  return { ...a };
}

/** The material's effective alpha VALUE at object-local p (UR16-1). For the
 *  'value' kind this is constant; a gradient evaluates its scalar; an image alpha
 *  channel isn't position-closed-form so it falls back to 1 here (the raster/
 *  tracer sample it through the texture path instead). Clamped 0..1. */
export function materialAlphaAt(mat: Pick<Material, 'alpha'>, px: number, py: number, pz: number): number {
  const a = mat.alpha;
  if (!a) return 1;
  let v: number;
  if (a.kind === 'value') v = a.value;
  else if (a.kind === 'gradient') v = evalGradientScalar(a, px, py, pz);
  else return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface Material {
  /** Stable id, unique within the scene (referenced by SceneObject.materialId). */
  readonly id: number;
  name: string;
  /** Top-level shader (UR16-1). Absent → 'super' (everything, honors all fields).
   *  NEW materials default 'diffuse'; migrated legacy materials → 'super'/'emit'. */
  shader?: MaterialShader;
  /** Alpha channel (UR16-1). 0..1, default value 1. alpha < 1 → blended in raster
   *  (auto-alphaBlend) and stochastic pass-through in the tracer/GPU. Absent → 1
   *  (opaque), so pre-UR16 materials are byte-identical. */
  alpha?: ChannelInput<number>;
  /** Object-space GRADIENT overrides (UR16-1) for the color/roughness/metallic
   *  channels. When present they win over the value/image legacy fields for that
   *  channel in every engine. Absent → the channel is value/image (legacy). */
  colorGradient?: GradientInput;
  roughGradient?: GradientInput;
  metalGradient?: GradientInput;
  /** Linear RGB 0..1 albedo. */
  baseColor: [number, number, number];
  /** 0 = dielectric, 1 = metal. */
  metallic: number;
  /** 0 = mirror, 1 = fully rough. */
  roughness: number;
  /**
   * Transmission (UR10-3, glass): 0 = fully opaque, 1 = fully transmissive
   * dielectric. Above 0 the F12 tracer traces a dielectric BSDF (Fresnel
   * reflect / Snell refract, TIR-aware) and the Rendered viewport draws the
   * surface as an alpha-blended, Fresnel-rimmed glass approximation. Optional so
   * pre-UR10-3 materials serialize/deserialize byte-identically (absent → 0).
   */
  transmission?: number;
  /**
   * Index of refraction (UR10-3), clamped 1.0–2.5 (CLAMP_IOR). Drives the glass
   * Fresnel + Snell refraction when transmission > 0. Default 1.45 (typical
   * glass). Optional; absent → 1.45.
   */
  ior?: number;
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
  transmission: 0,
  ior: 1.45,
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

/** Fresh mutable material with default params (scene assigns the id). NEW
 *  materials use the 'diffuse' shader (UR16-1) with an opaque alpha value. A
 *  fresh diffuse material's metallic/transmission are already 0, so it renders
 *  byte-identically to the pre-UR16 default material. */
export function makeMaterial(id: number, name: string): Material {
  return {
    id,
    name,
    shader: 'diffuse',
    alpha: { kind: 'value', value: 1 },
    baseColor: [0.8, 0.8, 0.8],
    metallic: 0,
    roughness: 0.5,
    transmission: 0,
    ior: 1.45,
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
