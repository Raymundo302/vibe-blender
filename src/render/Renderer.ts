import type { GlContext } from './gl/context';
import { VertexArray } from './gl/VertexArray';
import { MeshPass } from './passes/meshPass';
import { StudioPass } from './passes/studioPass';
import { WirePass } from './passes/wirePass';
import { GridPass } from './passes/gridPass';
import { OutlinePass } from './passes/outlinePass';
import { PickingPass } from './passes/pickingPass';
import { GizmoPass, GIZMO_PICK_BASE, GIZMO_AXES, gizmoScreenScale, type GizmoAxis } from './passes/gizmoPass';
import { EditOverlayPass } from './passes/editOverlayPass';
import {
  ElementPickPass,
  closestNonZeroId,
  decodePick,
  type ElementPickResult,
} from './passes/elementPickPass';
import { elementIndexMaps } from '../core/mesh/editOverlayData';
import { RenderedPass, WorldBackgroundPass, collectLights, shadowCasterIndices, cubeCasterIndices, type LightSet } from './passes/renderedPass';
import { ShadowPass, sunShadowMatrix, spotShadowMatrix, cubeFaceView, SHADOW_SLOTS, CUBE_SHADOW_SLOTS } from './passes/shadowPass';
import { averageWorldColor } from '../core/scene/worldData';
import { IconPass, type IconShape } from './passes/iconPass';
import { CameraFrustumPass, cameraViewMatrix, cameraProjMatrix } from './passes/cameraFrustumPass';
import { LightDirPass, hasAimArrow } from './passes/lightDirPass';
import { ensureBaked } from '../core/nodes/bake';
import { nodeImageCache } from '../core/nodes/imageCache';
import { cameraFovY, type Material } from '../core/scene/objectData';
import { overlays } from './overlayPrefs';
import { shadePrefs } from './shadePrefs';
import { AoPass } from './passes/aoPass';
import { SdfAtlas } from './sdfAtlas';
import { createMatcapTexture } from './matcap';
import { themeViewport } from '../ui/themes';
import { meshToRenderData } from '../core/mesh/meshToGpu';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';

interface GpuMesh {
  triangles: VertexArray;
  /** Unique-edge line segments (position-only), for wireframe shading. */
  edges: VertexArray;
  /** Composite cache key: which mesh (base vs evaluated) + its versions. */
  version: string;
  /** Local-space AABB of the triangles (null for empty meshes) — frames the
   *  sun shadow map's ortho box without re-touching vertex data per frame. */
  bounds: { min: Vec3; max: Vec3 } | null;
}

/** Viewport solid-shading mode; Z cycles matcap → wireframe → studio → rendered. */
export type ShadingMode = 'matcap' | 'wireframe' | 'studio' | 'rendered';

const SHADING_CYCLE: readonly ShadingMode[] = ['matcap', 'wireframe', 'studio', 'rendered'];

/**
 * What a pick landed on: a scene object, a translate-gizmo axis handle, or
 * (null) the background. InputManager branches on `kind`.
 */
export type PickResult =
  | { kind: 'object'; id: number }
  | { kind: 'gizmo'; axis: GizmoAxis };

// Viewport clear color comes from the active theme (themeViewport.background).

/** Which glyph the icon pass draws for a non-mesh object. */
function iconShape(obj: SceneObject): IconShape {
  if (obj.kind === 'camera') return 3;
  switch (obj.light?.type) {
    case 'sun': return 1;
    case 'spot': return 2;
    default: return 0;
  }
}

/**
 * Overlay tint for a non-mesh object's icon / frustum: selection orange (bright
 * for the active object, dimmer for the rest of the selection), light grey when
 * unselected. Shared by the icon pass and the camera-frustum pass so both read
 * as one selection system.
 */
function selectionColor(scene: Scene, obj: SceneObject): [number, number, number] {
  if (!scene.selection.has(obj.id)) return [0.85, 0.85, 0.85];
  return scene.activeId === obj.id ? [1, 0.66, 0.25] : [0.95, 0.55, 0.2];
}

export class Renderer {
  private readonly meshPass: MeshPass;
  private readonly studioPass: StudioPass;
  private readonly wirePass: WirePass;
  private readonly gridPass: GridPass;
  private readonly outlinePass: OutlinePass;
  private readonly pickingPass: PickingPass;
  private readonly gizmoPass: GizmoPass;
  private readonly editOverlayPass: EditOverlayPass;
  private readonly elementPickPass: ElementPickPass;
  private readonly renderedPass: RenderedPass;
  private readonly shadowPass: ShadowPass;
  private readonly aoPass: AoPass;
  private readonly sdfAtlas: SdfAtlas;
  private readonly worldBgPass: WorldBackgroundPass;
  private readonly iconPass: IconPass;
  private readonly cameraFrustumPass: CameraFrustumPass;
  private readonly lightDirPass: LightDirPass;
  /** GPU buffers per object id, invalidated by mesh.version. */
  private readonly gpuMeshes = new Map<number, GpuMesh>();
  /** Equirect HDRI texture for the Rendered-mode background, or null. */
  private hdriTexture: WebGLTexture | null = null;
  /** The `world.hdri` data URL currently uploaded (null tracks "none"). */
  private hdriUrl: string | null = null;
  /**
   * Lazy per-material base-color texture cache (P11), keyed by material id. `url`
   * tracks which data URL is uploaded so a texDataUrl change re-uploads; `tex`
   * stays null while the async image decodes (falls back to white until ready).
   */
  private readonly matTextures = new Map<number, { url: string; tex: WebGLTexture | null }>();
  /** P13: lazy data-URL → GL texture cache for map slots. Key prefix encodes
   *  color space ('s:' sRGB base color, 'l:' linear data maps). */
  private readonly urlTextures = new Map<string, { tex: WebGLTexture | null }>();

  /**
   * Whether the translate gizmo may draw / be picked. InputManager clears this
   * while a modal operator owns input (so no gizmo shows mid-G/R/S or mid-drag)
   * and restores it when the operator ends. It only shows when there is also an
   * active object, so nothing is drawn on an empty selection either.
   */
  gizmoVisible = true;

  /**
   * Modal axis-lock indicator: while a G/R/S runs with an X/Y/Z constraint,
   * InputManager mirrors the operator's lock here and render() draws just that
   * axis's arrow + guide line at the operator's pivot (the full gizmo stays
   * hidden). Null when no modal or no lock.
   */
  axisIndicator: { axis: GizmoAxis; pivot: Vec3 } | null = null;

  /**
   * Current viewport solid-shading mode. Z (or the topbar chip) cycles it via
   * {@link cycleShadingMode}. The solid pass in render() branches on this;
   * outlines / edit-cage / gizmo overlays are unaffected.
   */
  shadingMode: ShadingMode = 'matcap';

  /**
   * Ad-hoc overlay polyline in the edit object's LOCAL space (loop-cut
   * preview). Owning operator sets it on hover and MUST null it on
   * confirm/cancel. Pass a NEW array per change — it doubles as the cache key.
   */
  editPreviewLines: Float32Array | null = null;

  /**
   * When set to a camera object's id, render() and pick() look THROUGH that
   * camera (Numpad0) instead of the OrbitCamera. Cleared automatically if the
   * object disappears or stops being a camera; InputManager also clears it when
   * the user orbits/pans/zooms. Public so e2e can drive it directly.
   */
  cameraViewId: number | null = null;

  constructor(private readonly ctx: GlContext) {
    const { gl, canvas } = ctx;
    this.meshPass = new MeshPass(gl, createMatcapTexture(gl));
    this.studioPass = new StudioPass(gl);
    this.wirePass = new WirePass(gl);
    this.gridPass = new GridPass(gl);
    this.outlinePass = new OutlinePass(gl, canvas.width, canvas.height);
    this.pickingPass = new PickingPass(gl, canvas.width, canvas.height);
    this.gizmoPass = new GizmoPass(gl);
    this.editOverlayPass = new EditOverlayPass(gl);
    this.elementPickPass = new ElementPickPass(gl, canvas.width, canvas.height);
    this.renderedPass = new RenderedPass(gl);
    this.shadowPass = new ShadowPass(gl);
    this.aoPass = new AoPass(gl, canvas.width, canvas.height);
    this.sdfAtlas = new SdfAtlas(gl);
    this.worldBgPass = new WorldBackgroundPass(gl);
    this.iconPass = new IconPass(gl);
    this.cameraFrustumPass = new CameraFrustumPass(gl);
    this.lightDirPass = new LightDirPass(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  /**
   * GPU buffers for what this object DISPLAYS: the modifier-evaluated mesh in
   * object mode, the raw base mesh while it is being edited (modifiers are
   * hidden during edit — predictable cage, no double-vision).
   */
  private gpuMesh(obj: SceneObject, scene: Scene): GpuMesh {
    const editing = scene.editMode?.objectId === obj.id;
    const mesh = editing ? obj.mesh : obj.evaluatedMesh(scene.modifierContext(obj));
    const version = `${editing ? 'edit' : 'obj'}:${mesh.version}:${obj.modifiersVersion}:${obj.shadeSmooth ? 's' : 'f'}`;
    const cached = this.gpuMeshes.get(obj.id);
    if (cached && cached.version === version) return cached;
    cached?.triangles.dispose();
    cached?.edges.dispose();

    const data = meshToRenderData(mesh, obj.shadeSmooth);
    let bounds: GpuMesh['bounds'] = null;
    const pos = data.trianglePositions;
    if (pos.length >= 3) {
      const min = [pos[0], pos[1], pos[2]];
      const max = [pos[0], pos[1], pos[2]];
      for (let i = 3; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (pos[i + a] < min[a]) min[a] = pos[i + a];
          if (pos[i + a] > max[a]) max[a] = pos[i + a];
        }
      }
      bounds = { min: new Vec3(min[0], min[1], min[2]), max: new Vec3(max[0], max[1], max[2]) };
    }
    const entry: GpuMesh = {
      triangles: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.trianglePositions },
        { location: 1, size: 3, data: data.triangleNormals },
        { location: 2, size: 3, data: data.triangleColors },
        { location: 3, size: 2, data: data.triangleUVs },
      ]),
      edges: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.edgePositions },
        { location: 1, size: 3, data: data.edgeFaceNormals1 },
        { location: 2, size: 3, data: data.edgeFaceNormals2 },
      ]),
      version,
      bounds,
    };
    this.gpuMeshes.set(obj.id, entry);
    return entry;
  }

  /**
   * Keep the GL HDRI texture in sync with scene.world.hdri. Uploads the equirect
   * image (sRGB internal format → sampled as linear) the first time a new data
   * URL appears; clears the binding when the world drops HDRI. Async image
   * decode: until it lands, the background falls back to the gradient (hasHdri 0).
   */
  private syncHdriTexture(scene: Scene): void {
    const url = scene.world.mode === 'hdri' ? scene.world.hdri : null;
    if (url === this.hdriUrl) return;
    this.hdriUrl = url;
    this.hdriTexture = null; // fall back to gradient until the new image loads
    if (!url) return;
    const gl = this.ctx.gl;
    const img = new Image();
    img.onload = () => {
      // Ignore a stale load (world.hdri changed again before this resolved).
      if (this.hdriUrl !== url) return;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.hdriTexture = tex;
    };
    img.onerror = () => { /* keep the gradient fallback */ };
    img.src = url;
  }

  /**
   * Base-color image texture for an image material, uploaded lazily and cached by
   * material id (mirrors the HDRI upload). Returns null while the async decode is
   * in flight or for non-image materials — the RenderedPass then binds white.
   * A changed texDataUrl triggers a fresh upload; the old GL texture is deleted.
   */
  private materialTexture(mat: Material): WebGLTexture | null {
    if (mat.texKind !== 'image' || !mat.texDataUrl) return null;
    const url = mat.texDataUrl;
    const cached = this.matTextures.get(mat.id);
    if (cached && cached.url === url) return cached.tex;
    if (cached?.tex) this.ctx.gl.deleteTexture(cached.tex);
    const holder = { url, tex: null as WebGLTexture | null };
    this.matTextures.set(mat.id, holder);
    const gl = this.ctx.gl;
    const img = new Image();
    img.onload = () => {
      if (holder.url !== mat.texDataUrl) return; // stale (url changed again)
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      holder.tex = tex;
    };
    img.onerror = () => { /* leave white fallback */ };
    img.src = url;
    return null;
  }

  /**
   * P13 map-slot upload: data URL → GL texture, cached by URL. Returns null
   * while the async decode is in flight (caller binds a neutral fallback).
   * `srgb` = false uploads LINEAR (normal/rough/metal maps are data, not
   * color); true mirrors the base-color path. Cache is URL-keyed and never
   * evicted — packed data URLs are few and shared across materials.
   */
  private textureFor(url: string | null, srgb: boolean): WebGLTexture | null {
    if (!url) return null;
    const key = (srgb ? 's:' : 'l:') + url;
    const cached = this.urlTextures.get(key);
    if (cached) return cached.tex;
    const holder = { tex: null as WebGLTexture | null };
    this.urlTextures.set(key, holder);
    const gl = this.ctx.gl;
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      holder.tex = tex;
    };
    img.onerror = () => { /* leave null → feature stays off */ };
    img.src = url;
    return null;
  }

  /**
   * Render this frame's shadow maps (Rendered mode only): every sun and spot
   * (up to SHADOW_SLOTS, scene order) gets one depth-only render of the
   * visible meshes — suns through an ortho box fitted around the world-space
   * bounds, spots through a perspective frustum matching their cone. Returns
   * casters[slot] = { light-space matrix, light index } for the RenderedPass;
   * empty when there is nothing to cast or no shadowing light. Fixed 1024²
   * maps, redrawn per frame — cheap depth-only rasterization.
   */
  private renderShadows(
    scene: Scene,
    meshes: SceneObject[],
    lights: LightSet,
  ): {
    casters: { viewProj: Mat4; lightIndex: number }[];
    cubeCasters: { lightIndex: number; near: number; far: number }[];
  } {
    const casterIdx = shadowCasterIndices(lights, SHADOW_SLOTS);
    const cubeIdx = cubeCasterIndices(lights, CUBE_SHADOW_SLOTS);
    if ((casterIdx.length === 0 && cubeIdx.length === 0) || meshes.length === 0) {
      return { casters: [], cubeCasters: [] };
    }

    // World-space AABB of everything that will cast/receive: transform each
    // mesh's cached local AABB corners by its world matrix.
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const obj of meshes) {
      const b = this.gpuMesh(obj, scene).bounds;
      if (!b) continue;
      const world = scene.worldMatrix(obj);
      for (let c = 0; c < 8; c++) {
        const p = world.transformPoint(new Vec3(
          c & 1 ? b.max.x : b.min.x,
          c & 2 ? b.max.y : b.min.y,
          c & 4 ? b.max.z : b.min.z,
        ));
        min = min ? new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z)) : p;
        max = max ? new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z)) : p;
      }
    }
    if (!min || !max) return { casters: [], cubeCasters: [] };
    const center = min.add(max).scale(0.5);
    const radius = max.sub(min).length() * 0.5;

    const { gl, canvas } = this.ctx;
    const casters: { viewProj: Mat4; lightIndex: number }[] = [];
    for (const lightIndex of casterIdx) {
      const dir = new Vec3(
        lights.directions[lightIndex * 3],
        lights.directions[lightIndex * 3 + 1],
        lights.directions[lightIndex * 3 + 2],
      ).normalize();
      let viewProj: Mat4;
      if (lights.types[lightIndex] === 1) {
        viewProj = sunShadowMatrix(dir, center, radius);
      } else {
        const pos = new Vec3(
          lights.positions[lightIndex * 3],
          lights.positions[lightIndex * 3 + 1],
          lights.positions[lightIndex * 3 + 2],
        );
        // Full apex angle back from the stored cos(outer half-angle).
        const spotAngle = 2 * Math.acos(Math.min(1, Math.max(-1, lights.spots[lightIndex * 2 + 1])));
        const far = pos.distanceTo(center) + radius * 1.5;
        viewProj = spotShadowMatrix(pos, dir, spotAngle, far);
      }
      this.shadowPass.begin(casters.length, viewProj);
      for (const obj of meshes) {
        this.shadowPass.setObject(scene.worldMatrix(obj));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      casters.push({ viewProj, lightIndex });
    }

    // Point lights: 6 depth renders into the slot's cube map (90° fov faces).
    const cubeCasters: { lightIndex: number; near: number; far: number }[] = [];
    for (const lightIndex of cubeIdx) {
      const pos = new Vec3(
        lights.positions[lightIndex * 3],
        lights.positions[lightIndex * 3 + 1],
        lights.positions[lightIndex * 3 + 2],
      );
      const near = 0.05;
      const far = Math.max(pos.distanceTo(center) + radius * 1.5, 1);
      const proj = Mat4.perspective(Math.PI / 2, 1, near, far);
      for (let face = 0; face < 6; face++) {
        this.shadowPass.beginCubeFace(cubeCasters.length, face, proj.mul(cubeFaceView(pos, face)));
        for (const obj of meshes) {
          this.shadowPass.setObject(scene.worldMatrix(obj));
          this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
        }
      }
      cubeCasters.push({ lightIndex, near, far });
    }
    this.shadowPass.end(canvas.width, canvas.height);
    return { casters, cubeCasters };
  }

  /**
   * Advance the shading mode one step (matcap → wireframe → studio → matcap)
   * and return the new mode. Called by the Z keybind and the topbar chip.
   */
  cycleShadingMode(): ShadingMode {
    const i = SHADING_CYCLE.indexOf(this.shadingMode);
    this.shadingMode = SHADING_CYCLE[(i + 1) % SHADING_CYCLE.length];
    return this.shadingMode;
  }

  /**
   * The view/proj (plus eye + fovY, for lighting, grid fade and gizmo scale)
   * this frame uses: the active camera object when looking through one
   * (cameraViewId), otherwise the OrbitCamera. Self-heals a stale cameraViewId
   * (object gone or no longer a camera). Called by both render() and pick() so
   * everything downstream — picking, gizmo, edit overlays — agrees.
   */
  private resolveView(
    scene: Scene,
    camera: OrbitCamera,
  ): { view: Mat4; proj: Mat4; eye: Vec3; fovY: number } {
    const { canvas } = this.ctx;
    const aspect = canvas.width / canvas.height;
    if (this.cameraViewId !== null) {
      const camObj = scene.get(this.cameraViewId);
      if (!camObj || camObj.kind !== 'camera') {
        this.cameraViewId = null; // object gone: fall through to the user camera
      } else if (camObj.visible && camObj.camera) {
        const pose = scene.worldTransformOf(camObj);
        return {
          view: cameraViewMatrix(camObj, pose),
          proj: cameraProjMatrix(camObj.camera, aspect),
          eye: pose.position,
          fovY: cameraFovY(camObj.camera),
        };
      }
    }
    return {
      view: camera.viewMatrix(),
      proj: camera.projMatrix(aspect),
      eye: camera.eye,
      fovY: camera.fovY,
    };
  }

  render(scene: Scene, camera: OrbitCamera): void {
    const { gl, canvas } = this.ctx;
    if (this.ctx.syncSize()) {
      this.outlinePass.resize(canvas.width, canvas.height);
      this.pickingPass.resize(canvas.width, canvas.height);
      this.elementPickPass.resize(canvas.width, canvas.height);
      this.aoPass.resize(canvas.width, canvas.height);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bg = themeViewport.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { view, proj, eye, fovY } = this.resolveView(scene, camera);
    const visible = scene.objects.filter((o) => scene.effectiveVisible(o));

    // SSAO (shading-dropdown "Ambient Occlusion", solid modes only): depth
    // prepass of the visible meshes, then SSAO+blur into aoPass.texture. The
    // solid passes below multiply it in; when off they bind the 1×1 white.
    const aoOn = shadePrefs.ao && this.shadingMode !== 'wireframe';
    if (aoOn) {
      this.aoPass.beginDepth(view, proj);
      const aoMeshes: SceneObject[] = [];
      for (const obj of visible) {
        if (obj.kind !== 'mesh') continue;
        aoMeshes.push(obj);
        this.aoPass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      if (shadePrefs.aoMode === 'object') {
        // Object AO (Ray's SDF technique): voxel-SDF atlas in sync with the
        // visible meshes, then the world-space march instead of GTAO.
        const sdf = this.sdfAtlas.sync(scene, aoMeshes);
        this.aoPass.computeObject(proj.invert(), view.invert(), sdf,
          shadePrefs.aoRadius, shadePrefs.aoStrength, shadePrefs.aoSamples, shadePrefs.aoMethod);
      } else {
        this.aoPass.compute(proj, proj.invert(), shadePrefs.aoRadius, shadePrefs.aoStrength, shadePrefs.aoSamples);
      }
    }
    const aoTex = aoOn ? this.aoPass.texture : this.aoPass.white;

    // Solid pass — branch on shading mode. Wireframe draws dark edge lines with
    // no fill; matcap/studio fill triangles with their respective shaders.
    if (this.shadingMode === 'wireframe') {
      // Hidden-line option: prime the depth buffer with the solid faces
      // (color untouched) so backfacing wires and wires behind other geometry
      // fail the depth test; the biased lines then only survive where visible.
      if (shadePrefs.wireHiddenLine) {
        this.wirePass.begin(view, proj);
        gl.colorMask(false, false, false, false);
        for (const obj of visible) {
          this.wirePass.setObject(scene.worldMatrix(obj), view);
          this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
        }
        gl.colorMask(true, true, true, true);
      }
      this.wirePass.begin(view, proj, shadePrefs.wireHiddenLine ? 0.002 : 0,
        shadePrefs.wireHiddenLine);
      for (const obj of visible) {
        this.wirePass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).edges.draw(gl.LINES);
      }
    } else if (this.shadingMode === 'studio') {
      this.studioPass.begin(view, proj, aoTex, canvas.width, canvas.height);
      for (const obj of visible) {
        this.studioPass.setObject(scene.worldMatrix(obj), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    } else if (this.shadingMode === 'rendered') {
      // World environment as the backdrop (flat / gradient / HDRI), then the
      // meshes over it. Other shading modes keep the theme clear color.
      this.syncHdriTexture(scene);
      const meshes = visible.filter((o) => o.kind === 'mesh');
      const lights = collectLights(scene);
      const { casters, cubeCasters } = this.renderShadows(scene, meshes, lights);
      const invViewProj = proj.mul(view).invert();
      this.worldBgPass.render(invViewProj, eye, scene.world, this.hdriTexture);
      const amb = averageWorldColor(scene.world);
      const k = scene.world.strength * 0.3;
      this.renderedPass.begin(view, proj, eye, lights,
        new Vec3(amb[0] * k, amb[1] * k, amb[2] * k), this.shadowPass.textures, casters,
        this.shadowPass.cubeTextures, cubeCasters, aoTex, canvas.width, canvas.height);
      for (const obj of meshes) {
        const mat = scene.materialOf(obj);
        // P14 shader nodes: bake the graph (idempotent per version) and view
        // the material THROUGH the bake — texture slots point at the baked
        // maps, scalars forced to 1 so the map-multiply becomes replacement.
        let effMat = mat;
        if (mat.useNodes && mat.nodeGraph) {
          ensureBaked(mat, nodeImageCache());
          if (mat.baked) {
            effMat = {
              ...mat,
              baseColor: [1, 1, 1],
              roughness: 1,
              metallic: 1,
              texKind: 'image',
              texDataUrl: mat.baked.baseUrl,
              roughDataUrl: mat.baked.roughUrl,
              metalDataUrl: mat.baked.metalUrl,
            };
          }
        }
        this.renderedPass.setObject(scene.worldMatrix(obj), effMat);
        this.renderedPass.bindTexture(
          effMat === mat ? this.materialTexture(mat) : this.textureFor(effMat.texDataUrl, true),
        );
        this.renderedPass.bindMaps(
          effMat,
          this.textureFor(effMat.normalDataUrl, false),
          this.textureFor(effMat.roughDataUrl, false),
          this.textureFor(effMat.metalDataUrl, false),
        );
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    } else {
      this.meshPass.begin(view, proj, aoTex, canvas.width, canvas.height);
      for (const obj of visible) {
        this.meshPass.setObject(scene.worldMatrix(obj), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    }

    // Wireframe overlay (shading-dropdown option): the edge wires drawn over
    // the shaded result, depth-tested against it with a small bias so lines on
    // the surface win. Occlusion comes free from the solid pass's depth buffer.
    if (shadePrefs.wireOverlay && this.shadingMode !== 'wireframe') {
      this.wirePass.begin(view, proj, 0.002, true);
      for (const obj of visible) {
        this.wirePass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).edges.draw(gl.LINES);
      }
    }

    // Grid (blended, after opaque) — Overlays › Grid toggles it (P12-2).
    if (overlays.grid) this.gridPass.render(view, proj, eye);

    // Camera frustums — after the grid, before outlines. Skip the camera we are
    // currently looking through (its wireframe would smear across the whole view).
    const frustums = visible.filter((o) => overlays.frustums && o.kind === 'camera' && o.id !== this.cameraViewId);
    if (frustums.length > 0) {
      const viewProj = proj.mul(view);
      this.cameraFrustumPass.begin();
      for (const obj of frustums) {
        this.cameraFrustumPass.draw(viewProj, obj, selectionColor(scene, obj), scene.worldTransformOf(obj));
      }
    }

    // Aim arrows for directional lights (sun/spot) — rides the icons toggle,
    // same selection tint as the icon so they read as one object.
    const aimed = visible.filter((o) => overlays.icons && hasAimArrow(o));
    if (aimed.length > 0) {
      const viewProj = proj.mul(view);
      this.lightDirPass.begin();
      for (const obj of aimed) {
        this.lightDirPass.draw(viewProj, scene.worldTransformOf(obj), selectionColor(scene, obj));
      }
    }

    // Billboard icons for non-mesh objects (lights, cameras). The looked-through
    // camera has no icon either (it is the viewpoint).
    const icons = visible.filter((o) => overlays.icons && o.kind !== 'mesh' && o.id !== this.cameraViewId);
    if (icons.length > 0) {
      this.iconPass.begin(proj.mul(view), canvas.width, canvas.height);
      for (const obj of icons) {
        this.iconPass.draw(scene.worldTransformOf(obj).position, iconShape(obj), selectionColor(scene, obj));
      }
    }

    // Selection outlines — the object being edited gets the cage, not an outline
    const editObj = scene.editObject;
    const selected = visible.filter((o) => scene.selection.has(o.id) && o !== editObj);
    if (selected.length > 0) {
      const viewProj = proj.mul(view);
      this.outlinePass.beginMask();
      for (const obj of selected) {
        this.outlinePass.maskObject(viewProj.mul(scene.worldMatrix(obj)));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      this.outlinePass.endMask(canvas.width, canvas.height);
      this.outlinePass.renderEdges();
    }

    // Edit-mode cage (verts/edges/selected-face fill)
    if (editObj && scene.effectiveVisible(editObj) && scene.editMode) {
      const mvp = proj.mul(view).mul(scene.worldMatrix(editObj));
      this.editOverlayPass.render(mvp, editObj.mesh, scene.editMode);
      if (this.editPreviewLines) this.editOverlayPass.renderPreview(mvp, this.editPreviewLines);
    }

    // Translate gizmo — on top of everything (clear depth after outlines).
    const gz = this.gizmoTransform(scene, eye, fovY);
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this.gizmoPass.render(proj.mul(view), gz.origin, gz.scale);
    }

    // Locked-axis indicator — the one gizmo arrow + guide line that stays on
    // while a modal G/R/S is constrained to an axis.
    if (this.axisIndicator) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const { axis, pivot } = this.axisIndicator;
      // World-space view direction = -(third row of the view matrix).
      const forward = new Vec3(-view.m[2], -view.m[6], -view.m[10]);
      this.gizmoPass.renderAxis(
        proj.mul(view), pivot, gizmoScreenScale(eye, pivot, fovY), axis, eye, forward,
      );
    }
  }

  /** Gizmo placement (active object's position) + constant-screen-size scale (from
   *  the current viewpoint's eye/fovY), or null when hidden. */
  private gizmoTransform(scene: Scene, eye: Vec3, fovY: number): { origin: Vec3; scale: number } | null {
    if (!this.gizmoVisible) return null;
    if (scene.editMode) return null; // object gizmo has no meaning in edit mode (P2-3 may add an element gizmo)
    const active = scene.activeObject;
    if (!active || !active.visible) return null;
    const origin = scene.worldTransformOf(active).position;
    return { origin, scale: gizmoScreenScale(eye, origin, fovY) };
  }

  /** The view-projection of whatever is on screen right now (orbit camera or
   *  a looked-through camera object) — for DOM overlays like the 3D cursor. */
  currentViewProj(scene: Scene, camera: OrbitCamera): Mat4 {
    const { view, proj } = this.resolveView(scene, camera);
    return proj.mul(view);
  }

  /**
   * Pick what is under CSS-pixel position (x, y). Renders the id buffer on
   * demand: objects first, then (if visible) the gizmo handles LAST with depth
   * cleared so they win over objects behind them. Returns null for background.
   */
  pick(scene: Scene, camera: OrbitCamera, cssX: number, cssY: number): PickResult | null {
    const { gl, canvas } = this.ctx;
    const { view, proj, eye, fovY } = this.resolveView(scene, camera);
    const viewProj = proj.mul(view);

    this.pickingPass.begin();
    for (const obj of scene.objects) {
      if (!scene.effectiveVisible(obj)) continue;
      this.pickingPass.drawObject(viewProj.mul(scene.worldMatrix(obj)), obj.id + 1);
      this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
    }
    const gz = this.gizmoTransform(scene, eye, fovY);
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT); // pick FBO still bound: gizmo handles win
      this.gizmoPass.renderPick(this.pickingPass, viewProj, gz.origin, gz.scale);
    }
    // Light/camera icons — drawn last (iconPass switches GL programs, and
    // pickingPass.drawObject assumes the picking shader is still active). The
    // looked-through camera has no on-screen icon, so it is not pickable either.
    const iconObjs = scene.objects.filter((o) => overlays.icons && scene.effectiveVisible(o) && o.kind !== 'mesh' && o.id !== this.cameraViewId);
    if (iconObjs.length > 0) {
      this.iconPass.begin(viewProj, canvas.width, canvas.height);
      for (const obj of iconObjs) this.iconPass.drawPick(scene.worldTransformOf(obj).position, obj.id + 1);
    }
    this.pickingPass.end(canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    const raw = this.pickingPass.read(Math.round(cssX * dpr), Math.round(cssY * dpr));
    if (raw === 0) return null;
    if (raw >= GIZMO_PICK_BASE) return { kind: 'gizmo', axis: GIZMO_AXES[raw - GIZMO_PICK_BASE] };
    return { kind: 'object', id: raw - 1 };
  }

  /**
   * Pick the edit-object element (vert/edge/face for the current elementMode)
   * under CSS-pixel (cssX, cssY). Renders the element id buffer on demand and
   * reads a 9×9 region so small elements have click tolerance. Returns element
   * ids/keys (not indices), or null for a miss / when not in edit mode.
   */
  pickElement(
    scene: Scene,
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    kindOverride?: 'vert' | 'edge' | 'face',
  ): ElementPickResult | null {
    const editObj = scene.editObject;
    const sel = scene.editMode;
    if (!editObj || !sel) return null;
    const { gl, canvas } = this.ctx;

    const view = camera.viewMatrix();
    const proj = camera.projMatrix(canvas.width / canvas.height);
    const mvp = proj.mul(view).mul(scene.worldMatrix(editObj));
    this.elementPickPass.render(mvp, editObj.mesh, kindOverride ?? sel.elementMode);

    // Center a clamped 9×9 window on the cursor (device pixels, GL bottom-up).
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(cssX * dpr);
    const py = Math.round(cssY * dpr);
    const w = canvas.width;
    const h = canvas.height;
    const glCenterY = h - 1 - py;
    const size = 9;
    const x0 = Math.max(0, Math.min(px - 4, w - size));
    const y0 = Math.max(0, Math.min(glCenterY - 4, h - size));
    const region = this.elementPickPass.readRegion(x0, y0, size, size);
    const raw = closestNonZeroId(region, size, size, px - x0, glCenterY - y0);
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (raw === 0) return null;
    return decodePick(raw, elementIndexMaps(editObj.mesh));
  }
}
